// ======================================================================
//  CerviniaLive - push-send
//
//  Supabase calls this once, automatically, every time a row lands in
//  public.alerts. It works out who should hear about it, encrypts a copy
//  of the message separately for each subscriber, and hands each one to
//  that browser's push service.
//
//  Everything cryptographic here is RFC 8291 (message encryption) and
//  RFC 8292 (VAPID), written against Web Crypto so there is no npm
//  dependency to break on a runtime upgrade.
//
//  Secrets it needs (Supabase -> Edge Functions -> Secrets):
//    VAPID_PUBLIC_KEY   - the same one the browser subscribes with
//    VAPID_PRIVATE_KEY  - never leaves this list
//    VAPID_SUBJECT      - mailto: address, so a push service can complain
//    SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY - provided by Supabase itself
//
//  The shared secret the database webhook sends is NOT in that list any
//  more. It used to be, as PUSH_HOOK_SECRET, and the trigger in the
//  database carried its own copy - two copies of one value, which have to
//  match exactly and have no way of telling you when they stop. On 8.11
//  they stopped: every push since the rotation failed with 403, the site
//  looked perfectly healthy, the green line appeared on the strip, and no
//  phone rang. It took reading pg_net's own response table to see it.
//
//  So there is one copy now, the row in public.cl_secrets, read here with
//  the service key. Rotating it is a single UPDATE, and nothing can drift
//  from anything.
// ======================================================================

const enc = new TextEncoder();

/* ------------------------------------------------------------ helpers -- */

function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Web Crypto's HKDF does extract-and-expand in one call, which is exactly
// the shape RFC 8291 asks for at each of its three steps.
async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, len: number) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8),
  );
}

/* --------------------------------------------------------- encryption -- */

// One message, encrypted for one subscription. The first 86 bytes of the
// result are a header the receiving browser needs in order to decrypt: our
// salt, the record size, and a public key we throw away afterwards. None of
// that is secret - the secret is the shared value only this browser's private
// key can derive.
async function encryptPayload(payload: string, p256dhB64: string, authB64: string) {
  const uaPublic   = b64urlToBytes(p256dhB64);  // 65 bytes, uncompressed point
  const authSecret = b64urlToBytes(authB64);    // 16 bytes

  // A fresh key pair per message. Reusing one would let anybody who ever
  // learned a single plaintext work backwards into the others.
  const as = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  ) as CryptoKeyPair;

  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey(
    "raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256),
  );

  // Fold in the subscription's auth secret. Both public keys go into the info
  // string, which binds the result to this exact pair of parties.
  const ikm = await hkdf(
    shared, authSecret, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32,
  );

  const salt  = crypto.getRandomValues(new Uint8Array(16));
  const cek   = await hkdf(ikm, salt, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, salt, enc.encode("Content-Encoding: nonce\0"), 12);

  // 0x02 marks this as the final record. Everything we send fits in one.
  const plain  = concat(enc.encode(payload), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, plain),
  );

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);

  // salt(16) | record size(4) | key length(1) | our public key(65) | ciphertext
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

/* -------------------------------------------------------------- VAPID -- */

// Proof that the sender is us. The push service checks this signature against
// the public key the browser handed it at subscribe time, so a stolen endpoint
// on its own is not enough to send in our name.
async function vapidHeader(endpoint: string, subject: string, pub: string, priv: string) {
  const pk = b64urlToBytes(pub);
  if (pk.length !== 65 || pk[0] !== 4) throw new Error("VAPID public key is not a 65-byte P-256 point");

  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC", crv: "P-256", ext: true,
      d: priv.replace(/=+$/, ""),
      x: bytesToB64url(pk.slice(1, 33)),
      y: bytesToB64url(pk.slice(33, 65)),
    },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );

  const head = bytesToB64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  // 12 hours. The spec allows 24; a shorter life limits the damage if one of
  // these ever ends up in a log somewhere.
  const body = bytesToB64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + body),
  ));

  return "vapid t=" + head + "." + body + "." + bytesToB64url(sig) + ", k=" + pub;
}

