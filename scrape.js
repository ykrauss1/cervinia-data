import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createClient } from '@supabase/supabase-js';

puppeteerExtra.use(StealthPlugin());

// ----------- SUPABASE CONFIG -----------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let totalHeight = 0;
      const distance = 400;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight - 1000) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  });
}

async function extractForecastBlock(page, titleText) {
  return await page.$$eval('div.HHL8B', (blocks, titleText) => {
    const block = blocks.find(b =>
      b.querySelector('p')?.innerText.trim().toLowerCase() === titleText.toLowerCase()
    );
    if (!block) return [];

    const items = [...block.querySelectorAll('div._66oia')];

    return items.map(item => {
      const name = item.querySelector('span.demi')?.innerText.trim() || null;
      const icon = item
        .querySelector('use')
        ?.getAttribute('xlink:href')
        ?.replace('#icon-', '') || null;
      return { name, icon };
    });
  }, titleText);
}

async function scrape() {
  const browser = await puppeteerExtra.launch({
    headless: false, // חשוב! stealth עובד טוב יותר ככה
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36"
  );

  // ============================================================
  // 1) HOME PAGE
  // ============================================================

  await page.goto('https://www.cervinia.it/en', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  await autoScroll(page);
  await sleep(1500);

  const raw_home_html = await page.content();

  let temperature_global = null;
  let lifts_open_global = null;
  let slopes_open_global = null;

  try {
    await page.waitForSelector('div._4ruBB', { timeout: 8000 });

    const globalBlocks = await page.$$eval('div._4ruBB a', items =>
      items.map(a => {
        const value = a.querySelector('.edagF')?.innerText.trim() || null;
        const label = a.querySelector('.Ognil')?.innerText.trim().toLowerCase() || null;
        return { value, label };
      })
    );

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
  } catch (e) {
    console.log("GLOBAL DATA NOT FOUND");
  }

  const lifts_total_global = 47;
  const slopes_total_global = 109;

  let zermatt_link = await page.$eval(
    'span.U4QfZ',
    el => el.innerText.trim().toUpperCase()
  ).catch(() => null);

  // LOCAL LIFTS
  let lifts_open_local = null;
  let lifts_total_local = null;
  let slopes_open_local = null;
  let slopes_total_local = null;

  try {
    const localBlocks = await page.$$eval('a[href="/en/impianti"]', items =>
      items.map(a => {
        const open = a.querySelector('.size-25')?.innerText.trim() || null;
        const total = a.querySelector('.size-18')?.innerText.trim() || null;
        return { open, total };
      })
    );

    if (localBlocks.length >= 2) {
      lifts_open_local = parseInt(localBlocks[0].open);
      lifts_total_local = parseInt(localBlocks[0].total);

      slopes_open_local = parseInt(localBlocks[1].open);
      slopes_total_local = parseInt(localBlocks[1].total);
    }
  } catch (e) {
    console.log("LOCAL LIFTS NOT FOUND");
  }

  // ============================================================
  // 2) SNOW PAGE
  // ============================================================

  await page.goto('https://www.cervinia.it/en/neve', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  await autoScroll(page);
  await sleep(1500);

  const raw_snow_html = await page.content();

  let snow_depth = null;
  let last_snowfall = null;

  try {
    await page.waitForSelector('table.DD2Zg tbody tr', { timeout: 8000 });

    const snowRows = await page.$$eval('table.DD2Zg tbody tr', rows =>
      rows.map(r => {
        const cells = [...r.querySelectorAll('td')].map(td => td.innerText.trim());
        return {
          location: cells[0],
          snow: cells[1],
          last: cells[2]
        };
      })
    );

    if (snowRows.length > 0) {
      snow_depth = snowRows[0].snow;
      last_snowfall = snowRows[0].last;
    }
  } catch (e) {
    console.log("SNOW TABLE NOT FOUND");
  }

  let avalanche_level = null;
  let avalanche_text = null;

  try {
    avalanche_level = await page.$eval('span.anpIX', el => el.innerText.trim());
    avalanche_text = await page.$eval('div.kpCCY span.size-20', el => el.innerText.trim());
  } catch (e) {
    console.log("AVALANCHE NOT FOUND");
  }

  const raw_avalanche_html = raw_snow_html;

  // ============================================================
  // 3) METEO PAGE
  // ============================================================

  await page.goto('https://www.cervinia.it/en/meteo', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  await autoScroll(page);
  await sleep(1500);

  const raw_meteo_html = await page.content();

  let forecast_date = await page.$eval(
    'h3.size-25.demi.bg-title',
    el => el.innerText.trim()
  ).catch(() => null);

  const forecast_morning = await extractForecastBlock(page, 'Morning').catch(() => []);
  const forecast_afternoon = await extractForecastBlock(page, 'Pomeriggio e sera').catch(() => []);

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
  // BUILD FINAL RESULT
  // ============================================================

  const result = {
    temperature: temperature_global,
    zermatt_link,

    lifts_open_global,
    lifts_total_global,
    slopes_open_global,
    slopes_total_global,

    lifts_open_local,
    lifts_total_local,
    slopes_open_local,
    slopes_total_local,

    snow_depth,
    last_snowfall,

    avalanche_level,
    avalanche_text,

    forecast_today: {
      date: forecast_date,
      morning: forecast_morning,
      afternoon: forecast_afternoon
    },

    forecast_next_days,

    raw_home_html,
    raw_snow_html,
    raw_avalanche_html,
    raw_meteo_html
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

const data = await scrape();
console.log('SCRAPED DATA:', JSON.stringify(data, null, 2));
await saveToSupabase(data);
