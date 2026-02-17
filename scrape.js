import puppeteer from "puppeteer";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------- Helper: robust fetch with headers + retry ----------

async function fetchJsonWithHeaders(url, retries = 3) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
    "Connection": "keep-alive",
    "DNT": "1",
    "Referer": "https://www.cervinia.it/",
    "Origin": "https://www.cervinia.it"
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers });

      const text = await res.text();

      if (!res.ok) {
        console.error(`❌ ${url} returned status ${res.status}`);
        console.error(text.slice(0, 200));
        continue;
      }

      if (text.trim().startsWith("<")) {
        console.error(`❌ ${url} returned HTML instead of JSON (attempt ${attempt})`);
        console.error(text.slice(0, 200));
        continue;
      }

      return JSON.parse(text);
    } catch (err) {
      console.error(`❌ Fetch error on ${url}, attempt ${attempt}:`, err);
    }
  }

  return null;
}

// ---------- Helper: fetch JSON via page.evaluate (fallback through browser) ----------

async function fetchJsonViaPage(page, url) {
  try {
    const result = await page.evaluate(async (url) => {
      const res = await fetch(url, {
        headers: {
          "Accept": "application/json, text/javascript, */*; q=0.01"
        }
      });
      const text = await res.text();
      if (text.trim().startsWith("<")) {
        return { ok: false, text };
      }
      return { ok: true, json: JSON.parse(text) };
    }, url);

    if (!result.ok) {
      console.error(`❌ Browser fetch for ${url} returned HTML:`);
      console.error(result.text.slice(0, 200));
      return null;
    }

    return result.json;
  } catch (err) {
    console.error(`❌ Browser fetch error for ${url}:`, err);
    return null;
  }
}

async function scrape() {
  console.log("🚀 Starting scraper...");

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();
  await page.goto("https://www.cervinia.it/en", { waitUntil: "networkidle2" });

  // ---------- LOCAL DATA (Cervinia only, from DOM) ----------

  // טמפרטורה מקומית
  const temperature_local = await page
    .$eval(".edagF", el => parseFloat(el.innerText.replace("°", "").trim()))
    .catch(() => null);

  // מעליות ומסלולים מקומיים (העיגולים)
  const lifts_open_local = await page
    .$eval('a[href="/en/impianti"] .vv1Cd span.size-25.secondary', el =>
      parseInt(el.innerText.trim())
    )
    .catch(() => null);

  const lifts_total_local = await page
    .$eval('a[href="/en/impianti"] .vv1Cd span.size-18.medium', el =>
      parseInt(el.innerText.trim())
    )
    .catch(() => 16); // fallback קבוע

  const slopes_open_local = await page
    .$eval('a[href="/en/impianti"] .vv1Cd span.size-25.secondary.demi', el =>
      parseInt(el.innerText.trim())
    )
    .catch(() => null);

  const slopes_total_local = 46; // קבוע לפי האתר

  // קישור צ'רמט / מעבר אלפיני
  const zermatt_link = await page
    .$eval(".FkAOa span", el => el.innerText.trim().toUpperCase())
    .catch(() => null);

  const alpine_crossing = "Unknown"; // אפשר לשפר בהמשך אם יש מקור ברור

  // ---------- GLOBAL DATA (whole area) via API ----------

  const IMP_URL = "https://www.cervinia.it/wp-json/cervinia/v1/impianti";
  const METEO_URL = "https://www.cervinia.it/wp-json/cervinia/v1/meteo";
  const SNOW_URL = "https://www.cervinia.it/wp-json/cervinia/v1/neve";

  let impianti = await fetchJsonWithHeaders(IMP_URL);
  let meteo = await fetchJsonWithHeaders(METEO_URL);
  let snow = await fetchJsonWithHeaders(SNOW_URL);

  // אם ה‑API חסום גם אחרי retry → ננסה דרך הדפדפן
  if (!impianti || !meteo || !snow) {
    console.log("⚠️ Falling back to browser-based API fetch...");
    if (!impianti) impianti = await fetchJsonViaPage(page, IMP_URL);
    if (!meteo) meteo = await fetchJsonViaPage(page, METEO_URL);
    if (!snow) snow = await fetchJsonViaPage(page, SNOW_URL);
  }

  // ---------- Parse global data from API ----------

  let lifts_total_global = 47;   // קבוע לפי האתר, גם אם ה‑API נופל
  let slopes_total_global = 109; // קבוע לפי האתר

  let lifts_open_global = null;
  let slopes_open_global = null;
  let areas = null;
  let forecast = null;

  if (impianti && impianti.orari) {
    areas = {};
    let totalLifts = 0;
    let totalOpenLifts = 0;
    let totalSlopes = 0;
    let totalOpenSlopes = 0;

    for (const [areaName, areaData] of Object.entries(impianti.orari)) {
      const liftsArr = areaData.orari_impianti_singoli || [];
      const slopesArr = areaData.orari_piste_singole || [];

      const liftsCount = liftsArr.length;
      const liftsOpenCount = liftsArr.filter(l => l.stato === "Aperto" || l.stato === "Open").length;

      const slopesCount = slopesArr.length;
      const slopesOpenCount = slopesArr.filter(s => s.stato === "Aperta" || s.stato === "Open").length;

      totalLifts += liftsCount;
      totalOpenLifts += liftsOpenCount;
      totalSlopes += slopesCount;
      totalOpenSlopes += slopesOpenCount;

      areas[areaName] = {
        lifts_total: liftsCount,
        lifts_open: liftsOpenCount,
        slopes_total: slopesCount,
        slopes_open: slopesOpenCount,
        seasonal_opening: areaData.apertura_stagionale_descrizione || null
      };
    }

    // אם ה‑API החזיר מספרים אמיתיים – נעדיף אותם על הקבועים
    if (totalLifts > 0) lifts_total_global = totalLifts;
    if (totalSlopes > 0) slopes_total_global = totalSlopes;

    lifts_open_global = totalOpenLifts;
    slopes_open_global = totalOpenSlopes;
  }

  if (meteo && meteo.previsioni) {
    forecast = meteo.previsioni;
  }

  // ---------- Build record ----------

  const record = {
    // מקומי
    temperature_local,
    lifts_open_local,
    lifts_total_local,
    slopes_open_local,
    slopes_total_local,

    // כללי
    lifts_open_global,
    lifts_total_global,
    slopes_open_global,
    slopes_total_global,

    // נוספים
    zermatt_link,
    alpine_crossing,

    // API parsed
    areas,
    forecast,
    snow,

    // raw
    raw_impianti: impianti,
    raw_meteo: meteo,
    raw_snow: snow
  };

  console.log("📦 Final record:", JSON.stringify(record, null, 2));

  // ---------- Save to Supabase ----------

  const { error } = await supabase.from("ski_status_history").insert(record);

  if (error) {
    console.error("❌ Supabase insert error:", error);
  } else {
    console.log("✅ Data saved successfully!");
  }

  await browser.close();
}

scrape().catch(err => {
  console.error("❌ Fatal error in scrape():", err);
});
