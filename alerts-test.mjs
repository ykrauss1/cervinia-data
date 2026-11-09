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
         liftsOpen, LIFT_WINDOW, lastKnownZermatt, baselineFrom,
         TOPIC_OF } from './alerts.mjs';

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

// The good-day line can legitimately appear here, so this one asks only
// what it meant to ask: that an opening at the opening hour is not news.
if (!keys(read({ zermatt_link: 'CLOSED' }), read({ zermatt_link: 'OPEN' }), at(8, 45))
      .includes('zermatt-open')) ok();
else fail('the crossing opens with the lifts, as it does every morning',
  'an opening at the opening hour is announced as though it were late');

// The live feed does not only say OPEN and CLOSED. On 8.11 it was reporting
// "NEXT UPDATE" - the operator's placeholder between seasons. It matches
// neither branch, so nothing fires, which is right: an unknown state is not
// news. It is written down here because it was found in production rather
// than imagined, and because a placeholder landing between a closure and an
// opening breaks the transition the rules look for.
expect('the feed\'s between-seasons placeholder is not a state',
  keys(read({ zermatt_link: 'OPEN' }), read({ zermatt_link: 'NEXT UPDATE' }), at(11)), []);
expect('and coming back from it is not an opening either',
  keys(read({ zermatt_link: 'NEXT UPDATE' }), read({ zermatt_link: 'OPEN' }), at(11)), []);
expect('nor does a placeholder look like a day-long closure',
  keys(read({ zermatt_link: 'NEXT UPDATE' }), read({ zermatt_link: 'NEXT UPDATE' }), at(10)), []);

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
  if (/(^|\s)30 ס״מ נוספו/.test(t)) ok();
  else fail('fresh snow says how much fell', `"${t}"`);
  if (/שלג טרי/.test(t)) ok(); else fail('fresh snow says what it is', `"${t}"`);
}
// Forty centimetres is where the sentence changes register. Both halves are
// tested, because a threshold with only one side tested is a constant.
{
  const pts = [{ station: 'top', name: 'Plateau Rosa', altitude: 3480 },
               { station: 'mid', name: 'Plan Maison',  altitude: 2555 }];
  const snowText = (from, to) => {
    const a = detectAutoAlerts(read({ snow_depth: from }),
                               read({ snow_depth: to, snow_points: pts }), at(7));
    return ((a || []).find(x => x.key === 'fresh-snow') || {}).text || '';
  };
  const ordinary = snowText(100, 130);
  const lots     = snowText(100, 145);
  const edgeLow  = snowText(100, 139);
  const edgeHigh = snowText(100, 140);

  if (/^שלג טרי!/.test(ordinary)) ok();
  else fail('a good morning sounds like one', `"${ordinary}"`);
  if (!/המון|גלישה מהנה/.test(ordinary)) ok();
  else fail('thirty centimetres is not a powder day', `"${ordinary}"`);
  if (/^המון שלג טרי!/.test(lots)) ok();
  else fail('a big fall sounds bigger', `"${lots}"`);
  if (/גלישה מהנה/.test(lots)) ok();
  else fail('the big one wishes them well', `"${lots}"`);
  if (!/המון/.test(edgeLow)) ok();
  else fail('39 cm is still the ordinary line', `"${edgeLow}"`);
  if (/המון/.test(edgeHigh)) ok();
  else fail('40 cm is where it changes', `"${edgeHigh}"`);
  for (const [name, t] of [['the ordinary line', ordinary], ['the big one', lots]]) {
    if (/Plan Maison/.test(t)) ok();
    else fail(`${name} still names the station`, `"${t}"`);
    if (/2,555/.test(t)) ok();
    else fail(`${name} still gives the altitude`, `"${t}"`);
    // With the number, not just the words: "העומק כעת  ס״מ" would have
    // passed a check for the phrase alone, and did.
    if (/העומק כעת \d+ ס״מ/.test(t)) ok();
    else fail(`${name} still gives the depth`, `"${t}"`);
    // And the amount that fell, anchored - a bare /30/ matched the 130 of
    // the depth, so the check passed with the figure it was testing gone.
    if (/(^|\s)\d+ ס״מ נוספו/.test(t)) ok();
    else fail(`${name} still says how much fell`, `"${t}"`);
  }
}

