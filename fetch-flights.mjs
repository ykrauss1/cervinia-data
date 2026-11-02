#!/usr/bin/env node
/* =====================================================================
 *  CerviniaLive — the daily flight snapshot
 *
 *  Why a snapshot and not a live search. A full pricing call against the
 *  provider takes about nine seconds and is metered per call. A visitor
 *  who waits nine seconds for a popup closes the popup, and a hundred
 *  visitors a day would spend the quota on people who never book. So the
 *  prices are fetched once a day, here, and the page reads a file.
 *
 *  The price calendar is the cheap primitive: one call returns a whole
 *  month of departure dates for a given trip length, in well under a
 *  second. It is also the limited one - it returns a date and a price and
 *  nothing else, no airline. So this runs in two passes:
 *
 *    pass 1  the calendar, across destination x nights x month. This is
 *            what the page searches when a reader picks dates, and it is
 *            instant because it is a lookup in a file already loaded.
 *    pass 2  a handful of real pricing calls, aimed at the dates pass 1
 *            said were worth it. These are the nine-second calls, and
 *            they are the only place an airline name can come from.
 *
 *  Calls the same Supabase edge function trip-finder uses. It takes no
 *  key - trip-finder's own browser code posts to it unauthenticated - so
 *  there is no secret here to leak.
 *
 *  Writes data/flights.json. Never edit that file by hand; this owns it.
 * ===================================================================== */

import fs from 'node:fs';
import path from 'node:path';

const EDGE = 'https://cdgqodtbdhsqkvcgcdlm.functions.supabase.co/Flights-gflights';
const OUT  = path.join('data', 'flights.json');

const ORIGIN = 'TLV';

// The three airports the site already offers, with the drive as the page
// states it elsewhere. Geneva is deliberately absent: it adds a border and
// the Mont Blanc toll, which is a different kind of trip.
// Milan Malpensa only. The first live run answered the question: Bergamo
// returned a priced day in NO month at all (Ryanair is not flying TLV-BGY
// this season), and Turin returned December and then one stray day in
// February. Sixty of the eighty-four calls bought nothing. The two are
// kept here, commented out, because a Ryanair season would bring Bergamo
// straight back.
const DESTS = [
  { code: 'MXP', he: 'מילאנו מלפנסה',  km: 175 }
  // { code: 'BGY', he: 'מילאנו ברגמו', km: 200 },   // no inventory 2026/27
  // { code: 'TRN', he: 'טורינו',        km: 100 }    // December only
];

// The lengths people actually ask for, which is the question Yossi raised:
// a long weekend (3), Sunday-to-Thursday (4), Sunday-to-Friday (5), and a
// full week (6-7). Each length is a separate call - the calendar is keyed on
// it - but with one airport that is 25 calls, not 84.
const NIGHTS = [3, 4, 5, 6, 7];

// Which of those lengths belongs to which kind of trip. The headline offers
// are built one per band, because "the cheapest flight of the winter" is a
// useless number to somebody who can only get away from Thursday to Sunday.
const BANDS = [
  { key: 'weekend', he: 'סוף שבוע',    nights: [3] },
  { key: 'midweek', he: 'אמצע שבוע',   nights: [4, 5] },
  { key: 'week',    he: 'שבוע מלא',    nights: [6, 7] }
];

// Cervinia's season. Months outside it are not fetched at all - an August
// price for a ski trip is a number nobody wants.
const SEASON_MONTHS = [11, 0, 1, 2, 3];   // Dec, Jan, Feb, Mar, Apr (0-based)

// ONE passenger, and the whole file depends on it. The price-calendar call
// takes no `adults` parameter at all, so it answers for a single traveller;
// the pricing call was asking for two. The first snapshot put 126 and 252
// side by side for the same flight on the same date - exactly 2.00x - and
// the page labelled the 126 "for two travellers", which is the opposite of
// true. Per person is also how flight engines display, so the reader needs
// no conversion in their head, only a multiplication.
const ADULTS = 1;

// Marketing names as the provider writes them. Matched case-insensitively
// on a substring, which is how trip-finder matches them too.
const ISRAELI = ['el al', 'israir', 'arkia', 'air haifa', 'sundor', "sun d'or"];

const SLEEP_BETWEEN = 250;          // gentle on the provider's rate limit
const CAL_TIMEOUT   = 20000;
const PRICE_TIMEOUT = 60000;
const PRICE_CALLS   = 3;            // one per band, and they are the slow ones
const CAL_RETRY     = 1;            // one more go at a call that fell over