/* ------------------------------------------------------- what to say --- */

// lang: the language the subscriber signed up in (push_subs.lang). English
// gets the English wording when the alert has one - automatic alerts do;
// a reader's report is in whatever language its author wrote it.
function buildPayload(a: Record<string, unknown>, lang = "he") {
  const en   = lang === "en";
  const kind = String(a.kind || "alert");
  const sev  = String(a.severity || "warning");
  const text = String((en && a.text_en) ? a.text_en : (a.text || "")).slice(0, 300);

  const title = en
    ? (kind === "notice"
        ? "Notice - CerviniaLive"
        : (sev === "danger" ? "⚠️ Alert - Cervinia" : "Alert - Cervinia"))
    : (kind === "notice"
        ? "הודעה - צ'רוויניה לייב"
        : (sev === "danger" ? "⚠️ התראה - צ'רוויניה" : "התראה - צ'רוויניה"));

  return JSON.stringify({
    title,
    body: text,
    severity: kind === "notice" ? "info" : sev,
    // Separate tags, so a standing notice never replaces a live danger alert
    // on the lock screen, and vice versa.
    tag: kind === "notice" ? "cervinia-notice" : "cervinia-alert",
    url: en ? "./index.html?open=alerts&lang=en" : "./index.html?open=alerts",
  });
}

/* --------------------------------------------------------------- main -- */

