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
    headless: 'new',
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

    const validBlocks = localBlocks.filter(b => b.open !== null && b.total !== null);
    console.log('Valid local blocks:', JSON.stringify(validBlocks));
    if (validBlocks.length >= 2) {
      lifts_open_local = parseInt(validBlocks[0].open);
      lifts_total_local = parseInt(validBlocks[0].total);
      slopes_open_local = parseInt(validBlocks[1].open);
      slopes_total_local = parseInt(validBlocks[1].total);
    }
    console.log('Local lifts result:', { lifts_open_local, lifts_total_local, slopes_open_local, slopes_total_local });
  } catch (e) {
    console.log('LOCAL LIFTS ERROR:', e.message);
  }

  // ============================================================
  // 2) SNOW & WEATHER DATA
  // ============================================================
  console.log('Fetching snow/weather data from neve page...');

  let snow_depth = null;
  let last_snowfall = null;
  let avalanche_level = null;
  let avalanche_text = null;
  let wind_speed = null;
  let wind_gust = null;
  let humidity = null;
  let weather_description = null;
  let opening_hours = null;
  let snow_points = [];

  const snowUrls = [
    'https://www.cervinia.it/en/snow',
    'https://www.cervinia.it/en/neve',
    'https://www.cervinia.it/snow',
    'https://www.cervinia.it/en/meteo'
  ];

  let nuxtData = null;

  for (const url of snowUrls) {
    try {
      console.log('Trying URL:', url);
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(1500);

      nuxtData = await page.evaluate(() => {
        const scripts = [...document.querySelectorAll('script:not([src])')];
        for (const s of scripts) {
          if (s.textContent.includes('weatherHeader') || s.textContent.includes('snow_depth') || s.textContent.includes('impiantiOpened')) {
            return s.textContent.slice(0, 5000);
          }
        }
        return null;
      });

      if (nuxtData) {
        console.log('Found __NUXT__ data at:', url);
        break;
      }
    } catch (e) {
      console.log('URL failed:', url, e.message);
    }
  }

  if (nuxtData) {
    try {
      const humidityMatch = nuxtData.match(/humidity:\{current:"(\d+\.?\d*)"/);
      if (humidityMatch) humidity = parseInt(humidityMatch[1]);

      const windMatch = nuxtData.match(/avg_speed_kmh:\{current:"(\d+\.?\d*)"/);
      if (windMatch) wind_speed = parseFloat(windMatch[1]);

      const gustMatch = nuxtData.match(/gust_speed_kmh:\{max:\{value:"(\d+\.?\d*)"/);
      if (gustMatch) wind_gust = parseFloat(gustMatch[1]);

      console.log('Weather from NUXT:', { wind_speed, wind_gust, humidity });
    } catch (e) {
      console.log('NUXT parse error:', e.message);
    }
  }

  console.log('Snow/weather result:', { snow_depth, last_snowfall, wind_speed, wind_gust, humidity });

  // ============================================================
  // 3) METEO PAGE — snow table + weather data
  // ============================================================
  console.log('Fetching meteo page...');

  await page.goto('https://www.cervinia.it/en/meteo', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  await autoScroll(page);
  await sleep(2000);

  // חלץ נתוני NUXT למזג אוויר ומפולות
  try {
    const meteoNuxt = await page.evaluate(() => {
      const scripts = [...document.querySelectorAll('script:not([src])')];
      for (const s of scripts) {
        if (s.textContent.includes('snow') || s.textContent.includes('avalanche') || s.textContent.includes('neve')) {
          return s.textContent.slice(0, 25000);
        }
      }
      return null;
    });

    if (meteoNuxt) {
      console.log('METEO NUXT SAMPLE:', meteoNuxt.slice(4000, 10000));

      const avalanchePatterns = [
        /avalanche[_\s]?level[":]+\s*"?(\d+)"?/i,
        /rischio[_\s]?valanghe[":]+\s*"?(\d+)"?/i,
        /danger[_\s]?level[":]+\s*"?(\d+)"?/i,
      ];
      for (const pat of avalanchePatterns) {
        const m = meteoNuxt.match(pat);
        if (m) { avalanche_level = m[1]; break; }
      }

      const avMatch = meteoNuxt.match(/avalanche risk:(\d+)/i);
      if (avMatch) avalanche_level = avMatch[1];

      const weatherDescMatch = meteoNuxt.match(/weather:"([^"]+)"/);
      if (weatherDescMatch) weather_description = weatherDescMatch[1];

      const hoursMatch = meteoNuxt.match(/opening_hours:"([^"]+)"/);
      if (hoursMatch) opening_hours = hoursMatch[1];
    }
  } catch (e) {
    console.log('Meteo NUXT error:', e.message);
  }

  // ============================================================
  // חילוץ טבלת שלג ישירות מה-DOM — הדרך האמינה!
  // ============================================================
  try {
    const snowTableData = await page.$$eval('table tr', rows =>
      rows.map(r => {
        const cells = [...r.querySelectorAll('td')].map(c => c.innerText.trim());
        return cells;
      }).filter(cells => cells.length >= 2 && /\d+\s*cm/i.test(cells[1]))
    );

    console.log('Snow table rows:', JSON.stringify(snowTableData));

    if (snowTableData.length > 0) {
      const stationMap = {
        'Plateau Rosa':       { station: 'top',  altitude: 3480 },
        'Cime Bianche Laghi': { station: 'cime', altitude: 2814 },
        'Plan Maison':        { station: 'mid',  altitude: 2600 },
        'Breuil':             { station: 'base', altitude: 2050 },
        'Valtournenche':      { station: 'valt', altitude: 1520 },
        'La Salette':         { station: 'salette', altitude: 2289 },
      };

      snow_points = [];
      for (const row of snowTableData) {
        const name = row[0];
        const depthMatch = row[1].match(/(\d+)/);
        const dateCell = row[2] || null;
        if (!depthMatch) continue;
        const depth = parseInt(depthMatch[1]);
        const meta = stationMap[name];
        if (meta) {
          snow_points.push({
            station: meta.station,
            altitude: meta.altitude,
            depth,
            name,
            last_snowfall: dateCell
          });
        }
      }
      console.log('snow_points from table:', JSON.stringify(snow_points));

      // snow_depth הראשי — Plan Maison אם יש, אחרת Plateau Rosa
      const mid = snow_points.find(p => p.station === 'mid');
      const top = snow_points.find(p => p.station === 'top');
      if (mid) snow_depth = mid.depth + ' cm';
      else if (top) snow_depth = top.depth + ' cm';

      // last_snowfall — מ-Plateau Rosa
      if (top && top.last_snowfall) last_snowfall = top.last_snowfall;
    }
  } catch (e) {
    console.log('Snow table extraction error:', e.message);
  }

  // חלץ רמת מפולות מה-DOM אם לא נמצאה ב-NUXT
  if (!avalanche_level) {
    try {
      const avText = await page.$eval(
        '[class*="avalanche"], [class*="valang"], .avalanche-level',
        el => el.innerText.trim()
      ).catch(() => null);

      if (avText) {
        const avNum = avText.match(/(\d)/);
        if (avNum) avalanche_level = avNum[1];
        console.log('Avalanche from DOM:', avText);
      }
    } catch (e) {
      console.log('Avalanche DOM error:', e.message);
    }
  }

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
    wind_speed,
    wind_gust,
    humidity,

    avalanche_level,
    avalanche_text,
    weather_description,
    opening_hours,
    snow_points,

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
  const { error } = await supabase
    .from('ski_status_history')
    .insert([data]);

  if (error) {
    console.error('Supabase insert error:', error);
  } else {
    console.log('Saved to Supabase successfully.');
  }

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