const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function post(body, timeout) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(EDGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal
    });
    if (!r.ok) return { _httpError: r.status };
    return await r.json();
  } catch (e) {
    return { _error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(t);
  }
}

/* ---------------------------------------------------------------------
 *  Which months to ask for
 *
 *  Computed from today rather than written down, so the file does not go
 *  stale the moment a season ends. Starts tomorrow (the provider returns
 *  nothing for today) and runs to the end of the last season month that
 *  is still ahead of us, capped at fourteen months out.
 * ------------------------------------------------------------------- */
function seasonWindows(today = new Date()) {
  const out = [];
  const start = new Date(today); start.setDate(start.getDate() + 1);
  let started = false;
  for (let i = 0; i < 15; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
    const inSeason = SEASON_MONTHS.includes(d.getMonth());
    // Skip forward to the first ski month, then take the months that follow
    // it and STOP at the first one outside the season. December to April are
    // consecutive, so this is exactly one season. The earlier version kept
    // scanning and asked for December 2027 and January 2028 as well - twelve
    // calls that came back empty every time, because the provider has no
    // inventory that far out.
    if (!inSeason) { if (started) break; else continue; }
    started = true;
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const last  = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const from  = first < start ? start : first;
    if (from > last) continue;
    out.push({ from: iso(from), to: iso(last),
               label: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` });
  }
  return out;
}
// Local date parts, NOT toISOString: these Dates are built from local
// calendar numbers, and converting them to UTC on a machine east of
// Greenwich moves every window back a day - the test caught a January
// window that began on the 20th and ended on the 30th.
const iso = d => d.getFullYear() + '-' +
  String(d.getMonth() + 1).padStart(2, '0') + '-' +
  String(d.getDate()).padStart(2, '0');

/* ---------------------------------------------------------------------
 *  Pass 1 — the calendar
 * ------------------------------------------------------------------- */
async function fetchCalendars(windows) {
  const cal = {};           // cal[dest][nights][date] = price
  const rets = {};          // rets[dest][nights][date] = returnDate
  let first = true, calls = 0, got = 0;

  for (const d of DESTS) {
    cal[d.code] = {}; rets[d.code] = {};
    for (const n of NIGHTS) {
      cal[d.code][n] = {}; rets[d.code][n] = {};
      for (const w of windows) {
        calls++;
        // A transient failure costs a whole month of a whole trip length,
        // and the first run lost eight of them that way - March and April at
        // five nights, January at seven - months that certainly have flights.
        // "no data" after a retry is far likelier to be real.
        let j = null;
        for (let attempt = 0; attempt <= CAL_RETRY; attempt++) {
          j = await post({ priceCalendar: true, origin: ORIGIN,
                           destination: d.code, from: w.from, to: w.to,
                           nights: n }, CAL_TIMEOUT);
          const broke = !j || j._error || j._httpError;
          if (!broke) break;
          if (attempt < CAL_RETRY) { calls++; await sleep(900); }
        }

        // The first answer is printed whole. This job cannot be tested from
        // a development container - the network there does not reach
        // Supabase - so the Actions log is where its shape is first seen.
        if (first) {
          first = false;
          log('--- first calendar response, verbatim ---');
          log(JSON.stringify(j).slice(0, 1200));
          log('--- end ---');
        }

        if (!j || j._error || j._httpError || !j.ok || !Array.isArray(j.days)) {
          log(`  ${d.code} ${n}n ${w.label}: no data` +
              (j && (j._error || j._httpError) ? ` (${j._error || 'HTTP ' + j._httpError})` : ''));
          await sleep(SLEEP_BETWEEN);
          continue;
        }
        let kept = 0;
        for (const day of j.days) {
          if (!day || !day.date || day.price == null) continue;
          const p = Math.round(Number(day.price));
          if (!isFinite(p) || p <= 0) continue;
          cal[d.code][n][day.date] = p;
          if (day.ret) rets[d.code][n][day.date] = day.ret;
          kept++; got++;
        }
        log(`  ${d.code} ${n}n ${w.label}: ${kept} days`);
        await sleep(SLEEP_BETWEEN);
      }
    }
  }
  log(`calendar: ${calls} calls, ${got} priced days`);
  return { cal, rets };
}

/* ---------------------------------------------------------------------
 *  Pass 2 — real prices, for the airline names
 *
 *  The calendar says which dates are cheap but not who flies them. These
 *  are the expensive calls, so they are aimed: the cheapest date overall,
 *  the cheapest at each other airport, and nothing else.
 * ------------------------------------------------------------------- */
function pickDatesToPrice({ cal, rets }) {
  // One candidate per BAND. "The cheapest flight of the winter" is a useless
  // figure to somebody who can only get away Thursday to Sunday, so each
  // kind of trip gets its own cheapest date and its own pricing call.
  const best = {};
  for (const b of BANDS) {
    for (const d of DESTS) {
      for (const n of b.nights) {
        for (const [date, price] of Object.entries(cal[d.code]?.[n] || {})) {
          if (!best[b.key] || price < best[b.key].price) {
            best[b.key] = { band: b.key, bandHe: b.he, dest: d.code, nights: n,
                            date, price,
                            ret: rets[d.code][n][date] || addDays(date, n) };
          }
        }
      }
    }
  }
  return BANDS.map(b => best[b.key]).filter(Boolean).slice(0, PRICE_CALLS);
}
function addDays(isoDate, n) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function resolveIds(dest) {
  const j = await post({ origin: ORIGIN, destination: dest, resolveOnly: true }, CAL_TIMEOUT);
  if (!j || !j.ok || !j.origin_id || !j.dest_id) {
    log(`  resolve ${dest}: failed` + (j && j._error ? ` (${j._error})` : ''));
    return null;
  }
  return j;
}

// The edge answers in one of two shapes: a ready list of combined options,
// or the two legs separately for the client to pair. Both are flattened to
// {price, carrier, direct} here; a leg pair is summed, which is right for
// the two-one-ways shape this path returns.
function flightsFrom(win) {
  const out = [];
  if (win && Array.isArray(win.options) && win.options.length) {
    for (const o of win.options) {
      if (o && o.price != null) {
        out.push({ price: Math.round(Number(o.price)),
                   carrier: tidyCarrier(o.carrier), direct: !!o.isDirect });
      }
    }
    return out;
  }
  const a = (win && win.outbound) || [], b = (win && win.returns) || [];
  for (const x of a.slice(0, 12)) {
    for (const y of b.slice(0, 12)) {
      if (x && y && x.price != null && y.price != null) {
        out.push({ price: Math.round(Number(x.price) + Number(y.price)),
                   carrier: tidyCarrier(sameCarrier(x.carrier, y.carrier)),
                   direct: !!(x.isDirect && y.isDirect) });
      }
    }
  }
  return out;
}
// The edge names an option by joining both legs itself, so a Wizz round
// trip arrives as "Wizz Air / Wizz Air". Left alone it reads as two
// different airlines - and worse, it was defeating isIsraeli below, which
// rejects a joined name on purpose. A genuine El Al round trip came through
// as "El Al / El Al" and was thrown away, which is why the first snapshot
// had no Israeli offer at all.
function tidyCarrier(c) {
  if (!c) return '';
  const seen = [];
  for (const part of String(c).split('/')) {
    const t = part.trim();
    if (t && !seen.some(x => x.toLowerCase() === t.toLowerCase())) seen.push(t);
  }
  return seen.join(' / ');
}

// A round trip is "El Al" only when both legs are El Al. A mixed pair is
// named as the pair, because calling it by one of the two would be a claim
// the ticket does not support.
function sameCarrier(a, b) {
  a = (a || '').trim(); b = (b || '').trim();
  if (!a && !b) return '';
  if (!a) return b;
  if (!b) return a;
  return a.toLowerCase() === b.toLowerCase() ? a : a + ' / ' + b;
}
const isIsraeli = c =>
  !!c && ISRAELI.some(k => c.toLowerCase().includes(k)) && !c.includes(' / ');

async function priceCandidates(cands) {
  const priced = [];
  const idCache = {};
  for (const c of cands) {
    if (!idCache[c.dest]) idCache[c.dest] = await resolveIds(c.dest);
    const ids = idCache[c.dest];
    if (!ids) continue;

    const j = await post({ originId: ids.origin_id, destId: ids.dest_id,
                           trips: [{ departureDate: c.date, returnDate: c.ret }],
                           adults: ADULTS, children: 0, infants: 0,
                           includeStops: true, forceLegs: true }, PRICE_TIMEOUT);

    if (!j || !j.ok || !Array.isArray(j.results) || !j.results[0]) {
      log(`  price ${c.dest} ${c.date}: no result` +
          (j && (j._error || j._httpError) ? ` (${j._error || 'HTTP ' + j._httpError})` : ''));
      continue;
    }
    const list = flightsFrom(j.results[0]);
    log(`  price ${c.dest} ${c.date}→${c.ret}: ${list.length} flights`);
    if (list.length) priced.push({ ...c, flights: list });
    await sleep(SLEEP_BETWEEN);
  }
  return priced;
}

/* ---------------------------------------------------------------------
 *  The three headline offers
 *
 *  Cheapest, best, and an Israeli carrier. The third is not a kashrut
 *  argument and is not written as one: an airline that keeps flying when
 *  others cancel is worth money to anyone holding a lift pass they have
 *  already paid for.
 * ------------------------------------------------------------------- */
function buildOffers(priced) {
  const offers = [];
  const all = [];

  // One offer per band: the cheapest flight actually found for that kind of
  // trip, carrying the airline that flies it.
  for (const p of priced) {
    const flights = p.flights.slice().sort((a, b) => a.price - b.price);
    for (const f of flights) {
      all.push({ ...f, dest: p.dest, date: p.date, ret: p.ret,
                 nights: p.nights, band: p.band, bandHe: p.bandHe });
    }
    if (!flights.length) continue;
    const cheap = flights[0];
    // A direct flight within a quarter of the cheapest price is worth having
    // instead: same money, hours less travelling.
    const direct = flights.filter(f => f.direct && f.price <= cheap.price * 1.25)[0];
    const pick = direct || cheap;
    offers.push({ kind: p.band, bandHe: p.bandHe, dest: p.dest, date: p.date,
                  ret: p.ret, nights: p.nights, price: pick.price,
                  carrier: pick.carrier, direct: pick.direct });
  }

  // And one across all of them for an Israeli carrier, which is a different
  // question from price: an airline that keeps flying when others cancel is
  // worth money to anyone holding a lift pass already paid for.
  const il = all.filter(f => isIsraeli(f.carrier)).sort((a, b) => a.price - b.price)[0];
  if (il && !offers.some(o => o.carrier === il.carrier && o.price === il.price)) {
    offers.push({ kind: 'israeli', bandHe: il.bandHe, dest: il.dest, date: il.date,
                  ret: il.ret, nights: il.nights, price: il.price,
                  carrier: il.carrier, direct: il.direct });
  }
  return offers;
}

/* ------------------------------------------------------------------- */
async function main() {
  const t0 = Date.now();
  const windows = seasonWindows();
  if (!windows.length) {
    log('no ski months ahead - nothing to fetch');
    return;
  }
  log(`months: ${windows.map(w => w.label).join(', ')}`);
  log(`grid: ${DESTS.length} airports x ${NIGHTS.length} trip lengths x ${windows.length} months`);

  const { cal, rets } = await fetchCalendars(windows);

  const cands = pickDatesToPrice({ cal, rets });
  log(`pricing ${cands.length} dates for airline names`);
  const priced = await priceCandidates(cands);
  const offers = buildOffers(priced);
  log(`offers: ${offers.map(o => o.kind).join(', ') || 'none'}`);

  const payload = {
    generated: new Date().toISOString(),
    origin: ORIGIN,
    adults: ADULTS,
    currency: 'USD',
    dests: Object.fromEntries(DESTS.map(d => [d.code, { he: d.he, km: d.km }])),
    nights: NIGHTS,
    bands: BANDS,
    cal, rets, offers
  };

  // A run that found nothing must not overwrite yesterday's good file with
  // an empty one - a blank panel is worse than a day-old price.
  const priced_days = Object.values(cal)
    .flatMap(byN => Object.values(byN))
    .reduce((n, days) => n + Object.keys(days).length, 0);
  if (!priced_days) {
    log('EMPTY RESULT - keeping the previous file');
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload));
  const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
  log(`wrote ${OUT} — ${priced_days} days, ${offers.length} offers, ${kb} KB, ` +
      `${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

// The test harness imports this file to exercise the pure parts - the
// season maths, the leg pairing, the choice of offers - without touching
// the network.
export { seasonWindows, flightsFrom, sameCarrier, tidyCarrier, isIsraeli, buildOffers,
         pickDatesToPrice, addDays, BANDS, NIGHTS, DESTS };

if (!process.env.CL_FLIGHTS_TEST) {
  main().catch(e => { console.error('fetch-flights failed:', e); process.exitCode = 1; });
}
