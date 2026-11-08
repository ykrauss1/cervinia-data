#!/usr/bin/env node
// ============================================================
//  THE ALERT RULES, UNDER TEST
//
//  This is the part of the project that decides what buzzes on a stranger's
//  phone at seven in the morning, and until now it was the only part with
//  no tests at all - because reaching it meant importing a file that starts
//  a scraper. alerts.mjs fixed that; this file is the reason it was worth
//  doing.
//
//  Every case here is the rule's own stated intent, taken from the comments
//  beside it. Where a comment explains WHY a rule declines to fire - the
//  evening timetable, the morning that is not a fault, the bulletin read the
//  night before - there is a case for the firing and a case for the silence,
//  because a rule that only ever fires is not a rule.
// ============================================================
import { detectAutoAlerts, parseOpeningHours, skiDayWindow, num, upper,
         liftsOpen, LIFT_WINDOW } from './alerts.mjs';

let pass = 0; const fails = [];
const ok   = () => pass++;
const fail = (t, m) => fails.push([t, m]);
const at   = (h, m = 0) => h * 60 + m;

// A reading, with the fields the rules look at. The opening hours are the
// operator's own, so the windows in the tests are the real ones.
const read = (o = {}) => Object.assign({
  opening_hours: '08:00 - 16:45',
  zermatt_link: 'OPEN',
  lifts_open_local: 20, lifts_total_local: 24,
  wind_gust: 30, avalanche_level: 2, snow_depth: 100
}, o);

const keys = (prev, next, min) =>
  detectAutoAlerts(prev, next, min).map(a => a.key).sort();

function expect(t, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) ok(); else fail(t, `got ${g}, expected ${w}`);
}

