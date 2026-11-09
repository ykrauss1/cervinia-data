// Supabase Edge Function: tf-translate
//
// WHAT CHANGED, AND WHY (9 November 2026)
//
// The previous version took a free-form `prompt` from the browser and ran it
// on Yossi's Anthropic key. The browser sends no apikey and no Authorization,
// and it works in production - so Verify JWT is off, and the URL sits in the
// page source of a public website. That made this a general-purpose LLM
// proxy that anybody could spend his money on, 8,000 characters at a time.
//
// No secret can fix that: anything the browser holds is as public as the URL
// itself. What CAN be fixed is the shape of what may be asked. This function
// no longer accepts a prompt. It accepts DATA for the two jobs the site
// actually has - parse a trip sentence, translate a sentence - and builds
// the prompt itself. A stranger who finds the URL can now translate short
// sentences and nothing else, which is worth almost nothing to steal.
//
// Request (new):
//   { kind: "trip",      text, today: "YYYY-MM-DD", chagim: "<name> <iso> · ..." }
//   { kind: "translate", text, to: "it" | "en" | "he" }
// Request (legacy, during the deploy window only - see ALLOW_LEGACY):
//   { prompt: "..." }
// Response (unchanged, so the client needs no flag day):
//   { ok: true, intent: {...}, model } | { ok: false, error, status }

const MODEL = "claude-haiku-4-5-20251001";

// The free-form door, closed on 9 November once the new page was live.
//
// It is false in THIS FILE, and that matters: it was switched off in the
// Supabase editor rather than here, and the next version of this file -
// which still said true - was pasted over it and reopened the hole without
// anybody meaning to. A setting that lives only in the editor survives
// exactly until the next paste. alerts-test.mjs now fails if this is true.
const ALLOW_LEGACY = false;

// Browsers always send Origin on a cross-origin POST, and this function is
// always cross-origin to the site. curl can forge it, so this is a fence and
// not a wall - but it stops another website pointing its visitors here.
const ALLOW_ORIGINS = [
  "https://cervinialive.co.il",
  "https://www.cervinialive.co.il",
  "https://ykrauss1.github.io",
];

// Short on purpose. The real sentences are one line; the trip parser caps
// its own input at 400 characters. A cap is what makes the endpoint useless
// as a general-purpose model.
const MAX_TEXT = { trip: 400, translate: 600, legacy: 1200 };
const MAX_TOKENS = { trip: 900, translate: 400, legacy: 500 };

// Per IP per hour, and for everybody together per day. The daily one is the
// number that matters: it is the most this function can cost in 24 hours
// even if somebody rotates through a thousand addresses.
const LIMIT_IP_HOUR = 40;
const LIMIT_ALL_DAY = 1500;

const corsFor = (origin: string) => ({
  "Access-Control-Allow-Origin": ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0],
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});

const J = (obj: unknown, status = 200, origin = "") =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsFor(origin) },
  });

function extractJson(txt: string): any {
  let t = String(txt || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(t); } catch (_e) { /* keep trying */ }
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i >= 0 && j > i) {
    try { return JSON.parse(t.slice(i, j + 1)); } catch (_e) { /* fall through */ }
  }
  return null;
}

// ── the two prompts, which now live here rather than in the page ──────────
const LANG = { it: "Italian", en: "English", he: "Hebrew" } as const;

function translatePrompt(text: string, to: keyof typeof LANG) {
  const full = LANG[to];
  return (
    `Translate the following into ${full}. It is one sentence from a polite ` +
    `enquiry to a holiday-apartment agency in Breuil-Cervinia, Italy. Keep it ` +
    `polite, keep it a question if it is one, and translate it as it stands - ` +
    `do not improve it, do not answer it, and do not add anything. Return ONLY ` +
    `valid JSON, no markdown: {"t":"<the ${full} text>"}\n\n` + text
  );
}

function tripPrompt(text: string, today: string, chagim: string) {
  return 'תרגם בקשת תכנון טיול לצ’רוויניה (איטליה) ל-JSON. החזר אך ורק JSON תקין — בלי טקסט ובלי markdown.\n'
    + 'התאריך היום: ' + today + '. כשחודש או חג נזכר בלי שנה — בחר את המופע העתידי הקרוב.\n'
    + 'תאריכי החגים האמיתיים (השתמש בהם, אל תחשב בעצמך): ' + chagim + '\n'
    + 'שדות:\n'
    + '- airport: "MXP" (מילאנו/מלפנסה), "BGY" (ברגמו), "TRN" (טורינו), או null אם לא צוין\n'
    + '- checkin / checkout: "YYYY-MM-DD" או null. אם צוין חודש בלבד — קח את ה-1 בחודש\n'
    + '- nights: מספר לילות ("שבוע"=7, "סופש"=2, "שבועיים"=14) או null\n'
    + 'אם צוינו ימי שבוע ("מראשון עד שישי") — חשב בעצמך את התאריכים בפועל: '
    + 'checkin = יום השבוע המבוקש הראשון בתאריך שצוין או אחריו, '
    + 'checkout = יום החזרה המבוקש הראשון אחרי checkin. אל תשאיר תאריכים ריקים כשאפשר לחשב אותם.\n'
    + '- adults / children: מספרים או null. "זוג"=2 מבוגרים, "משפחה"=2 מבוגרים ו-2 ילדים\n'
    + '- car: true אם ביקש רכב, אחרת null\n'
    + '- hotel: false אם ביקש בלי לינה, true אם ביקש לינה, אחרת null\n'
    + '- accType: "apt" אם ביקש דירה/אפרטמנט, "hotel" אם מלון, "any" אם כל סוג לינה, אחרת null\n'
    + '- airportPickup: true אם ביקש לקבל את הרכב בשדה התעופה, אחרת null\n'
    + '- automatic: true אם ביקש גיר אוטומטי, false אם ביקש ידני, אחרת null\n'
    + '- summary: תקציר עברי קצר של מה שהובן\n'
    + 'אל תמציא ערך שלא נכתב. פלט: {"airport":null,"checkin":null,"checkout":null,"nights":null,"adults":null,"children":null,"car":null,"hotel":null,"accType":null,"airportPickup":null,"automatic":null,"summary":""}\n'
    + 'הבקשה: "' + text + '"';
}

