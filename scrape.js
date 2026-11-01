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

  // The totals are read further down, from the lifts-and-slopes page, where
  // the operator prints them himself ("SKI LIFTS 10 di 15", "SLOPES 0 di 9").
  // They used to be the constants 47 and 109 - the whole-season totals - and
  // that is not what cervinia.it shows: in October it turned "no slope open"
  // into "0/109" instead of the operator's "0/9".
  let lifts_total_global = null;
  let slopes_total_global = null;

  let zermatt_link = await page.$eval(
    'span.U4QfZ',
    el => el.innerText.trim().toUpperCase()
  ).catch(() => null);

  console.log('Zermatt link status:', zermatt_link);

  // ------------------------------------------------------------
  // LOCAL LIFTS AND SLOPES - the live panel on the home page
  // ------------------------------------------------------------
  // The panel has one tab per village and opens on Breuil-Cervinia. It is
  // read by the labels "Open ski lifts" and "Open slopes" rather than by the
  // generated class names, which change whenever the site is rebuilt, and the
  // open tab is checked: publishing Valtournenche's figures as Cervinia's
  // would be worse than publishing none.
  let lifts_open_local = null;
  let lifts_total_local = null;
  let slopes_open_local = null;
  let slopes_total_local = null;

  try {
    const local = await page.evaluate(() => {
      // textContent, not innerText: innerText depends on layout, and in a
      // headless browser the panel can lay out differently or not at all -
      // which is how the Cervinia figures silently became null.
      const txt = (el) => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();

      // the selected village is the one drawn in black, the others grey
      const tab = [...document.querySelectorAll('*')].find(el =>
        !el.children.length &&
        /^(BREUIL CERVINIA|VALTOURNENCHE|CHAMOIS|TORGNON|ZERMATT)$/.test(txt(el).toUpperCase()) &&
        / black /.test(' ' + ((el.parentElement && el.parentElement.className) || '') + ' ')
      );

      // 1) the generated class names, which is what the page actually uses
      const byClass = [...document.querySelectorAll('a[href="/en/impianti"]')]
        .map(a => [a.querySelector('.size-25'), a.querySelector('.size-18')])
        .filter(([o, t]) => o && t)
        .map(([o, t]) => [parseInt(txt(o), 10), parseInt(txt(t), 10)])
        .filter(([o, t]) => !isNaN(o) && !isNaN(t));

      // 2) the labels, for the day those class names change
      const byLabel = (label) => {
        const el = [...document.querySelectorAll('div')].find(d => {
          const t = txt(d).toLowerCase();
          return t.indexOf(label) === 0 && /\d+ \d+$/.test(t);
        });
        const m = el && txt(el).match(/(\d+) (\d+)$/);
        return m ? [Number(m[1]), Number(m[2])] : null;
      };

      const lifts  = byClass[0] || byLabel('open ski lifts');
      const slopes = byClass[1] || byLabel('open slopes');
      return {
        active: tab ? txt(tab).toUpperCase() : null,
        via: byClass.length >= 2 ? 'class' : 'label',
        lifts, slopes
      };
    });

    console.log('Local panel:', JSON.stringify(local));

    if (local.active && local.active.indexOf('CERVINIA') === -1) {
      console.log('LOCAL PANEL IS SHOWING', local.active, '- not publishing it as Cervinia');
    } else {
      if (local.lifts)  { lifts_open_local  = local.lifts[0];  lifts_total_local  = local.lifts[1]; }
      if (local.slopes) { slopes_open_local = local.slopes[0]; slopes_total_local = local.slopes[1]; }
    }
    console.log('Local lifts result:', { lifts_open_local, lifts_total_local, slopes_open_local, slopes_total_local });
  } catch (e) {
    console.log('LOCAL LIFTS ERROR:', e.message);
  }

  // ============================================================
  // 1b) LIFTS AND SLOPES PAGE - the totals, as the operator counts them
  // ============================================================
  // The page prints "SKI LIFTS 10 di 15" and "SLOPES 0 di 9": how many are
  // open out of how many are in service this period - not out of the whole
  // season's inventory. Both numbers are taken from here so the bar can never
  // disagree with the page it is quoting.
  console.log('Fetching lifts and slopes page...');

  try {
    await page.goto('https://www.cervinia.it/en/impianti', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await autoScroll(page);
    await sleep(2000);

    const pairs = await page.evaluate(() => {
      const txt = (d) => (d.innerText || '').replace(/\s+/g, ' ').trim();
      const hits = [...document.querySelectorAll('div')].filter(d => /^\d+ di \d+$/.test(txt(d)));
      // keep the innermost match only, so a wrapper is not counted twice
      return hits
        .filter(d => !hits.some(o => o !== d && d.contains(o)))
        .map(d => txt(d).split(' di ').map(Number));
    });

    console.log('Area totals found:', JSON.stringify(pairs));

    // the page prints lifts first, then slopes
    if (pairs.length >= 2) {
      lifts_open_global   = pairs[0][0];
      lifts_total_global  = pairs[0][1];
      slopes_open_global  = pairs[1][0];
      slopes_total_global = pairs[1][1];
    }
  } catch (e) {
    console.log('AREA TOTALS NOT FOUND:', e.message);
  }

  // A denominator is better than none, so the season totals stay as the last
  // resort - but the log says so, because they are the figures that were wrong.
  if (lifts_total_global == null)  { lifts_total_global  = 47;  console.log('Falling back to the season total for lifts (47)'); }
  if (slopes_total_global == null) { slopes_total_global = 109; console.log('Falling back to the season total for slopes (109)'); }

  // Nothing downstream can make sense of "9 open out of 5", so a pair that
  // contradicts itself is dropped rather than published.
  const sane = (open, total) => !(open != null && total != null && open > total);
  if (!sane(lifts_open_global, lifts_total_global)) {
    console.log('DROPPING area lifts:', lifts_open_global, '>', lifts_total_global);
    lifts_open_global = lifts_total_global = null;
  }
  if (!sane(slopes_open_global, slopes_total_global)) {
    console.log('DROPPING area slopes:', slopes_open_global, '>', slopes_total_global);
    slopes_open_global = slopes_total_global = null;
  }
  if (!sane(lifts_open_local, lifts_total_local)) {
    console.log('DROPPING local lifts:', lifts_open_local, '>', lifts_total_local);
    lifts_open_local = lifts_total_local = null;
  }
  if (!sane(slopes_open_local, slopes_total_local)) {
    console.log('DROPPING local slopes:', slopes_open_local, '>', slopes_total_local);
    slopes_open_local = slopes_total_local = null;
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
// AUTOMATIC ALERTS
//
// The scraper runs every half hour and is the only thing on this project
// that sees the mountain twice. That is all an alert needs: not a reading,
// but a reading next to the one before it. "Gust 78" is weather; "gust was
// 40 and is now 78" is news.
//
// Three rules the whole block obeys:
//
//   1. Transitions only. Every check compares the previous row against the
//      new one, so a condition that persists is reported once, not every
//      thirty minutes. cl_auto_alert's cooldown is the net under that, for
//      the runs where the previous row is missing.
//   2. No baseline, no alerts. If the previous reading cannot be read, this
//      block does nothing at all rather than treat every value as a change.
//   3. Daylight for anything about lifts. The feed reports zero open after
//      closing time, every single evening. Pushing that would teach people
//      to ignore us by the end of the first week.
//
// Set CL_AUTO_ALERTS=off to silence the whole block without touching code.
// ============================================================

// Minutes since midnight in Europe/Rome - the mountain's own clock, not the
// runner's UTC and not the reader's.
function romeMinutes(d = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Rome',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(d);
    const h = +parts.find(p => p.type === 'hour').value;
    const m = +parts.find(p => p.type === 'minute').value;
    return h * 60 + m;
  } catch {
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
}

// Lifts are reported closed all evening and all night, and so is the
// crossing to Zermatt - it is a cable-car link, and it shuts when the lifts
// shut. Only inside the skiing day does "closed" mean something went wrong.
//
// The window is not guessed: the feed carries the operator's own hours in
// opening_hours ("08:00 - 16:45"), so the mountain says when its day is,
// and these are the fallbacks for the runs where that field is missing.
const LIFT_WINDOW = [9 * 60, 15 * 60 + 30];   // 09:00 - 15:30 Rome
const WIND_WINDOW = [6 * 60, 18 * 60];        // 06:00 - 18:00 Rome

function inWindow([from, to], now = romeMinutes()) {
  return now >= from && now <= to;
}

// "08:00 - 16:45" -> [480, 1005]. Anything else -> null.
function parseOpeningHours(d) {
  const m = String((d && d.opening_hours) || '')
    .match(/(\d{1,2}):(\d{2})\s*[-\u2013\u2014]\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const from = (+m[1]) * 60 + (+m[2]);
  const to   = (+m[3]) * 60 + (+m[4]);
  if (!(to > from) || to > 24 * 60) return null;
  return [from, to];
}

// The operating day, trimmed at both ends. The trims are the point:
//
//   padStart - the lifts do not all start at once, so "not everything is
//              running yet" at 08:10 is a morning, not a fault.
//   padEnd   - everything shuts at the end of the day, every day. Without
//              this trim the scraper would report the timetable as an
//              emergency once every evening, and people would mute it
//              inside a week.
//
// Zermatt needs a longer tail than the lifts: the last ascent back to Italy
// is around 14:50, so the crossing is already shutting while the pistes are
// still running.
function skiDayWindow(next, padStart, padEnd, fallback) {
  const hours = parseOpeningHours(next);
  if (!hours) return fallback;
  const from = hours[0] + padStart;
  const to   = hours[1] - padEnd;
  return (to > from) ? [from, to] : fallback;
}

// Numbers arrive as numbers, as "45", as "45 cm" or as null, depending on
// which part of the feed they came from.
function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const m = String(v).match(/-?\d+(?:[.,]\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(',', '.'));
  return isFinite(n) ? n : null;
}

function upper(v) {
  return String(v ?? '').trim().toUpperCase();
}

// The resort this site is about, falling back to the whole Matterhorn area
// when the village panel could not be read.
function liftsOpen(d) {
  const local = num(d?.lifts_open_local);
  return local !== null ? local : num(d?.lifts_open_global);
}
function liftsTotal(d) {
  const local = num(d?.lifts_total_local);
  return local !== null ? local : num(d?.lifts_total_global);
}

// ------------------------------------------------------------
// The rules
//
// Each returns an alert or nothing. Severity decides the push: 'warning' and
// 'danger' reach phones, 'info' only reaches the strip - so good news is
// shown without waking anybody.
// ------------------------------------------------------------
// nowMin is injectable so the rules can be tested at a chosen hour instead
// of only at whatever hour the test happens to run.
function detectAutoAlerts(prev, next, nowMin = romeMinutes()) {
  if (!prev || !next) return [];
  const out = [];

  const liftWin = skiDayWindow(next, 60, 90, LIFT_WINDOW);

  // The crossing gets a window of its own, and a wider one than the lifts.
  // The first version trimmed two hours off the front, on the reasoning that
  // the last ascent back to Italy is about 14:50 - which quietly assumed
  // everybody comes back the same day. They do not: you can ski across and
  // stay, and there are lockers at the lower station in Zermatt. So the
  // afternoon stays in. Only the final hour is trimmed, because at 16:45
  // everything shuts and that is the timetable, not news.
  const zermWin = skiDayWindow(next, 0, 60, LIFT_WINDOW);

  // Two moments inside that window behave differently from the rest:
  //
  //   zMorning - by an hour after the lifts start, a crossing that is still
  //              shut is a fact about today, not a mountain waking up.
  //   zOpenFrom- the crossing opens WITH the lifts every morning, so a
  //              CLOSED->OPEN before this is the timetable. After it, the
  //              same transition means it opened after having been shut,
  //              which is the news somebody who gave up at nine wants.
  const zMorning  = zermWin[0] + 60;
  const zOpenFrom = Math.max(zermWin[0] + 90, 9 * 60 + 30);

  // --- the crossing to Zermatt ------------------------------------------
  //
  // This is a cable-car link, not a border post: it closes every single
  // evening with the lifts, and opens every morning with them. Reporting
  // either as news would mean a push every day at dusk - the same mistake
  // the lift rules were already guarded against, and one this rule made
  // until a reader asked why a closure at six in the evening would alert.
  const zPrev = upper(prev.zermatt_link);
  const zNext = upper(next.zermatt_link);
  if (!inWindow(zermWin, nowMin)) {
    // outside the crossing's operating hours, both directions are the
    // timetable doing what a timetable does
  } else if (zPrev === 'OPEN' && zNext === 'CLOSED') {
    // it was running and it stopped - wind, or a fault
    out.push({
      key: 'zermatt-closed',
      severity: 'danger',
      hours: 8,
      cooldown: 10,
      text: 'המעבר לצ׳רמט נסגר. מי שתכנן לחצות היום — בדקו לפני שאתם עולים.'
    });
  } else if (zPrev === 'CLOSED' && zNext === 'CLOSED'
             && nowMin >= zMorning && (liftsOpen(next) || 0) > 0) {
    // Still shut an hour into a day on which the mountain is running. This
    // is a STATE, not a transition, which is the point: on a day the
    // crossing never opens at all there is no transition to catch, and
    // somebody planning to cross finds out by going up. The cooldown keeps
    // it to once a day.
    out.push({
      key: 'zermatt-shut-today',
      severity: 'warning',
      hours: 7,
      cooldown: 14,
      text: 'המעבר לצ׳רמט סגור היום, בזמן שהמעליות בצ׳רוויניה פועלות.'
    });
  } else if (zPrev === 'CLOSED' && zNext === 'OPEN' && nowMin >= zOpenFrom) {
    // Opened after having been shut - worth telling the person who gave up
    // at nine. Before zOpenFrom this is just the morning timetable.
    out.push({
      key: 'zermatt-open',
      severity: 'info',          // good news: the strip, not the phone
      hours: 5,
      cooldown: 8,
      text: 'המעבר לצ׳רמט נפתח. אפשר לחצות.'
    });
  }

  // --- lifts, inside the skiing day only --------------------------------
  if (inWindow(liftWin, nowMin)) {
    const oPrev = liftsOpen(prev);
    const oNext = liftsOpen(next);
    const tNext = liftsTotal(next);

    // "Was running, is not." Three is the floor on purpose: it means the day
    // had actually started, so this is a stoppage and not a slow morning.
    if (oPrev !== null && oNext !== null && oPrev >= 3 && oNext === 0) {
      out.push({
        key: 'lifts-all-closed',
        severity: 'danger',
        hours: 5,
        cooldown: 8,
        text: 'כל המעליות בצ׳רוויניה סגורות כרגע. בדקו את המצב לפני שאתם יוצאים.'
      });
    } else if (
      oPrev !== null && oNext !== null && tNext &&
      oPrev >= 5 && oNext > 0 && oNext <= Math.floor(oPrev * 0.4)
    ) {
      out.push({
        key: 'lifts-mostly-closed',
        severity: 'warning',
        hours: 4,
        cooldown: 8,
        text: 'רוב המעליות בצ׳רוויניה נסגרו — ' + oNext + ' פתוחות מתוך ' + tNext + '.'
      });
    }
  }

  // --- wind ---------------------------------------------------------------
  if (inWindow(WIND_WINDOW, nowMin)) {
    const gPrev = num(prev.wind_gust);
    const gNext = num(next.wind_gust);
    if (gPrev !== null && gNext !== null) {
      if (gPrev < 100 && gNext >= 100) {
        out.push({
          key: 'wind-severe',
          severity: 'danger',
          hours: 6,
          cooldown: 10,
          text: 'רוח עזה בהר — משבים עד ' + Math.round(gNext) +
                ' קמ״ש. צפו לסגירות נרחבות של מעליות.'
        });
      } else if (gPrev < 70 && gNext >= 70) {
        out.push({
          key: 'wind-strong',
          severity: 'warning',
          hours: 5,
          cooldown: 10,
          text: 'רוח חזקה בהר — משבים עד ' + Math.round(gNext) +
                ' קמ״ש. ייתכנו סגירות של מעליות גבוהות.'
        });
      }
    }
  }

  // --- avalanche danger ---------------------------------------------------
  const aPrev = num(prev.avalanche_level);
  const aNext = num(next.avalanche_level);
  if (aNext !== null && aNext >= 4 && (aPrev === null || aPrev < 4)) {
    out.push({
      key: 'avalanche-high',
      severity: 'danger',
      hours: 18,
      cooldown: 20,
      text: 'דרגת סכנת מפולות ' + aNext +
            ' באיזור. אל תצאו מהפיסטות המסומנות.'
    });
  }

  // --- fresh snow ---------------------------------------------------------
  // The one piece of good news worth a line on the strip. No push: nobody
  // needs their phone to buzz about powder at four in the morning.
  const sPrev = num(prev.snow_depth);
  const sNext = num(next.snow_depth);
  if (sPrev !== null && sNext !== null && sNext - sPrev >= 20) {
    out.push({
      key: 'fresh-snow',
      severity: 'info',
      hours: 14,
      cooldown: 20,
      text: 'ירד שלג טרי — ' + Math.round(sNext - sPrev) +
            ' ס״מ נוספו, ועומק השלג כעת ' + Math.round(sNext) + ' ס״מ.'
    });
  }

  return out;
}

// ------------------------------------------------------------
//  Reading the baseline
//
//  This read decides everything: with no previous reading the whole alert
//  block stays silent, by design. So it must come from the table that is
//  actually filled.
//
//  It used to read ski_status_current, and that was wrong for a reason
//  written three lines above the upsert that fills it: that upsert is
//  treated as OPTIONAL - saveToSupabase only warns when it fails. A table
//  the writer is allowed to give up on is the last place to look for the
//  one fact the alerts depend on, and the first real transition proved it:
//  Zermatt went CLOSED -> OPEN, ski_status_history recorded both readings,
//  and no alert was raised because the baseline came back empty.
//
//  ski_status_history gets a plain insert on every run and is checked for
//  errors. Its newest row IS the previous reading, because this runs before
//  saveToSupabase writes the new one.
// ------------------------------------------------------------
function _describeReading(r) {
  if (!r) return 'none';
  return (r.updated_at || '?')
       + ' (zermatt=' + (r.zermatt_link || '?')
       + ', lifts=' + (r.lifts_open_local != null ? r.lifts_open_local : '?')
       + ', gust=' + (r.wind_gust != null ? r.wind_gust : '?') + ')';
}

async function readPreviousReading() {
  // 1. the table every run inserts into
  try {
    const { data, error } = await supabase
      .from('ski_status_history')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(1);
    if (error) {
      console.warn('History baseline unavailable:', error.message);
    } else if (data && data.length) {
      console.log('Baseline from ski_status_history: ' + _describeReading(data[0]));
      return data[0];
    } else {
      console.log('ski_status_history is empty.');
    }
  } catch (e) {
    console.warn('History baseline failed:', e.message);
  }

  // 2. the single-row table, if it happens to be there
  try {
    const { data, error } = await supabase
      .from('ski_status_current')
      .select('*')
      .eq('id', 1)
      .maybeSingle();
    if (error) {
      console.warn('Current-row baseline unavailable:', error.message);
    } else if (data) {
      console.log('Baseline from ski_status_current: ' + _describeReading(data));
      return data;
    }
  } catch (e) {
    console.warn('Current-row baseline failed:', e.message);
  }

  // Said out loud, because this is the state in which the alert block does
  // nothing at all and the log should never leave that to be guessed at.
  console.log('No previous reading - auto alerts stay quiet this run.');
  return null;
}

// ------------------------------------------------------------
// Raising them
//
// cl_auto_alert returns the new id, or null when the key is still within its
// cooldown. Both are success; only a thrown error is a problem, and even that
// is logged rather than allowed to fail the run - the data is already saved
// by this point and a missed alert is better than a missed update.
// ------------------------------------------------------------
async function raiseAutoAlerts(prev, next) {
  if (String(process.env.CL_AUTO_ALERTS || '').toLowerCase() === 'off') {
    console.log('Auto alerts: disabled by CL_AUTO_ALERTS=off.');
    return;
  }

  let found;
  try {
    found = detectAutoAlerts(prev, next);
  } catch (e) {
    console.error('Auto alert detection failed:', e.message);
    return;
  }

  if (!found.length) {
    console.log('Auto alerts: nothing changed.');
    return;
  }

  for (const a of found) {
    try {
      const { data, error } = await supabase.rpc('cl_auto_alert', {
        p_key:      a.key,
        p_text:     a.text,
        p_severity: a.severity,
        p_hours:    a.hours,
        p_cooldown: a.cooldown
      });
      if (error) {
        console.error('Auto alert "' + a.key + '" rejected:', error.message);
      } else if (data) {
        console.log('Auto alert raised [' + a.severity + '] ' + a.key + ' -> ' + data);
      } else {
        console.log('Auto alert "' + a.key + '" still in cooldown - not sent.');
      }
    } catch (e) {
      console.error('Auto alert "' + a.key + '" failed:', e.message);
    }
  }
}

// ============================================================
// MAIN
//
// The order matters in one place: the previous reading is fetched first,
// because saveToSupabase overwrites it.
// ============================================================
const previous = await readPreviousReading();

const data = await scrape();
console.log('SCRAPED DATA:', JSON.stringify(data, null, 2));

saveToJson(data);
await saveToSupabase(data);
await raiseAutoAlerts(previous, data);
