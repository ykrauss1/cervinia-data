// Supabase Edge Function: visit-stats
//
// WHAT IT IS FOR (17 November 2026)
//
// The site counts visits with GoatCounter. Its totals are public and the
// admin dashboard reads them straight from GoatCounter; where the readers
// came from, which pages they opened and what they hold in their hands is
// behind GoatCounter's API, and that asks for a token. The repository is
// public and so is every line the browser runs, so the token cannot live in
// the page. It lives here, as the secret GOATCOUNTER_TOKEN, and this
// function is the only thing that ever sees it.
//
// It answers a signed-in admin and nobody else: the browser sends the
// session token it already holds, Supabase says whose it is, and the
// profile says whether that person is an admin (the same check as the
// "site" kind of tf-translate).
//
// Request:   POST { start: "<ISO time>" }   + Authorization: Bearer <session token>
//            start is where the span begins; it ends now. Left out: a week.
// Response:  { ok: true, start, end, total, days: [{day, n}],
//              refs: [{name, n}], pages: [{path, title, n}],
//              places: [{name, n}], systems: [{name, n}], sizes: [{name, n}] }
//            a list GoatCounter would not give is null, not [] - "could not
//            ask" is not "nobody came".
//          | { ok: false, error }
//
// Secrets:   GOATCOUNTER_TOKEN - made in GoatCounter under the user menu,
//            API, with the permission to read statistics and no other.
//            SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY
//            are there on their own.
// Verify JWT: off, as in tf-translate. The check is the one below.

const GC = "https://cervinialive.goatcounter.com/api/v0";

const ALLOW_ORIGINS = [
  "https://cervinialive.co.il",
  "https://www.cervinialive.co.il",
  "https://ykrauss1.github.io",
];

// The counter went in on 17 November 2026; nothing is older than that.
const EARLIEST = Date.parse("2026-11-01T00:00:00Z");

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

// Is the caller a signed-in admin? The token is the one the browser already
// holds for its Supabase session; Supabase says who it belongs to, and the
// profile says whether that person is an admin.
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One question to GoatCounter. null when it would not answer; the status of
// the first refusal is kept, so a wrong token reads as a wrong token.
let firstRefusal = 0;
async function ask(token: string, path: string, q: Record<string, string>): Promise<any> {
  try {
    const r = await fetch(GC + path + "?" + new URLSearchParams(q).toString(), {
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    });
    if (!r.ok) { if (!firstRefusal) firstRefusal = r.status; return null; }
    return await r.json();
  } catch (_e) { return null; }
}

const names = (d: any, n: number) =>
  Array.isArray(d?.stats)
    ? d.stats.slice(0, n).map((s: any) => ({ name: String(s?.name ?? ""), n: Number(s?.count) || 0 }))
    : null;

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(origin) });

  try {
    if (req.method !== "POST") return J({ ok: false, error: "POST only" }, 405, origin);
    if (!ALLOW_ORIGINS.includes(origin)) return J({ ok: false, error: "origin not allowed" }, 403, origin);
    if (!(await callerIsAdmin(req))) return J({ ok: false, error: "admins only" }, 403, origin);

    const token = Deno.env.get("GOATCOUNTER_TOKEN");
    if (!token) return J({ ok: false, error: "GOATCOUNTER_TOKEN not set" }, 500, origin);

    const body = await req.json().catch(() => ({}));
    const now = Date.now();
    let from = Date.parse(String(body?.start ?? ""));
    if (!Number.isFinite(from)) from = now - 7 * 86400000;
    from = Math.min(Math.max(from, EARLIEST), now);
    const span = { start: new Date(from).toISOString(), end: new Date(now).toISOString() };

    // GoatCounter allows four questions a second. Three, a pause, three.
    firstRefusal = 0;
    const [total, refs, hits] = await Promise.all([
      ask(token, "/stats/total", span),
      ask(token, "/stats/toprefs", { ...span, limit: "15" }),
      ask(token, "/stats/hits", { ...span, limit: "10", group: "day" }),
    ]);
    if (total === null && refs === null && hits === null) {
      const why = firstRefusal === 401 ? "GoatCounter refused the token"
        : firstRefusal === 403 ? "the GoatCounter token may not read statistics"
        : "GoatCounter did not answer" + (firstRefusal ? " (" + firstRefusal + ")" : "");
      return J({ ok: false, error: why }, 502, origin);
    }
    await sleep(1100);
    const [places, systems, sizes] = await Promise.all([
      ask(token, "/stats/locations", { ...span, limit: "8" }),
      ask(token, "/stats/systems", { ...span, limit: "6" }),
      ask(token, "/stats/sizes", { ...span, limit: "6" }),
    ]);

    return J({
      ok: true,
      start: span.start,
      end: span.end,
      total: total ? Number(total.total) || 0 : null,
      days: Array.isArray(total?.stats)
        ? total.stats.map((s: any) => ({ day: String(s?.day ?? "").slice(0, 10), n: Number(s?.daily) || 0 }))
        : null,
      refs: names(refs, 15),
      pages: Array.isArray(hits?.hits)
        ? hits.hits.slice(0, 10).map((h: any) => ({
            path: String(h?.path ?? ""), title: String(h?.title ?? ""), n: Number(h?.count) || 0,
          }))
        : null,
      places: names(places, 8),
      systems: names(systems, 6),
      sizes: names(sizes, 6),
    }, 200, origin);
  } catch (e) {
    return J({ ok: false, error: String((e as Error)?.message || e) }, 500, origin);
  }
});