// ── counting ──────────────────────────────────────────────────────────────
// Fails OPEN on a database error: a Supabase hiccup must not take the search
// box down with it. That is a deliberate trade, and it is why the spend cap
// on the Anthropic account is the backstop and not this.
async function overLimit(bucket: string, limit: number): Promise<boolean> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return false;
  try {
    const r = await fetch(url + "/rest/v1/rpc/cl_ai_bump", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key,
                 Authorization: "Bearer " + key },
      body: JSON.stringify({ p_bucket: bucket, p_limit: limit }),
    });
    if (!r.ok) return false;
    return (await r.json()) === false;   // cl_ai_bump returns "still allowed"
  } catch (_e) { return false; }
}

// Anthropic answers an exhausted balance with a billing error, and the site
// degrades quietly when that happens - the trip search falls back to the
// local parser, the letter keeps its pre-written part. Quiet is right for
// the reader and wrong for Yossi, who would otherwise learn about it weeks
// later. This leaves a mark in the same table the counters use; the scraper
// reads it within the hour and turns its run red, which reaches him by mail.
async function noteCreditOut() {
  const day = new Date().toISOString().slice(0, 10);
  try { await overLimit("credit-out:" + day, 1_000_000); } catch (_e) { /**/ }
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsFor(origin) });

  try {
    if (!ALLOW_ORIGINS.includes(origin))
      return J({ ok: false, error: "origin not allowed" }, 403, origin);

    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return J({ ok: false, error: "ANTHROPIC_API_KEY not set" }, 500, origin);

    const body = await req.json().catch(() => null);
    if (!body) return J({ ok: false, error: "bad body" }, 400, origin);

    const kind = String(body.kind || (body.prompt ? "legacy" : "")).trim();
    let prompt = "", maxTokens = 500;

    if (kind === "translate") {
      const to = String(body.to || "");
      if (!(to in LANG)) return J({ ok: false, error: "bad target language" }, 400, origin);
      const text = String(body.text || "").trim();
      if (!text) return J({ ok: false, error: "text required" }, 400, origin);
      if (text.length > MAX_TEXT.translate)
        return J({ ok: false, error: "text too long" }, 400, origin);
      prompt = translatePrompt(text, to as keyof typeof LANG);
      maxTokens = MAX_TOKENS.translate;

    } else if (kind === "trip") {
      const text = String(body.text || "").trim().slice(0, MAX_TEXT.trip);
      if (!text) return J({ ok: false, error: "text required" }, 400, origin);
      const today = String(body.today || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(today))
        return J({ ok: false, error: "bad date" }, 400, origin);
      // The holiday table is data the page computed, and it lands inside the
      // prompt - so it is held to a shape that cannot carry instructions.
      const chagim = String(body.chagim || "").slice(0, 400);
      if (chagim && !/^[֐-׿’'"\s\d·\-]+$/.test(chagim))
        return J({ ok: false, error: "bad holiday table" }, 400, origin);
      prompt = tripPrompt(text, today, chagim);
      maxTokens = MAX_TOKENS.trip;

    } else if (kind === "legacy" && ALLOW_LEGACY) {
      prompt = String(body.prompt || "").trim();
      if (!prompt) return J({ ok: false, error: "prompt required" }, 400, origin);
      if (prompt.length > MAX_TEXT.legacy)
        return J({ ok: false, error: "prompt too long" }, 400, origin);
      maxTokens = MAX_TOKENS.legacy;

    } else {
      return J({ ok: false, error: "unknown kind" }, 400, origin);
    }

    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
    const now = new Date().toISOString();
    if (await overLimit("day:" + now.slice(0, 10), LIMIT_ALL_DAY))
      return J({ ok: false, error: "daily limit reached" }, 429, origin);
    if (await overLimit("ip:" + ip + ":" + now.slice(0, 13), LIMIT_IP_HOUR))
      return J({ ok: false, error: "too many requests" }, 429, origin);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let r: Response;
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,                 // no longer taken from the request
          max_tokens: maxTokens,
          temperature: 0,
          system: "Return ONLY a single JSON object. No prose, no markdown, no code fences.",
          messages: [{ role: "user", content: prompt }],
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      return J({ ok: false, error: "upstream " + String(e) }, 502, origin);
    }
    clearTimeout(timer);

    if (!r.ok) {
      let detail = "";
      try { detail = (await r.text()).slice(0, 400); } catch (_e) { /**/ }
      if (/credit|billing|payment|quota/i.test(detail)) await noteCreditOut();
      return J({ ok: false, error: "anthropic " + r.status, status: r.status, detail }, 502, origin);
    }

    const d = await r.json();
    const txt = (d?.content || []).filter((b: any) => b?.type === "text")
                                  .map((b: any) => b.text).join("");
    const intent = extractJson(txt);
    if (!intent)
      return J({ ok: false, error: "unparseable model reply",
                 sample: String(txt).slice(0, 300) }, 502, origin);

    return J({ ok: true, intent, model: d?.model || MODEL }, 200, origin);
  } catch (e) {
    return J({ ok: false, error: String(e) }, 500, origin);
  }
});
