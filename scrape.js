// scrape.js — יוסי, גרסה מלאה עם שמירה ל‑Supabase

const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

// ----------- SUPABASE CONFIG -----------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function scrape() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  // ============================================================
  // 1) HOME PAGE — GLOBAL DATA + ZERMATT LINK
  // ============================================================

  await page.goto('https://www.cervinia.it/en', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  await page.waitForTimeout(2000);

  const globalBlocks = await page.$$eval('div._4ruBB a', items =>
    items.map(a => {
      const value = a.querySelector('.edagF')?.innerText.trim() || null;
      const label = a.querySelector('.Ognil')?.innerText.trim().toLowerCase() || null;
      return { value, label };
    })
  ).catch(() => []);

  let temperature_global = null;
  let lifts_open_global = null;
  let slopes_open_global = null;

  for (const item of globalBlocks) {
    if (!item.label || !item.value) continue;

    if (item.label === 'weather') {
      temperature_global = parseFloat(item.value.replace('°', ''));
    }

    if (item.label === 'lifts') {
      lifts_open_global = parseInt(item.value);
    }

    if (item.label === 'slopes') {
      slopes_open_global = parseInt(item.value);
    }
  }

  const lifts_total_global = 47;
  const slopes_total_global = 109;

  let zermatt_link = await page.$eval(
    'span.U4QfZ',
    el => el.innerText.trim().toUpperCase()
  ).catch(() => null);

  // ============================================================
  // 2) SNOW PAGE — SNOW TABLE + AVALANCHE RISK
  // ============================================================

  await page.goto('https://www.cervinia.it/en/neve', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  await page.waitForTimeout(2000);

  const snowRows = await page.$$eval('tr.u-text-left.size-18.medium', rows =>
    rows.map(row => {
      const cells = [...row.querySelectorAll('td')].map(td => td.innerText.trim());
      return {
        location: cells[0] || null,
        snow_depth: cells[1] || null,
        last_snowfall: cells[2] || null
      };
    })
  ).catch(() => []);

  let snow = null;
  if (snowRows.length > 0) {
    snow =
      snowRows.find(r => (r.location || '').toLowerCase().includes('plateau')) ||
      snowRows[0];
  }

  let avalanche_risk_level = await page.$eval(
    'span.anpIX',
    el => el.innerText.trim()
  ).catch(() => null);

  let avalanche_risk_text = await page.$eval(
    'div.kpCCY span.size-20',
    el => el.innerText.trim()
  ).catch(() => null);

  // ============================================================
  // 3) METEO PAGE — TODAY + NEXT DAYS
  // ============================================================

  await page.goto('https://www.cervinia.it/en/meteo', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  await page.waitForTimeout(2000);

  let forecast_date = await page.$eval(
    'h3.size-25.demi.bg-title',
    el => el.innerText.trim()
  ).catch(() => null);

  let forecast_regions = await page.$$eval('div._66oia', regions =>
    regions.map(r => {
      const name = r.querySelector('span.demi')?.innerText.trim() || null;
      const icon = r
        .querySelector('use')
        ?.getAttribute('xlink:href')
        ?.replace('#icon-', '') || null;
      return { name, icon };
    })
  ).catch(() => []);

  let forecast_next_days = await page.$$eval('div._4yTBS .grid__col', days =>
    days
      .map(day => {
        const date = day.querySelector('p.demi.size-25')?.innerText.trim() || null;
        if (!date) return null;

        const periods = [...day.querySelectorAll('.s8COa')].map(p => {
          const label = p.querySelector('span.demi')?.innerText.trim() || null;
          const icon = p
            .querySelector('use')
            ?.getAttribute('xlink:href')
            ?.replace('#icon-', '') || null;

          return { label, icon };
        });

        return { date, periods };
      })
      .filter(Boolean)
  ).catch(() => []);

  await browser.close();

  // ============================================================
  // BUILD FINAL RESULT OBJECT
  // ============================================================

  const result = {
    temperature: temperature_global,
    zermatt_link,
    lifts_open_global,
    lifts_total_global,
    slopes_open_global,
    slopes_total_global,

    snow_depth: snow?.snow_depth || null,
    last_snowfall: snow?.last_snowfall || null,

    avalanche_level: avalanche_risk_level,
    avalanche_text: avalanche_risk_text,

    forecast_today: {
      date: forecast_date,
      regions: forecast_regions
    },

    forecast_next_days
  };

  return result;
}

// ============================================================
// SAVE TO SUPABASE
// ============================================================

async function saveToSupabase(data) {
  const { error } = await supabase
    .from('ski_status_history')
    .insert([data]);

  if (error) {
    console.error('Supabase insert error:', error);
  } else {
    console.log('Saved to Supabase successfully.');
  }
}

// ============================================================
// MAIN
// ============================================================

(async () => {
  try {
    const data = await scrape();
    console.log('SCRAPED DATA:', JSON.stringify(data, null, 2));

    await saveToSupabase(data);
  } catch (err) {
    console.error('SCRAPE ERROR:', err);
    process.exit(1);
  }
})();
