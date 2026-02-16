import puppeteer from "puppeteer";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function scrape() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();
  await page.goto("https://www.cervinia.it/en", { waitUntil: "networkidle2" });

  // --- DOM SCRAPING ---
  const temperature = await page.$eval(".edagF", el => el.innerText.trim());
  const zermatt_link = await page.$eval(".FkAOa span", el => el.innerText.trim());

  // Breuil Cervinia lifts/slopes
  const lifts_open = await page.$eval(
    'a[href="/en/impianti"] .vv1Cd span.size-25.secondary',
    el => el.innerText.trim()
  );

  const lifts_total = await page.$eval(
    'a[href="/en/impianti"] .vv1Cd span.size-18.medium',
    el => el.innerText.trim()
  );

  const slopes_open = await page.$eval(
    'a[href="/en/impianti"] .vv1Cd span.size-25.secondary.demi',
    el => el.innerText.trim()
  );

  const slopes_total = await page.$eval(
    'a[href="/en/impianti"] .vv1Cd span.size-18.medium.u-ml-10',
    el => el.innerText.trim()
  );

  // Global slopes total (109)
  const global_slopes_total = 109;

  await browser.close();

  // --- API FETCHING ---
  const impiantiRes = await fetch("https://www.cervinia.it/wp-json/cervinia/v1/impianti");
  const impianti = await impiantiRes.json();

  const meteoRes = await fetch("https://www.cervinia.it/wp-json/cervinia/v1/meteo");
  const meteo = await meteoRes.json();

  const snowRes = await fetch("https://www.cervinia.it/wp-json/cervinia/v1/neve");
  const snow = await snowRes.json();

  // Count total lifts from API
  const lifts_total_api = Object.values(impianti.orari || {})
    .flatMap(area => area.orari_impianti_singoli || [])
    .length;

  // Build areas object
  const areas = {};
  for (const [areaName, areaData] of Object.entries(impianti.orari || {})) {
    areas[areaName] = {
      lifts: areaData.orari_impianti_singoli?.length || 0,
      seasonal_opening: areaData.apertura_stagionale_descrizione || null
    };
  }

  // --- SAVE TO SUPABASE ---
  const { error } = await supabase.from("ski_status_history").insert({
    temperature: parseFloat(temperature),
    zermatt_link,
    alpine_crossing: "Closed", // אפשר לגרד גם את זה אם תרצה

    lifts_open: parseInt(lifts_open),
    lifts_total: lifts_total_api,
    slopes_open: parseInt(slopes_open),
    slopes_total: global_slopes_total,

    snow,
    forecast: meteo.previsioni || [],
    areas,

    raw_impianti: impianti,
    raw_meteo: meteo,
    raw_snow: snow
  });

  if (error) console.error("Supabase insert error:", error);
  else console.log("Data saved successfully");
}

scrape();