Deno.serve(async (req) => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const VAPID_PUB    = Deno.env.get("VAPID_PUBLIC_KEY");
  const VAPID_PRIV   = Deno.env.get("VAPID_PRIVATE_KEY");
  const SUBJECT      = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";

  // Fail closed. A missing key means the function was deployed before it was
  // configured, and the one thing worse than no notifications is a public
  // endpoint that makes everybody's phone ring.
  if (!VAPID_PUB || !VAPID_PRIV || !SUPABASE_URL || !SERVICE_KEY) {
    return new Response("not configured", { status: 503 });
  }

  const rest = (path: string, init: RequestInit = {}) =>
    fetch(SUPABASE_URL + "/rest/v1/" + path, {
      ...init,
      headers: {
        apikey: SERVICE_KEY,
        Authorization: "Bearer " + SERVICE_KEY,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });

  // The one copy of the shared secret. cl_secrets has RLS on and no policy,
  // so no browser can reach it; the service key here bypasses that, as it is
  // meant to. btrim on both sides, because a secret that stops working over
  // one invisible trailing newline is a day nobody gets back.
  let hookSecret = "";
  try {
    const sRes = await rest("cl_secrets?key=eq.push_hook_secret&select=value");
    if (sRes.ok) {
      const rows = await sRes.json();
      hookSecret = String(rows?.[0]?.value ?? "").trim();
    }
  } catch { /* falls through to the check below */ }

  if (!hookSecret) {
    // Said plainly, because the alternative is another silent 403: the row
    // is missing, empty, or unreadable, and nothing will be sent until it
    // is there.
    return new Response("no push_hook_secret in cl_secrets", { status: 503 });
  }
  if ((req.headers.get("x-push-secret") ?? "").trim() !== hookSecret) {
    return new Response("forbidden", { status: 403 });
  }

  let alertId = "";
  try {
    const body = await req.json();
    // Supabase's database webhook shape, with a plain {id} accepted too so the
    // function can be re-fired by hand from curl when testing.
    alertId = String(body?.record?.id ?? body?.id ?? "");
  } catch { /* falls through to the check below */ }
  if (!alertId) return new Response("no alert id", { status: 400 });

  // Who should get it. All the rules - live, not sent yet, severe enough,
  // never the author - live in cl_push_targets, in SQL, where they can be read.
  const tRes = await rest("rpc/cl_push_targets", {
    method: "POST", body: JSON.stringify({ p_alert: alertId }),
  });
  if (!tRes.ok) {
    return new Response("targets failed: " + (await tRes.text()), { status: 500 });
  }
  const targets: { endpoint: string; p256dh: string; auth: string }[] = await tRes.json();

  // Read the alert itself for its wording. text_en may not exist on a
  // database the migration has not reached; then read without it, so a
  // missing column can never stop a push.
  let aRes = await rest("alerts?id=eq." + alertId + "&select=id,text,text_en,severity,kind");
  if (!aRes.ok) aRes = await rest("alerts?id=eq." + alertId + "&select=id,text,severity,kind");
  const rows = aRes.ok ? await aRes.json() : [];

  // Which subscribers signed up in English. Read separately rather than
  // through cl_push_targets, so that function did not have to change; the
  // English list is small. If lang is missing, everybody gets Hebrew, as
  // before.
  const enSubs = new Set<string>();
  try {
    const lRes = await rest("push_subs?lang=eq.en&select=endpoint");
    if (lRes.ok) for (const r of await lRes.json()) enSubs.add(String(r.endpoint));
  } catch { /* Hebrew for all */ }
  if (!rows.length) return new Response("alert not found", { status: 404 });

  // Stamp it sent BEFORE sending. If this function dies half way through, a
  // retry would otherwise deliver the message a second time to everybody who
  // already had it. A rare miss is better than a duplicate buzz at 2am, and
  // the alert is still on the board either way.
  await rest("alerts?id=eq." + alertId, {
    method: "PATCH", body: JSON.stringify({ pushed_at: new Date().toISOString() }),
  });

  if (!targets.length) {
    return new Response(JSON.stringify({ sent: 0, reason: "no recipients" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const payloadHe = buildPayload(rows[0], "he");
  const payloadEn = buildPayload(rows[0], "en");
  let sent = 0, gone = 0, failed = 0;

  // In batches, so a hundred subscribers do not open a hundred sockets at once.
  for (let i = 0; i < targets.length; i += 20) {
    await Promise.all(targets.slice(i, i + 20).map(async (t) => {
      try {
        const payload = enSubs.has(t.endpoint) ? payloadEn : payloadHe;
        const body = await encryptPayload(payload, t.p256dh, t.auth);
        const res = await fetch(t.endpoint, {
          method: "POST",
          headers: {
            Authorization: await vapidHeader(t.endpoint, SUBJECT, VAPID_PUB, VAPID_PRIV),
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            TTL: "86400",
            // "normal" lets Android hold a message until the phone next
            // wakes, which on a device asleep on a table can be twenty
            // minutes. That is fine for good news and wrong for a warning:
            // lifts stopping, or gusts at 105, are things somebody needs
            // before they set off, not after. And nobody is woken who did
            // not ask - the reader chose these categories themselves.
            Urgency: (rows[0].severity === "danger" ||
                      rows[0].severity === "warning") ? "high" : "normal",
          },
          body,
        });

        if (res.status === 404 || res.status === 410) {
          // The browser is gone for good - uninstalled, or site data cleared.
          // This is the normal end of a subscription, not an error.
          gone++;
          await rest("push_subs?endpoint=eq." + encodeURIComponent(t.endpoint), { method: "DELETE" });
        } else if (res.ok) {
          sent++;
          await rest("push_subs?endpoint=eq." + encodeURIComponent(t.endpoint), {
            method: "PATCH",
            body: JSON.stringify({ last_sent_at: new Date().toISOString(), fail_count: 0 }),
          });
        } else {
          failed++;
          console.error("push " + res.status + " " + (await res.text()).slice(0, 200));
          await rest("rpc/cl_push_bump", {
            method: "POST", body: JSON.stringify({ p_endpoint: t.endpoint }),
          });
        }
      } catch (e) {
        failed++;
        console.error("push threw: " + (e instanceof Error ? e.message : String(e)));
      }
    }));
  }

  return new Response(JSON.stringify({ alert: alertId, sent, gone, failed }), {
    headers: { "Content-Type": "application/json" },
  });
});