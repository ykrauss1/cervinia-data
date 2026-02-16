import puppeteer from "puppeteer";
import { createClient } from "@supabase/supabase-js";

// --- Supabase ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- Helper: fetch JSON safely ---
async function fetchJson(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json"
      }
    });

    const text = await res.text();

    // If API returned HTML → error
    if (text.startsWith("<")) {
      console.error("❌ API returned HTML instead of JSON:", url);
      console.error(text.slice(0, 200));
      return null;
    }

    return JSON.parse(text);
  } catch (err) {
    console.error("❌ Fetch failed:", url, err);
    return null;
  }
}

async function scrape() {
  console.log("🚀 Starting scraper...");

  // --- Launch Puppeteer ---
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();
  await page.goto("https://www.cervinia.it/en", { waitUntil: "networkidle2" });

  // --- DOM scraping ---
  const temperature = await page.$eval(".edagF", el => el.innerText.trim()).catch(() => null);
  const zermatt_link = await page.$eval(".FkAOa span", el => el.innerText.trim()).catch(() => null);

  const lifts_open = await page.$eval(
    'a[href="/en/impianti"] .vv1Cd span.size-25.secondary',
    el => el.innerText.trim()
  ).catch(() => null);

  const lifts_total_dom = await page.$eval(
    'a[href="/en/impianti"] .vv1Cd span.size-18.medium',
    el => el.innerText.trim()
  ).catch(() => null);

  const slopes_open = await page.$eval(
    'a[href="/en/impianti"] .vv1Cd span.size-25.secondary.demi',
    el => el.innerText.trim()
  ).catch(() => null);

  await browser.close();

  // --- API calls ---
  const impianti = await fetchJson("https://www.cervinia.it/wp-json/cervinia/v1/impianti");
  const meteo = await fetchJson("https://www.cervinia.it/wp-json/cervinia/v1/meteo");
  const snow = await fetchJson("https://www.cervinia.it/wp-json/cervinia/v1/neve");

  // --- Compute totals ---
  let lifts_total_api = 0;
  let areas = {};

  if (impianti && impianti.orari) {
    for (const [areaName, areaData] of Object.entries(impianti.orari)) {
      const count = areaData.orari_impianti_singoli?.length || 0;
      lifts_total_api += count;

      areas[areaName] = {
        lifts: count,
        seasonal_opening: areaData.apertura_stagionale_descrizione || null
      };
    }
  }

  const slopes_total = 109; // קבוע לפי האתר

  // --- Build record ---
  const record = {
    temperature: temperature ? parseFloat(temperature) : null,
    zermatt_link,
    alpine_crossing: "Unknown",

    lifts_open: lifts_open ? parseInt(lifts_open) : null,
    lifts_total: lifts_total_api || (lifts_total_dom ? parseInt(lifts_total_dom) : null),

    slopes_open: slopes_open ? parseInt(slopes_open) : null,
    slopes_total,

    snow,
    forecast: meteo?.previsioni || null,
    areas,

    raw_impianti: impianti,
    raw_meteo: meteo,
    raw_snow: snow
  };

  console.log("📦 Data ready:", record);

  // --- Save to Supabase ---
  const { error } = await supabase.from("ski_status_history").insert(record);

  if (error) {
    console.error("❌ Supabase insert error:", error);
  } else {
    console.log("✅ Data saved successfully!");
  }
}

scrape();