// A rule that throws takes the rest of the suite down with it, and a run
// that stops at case nine says nothing about cases ten to a hundred. In
// production the throw is swallowed by a try/catch in scrape.js and the
// whole alert block falls silent - so a crash here is exactly the failure
// worth reporting clearly rather than hiding behind a stack trace.
try {

// With 08:00-16:45 as the day:
//   lift window  = 09:00 - 15:15   (+60 / -90)
//   zermatt      = 08:00 - 15:45   (+0  / -60)
//   zMorning     = 09:00,  zOpenFrom = max(09:30, 09:30) = 09:30
//   wind window  = 07:00 - 15:15   (-60 / -90)

// ── no baseline, no alerts ───────────────────────────────────────────────
expect('a missing previous reading says nothing',
  detectAutoAlerts(null, read(), at(12)), []);
expect('a missing new reading says nothing',
  detectAutoAlerts(read(), null, at(12)), []);
expect('two identical readings say nothing',
  detectAutoAlerts(read(), read(), at(12)), []);

// ── the crossing to Zermatt ──────────────────────────────────────────────
expect('the crossing stops running mid-morning',
  keys(read(), read({ zermatt_link: 'CLOSED' }), at(11)), ['zermatt-closed']);

expect('the crossing shuts at the end of the day - that is the timetable',
  keys(read(), read({ zermatt_link: 'CLOSED' }), at(16, 30)), []);

expect('the crossing is still shut an hour into a running day',
  keys(read({ zermatt_link: 'CLOSED' }), read({ zermatt_link: 'CLOSED' }), at(10)),
  ['zermatt-shut-today']);

expect('shut at 08:30 is a mountain waking up, not a fact about the day',
  keys(read({ zermatt_link: 'CLOSED' }), read({ zermatt_link: 'CLOSED' }), at(8, 30)), []);

expect('shut on a day when nothing else runs either is not news about the crossing',
  keys(read({ zermatt_link: 'CLOSED', lifts_open_local: 0 }),
       read({ zermatt_link: 'CLOSED', lifts_open_local: 0 }), at(10)), []);

expect('the crossing opens at ten, after a morning of being shut',
  keys(read({ zermatt_link: 'CLOSED' }), read({ zermatt_link: 'OPEN' }), at(10)),
  ['zermatt-open']);

expect('the crossing opens with the lifts, as it does every morning',
  keys(read({ zermatt_link: 'CLOSED' }), read({ zermatt_link: 'OPEN' }), at(8, 45)), []);

expect('a crossing reported in lower case is the same crossing',
  keys(read({ zermatt_link: 'open' }), read({ zermatt_link: 'closed' }), at(11)),
  ['zermatt-closed']);

// ── the lifts ────────────────────────────────────────────────────────────
expect('a mountain that was running stops',
  keys(read({ lifts_open_local: 18 }), read({ lifts_open_local: 0 }), at(11)),
  ['lifts-all-closed']);

expect('two lifts going to nothing is a slow morning, not a stoppage',
  keys(read({ lifts_open_local: 2 }), read({ lifts_open_local: 0 }), at(11)), []);

expect('most of the mountain closes',
  keys(read({ lifts_open_local: 20 }), read({ lifts_open_local: 6 }), at(11)),
  ['lifts-mostly-closed']);

expect('half the mountain closing is a day, not an event',
  keys(read({ lifts_open_local: 20 }), read({ lifts_open_local: 10 }), at(11)), []);

expect('everything shuts at closing time, every single day',
  keys(read({ lifts_open_local: 18 }), read({ lifts_open_local: 0 }), at(16, 30)), []);

expect('nothing is open at 07:00 either, and that is not news',
  keys(read({ lifts_open_local: 18 }), read({ lifts_open_local: 0 }), at(7)), []);

expect('the village count is preferred over the whole area',
  liftsOpen({ lifts_open_local: 4, lifts_open_global: 30 }), 4);
expect('and the area count stands in when the village panel was unreadable',
  liftsOpen({ lifts_open_local: null, lifts_open_global: 30 }), 30);

// ── wind ─────────────────────────────────────────────────────────────────
expect('gusts cross 100',
  keys(read({ wind_gust: 40 }), read({ wind_gust: 105 }), at(11)), ['wind-severe']);

expect('gusts cross 70',
  keys(read({ wind_gust: 40 }), read({ wind_gust: 78 }), at(11)), ['wind-strong']);

expect('gusts already strong, now severe',
  keys(read({ wind_gust: 75 }), read({ wind_gust: 110 }), at(11)), ['wind-severe']);

expect('gusts that were already strong and rose a little say nothing again',
  keys(read({ wind_gust: 75 }), read({ wind_gust: 85 }), at(11)), []);

expect('wind is worth knowing an hour before the lifts start',
  keys(read({ wind_gust: 40 }), read({ wind_gust: 105 }), at(7, 30)), ['wind-severe']);

expect('wind after everything has shut closes nothing that is open',
  keys(read({ wind_gust: 40 }), read({ wind_gust: 105 }), at(17)), []);

expect('gusts arriving as "78 km/h" are still 78',
  keys(read({ wind_gust: '40' }), read({ wind_gust: '78 km/h' }), at(11)), ['wind-strong']);

// ── avalanche ────────────────────────────────────────────────────────────
expect('the bulletin rises to 4',
  keys(read({ avalanche_level: 3 }), read({ avalanche_level: 4 }), at(18)),
  ['avalanche-high']);

expect('read in the evening, by somebody deciding about tomorrow',
  keys(read({ avalanche_level: 2 }), read({ avalanche_level: 4 }), at(19, 30)),
  ['avalanche-high']);

expect('but not at three in the morning',
  keys(read({ avalanche_level: 2 }), read({ avalanche_level: 4 }), at(3)), []);

expect('4 going to 5 has already been said',
  keys(read({ avalanche_level: 4 }), read({ avalanche_level: 5 }), at(18)), []);

expect('a first reading of 4 with no baseline level still warns',
  keys(read({ avalanche_level: null }), read({ avalanche_level: 4 }), at(18)),
  ['avalanche-high']);

// ── fresh snow ───────────────────────────────────────────────────────────
{
  const next = read({ snow_depth: 130, snow_points: [
    { station: 'top', name: 'Plateau Rosa', altitude: 3480 },
    { station: 'mid', name: 'Plan Maison',  altitude: 2555 }
  ]});
  const a = detectAutoAlerts(read({ snow_depth: 100 }), next, at(7));
  expect('20 cm or more is news', a.map(x => x.key), ['fresh-snow']);
  const t = (a[0] || {}).text || '';
  if (/Plan Maison/.test(t)) ok(); else fail('fresh snow names the station',
    `"${t}" - one number without a station reads as the depth of the whole ` +
    `resort, and the mountain does not have one depth`);
  if (/2,555/.test(t)) ok(); else fail('fresh snow gives the altitude',
    `"${t}" has no altitude beside the station`);
  if (/30/.test(t)) ok(); else fail('fresh snow says how much fell', `"${t}"`);
}
expect('19 cm is weather',
  keys(read({ snow_depth: 100 }), read({ snow_depth: 119 }), at(7)), []);
expect('snow melting is not fresh snow',
  keys(read({ snow_depth: 100 }), read({ snow_depth: 70 }), at(7)), []);
{
  const a = detectAutoAlerts(read({ snow_depth: 100 }), read({ snow_depth: 130 }), at(7));
  const t = (a[0] || {}).text || '';
  if (a.length === 1 && !/ ב-/.test(t) && /עומק השלג/.test(t)) ok();
  else fail('with no station list it does not invent one',
    `"${t}" - the fallback wording has to stand on its own`);
}

// ── the shape of an alert ────────────────────────────────────────────────
{
  const every = [
    detectAutoAlerts(read({ zermatt_link: 'CLOSED' }), read(), at(11)),
    detectAutoAlerts(read(), read({ zermatt_link: 'CLOSED' }), at(11)),
    detectAutoAlerts(read({ lifts_open_local: 18 }), read({ lifts_open_local: 0 }), at(11)),
    detectAutoAlerts(read({ lifts_open_local: 20 }), read({ lifts_open_local: 6 }), at(11)),
    detectAutoAlerts(read({ wind_gust: 40 }), read({ wind_gust: 105 }), at(11)),
    detectAutoAlerts(read({ wind_gust: 40 }), read({ wind_gust: 78 }), at(11)),
    detectAutoAlerts(read({ avalanche_level: 2 }), read({ avalanche_level: 4 }), at(18)),
    detectAutoAlerts(read({ snow_depth: 100 }), read({ snow_depth: 130 }), at(7))
  ].flat();
  if (every.length >= 8) ok(); else fail('the rules all still fire',
    `only ${every.length} of the eight rules produced anything`);
  for (const a of every) {
    for (const f of ['key', 'severity', 'hours', 'cooldown', 'text']) {
      if (a[f] === undefined || a[f] === null || a[f] === '')
        fail('every alert is complete', `${a.key || '?'} has no ${f}`);
      else ok();
    }
    if (['info', 'warning', 'danger'].includes(a.severity)) ok();
    else fail('severity is one the strip knows', `${a.key}: ${a.severity}`);
    if (/[֐-׿]/.test(a.text)) ok();
    else fail('the text reaches a Hebrew reader in Hebrew', `${a.key}: "${a.text}"`);
    if (!/undefined|NaN|\[object/.test(a.text)) ok();
    else fail('nothing leaks into the text', `${a.key}: "${a.text}"`);
    if (a.cooldown >= a.hours) ok();
    else fail('the cooldown outlasts the alert',
      `${a.key}: shown for ${a.hours}h but may repeat after ${a.cooldown}h`);
  }
  const seen = new Set();
  for (const a of every) {
    if (seen.has(a.key)) fail('each rule has a key of its own', `${a.key} twice`);
    else { seen.add(a.key); ok(); }
  }
}

// ── one reading, several things wrong at once ────────────────────────────
expect('a storm closes the lifts and the crossing together',
  keys(read({ zermatt_link: 'OPEN', lifts_open_local: 18, wind_gust: 40 }),
       read({ zermatt_link: 'CLOSED', lifts_open_local: 0, wind_gust: 105 }), at(11)),
  ['lifts-all-closed', 'wind-severe', 'zermatt-closed']);

// ── the window comes from the operator, not from a guess ─────────────────
expect('the operator\'s own hours are read', parseOpeningHours({ opening_hours: '08:00 - 16:45' }), [480, 1005]);
expect('an en dash is a dash', parseOpeningHours({ opening_hours: '08:30 – 16:00' }), [510, 960]);
expect('a missing field is not a window', parseOpeningHours({}), null);
expect('nonsense is not a window', parseOpeningHours({ opening_hours: 'closed today' }), null);
expect('a backwards day is not a window', parseOpeningHours({ opening_hours: '16:45 - 08:00' }), null);
expect('without hours the rules fall back to the fixed window',
  skiDayWindow({}, 60, 90, LIFT_WINDOW), LIFT_WINDOW);
expect('a short day still trims at both ends',
  skiDayWindow({ opening_hours: '09:00 - 15:00' }, 60, 90, LIFT_WINDOW), [600, 810]);
expect('a day too short to trim keeps the fallback rather than inverting',
  skiDayWindow({ opening_hours: '09:00 - 10:00' }, 60, 90, LIFT_WINDOW), LIFT_WINDOW);

// ── a short day moves the rules with it ──────────────────────────────────
expect('on a 09:00-15:00 day, 09:30 is still the morning',
  keys(read({ opening_hours: '09:00 - 15:00', zermatt_link: 'CLOSED' }),
       read({ opening_hours: '09:00 - 15:00', zermatt_link: 'CLOSED' }), at(9, 30)), []);
expect('and by 10:30 a shut crossing is a fact about that day',
  keys(read({ opening_hours: '09:00 - 15:00', zermatt_link: 'CLOSED' }),
       read({ opening_hours: '09:00 - 15:00', zermatt_link: 'CLOSED' }), at(10, 30)),
  ['zermatt-shut-today']);

// ── the small readers ────────────────────────────────────────────────────
expect('a number is a number', num(45), 45);
expect('a number in a string is a number', num('45 cm'), 45);
expect('a comma is a decimal point', num('4,5'), 4.5);
expect('a negative is kept', num('-3'), -3);
expect('nothing is null', num(null), null);
expect('words are null', num('no data'), null);
expect('a missing value upper-cases to empty', upper(null), '');

} catch (e) {
  fail('the rules run without throwing',
    `${e && e.message} - in production scrape.js catches this and the whole ` +
    `alert block goes quiet, so nobody is told anything at all`);
}

// ── the scraper and the rules have not drifted apart ─────────────────────
//
// Earlier this week a function declared twice in index.html cost four
// rounds of debugging: every fix went into the copy nobody called. These
// rules now live in two files that must stay one file's worth of truth.
try {
  const fs = await import('node:fs');
  const near = (n) => new URL(n, import.meta.url).pathname;
  const scr = fs.readFileSync(near('scrape.js'), 'utf8');
  if (/from '\.\/alerts\.mjs'/.test(scr)) ok();
  else fail('the scraper uses these rules',
    'scrape.js does not import alerts.mjs, so the rules under test here are ' +
    'not the rules that run');
  if (!/function detectAutoAlerts/.test(scr)) ok();
  else fail('the rules are defined once',
    'scrape.js declares detectAutoAlerts of its own - whichever one wins, ' +
    'half the fixes go into the copy nobody calls');
  for (const h of ['function romeMinutes', 'function skiDayWindow', 'function liftsOpen']) {
    if (!new RegExp(h).test(scr)) ok();
    else fail('the helpers are defined once', `scrape.js still declares ${h}`);
  }
} catch (e) {
  fail('scrape.js can be read beside these rules', String(e && e.message));
}

// ── report ───────────────────────────────────────────────────────────────
const line = '─'.repeat(64);
console.log(line);
console.log(`עברו ${pass} · נכשלו ${fails.length}`);
console.log(line);
for (const [t, m] of fails) console.log(`✗ ${t}\n   ${m}`);
if (!fails.length) console.log('הכול תקין.');
process.exit(fails.length ? 1 : 0);