expect('19 cm is weather',
  keys(read({ snow_depth: 100 }), read({ snow_depth: 119 }), at(7)), []);
expect('snow melting is not fresh snow',
  keys(read({ snow_depth: 100 }), read({ snow_depth: 70 }), at(7)), []);
{
  const a = detectAutoAlerts(read({ snow_depth: 100 }), read({ snow_depth: 130 }), at(7));
  const t = (a[0] || {}).text || '';
  if (a.length === 1 && !/ ב-/.test(t) && /עומק השלג כעת/.test(t)) ok();
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

// ── the day worth getting up for ─────────────────────────────────────────
//
// The one rule here that reads a state instead of a transition, and so the
// one that could arrive every single morning if its bar slipped. 8.11 is
// the day it was written for: crossing open, nine lifts of nine, nothing in
// the forecast, and an empty strip.
{
  const good = (o) => read(Object.assign({
    zermatt_link: 'OPEN', lifts_open_local: 9, lifts_total_local: 9,
    avalanche_level: 1, wind_gust: 20
  }, o || {}));
  const g = (o, min) => keys(good(o), good(o), min === undefined ? at(9) : min);

  expect('8.11, the morning this was written for', g(), ['great-day']);

  // A closed crossing at nine, with the mountain running, is its own alert -
  // so this one asks only that the good-day line is not among them.
  if (!g({ zermatt_link: 'CLOSED' }).includes('great-day')) ok();
  else fail('a closed crossing is not a good day',
    'the crossing is shut and the strip calls it a good day');
  expect('nor is a placeholder, whatever else is true',
    g({ zermatt_link: 'NEXT UPDATE' }), []);
  expect('two lifts of two is not the mountain being open',
    g({ lifts_open_local: 2, lifts_total_local: 2 }), []);
  expect('six of seven is',
    g({ lifts_open_local: 6, lifts_total_local: 7 }), ['great-day']);
  expect('but seven of ten is most of a mountain, not all of it',
    g({ lifts_open_local: 7, lifts_total_local: 10 }), []);
  expect('a high avalanche bulletin ends it',
    g({ avalanche_level: 3 }), []);
  expect('and so does a gale',
    g({ wind_gust: 60 }), []);
  expect('an unknown bulletin does not block a day that is good by everything else',
    g({ avalanche_level: null }), ['great-day']);

  expect('it belongs to the morning', g({}, at(8, 30)), ['great-day']);
  expect('and not to the afternoon', g({}, at(13)), []);
  expect('nor to the night before', g({}, at(6)), []);

  {
    const a = detectAutoAlerts(good(), good(), at(9))[0];
    if (a && a.severity === 'info') ok();
    else fail('good news is not dressed as a warning', `severity ${a && a.severity}`);
    if (a && a.cooldown >= 20) ok();
    else fail('it arrives once a day at most',
      `cooldown ${a && a.cooldown}h - a line that comes every half hour is noise`);
    // Not just the numbers: "9 מתוך 9." on its own is not a sentence.
    if (a && /9 מתוך 9 מעליות פועלות/.test(a.text)) ok();
    else fail('it says how much of the mountain is running, in words',
      `"${a && a.text}"`);
    if (a && /צ׳רמט/.test(a.text)) ok();
    else fail('it says the crossing is open', `"${a && a.text}"`);
  }

  // and it stands down when the opening has already said it
  expect('the opening says it better, so this stays quiet',
    keys(read({ zermatt_link: 'CLOSED', lifts_open_local: 9, lifts_total_local: 9,
                avalanche_level: 1, wind_gust: 20 }),
         good(), at(9, 45)), ['zermatt-open']);
}

// ── the placeholder no longer swallows the opening ───────────────────────
//
// This is 8.11 as it actually happened, read back out of ski_status_history.
// The crossing was shut all night, the feed went quiet for two readings, and
// by the time it said OPEN the rule had nothing to compare against. Every
// lift on the mountain was running and nobody was told.
{
  const hist = (...zs) => zs.map(z => read({ zermatt_link: z }));

  expect('the last answer that meant something is the one compared against',
    baselineFrom(hist('NEXT UPDATE', 'NEXT UPDATE', 'CLOSED')).zermatt_link, 'CLOSED');
  expect('a real reading is left exactly as it is',
    baselineFrom(hist('CLOSED', 'OPEN')).zermatt_link, 'CLOSED');
  expect('with nothing but placeholders behind it, nothing is invented',
    baselineFrom(hist('NEXT UPDATE', 'NEXT UPDATE')).zermatt_link, 'NEXT UPDATE');
  expect('no history at all is no baseline', baselineFrom([]), null);
  expect('and neither is nothing', baselineFrom(null), null);
  expect('the reader skips placeholders', lastKnownZermatt(hist('NEXT UPDATE', 'OPEN')), 'OPEN');
  expect('and says so when there is no answer to find',
    lastKnownZermatt(hist('NEXT UPDATE')), '');

  // the rest of the row is untouched: a placeholder says nothing about the
  // wind, but the wind in that row was measured
  const rows = [read({ zermatt_link: 'NEXT UPDATE', wind_gust: 77 }),
                read({ zermatt_link: 'CLOSED',      wind_gust: 10 })];
  expect('only the crossing is carried, not the whole reading',
    baselineFrom(rows).wind_gust, 77);

  // and end to end: the morning of 8.11, at 10:01 Rome
  const prev = baselineFrom([
    read({ zermatt_link: 'NEXT UPDATE', lifts_open_local: 7 }),
    read({ zermatt_link: 'NEXT UPDATE', lifts_open_local: 0 }),
    read({ zermatt_link: 'CLOSED',      lifts_open_local: 0 })
  ]);
  expect('the morning of 8.11 is announced',
    keys(prev, read({ zermatt_link: 'OPEN', lifts_open_local: 9 }), at(10, 1)),
    ['zermatt-open']);
  // without the carry-forward, which is what actually happened
  expect('and without it, the morning passes in silence',
    keys(read({ zermatt_link: 'NEXT UPDATE', lifts_open_local: 7 }),
         read({ zermatt_link: 'OPEN', lifts_open_local: 9 }), at(10, 1)), []);
}

// ── every rule answers to a switch ───────────────────────────────────────
//
// The reader can turn push categories off. Which category an alert belongs
// to is decided in SQL, by cl_alert_topic, matching on the start of the key
// - and three of the keys do not start with their category's name. Worse,
// the function ends in `else 'community'`, the switch for what other skiers
// report: a key nobody mapped is not dropped, it is delivered to the wrong
// people under the wrong heading. great-day was heading there.
//
// So this checks the one half that can be checked from here: that every key
// the rules can emit has a category, and that the categories are the five
// the site actually offers.
{
  const T = 'every rule answers to a switch';
  const OFFERED = ['zermatt', 'lifts', 'weather', 'snow', 'community'];

  // Every alert these rules can produce, gathered by firing each one.
  const fired = [
    detectAutoAlerts(read(), read({ zermatt_link: 'CLOSED' }), at(11)),
    detectAutoAlerts(read({ zermatt_link: 'CLOSED' }), read({ zermatt_link: 'OPEN' }), at(10)),
    detectAutoAlerts(read({ zermatt_link: 'CLOSED' }), read({ zermatt_link: 'CLOSED' }), at(10)),
    detectAutoAlerts(read({ lifts_open_local: 18 }), read({ lifts_open_local: 0 }), at(11)),
    detectAutoAlerts(read({ lifts_open_local: 20 }), read({ lifts_open_local: 6 }), at(11)),
    detectAutoAlerts(read({ wind_gust: 40 }), read({ wind_gust: 78 }), at(11)),
    detectAutoAlerts(read({ wind_gust: 40 }), read({ wind_gust: 105 }), at(11)),
    detectAutoAlerts(read({ avalanche_level: 2 }), read({ avalanche_level: 4 }), at(18)),
    detectAutoAlerts(read({ snow_depth: 100 }), read({ snow_depth: 130 }), at(7)),
    detectAutoAlerts(read({ zermatt_link: 'OPEN', lifts_open_local: 9, lifts_total_local: 9,
                            avalanche_level: 1, wind_gust: 20 }),
                     read({ zermatt_link: 'OPEN', lifts_open_local: 9, lifts_total_local: 9,
                            avalanche_level: 1, wind_gust: 20 }), at(9))
  ].flat().map(a => a.key);

  const seen = [...new Set(fired)];
  if (seen.length >= 10) ok();
  else fail(T, `only ${seen.length} distinct alerts could be produced; ` +
               `a rule that no case here fires is a rule nobody is checking`);

  for (const k of seen) {
    if (TOPIC_OF[k]) ok();
    else fail(T,
      `"${k}" has no category, so cl_alert_topic drops it into 'community' ` +
      `- it reaches the people who asked about field reports, and nobody who ` +
      `asked about this`);
  }
  for (const [k, t] of Object.entries(TOPIC_OF)) {
    if (OFFERED.includes(t)) ok();
    else fail(T, `"${k}" is filed under "${t}", which is not a switch the site offers`);
    if (seen.includes(k)) ok();
    else fail(T, `"${k}" has a category but no rule produces it any more`);
  }

  // the prefix match in SQL works for two families and not for the rest;
  // these are the ones that must be named explicitly over there
  for (const k of ['wind-strong', 'wind-severe', 'avalanche-high', 'fresh-snow', 'great-day']) {
    if (!k.startsWith(TOPIC_OF[k])) ok();
    else fail(T, `"${k}" was thought to need naming in SQL, but its key does ` +
                 `begin with "${TOPIC_OF[k]}" - this list is out of date`);
  }
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

  // Two sabotage runs walked straight past these: every rule above can be
  // right while the scraper hands them the wrong baseline, and nothing here
  // was looking at what the scraper actually asks the database for.
  // The push pipeline was dead for three days and nothing said so. The
  // scraper is the only thing that runs on a schedule and can reach both
  // the database and a channel that arrives - so it is the only thing that
  // can notice.
  // Defining the check is not running it: the first sabotage pass deleted
  // the call and left the function, and this passed. The second pass, on
  // 9 November, COMMENTED the call out - and this passed again, because the
  // text was still in the file. Hence the line anchor: a commented call is
  // not a call.
  if (/cl_push_stuck/.test(scr)) ok();
  else fail('the scraper notices when nothing is being delivered',
    'nothing checks whether raised alerts actually reached push-send, so a ' +
    'dead pipeline looks exactly like a quiet week');
  if (/^\s*await\s+reportStuckPushes\(\)/m.test(scr)) ok();
  else fail('and the check is actually run',
    'reportStuckPushes is defined but never called - the code reads as ' +
    'though the pipeline is watched, and it is not');
  if (/process\.exitCode\s*=\s*1/.test(scr)) ok();
  else fail('and says so where it will be seen',
    'the check reports into a log nobody reads; without a red run there is ' +
    'no email, and without an email there is no notice');

  // ── the balance running out has to reach a person ──────────────────────
  // When Anthropic refuses on billing, the site degrades quietly: the trip
  // search falls back to the local parser and the letter keeps its
  // pre-written part. Quiet is right for the reader and wrong for Yossi,
  // who would otherwise find out weeks later. Same shape as the push check
  // above, and the same trap: defining it is not running it.
  if (/credit-out:/.test(scr)) ok();
  else fail('the scraper notices when the Anthropic balance is gone',
    'nothing reads the mark tf-translate leaves on a billing refusal, so an ' +
    'empty balance looks exactly like a quiet week');
  if (/^\s*await\s+reportCreditOut\(\)/m.test(scr)) ok();
  else fail('and that check is actually run',
    'reportCreditOut is defined but never called');
  const credBlock = scr.slice(scr.indexOf('async function reportCreditOut'),
                              scr.indexOf('await reportStuckPushes'));
  if (/cl_ai_usage/.test(credBlock)) ok();
  else fail('and it reads the table the mark is written to',
    'reportCreditOut does not query cl_ai_usage, so it cannot see the mark');
  if (/process\.exitCode\s*=\s*1/.test(credBlock)) ok();
  else fail('and turns the run red, which is what sends the mail',
    'reportCreditOut reports into a log nobody reads');

  // ── the edge function keeps the doors it was given ─────────────────────
  //
  // tf-translate runs on Yossi's Anthropic key and answers a public URL with
  // no apikey and no Authorization. It lived only in the Supabase editor
  // until 9 November, and that is exactly how the hole reopened: he turned
  // ALLOW_LEGACY off in the editor, a newer copy of the file still said
  // true, it was pasted over his change, and the free-form door was open
  // again with nobody meaning it. A setting that lives in an editor survives
  // until the next paste. These read the file in the repo, which is now the
  // only version that counts.
  let fn = '';
  try { fn = fs.readFileSync(near('supabase/functions/tf-translate/index.ts'), 'utf8'); }
  catch (e) { fn = ''; }
  if (fn) {
    ok();
    if (/^const ALLOW_LEGACY = false;/m.test(fn)) ok();
    else fail('the free-form door stays shut',
      'ALLOW_LEGACY is not false - tf-translate accepts any prompt again, ' +
      'which makes it a general-purpose model on Yossi\'s key');

    // It used to read `model: body?.model || MODEL`, so a caller could ask
    // for the most expensive model there is.
    if (!/\bbody[?.]*\.model\b/.test(fn)) ok();
    else fail('the caller cannot choose the model',
      'the model is taken from the request again');

    // Matching the bare call was not enough: corsFor() contains the same
    // text, so deleting the actual guard left this passing. What matters is
    // that a wrong origin is REFUSED, so match the refusal.
    if (/if \(!ALLOW_ORIGINS\.includes\(origin\)\)[\s\S]{0,160}?403/.test(fn)) ok();
    else fail('a wrong origin is refused, not just echoed',
      'nothing turns an origin outside the allowlist into a 403');

    if (/if \(\/credit\|billing\|payment\|quota\/i\.test\(detail\)\) await noteCreditOut\(\);/.test(fn)) ok();
    else fail('a billing refusal leaves a mark',
      'noteCreditOut is not called when Anthropic refuses, so an empty ' +
      'balance never reaches the scraper and never reaches Yossi');

    // chagim is interpolated straight into a prompt.
    if (/bad holiday table/.test(fn)) ok();
    else fail('the holiday table cannot smuggle instructions',
      'the chagim field goes into the prompt unvalidated');

    if (!/sk-ant-/.test(fn)) ok();
    else fail('no key in the file',
      'an Anthropic key is written into a file in a public repository');
  } else {
    fail('the edge function is under version control',
      'supabase/functions/tf-translate/index.ts is missing, so nothing here ' +
      'can tell whether its doors are open or shut');
  }

  if (/baselineFrom\(/.test(scr)) ok();
  else fail('the scraper uses the carried baseline',
    'scrape.js reads the newest row straight out of the history - so a run ' +
    'of "NEXT UPDATE" swallows the opening again, exactly as on 8.11');
  const lim = scr.match(/ski_status_history[\s\S]{0,240}?\.limit\((\d+)\)/);
  if (lim && Number(lim[1]) >= 4) ok();
  else fail('the scraper reads back far enough to find one',
    `the history query asks for ${lim ? lim[1] : 'an unknown number of'} row(s); ` +
    `with one there is nothing behind the placeholder to look at`);
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
