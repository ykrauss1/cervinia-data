// Supabase Edge Function: search-stats
//
// WHAT IT IS FOR (19 November 2026)
//
// Google Search Console knows how people find the site in Google: what they
// searched for, how often the site showed, how often it was clicked and at
// which place in the results. Yossi wants it in the admin dashboard beside
// the GoatCounter visits. The Search Console API asks for a Google account;
// a "service account" (a robot account) made for this alone is added to the
// property as a user who may only look. Its key is a secret and cannot live
// in the page, so it lives here, as GSC_SA_KEY, and this function is the
// only thing that ever sees it.
//
// It answers a signed-in admin and nobody else - the same check as
// visit-stats.
//
// Request:   POST { days: 28 }   + Authorization: Bearer <session token>
//            the span ends three days ago (Google's figures arrive late).
// Response:  { ok: true, start, end, totals: {clicks, impressions, ctr, position},
//              days: [{day, clicks, impressions}],
//              queries: [{q, clicks, impressions, position}],
//              pages: [{page, clicks, impressions, position}],
//              countries: [{c, clicks, impressions}] }
//          | { ok: false, error, said }
//
// Secrets:   GSC_SA_KEY - the whole JSON key file of the service account,
//            pasted as it is. SUPABASE_URL, SUPABASE_ANON_KEY and
//            SUPABASE_SERVICE_ROLE_KEY are there on their own.
// Verify JWT: off. The check is callerIsAdmin below.

const SITE = "https://cervinialive.co.il/";   // the URL-prefix property in Search Console

const ALLOW_ORIGINS = [
  "https://cervinialive.co.il",
  "https://www.cervinialive.co.il",
  "https://ykrauss1.github.io",
];

const corsFor = (origin: string) => ({
  "Access-Control-Allow-Origin": ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0],
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});

const J = (obj: unknown, status = 200, origin = "") =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsFor(origin) },
  });

async function callerIsAdmin(req: Request): Promise<boolean> {
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const auth = req.headers.get("authorization") || "";
  if (!url || !anon || !svc || !/^Bearer\s+\S+/.test(auth)) return false;
  try {
    const u = await fetch(url + "/auth/v1/user", { headers: { apikey: anon, Authorization: auth } });
    if (!u.ok) return false;
    const id = (await u.json())?.id;
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return false;
    const p = await fetch(url + "/rest/v1/profiles?id=eq." + id + "&select=is_admin",
      { headers: { apikey: svc, Authorization: "Bearer " + svc } });
    if (!p.ok) return false;
    const rows = await p.json();
    return Array.isArray(rows) && rows.length === 1 && rows[0]?.is_admin === true;
  } catch (_e) { return false; }
}

// ── a Google access token from the service account's key ──
// The key file holds an RSA private key (PEM, PKCS#8). A JWT signed with it
// is traded at Google for a token that may read Search Console and nothing
// else. Kept for its hour, so a busy dashboard does not ask each time.
let cached: { token: string; until: number } | null = null;

const b64url = (b: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b as ArrayBuffer);
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function googleToken(key: { client_email: string; private_key: string; token_uri?: string }): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const pem = key.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const pk = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const aud = key.token_uri || "https://oauth2.googleapis.com/token";
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: key.client_email, scope: "https://www.googleapis.com/auth/webmasters.readonly",
    aud, iat: now, exp: now + 3600,
  }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pk, new TextEncoder().encode(head + "." + claim));
  const res = await fetch(aud, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + head + "." + claim + "." + b64url(sig),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.access_token) throw new Error("token: " + res.status + " " + JSON.stringify(out).slice(0, 200));
  cached = { token: out.access_token, until: Date.now() + (out.expires_in || 3600) * 1000 };
  return cached.token;
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(origin) });
  if (req.method !== "POST") return J({ ok: false, error: "POST only" }, 405, origin);
  if (!(await callerIsAdmin(req))) return J({ ok: false, error: "admins only" }, 403, origin);

  let days = 28;
  try { const b = await req.json(); if (b?.days) days = Math.max(1, Math.min(480, Math.round(+b.days))); } catch (_e) { /* a week by default */ }

  const raw = Deno.env.get("GSC_SA_KEY");
  if (!raw) return J({ ok: false, error: "no GSC_SA_KEY secret" }, 500, origin);
  let key;
  try { key = JSON.parse(raw); } catch (_e) { return J({ ok: false, error: "GSC_SA_KEY is not the JSON key file" }, 500, origin); }

  // Google's figures lag two or three days: the span ends three days ago
  const end = Date.now() - 3 * 864e5, start = end - (days - 1) * 864e5;
  const range = { startDate: day(start), endDate: day(end) };

  let token: string;
  try { token = await googleToken(key); }
  catch (e) { return J({ ok: false, error: "google refused the key", said: String(e).slice(0, 300) }, 502, origin); }

  const ask = async (dimensions: string[], rowLimit = 25) => {
    const r = await fetch("https://www.googleapis.com/webmasters/v3/sites/" + encodeURIComponent(SITE) + "/searchAnalytics/query", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ ...range, dimensions, rowLimit, dataState: "all" }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status + " " + JSON.stringify(out).slice(0, 300));
    return (out.rows || []) as { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }[];
  };

  try {
    const [tot, byDay, byQuery, byPage, byCountry] = await Promise.all([
      ask([], 1), ask(["date"], 500), ask(["query"], 30), ask(["page"], 15), ask(["country"], 10),
    ]);
    const t = tot[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
    const r1 = (x: number) => Math.round(x * 10) / 10;
    return J({
      ok: true, start: range.startDate, end: range.endDate,
      totals: { clicks: t.clicks, impressions: t.impressions, ctr: Math.round(t.ctr * 1000) / 10, position: r1(t.position) },
      days: byDay.map((r) => ({ day: r.keys![0], clicks: r.clicks, impressions: r.impressions })),
      queries: byQuery.map((r) => ({ q: r.keys![0], clicks: r.clicks, impressions: r.impressions, position: r1(r.position) })),
      pages: byPage.map((r) => ({ page: r.keys![0], clicks: r.clicks, impressions: r.impressions, position: r1(r.position) })),
      countries: byCountry.map((r) => ({ c: r.keys![0], clicks: r.clicks, impressions: r.impressions })),
    }, 200, origin);
  } catch (e) {
    // 403 here is almost always "the service account is not a user of the property yet"
    return J({ ok: false, error: "search console refused", said: String(e).slice(0, 300) }, 502, origin);
  }
});
