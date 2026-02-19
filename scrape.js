import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync } from 'fs';

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
      const icon = item.querySelector('use')?.getAttribute('xlink:href')?.replace('#icon-', '') || null;
      return { name, icon };
    });
  }, titleText);
}

async function scrape() {
  const browser = await puppeteerExtra.launch({
    headless: 'new',   // תוקן — חייב להיות new בגיטהאב Actions
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
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
  console.log('Fetching home page...');

  await page.goto('https://www.cervinia.it/en', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  await autoScroll(page);
  await sleep(2000);

  let temperature_global = null;
  let lifts_open_global = null;
  let slopes_open_global = null;

  try {
    await page.waitForSelector('div._4ruBB', { timeout: 10000 });

    const globalBlocks = await page.$$eval('div._4ruBB a', items =>
      items.map(a => {
        const value = a.querySelector('.edagF')?.innerText.trim() || null;
        const label = a.querySelector('.Ognil')?.innerText.trim().toLowerCase() || null;
        return { value, label };
      })
    );

    for (const item of globalBlocks) {
      if (!item.label || !item.value) continue;
      if (item.label === 'weather') temperature_global = parseFloat(item.value.replace('°', ''));
      if (item.label === 'lifts') lifts_open_global = parseInt(item.value);
      if (item.label === 'slopes') slopes_open_global = parseInt(item.value);
    }

    console.log('Global data:', { temperature_global, lifts_open_global, slopes_open_global });
  } catch (e) {
    console.log('GLOBAL DATA NOT FOUND:', e.message);

    // fallback: try to find data with broader selectors
    try {
      const bodyText = await page.evaluate(() => document.body.innerText);
      console.log('Page body snippet:', bodyText.slice(0, 500));
    } catch (_) {}
  }

  const lifts_total_global = 47;
  const slopes_total_global = 109;

  let zermatt_link = await page.$eval(
    'span.U4QfZ',
    el => el.innerText.trim().toUpperCase()
  ).catch(() => null);

  console.log('Zermatt link status:', zermatt_link);

  // LOCAL LIFTS
  let lifts_open_local = null;
  let lifts_total_local = null;
  let slopes_open_local = null;
  let slopes_total_local = null;

  try {
    const localLinks = await page.$$('a[href="/en/impianti"]');
    console.log('Local lifts links found:', localLinks.length);

    const localBlocks = await page.$$eval('a[href="/en/impianti"]', items =>
      items.map(a => ({
        open: a.querySelector('.size-25')?.innerText.trim() || null,
        total: a.querySelector('.size-18')?.innerText.trim() || null,
        html: a.innerHTML.slice(0, 200)
      }))
    );
    console.log('Local blocks:', JSON.stringify(localBlocks));

    if (localBlocks.length >= 2) {
      lifts_open_local = parseInt(localBlocks[0].open);
      lifts_total_local = parseInt(localBlocks[0].total);
      slopes_open_local = parseInt(localBlocks[1].open);
      slopes_total_local = parseInt(localBlocks[1].total);
    }
    console.log('Local lifts result:', { lifts_open_local, lifts_total_local, slopes_open_local, slopes_total_local });
  } catch (e) {
    console.log('LOCAL LIFTS ERROR:', e.message);
  }

  // ============================================================
  // 2) SNOW PAGE
  // ============================================================
  console.log('Fetching snow page...');

  await page.goto('https://www.cervinia.it/en/neve', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  await autoScroll(page);
  await sleep(2000);

  let snow_depth = null;
  let last_snowfall = null;
  let avalanche_level = null;
  let avalanche_text = null;

  // צלם screenshot לדיבאג
  await page.screenshot({ path: 'data/debug_snow.png', fullPage: true });

  // הדפס טקסט מהדף לדיבאג
  const snowPageText = await page.evaluate(() => document.body.innerText);
  console.log('SNOW PAGE TEXT:', snowPageText.slice(0, 2000));

  // בדוק אילו טבלאות קיימות
  const allTables = await page.$$eval('table', tables =>
    tables.map(t => ({ class: t.className, rows: t.querySelectorAll('tr').length }))
  );
  console.log('All tables on snow page:', JSON.stringify(allTables));

  // חפש אלמנטים עם cm
  const cmElements = await page.$$eval('*', els =>
    els.filter(e => e.children.length === 0 && /\d+\s*cm/i.test(e.innerText))
       .slice(0, 10)
       .map(e => ({ tag: e.tagName, class: e.className, text: e.innerText.trim() }))
  );
  console.log('Elements with cm:', JSON.stringify(cmElements));

  // נסה selector מקורי
  try {
    const rows = await page.$$('table.DD2Zg tbody tr');
    console.log('table.DD2Zg rows:', rows.length);
    if (rows.length > 0) {
      const snowRows = await page.$$eval('table.DD2Zg tbody tr', rs =>
        rs.map(r => [...r.querySelectorAll('td')].map(td => td.innerText.trim()))
      );
      snow_depth = snowRows[0]?.[1] || null;
      last_snowfall = snowRows[0]?.[2] || null;
    }
  } catch (e) {
    console.log('SNOW SELECTOR ERROR:', e.message);
  }

  // נסה avalanche
  try {
    avalanche_level = await page.$eval('span.anpIX', el => el.innerText.trim());
  } catch (_) {}
  try {
    avalanche_text = await page.$eval('div.kpCCY span.size-20', el => el.innerText.trim());
  } catch (_) {}

  // הדפס כל span עם מספר בדף (רמזים לסלקטורים חדשים)
  const spans = await page.$$eval('span', els =>
    els.filter(e => /\d/.test(e.innerText) && e.innerText.length < 30)
       .slice(0, 20)
       .map(e => ({ class: e.className, text: e.innerText.trim() }))
  );
  console.log('Spans with numbers:', JSON.stringify(spans));

  console.log('Snow result:', { snow_depth, last_snowfall, avalanche_level, avalanche_text });

  // ============================================================
  // 3) METEO PAGE
  // ============================================================
  console.log('Fetching meteo page...');

  await page.goto('https://www.cervinia.it/en/meteo', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  await autoScroll(page);
  await sleep(2000);

  let forecast_date = await page.$eval(
    'h3.size-25.demi.bg-title',
    el => el.innerText.trim()
  ).catch(() => null);

  const forecast_morning = await extractForecastBlock(page, 'Morning').catch(() => []);
  const forecast_afternoon = await extractForecastBlock(page, 'Pomeriggio e sera').catch(() => []);

  let forecast_next_days = await page.$$eval('div._4yTBS .grid__col', days =>
    days.map(day => {
      const date = day.querySelector('p.demi.size-25')?.innerText.trim() || null;
      if (!date) return null;
      const periods = [...day.querySelectorAll('.s8COa')].map(p => ({
        label: p.querySelector('span.demi')?.innerText.trim() || null,
        icon: p.querySelector('use')?.getAttribute('xlink:href')?.replace('#icon-', '') || null
      }));
      return { date, periods };
    }).filter(Boolean)
  ).catch(() => []);

  await browser.close();
  console.log('Browser closed.');

  // ============================================================
  // BUILD FINAL RESULT
  // ============================================================

  const result = {
    updated_at: new Date().toISOString(),
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

    forecast_next_days
  };

  return result;
}

// ============================================================
// SAVE TO SUPABASE
// ============================================================
async function saveToSupabase(data) {
  // שמור raw HTML בנפרד — לא שדות כבדים ב-JSON
  const { error } = await supabase
    .from('ski_status_history')
    .insert([data]);

  if (error) {
    console.error('Supabase insert error:', error);
  } else {
    console.log('Saved to Supabase successfully.');
  }

  // עדכן גם את הרשומה "הנוכחית"
  const { error: upsertError } = await supabase
    .from('ski_status_current')
    .upsert([{ id: 1, ...data }]);

  if (upsertError) {
    console.warn('ski_status_current upsert (optional):', upsertError.message);
  }
}

// ============================================================
// SAVE TO data/data.json (for GitHub Pages)
// ============================================================
function saveToJson(data) {
  try {
    mkdirSync('data', { recursive: true });
    writeFileSync('data/data.json', JSON.stringify(data, null, 2), 'utf-8');
    console.log('data/data.json written successfully.');
  } catch (e) {
    console.error('Failed to write data.json:', e.message);
  }
}

// ============================================================
// MAIN
// ============================================================
const data = await scrape();
console.log('SCRAPED DATA:', JSON.stringify(data, null, 2));
saveToJson(data);
await saveToSupabase(data);
