// בדיקה עצמית של האתר
//
// Every defect found on 22.10.2026 was found either by accident or by Yossi
// reading the page: three dead links, a right-to-left scramble, a panel that
// opened behind another, inline styles destroyed by the number formatter,
// private phone numbers served in a public file. None of them needed a human
// to notice - they all have a shape a script can look for. This is that
// script, so the next one gets caught before he sees it.
//
//   node selfcheck.mjs                 # run everything
//   node selfcheck.mjs --page /path    # against another copy of index.html
//
// Exit code is 0 only when nothing failed.

// Playwright is resolved the normal way when it is installed next to the
// repo (GitHub Actions does that), and from the sandbox copy otherwise, so
// the same file runs in both places without editing.
let pw;
try { pw = (await import('playwright')).default ?? await import('playwright'); }
catch { pw = (await import('/opt/npm-tools/node_modules/playwright/index.js')).default; }
import fs from 'fs';
import path from 'path';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : d; };
// Look for the page and its texts beside this script, then one level up -
// the repo keeps them at its root while this file lives in tools/.
const HERE = path.dirname(new URL(import.meta.url).pathname);
const near = (name) => {
  for (const d of [HERE, path.dirname(HERE), process.cwd()]) {
    const f = path.join(d, name);
    if (fs.existsSync(f)) return f;
  }
  return path.join(HERE, name);
};
const PAGE  = path.resolve(arg('--page',  near('index.html')));
const TEXTS = path.resolve(arg('--texts', near('texts.json')));

const T = JSON.parse(fs.readFileSync(TEXTS, 'utf8'));
const fails = [];
const warns = [];
const fail = (test, detail) => fails.push({ test, detail });
const warn = (test, detail) => warns.push({ test, detail });
let passed = 0;
const ok = (t) => { passed++; };

// On GitHub's machines Playwright finds its own browser and this resolves to
// nothing. In the container the browser is pre-installed under a versioned
// folder, and the version moves, so the binary is looked up rather than named.
const LOCAL_CHROME = (() => {
  const root = '/opt/pw-browsers';
  if (!fs.existsSync(root)) return null;
  for (const d of fs.readdirSync(root)) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
      const f = path.join(root, d, rel);
      if (fs.existsSync(f)) return f;
    }
  }
  return null;
})();
const LAUNCH = LOCAL_CHROME ? { executablePath: LOCAL_CHROME } : {};
const browser = await pw.chromium.launch(LAUNCH);

// ── 1. every panel opens, and nothing throws ──────────────────────────────
// The container has no network, so Supabase and the weather feeds always
// fail here. Those are the environment, not the page, and are filtered out;
// anything else that throws is a real defect.
const NOISE = /supabase|Failed to fetch|NetworkError|ERR_|texts\.json|net::/i;

const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e).split('\n')[0]));
await page.goto('file://' + PAGE);
await page.waitForTimeout(1200);
await page.evaluate((T) => {
  window._texts = T;
  window.PISTES = T.pistes;
  window.SKI_INSTRUCTORS = T.ski_instructors || [];
  _applyTexts(T);
  if (typeof _wireSourceChips === 'function') _wireSourceChips();
}, T);
await page.waitForTimeout(400);

const modalIds = await page.evaluate(() => [...document.querySelectorAll('.modal')].map(m => m.id));
for (const id of modalIds) {
  const before = errors.length;
  const h = await page.evaluate((i) => {
    document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
    openM(i);
    const c = document.getElementById(i).querySelector('.modal-content');
    return c ? Math.round(c.scrollHeight) : -1;
  }, id);
  await page.waitForTimeout(220);
  if (h < 40) fail('panel renders', `${id} is ${h}px tall - it opened empty`);
  else ok();
  const fresh = errors.slice(before).filter(e => !NOISE.test(e));
  if (fresh.length) fail('no script errors', `${id}: ${fresh[0]}`); else ok();
}

// ── 2. every panel closes, by its button and by Escape ────────────────────
for (const id of modalIds) {
  const r = await page.evaluate(async (i) => {
    document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
    openM(i);
    const m = document.getElementById(i);
    const btn = m.querySelector('.close-btn')
             || [...m.querySelectorAll('[onclick]')].find(
                  e => (e.getAttribute('onclick') || '').indexOf("closeM('" + i + "')") > -1);
    if (!btn) return 'no close control';
    btn.click();
    await new Promise(r => setTimeout(r, 120));
    if (m.style.display !== 'none') return 'close button did not close it';
    return 'ok';
  }, id);
  if (r !== 'ok') fail('panel closes', `${id}: ${r}`); else ok();
}
// Escape closes the topmost panel, and only that one
const esc = await page.evaluate(async () => {
  document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
  openM('pisteModal');
  if (typeof openSources === 'function') openSources('pistes');
  await new Promise(r => setTimeout(r, 200));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  const s = document.getElementById('sourcesModal');
  const p = document.getElementById('pisteModal');
  return (s && s.style.display === 'none' ? 'sources closed' : 'sources still open')
       + ' / ' + (p && p.style.display !== 'none' ? 'pistes still open' : 'pistes closed too');
});
if (esc !== 'sources closed / pistes still open') fail('Escape closes only the top panel', esc); else ok();

// ── 3. duplicate element ids ──────────────────────────────────────────────
// A duplicate id makes getElementById return whichever came first, so one of
// the two controls silently stops working. It is invisible until someone
// clicks the wrong one.
const dups = await page.evaluate(() => {
  const seen = {}, out = [];
  document.querySelectorAll('[id]').forEach(e => {
    if (seen[e.id]) { if (out.indexOf(e.id) < 0) out.push(e.id); } else seen[e.id] = 1;
  });
  return out;
});
if (dups.length) fail('no duplicate ids', dups.join(', ')); else ok();

// ── 4. right-to-left handling ─────────────────────────────────────────────
// Forcing dir="ltr" onto a run that contains Hebrew scrambles it. This is
// the bug class Yossi kept catching by eye.
const bidi = await page.evaluate(async () => {
  const bad = [];
  for (const m of document.querySelectorAll('.modal')) {
    openM(m.id);
    await new Promise(r => setTimeout(r, 90));
    m.querySelectorAll('[dir="ltr"]').forEach(e => {
      // Hebrew inside an LTR run is correct as long as it is isolated - in a
      // <bdi> or a dir="rtl" of its own, which is how the kosher lists mix a
      // Latin brand run with a Hebrew gloss. Strip the isolates and look at
      // what Hebrew is left bare in the LTR run; that is the part that
      // actually scrambles.
      const clone = e.cloneNode(true);
      clone.querySelectorAll('bdi,[dir="rtl"]').forEach(n => n.remove());
      const bare = (clone.textContent || '').trim();
      if (bare.replace(/[^֐-׿]/g, '').length > 1) {
        bad.push(m.id + ' :: ' + e.tagName.toLowerCase() + ' :: ' + bare.slice(0, 48));
      }
    });
    closeM(m.id);
  }
  return bad;
});
if (bidi.length) fail('no Hebrew forced into an LTR run', bidi.slice(0, 5).join(' | ')); else ok();

// inline styles must survive the number formatter
const styleRot = await page.evaluate(() => {
  if (typeof _fixNums !== 'function') return 'no _fixNums';
  const probe = '<span style="font-size:0.78rem;color:#8a5a00;">מחיר 2,450 מ׳</span>';
  const out = _fixNums(probe);
  return out.indexOf('font-size:0.78rem') > -1 ? 'ok' : 'style attribute was rewritten: ' + out.slice(0, 90);
});
if (styleRot !== 'ok') fail('number formatter leaves tags alone', styleRot); else ok();

// ── 5. links ──────────────────────────────────────────────────────────────
// Placeholder and malformed hrefs, and any link built from an undefined
// variable - "undefined" inside a URL is a bug that still looks clickable.
const links = await page.evaluate(async () => {
  const out = [];
  for (const m of document.querySelectorAll('.modal')) {
    openM(m.id);
    await new Promise(r => setTimeout(r, 90));
    m.querySelectorAll('a[href]').forEach(a => {
      if (a.offsetParent === null) return;            // not on screen
      const h = a.getAttribute('href') || '';
      const label = (a.textContent || '').trim().slice(0, 30);
      if (h === '#' && a.getAttribute('onclick')) return;   // a handler
      // A data: URI is the file itself; base64 happens to contain "null" and
      // "NaN" often enough to trip the placeholder test every time.
      if (h.slice(0, 5) === 'data:') return;
      if (!h || /undefined|null|NaN|YOUR_|example\.com/i.test(h)) {
        out.push(m.id + ' :: ' + label + ' :: ' + h.slice(0, 70));
      }
    });
    closeM(m.id);
  }
  return out;
});
if (links.length) fail('no placeholder or broken links', links.slice(0, 6).join(' | ')); else ok();

// ── 6. nothing private leaks into the page ────────────────────────────────
// The instructors' mobile numbers were served publicly in texts.json. They
// are out now; this makes sure they stay out.
const PRIVATE = ['3429964605', '3338070010', '3887402206', '3298288980', '3393083937', '3280719765'];
const leakHtml = await page.evaluate(() => document.documentElement.innerHTML);
const leakTexts = JSON.stringify(T);
const leaked = PRIVATE.filter(n => leakHtml.includes(n) || leakTexts.includes(n));
if (leaked.length) fail('no private numbers in the page or texts.json', leaked.join(', ')); else ok();

// ── 7. every key the page asks for actually exists ────────────────────────
// _applyTexts reads dozens of fields. A renamed key fails silently - the
// element simply keeps whatever placeholder the HTML had.
const placeholders = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('.modal [id]').forEach(e => {
    const t = (e.textContent || '').trim();
    if (/^(TODO|undefined|null|\[\]|\{\})$/i.test(t)) out.push(e.id + ' = ' + t);
  });
  return out;
});
if (placeholders.length) fail('no unfilled placeholders', placeholders.slice(0, 5).join(', ')); else ok();

// ── 8. the piste filters always have something to show ────────────────────
const filters = await page.evaluate(async () => {
  const out = [];
  if (typeof PISTE_AREAS === 'undefined' || typeof PISTE_KINDS === 'undefined') return ['filters not defined'];
  openM('pisteModal');
  for (const a of PISTE_AREAS) {
    for (const k of PISTE_KINDS) {
      setPisteArea(a.k); setPisteKind(k.k);
      await new Promise(r => setTimeout(r, 40));
      const n = document.querySelectorAll('#piste-scroll .piste-card, #piste-scroll > div').length;
      if (n === 0) out.push(a.k + '/' + k.k);
    }
  }
  document.getElementById('pisteModal').style.display = 'none';
  return out;
});
if (filters.length) warn('filter combinations with nothing to show', filters.join(', ')); else ok();

// ── 9. nothing spills sideways, at every width that matters ──────────────
// A single width would have missed this: the sticky bars bled by a
// hard-coded amount with their own breakpoint, while the dialog's padding
// changed at two others. They agreed at 414 and 390 and disagreed at 430
// and 360, so the bug was invisible unless you happened to test the right
// phone.
for (const w of [430, 414, 393, 390, 375, 360, 320]) {
  const p2 = await browser.newPage({ viewport: { width: w, height: 880 } });
  await p2.goto('file://' + PAGE);
  await p2.waitForTimeout(900);
  await p2.evaluate((T) => {
    window._texts = T; window.PISTES = T.pistes;
    window.SKI_INSTRUCTORS = T.ski_instructors || [];
    _applyTexts(T);
  }, T);
  const spill = await p2.evaluate(async () => {
    const out = [];
    for (const m of document.querySelectorAll('.modal')) {
      openM(m.id);
      await new Promise(r => setTimeout(r, 70));
      const c = m.querySelector('.modal-content');
      if (c && c.scrollWidth > c.clientWidth + 2) {
        out.push(m.id + ' (' + c.scrollWidth + ' > ' + c.clientWidth + ')');
      }
      closeM(m.id);
    }
    return out;
  });
  if (spill.length) fail('no sideways overflow at ' + w + 'px', spill.join(', ')); else ok();
  await p2.close();
}

// ── 10. the content editor round-trips the file untouched ─────────────────
const roundTrip = await page.evaluate(() => {
  if (typeof CE === 'undefined') return 'editor not present';
  CE.data = null; CE.dirty = {};
  try { localStorage.removeItem('ce_draft'); } catch (e) {}
  CE.open();
  return JSON.stringify(CE.data) === JSON.stringify(window._texts) ? 'ok' : 'editor altered the file on load';
});
if (roundTrip !== 'ok') fail('editor loads the file unchanged', roundTrip); else ok();

const validatorCatches = await page.evaluate(() => {
  if (typeof CE === 'undefined') return 'editor not present';
  CE.set(CE.data, ['around', 'places', 0, 'what'], '<b>unclosed');
  const n = CE.validate().length;
  CE.data = JSON.parse(JSON.stringify(window._texts));
  return n > 0 ? 'ok' : 'a broken tag passed validation';
});
if (validatorCatches !== 'ok') fail('editor refuses a broken file', validatorCatches); else ok();


// ── 11. the arrival planner answers, and answers correctly ───────────────
//
// The planner is the one place on the site that computes rather than
// displays, so it is the one place a silent wrong answer can appear. Each
// case below has a known right answer worked out by hand from the operator's
// timetable; the test fails if the page disagrees with the timetable.
const planCases = [
  // [airport, date, landing, pax, what must appear, what must not]
  ['mxp', '2026-12-18', '12:00', 2, ['14:05', '15:40', '17:45', '18:40'], []],
  ['mxp', '2026-12-18', '18:00', 2, ['18:05'], ['17:45']],
  ['mxp', '2026-12-21', '09:00', 4, ['11:05', '12:40', '13:45', '14:40'], []],
  ['mxp', '2026-12-22', '09:00', 2, ['אינו פועל'], ['11:05']],
  ['mxp', '2026-12-24', '16:00', 2, ['18:35', '20:10', '19:35'], []],
  ['trn', '2026-12-21', '09:00', 3, ['Porta Susa'], []],
  // the desks close long before the night is over, and Turin closes
  // earlier again on a Sunday - the two cases that strand a late arrival
  ['mxp', '2026-12-18', '22:00', 2, ['שימו לב', '23:30'], []],
  ['mxp', '2026-12-18', '23:30', 2, ['רכב שכור לא יעזור'], []],
  ['trn', '2026-12-20', '19:30', 2, ['20:00', 'רכב שכור לא יעזור'], []],
  ['trn', '2026-12-21', '19:30', 2, [], ['רכב שכור לא יעזור']],
];
for (const [ap, date, time, pax, must, mustNot] of planCases) {
  const txt = await page.evaluate(([ap, date, time, pax]) => {
    if (typeof planTrip !== 'function') return '__missing__';
    if (!document.getElementById('ap-airport')) {
      renderArrivalPlanner(window._texts.transport.planner);
    }
    document.getElementById('ap-airport').value = ap;
    document.getElementById('ap-date').value = date;
    document.getElementById('ap-time').value = time;
    document.getElementById('ap-pax').value = String(pax);
    planTrip();
    return document.getElementById('ap-out').innerText;
  }, [ap, date, time, pax]);
  const label = `planner ${ap} ${date} ${time}`;
  if (txt === '__missing__') { fail(label, 'planTrip is not defined'); continue; }
  const missing = must.filter(x => txt.indexOf(x) === -1);
  const wrong   = mustNot.filter(x => txt.indexOf(x) !== -1);
  if (missing.length) fail(label, `missing from the answer: ${missing.join(', ')}`);
  else if (wrong.length) fail(label, `should not be in the answer: ${wrong.join(', ')}`);
  else ok();
}

// every airport offers something, whatever the day
const everyAirport = await page.evaluate(() => {
  const ids = window._texts.transport.planner.airports.map(a => a.id);
  const bad = [];
  for (const id of ids) {
    for (const day of ['2026-12-20', '2026-12-23']) {
      document.getElementById('ap-airport').value = id;
      document.getElementById('ap-date').value = day;
      document.getElementById('ap-time').value = '10:00';
      planTrip();
      const t = document.getElementById('ap-out').innerText || '';
      if (t.indexOf('הסעה פרטית') === -1 || t.indexOf('ברכב שכור') === -1) bad.push(id + ' ' + day);
    }
  }
  return bad;
});
if (everyAirport.length) fail('every airport always has an answer', everyAirport.join(', ')); else ok();

// ── 12. the seasonal hint fires on the right dates and stays quiet else ──
const seasonCases = [
  ['2027-02-07', '2027-02-14', 'Settimana', true],
  ['2027-03-14', '2027-03-21', 'אמצע מרץ', true],
  ['2026-12-26', '2027-01-02', 'חג המולד', true],
  // High summer is not silence any more: the verdict says the lifts are shut.
  ['2027-07-01', '2027-07-08', 'מחוץ לעונה', true],
];
for (const [a, b, needle, expect] of seasonCases) {
  const txt = await page.evaluate(([a, b]) => {
    if (typeof seasonHint !== 'function') return '__missing__';
    const d = s => { const x = s.split('-'); return new Date(+x[0], +x[1] - 1, +x[2]); };
    seasonHint(d(a), d(b));
    return (document.getElementById('season-hint') || {}).innerText || '';
  }, [a, b]);
  const label = `season hint ${a}`;
  if (txt === '__missing__') { fail(label, 'seasonHint is not defined'); continue; }
  if (expect && txt.indexOf(needle) === -1) fail(label, `expected to mention "${needle}", said: ${txt.slice(0, 60)}`);
  else if (!expect && txt.trim()) fail(label, `should have said nothing, said: ${txt.slice(0, 60)}`);
  else ok();
}

// the warning outranks the decoration when both apply
const hintOrder = await page.evaluate(() => {
  const d = s => { const x = s.split('-'); return new Date(+x[0], +x[1] - 1, +x[2]); };
  seasonHint(d('2026-12-26'), d('2027-01-02'));
  const t = document.getElementById('season-hint').innerText;
  return t.indexOf('חג המולד וראש השנה') < t.indexOf('שוק חג המולד') ? 'ok' : 'the market came first';
});
if (hintOrder !== 'ok') fail('the crowd warning comes before the Christmas market', hintOrder); else ok();

// ── 12b. the handoff to the car search ──────────────────────────────────
const carHandoff = await page.evaluate(async () => {
  if (typeof openCarSearch !== 'function') return 'openCarSearch is not defined';
  const body = document.getElementById('transport-body');
  if (body && !body.innerHTML) renderTransport(window._texts.transport);
  if (body && body.innerHTML.indexOf('openCarSearch()') === -1)
    return 'the car-search button is not on the page';
  openM('parkingModal');
  openCarSearch();
  await new Promise(r => setTimeout(r, 200));
  if (document.getElementById('parkingModal').style.display !== 'none')
    return 'the transport panel stayed open behind it';
  const hotel = document.getElementById('hotelModal').style.display;
  if (hotel === 'none' || hotel === '') return 'the trip panel did not open';
  if (document.getElementById('ttab-car').className.indexOf('ttab-active') === -1)
    return 'the trip panel opened on the wrong tab';
  document.getElementById('hotelModal').style.display = 'none';
  return 'ok';
});
if (carHandoff !== 'ok') fail('the car-search button opens the car tab', carHandoff); else ok();

// ── 12c. the search asks what you want before it asks when ──────────────
// The four tabs were always there and sat below the date form, so the first
// thing anybody met was "בחר תאריכי יציאה וחזרה" and the car and lodging
// searches were below the fold. Yossi, who wrote them, did not know they
// existed. Order is the whole fix, so order is what this pins.
const tabOrder = await page.evaluate(() => {
  const tabs  = document.getElementById('ttab-all');
  const dates = document.getElementById('trip-dates');
  if (!tabs)  return 'the tab bar is gone';
  if (!dates) return 'the date field is gone';
  if (!(tabs.compareDocumentPosition(dates) & Node.DOCUMENT_POSITION_FOLLOWING))
    return 'the date form comes before the tabs - the reader meets a form, not a choice';
  return 'ok';
});
if (tabOrder !== 'ok') fail('the search asks what before it asks when', tabOrder); else ok();

// ── 12d. one date picker per tab, never two ─────────────────────────────
const oneDatePicker = await page.evaluate(async () => {
  openM('hotelModal');
  if (typeof planGo === 'function') planGo('search');
  switchTripTab('car');
  await new Promise(r => setTimeout(r, 80));
  const common = document.getElementById('trip-common');
  if (!common) return 'the shared date block is gone';
  if (common.style.display !== 'none')
    return 'the flight dates are still on screen on the car tab';
  if (document.getElementById('tpanel-car').style.display === 'none')
    return 'the car panel did not open';
  switchTripTab('hotel');
  await new Promise(r => setTimeout(r, 80));
  if (document.getElementById('trip-common').style.display !== 'none')
    return 'the flight dates are still on screen on the lodging tab';
  switchTripTab('all');
  await new Promise(r => setTimeout(r, 80));
  if (document.getElementById('trip-common').style.display === 'none')
    return 'going back to "הכל" left the dates hidden';
  document.getElementById('hotelModal').style.display = 'none';
  return 'ok';
});
if (oneDatePicker !== 'ok') fail('each tab shows one set of dates, not two', oneDatePicker); else ok();

// ── 12e. the car tab still accepts the dates picked for the flight ──────
// Hiding the flight form on the car tab is only safe because searchCar
// falls back to it. If that fallback ever goes, somebody who picked dates
// on "הכל" and then switched to רכב would be told to pick them again.
const carFallback = await page.evaluate(async () => {
  openM('hotelModal');
  if (typeof planGo === 'function') planGo('search');
  switchTripTab('all');
  setTripDates('2027-01-10', '2027-01-17');
  const carEl = document.getElementById('car-dates');
  carEl.removeAttribute('data-ci');
  carEl.removeAttribute('data-co');
  if (carEl._flatpickr) carEl._flatpickr.clear();
  switchTripTab('car');
  await new Promise(r => setTimeout(r, 80));
  searchCar();
  await new Promise(r => setTimeout(r, 150));
  const res = document.getElementById('car-results');
  if (!res || res.style.display === 'none' || !res.innerHTML)
    return 'no results - the car search did not fall back to the trip dates';
  if (res.innerHTML.indexOf('2027-01-10') === -1)
    return 'the car links do not carry the dates picked for the flight';
  document.getElementById('hotelModal').style.display = 'none';
  return 'ok';
});
if (carFallback !== 'ok') fail('the car tab uses the dates already picked', carFallback); else ok();

// ── 12f. no fold hides a scroll ─────────────────────────────────────────
// Folding is only an answer while each fold is about a screen. "הציוד הכבד"
// had grown to 4,374 characters - three phone screens behind one summary -
// so looking up pole length meant scrolling past the whole buckling
// procedure. It is two folds now. This stops the next one growing back:
// when a fold passes the limit it wants splitting, not a bigger limit.
const FOLD_LIMIT = 3400;
const fatFolds = await page.evaluate((limit) => {
  document.querySelectorAll('div.modal[id]').forEach(d => { d.style.display = 'block'; });
  const out = [];
  const all = [...document.querySelectorAll('details')];
  const was = all.map(d => d.open);
  all.forEach(d => { d.open = true; });
  all.forEach(d => {
    const head = (d.querySelector('summary')?.innerText || '').replace(/\s+/g, ' ').trim();
    const body = (d.innerText || '').replace(/\s+/g, ' ').trim();
    // A fold that holds other folds is a drawer, not a scroll: what it costs
    // the reader is its own prose, so the nested folds come back off. Counting
    // them made the band "הכנות לפני הנסיעה" look like 14,000 characters when
    // it shows six lines and a list of summaries.
    let nested = 0;
    d.querySelectorAll('details').forEach(k => {
      nested += (k.innerText || '').replace(/\s+/g, ' ').trim().length;
    });
    const n = body.length - head.length - nested;
    if (n > limit) out.push(head.slice(0, 45) + ' (' + n + ')');
  });
  all.forEach((d, i) => { d.open = was[i]; });
  document.querySelectorAll('div.modal[id]').forEach(d => { d.style.display = 'none'; });
  return out;
}, FOLD_LIMIT);
if (fatFolds.length)
  fail('no fold hides more than ' + FOLD_LIMIT + ' characters',
       'split these: ' + fatFolds.join(' · '));
else ok();

// ── 12g. a dead session is never mistaken for a missing permission ──────
// On 9 November Yossi, an admin, could not delete posts from his phone -
// not even his own. The page said "אין לך הרשאה". His permissions were
// fine: getAuthToken() answered with the publishable key whenever there was
// no session, so the DELETE left signed as a passing stranger and RLS
// refused it, correctly. These pin the two halves: nothing unsigned goes
// out, and the person is told what actually happened.
const deadSession = await page.evaluate(async () => {
  // The container has no Supabase client, so getSB() would return null and
  // getAuthToken would answer from its first line - never reaching the line
  // that held the bug. A stub client that reports NO session puts the page
  // in exactly the state his phone was in, and makes the real line run.
  const noClient = (typeof _sb === 'undefined') ? null : _sb;
  _sb = { auth: { getSession: async () => ({ data: { session: null } }) } };
  const tok = await getAuthToken();
  if (tok !== '') {
    _sb = noClient;
    return 'getAuthToken answers with ' +
      (tok === SUPABASE_KEY ? 'the publishable key' : 'something') +
      ' when there is no session';
  }

  const sent = [];
  const realFetch = window.fetch;
  window.fetch = function (u, o) {
    sent.push(String(u) + ' ' + ((o && o.method) || 'GET'));
    return Promise.resolve({ ok: true, status: 200, json: async () => [],
                             text: async () => '' });
  };
  const realOpen = window.openM; window.openM = function () {};
  user = { name: 'דוד', sbId: 'abc', isAdmin: true };
  try { localStorage.setItem('skiUser', JSON.stringify(user)); } catch (e) {}

  let box = document.getElementById('forum-msg');
  if (!box) { box = document.createElement('div'); box.id = 'forum-msg';
              document.body.appendChild(box); }
  box.textContent = '';

  try { await confirmDelPost('123'); } catch (e) { /* reported below */ }

  const msg = box.textContent;
  const writes = sent.filter(x => / (DELETE|PATCH|POST)$/.test(x));
  window.fetch = realFetch; window.openM = realOpen; _sb = noClient;

  if (writes.length)
    return 'an unsigned write still went out: ' + writes.join(', ');
  if (/הרשאה/.test(msg))
    return 'the message still blames the permissions: ' + msg;
  if (!/התחבר/.test(msg))
    return 'the message does not say the session ended: ' + (msg || '(nothing)');
  if (localStorage.getItem('skiUser'))
    return 'the stored user outlived the session it depended on';
  return 'ok';
});
if (deadSession !== 'ok')
  fail('a dead session is not reported as a missing permission', deadSession);
else ok();

// ── 12h. every write travels as a named person ──────────────────────────
// A write that calls getAuthToken directly is one that can still leave
// unsigned. These four are the ones that bit him.
const unsigned = await page.evaluate(() => {
  const bad = [];
  ['confirmDelPost', 'confirmDelReply', 'saveEditPost', 'saveEditReply', 'sbInsert']
    .forEach(name => {
      const fn = window[name];
      if (typeof fn !== 'function') { bad.push(name + ' is missing'); return; }
      const src = fn.toString();
      if (src.indexOf('requireAuth') === -1) bad.push(name + ' does not require a session');
    });
  return bad;
});
if (unsigned.length) fail('every write travels as a named person', unsigned.join(' · '));
else ok();

// ── 12i. signed out when the session is gone, not when the signal is ────
// Clearing the stored user on load is what stops the phone drawing admin
// buttons nothing can sign. But this app is used on a mountain, and
// getSession() also comes back empty when the refresh simply could not
// reach Supabase. Logging somebody out of a gondola would be the worse bug.
const offlineSafe = await page.evaluate(async () => {
  const noClient = (typeof _sb === 'undefined') ? null : _sb;
  const onlineDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
  const setOnline = v => Object.defineProperty(navigator, 'onLine',
                            { configurable: true, get: () => v });
  const restore = () => {
    try { delete navigator.onLine; } catch (e) {}
    if (onlineDesc) Object.defineProperty(Navigator.prototype, 'onLine', onlineDesc);
  };
  _sb = { auth: { getSession: async () => ({ data: { session: null } }) } };
  const seed = () => {
    user = { name: 'דוד', sbId: 'abc', isAdmin: true };
    try { localStorage.setItem('skiUser', JSON.stringify(user)); } catch (e) {}
  };
  let verdict = 'ok';

  seed(); setOnline(true);
  await checkSupabaseSession();
  if (user) verdict = 'a stored user survived a session that is really gone';

  if (verdict === 'ok') {
    seed(); setOnline(false);
    await checkSupabaseSession();
    if (!user) verdict = 'going offline signed the person out';
  }

  restore(); _sb = noClient;
  try { localStorage.removeItem('skiUser'); } catch (e) {}
  user = null;
  return verdict;
});
if (offlineSafe !== 'ok') fail('signed out by a dead session, not a dead signal', offlineSafe);
else ok();

// ── 12j. every checkbox in the enquiry actually asks something ──────────
// Nine boxes, three languages. A box wired to nothing looks identical to a
// box that works until the agency answers the wrong question.
const lsBoxes = await page.evaluate(async () => {
  openM('localStayModal');
  const ids = [...document.querySelectorAll('#localStayModal input[id^="ls-opt-"]')]
                .map(el => el.id);
  if (ids.length < 9) return 'only ' + ids.length + ' boxes found';
  const it = document.getElementById('ls-it');
  const he = document.getElementById('ls-he');
  ids.forEach(id => { document.getElementById(id).checked = false; });
  buildLocalStayMail();
  const base = { it: it.value.length, he: he.textContent.length };
  const dead = [];
  for (const id of ids) {
    const el = document.getElementById(id);
    el.checked = true; buildLocalStayMail();
    const grewIt = it.value.length > base.it;
    const grewHe = he.textContent.length > base.he;
    el.checked = false;
    if (!grewIt || !grewHe)
      dead.push(id + (grewIt ? ' (Hebrew only)' : grewHe ? ' (foreign only)' : ''));
  }
  // and the Hebrew mirror must carry the same number of questions as the letter
  ids.forEach(id => { document.getElementById(id).checked = true; });
  buildLocalStayMail();
  const nIt = (it.value.match(/,/g) || []).length;
  const nHe = (he.textContent.match(/,/g) || []).length;
  ids.forEach(id => { document.getElementById(id).checked = false; });
  buildLocalStayMail();
  document.getElementById('localStayModal').style.display = 'none';
  if (dead.length) return 'these boxes change nothing: ' + dead.join(' · ');
  if (Math.abs(nIt - nHe) > 1)
    return 'the Hebrew mirror lists a different number of questions (' + nHe + ' vs ' + nIt + ')';
  return 'ok';
});
if (lsBoxes !== 'ok') fail('every box in the apartment enquiry asks something', lsBoxes); else ok();

// ── 12k. no sentence travels that the reader has not seen checked ───────
// The pre-written Italian is right because it was written by hand. The
// reader's own sentence is not, so it reaches the letter only while the
// translation on file is of THAT text, INTO the language now chosen.
const lsExtra = await page.evaluate(async () => {
  openM('localStayModal');
  const ta = document.getElementById('ls-extra');
  const it = document.getElementById('ls-it');
  const real = window._lsAsk;
  let asked = 0;
  window._lsAsk = async (text, to) => { asked++;
    return to === 'he' ? 'חזרה לעברית' : 'FRASE-TRADOTTA'; };
  const done = v => { window._lsAsk = real;
                      document.getElementById('localStayModal').style.display = 'none';
                      return v; };

  document.querySelector('input[name="ls-lang"][value="it"]').checked = true;
  ta.value = 'האם יש מיטת תינוק?';
  _lsExtraChanged();
  if (it.value.indexOf('FRASE-TRADOTTA') !== -1)
    return done('an untranslated sentence is already in the letter');

  await lsTranslateExtra(null);
  if (asked < 2) return done('no back-translation was asked for');
  if (it.value.indexOf('FRASE-TRADOTTA') === -1)
    return done('the translated sentence never reached the letter');
  const back = document.getElementById('ls-extra-back');
  if (back.style.display === 'none' || back.textContent.indexOf('חזרה לעברית') === -1)
    return done('the reader is never shown what the sentence says back in Hebrew');

  // edited after translating - what is on file is no longer what is in the box
  ta.value = 'האם יש מיטת תינוק, ובאיזה מחיר?';
  _lsExtraChanged();
  if (it.value.indexOf('FRASE-TRADOTTA') !== -1)
    return done('an edited sentence still travels under the old translation');

  // translated, then the language changed under it
  ta.value = 'האם יש מיטת תינוק?';
  _lsExtraChanged();
  await lsTranslateExtra(null);
  document.querySelector('input[name="ls-lang"][value="en"]').checked = true;
  buildLocalStayMail();
  if (it.value.indexOf('FRASE-TRADOTTA') !== -1)
    return done('an Italian sentence travelled inside an English letter');

  ta.value = ''; _lsExtraChanged();
  document.querySelector('input[name="ls-lang"][value="it"]').checked = true;
  buildLocalStayMail();
  return done('ok');
});
if (lsExtra !== 'ok') fail('nothing travels unchecked in the apartment enquiry', lsExtra); else ok();

// ── 12l. the heading describes what the panel does ──────────────────────
// It used to say "ממלאים בעברית, יוצא באיטלקית". Nothing was filled in in
// Hebrew: it was dates, a number, a radio and four boxes.
const lsHead = await page.evaluate(() => {
  // The headings are <summary> now that the panel is four drawers; the
  // question this asks is the same one, so it reads both.
  const h = [...document.querySelectorAll('#localStayModal h4, #localStayModal summary')]
              .map(x => x.textContent).join(' | ');
  if (/ממלאים בעברית/.test(h)) return 'the heading still claims the reader writes Hebrew';
  if (!/פנייה/.test(h)) return 'no heading names the enquiry: ' + h;
  return 'ok';
});
if (lsHead !== 'ok') fail('the enquiry heading says what the panel does', lsHead); else ok();

// ── 12n. the useful drawer is the open one, and it is first ────────────
// The panel was three phone screens with no fold anywhere, and the enquiry
// generator - the only thing here a reader cannot get elsewhere - sat LAST,
// under three lists of links. Order and default state are the whole fix.
const lsOrder = await page.evaluate(() => {
  openM('localStayModal');
  const m = document.getElementById('localStayModal');
  const folds = [...m.querySelectorAll(':scope .modal-content > details')];
  if (folds.length < 4) return 'only ' + folds.length + ' drawers in the panel';
  const head = folds.map(d => (d.querySelector('summary')?.textContent || '').trim());
  if (!/פנייה/.test(head[0]))
    return 'the enquiry is not first - first is: ' + head[0];
  if (!folds[0].open) return 'the enquiry drawer starts closed';
  if (folds.slice(1).some(d => d.open))
    return 'a link list starts open as well, so the panel is still a scroll';
  // opening one must not hide the others
  const visible = folds.filter(d => d.querySelector('summary').offsetParent !== null).length;
  if (visible < 4) return 'only ' + visible + ' headings are on screen at once';
  m.style.display = 'none';
  return 'ok';
});
if (lsOrder !== 'ok') fail('the apartment panel opens on the part that does work', lsOrder); else ok();

// ── 12q. the stay is one range, not two boxes ──────────────────────────
// Two <input type="date"> boxes knew nothing about each other: Yossi set
// the arrival to January 2027 and the departure box still offered today.
const lsDates = await page.evaluate(() => {
  openM('localStayModal');
  if (document.getElementById('ls-from') || document.getElementById('ls-to'))
    return 'the two separate date boxes are back';
  const el = document.getElementById('ls-dates');
  if (!el) return 'there is no date field';
  if (el.type !== 'text' || !el.readOnly)
    return 'the range field is typed into rather than picked';
  setLocalStayDates('2027-02-07', '2027-02-14');
  if (el.getAttribute('data-ci') !== '2027-02-07' ||
      el.getAttribute('data-co') !== '2027-02-14')
    return 'the field did not keep the dates it was given';
  // It is no good having the dates only in the attributes: flatpickr parses
  // a string with the field's own 'j בF' format, so an ISO string failed
  // silently and the box sat empty while the letter carried the dates.
  if (!el.value || !/\d/.test(el.value))
    return 'the field shows nothing after being given dates: "' + el.value + '"';
  const it = document.getElementById('ls-it').value;
  if (it.indexOf('07/02/2027') === -1 || it.indexOf('14/02/2027') === -1)
    return 'the letter does not carry the picked dates';
  if (!/7 notti|7 nights/.test(it)) return 'the letter miscounts the nights';
  document.getElementById('localStayModal').style.display = 'none';
  return 'ok';
});
if (lsDates !== 'ok') fail('the stay is picked as one range', lsDates); else ok();

// ── 12o. the drawn routes match what Yossi marked ──────────────────────
// The piste map is a hand-drawn panorama, not a projection, so nothing can
// be computed onto it. Yossi clicked each route on the real sheet and the
// line was fitted to the artwork between his points. These pin the data.
const routeData = await page.evaluate(() => {
  const rm = _texts.pistes.route_map;
  const rd = rm && rm.routes_drawn;
  if (!rd) return 'no routes_drawn in texts.json';
  const want = ['grand_tour', 'warmup', 'ventina'];
  for (const id of want) {
    const r = rd[id];
    if (!r) return id + ' is missing';
    if (!r.title || !r.sub) return id + ' has no title or subtitle';
    if (!r.layers || !r.layers.length) return id + ' has no drawn layer';
    for (const l of r.layers) {
      if (!/^(ski|lift|alt|mixed)$/.test(l.kind)) return id + ': unknown layer kind ' + l.kind;
      if (!/^#[0-9a-f]{6}$/i.test(l.c))           return id + ': ' + l.kind + ' has no colour';
      if (!l.d || l.d.length < 60)                return id + ': ' + l.kind + ' has no path';
      // every coordinate has to land on the sheet, or it draws off-map
      const nums = l.d.match(/-?\d+(\.\d+)?/g).map(Number);
      for (let i = 0; i < nums.length; i += 2) {
        if (nums[i] < 0 || nums[i] > rm.page.w) return id + ': an x of ' + nums[i] + ' is off the page';
        if (nums[i+1] < 0 || nums[i+1] > rm.page.h) return id + ': a y of ' + nums[i+1] + ' is off the page';
      }
    }
  }
  // the one that carries lifts, skiing and a branch
  const kinds = rd.ventina.layers.map(l => l.kind).sort().join(',');
  if (kinds !== 'alt,lift,ski') return 'the Ventina lost a layer: ' + kinds;
  return 'ok';
});
if (routeData !== 'ok') fail('the drawn routes are whole and on the sheet', routeData); else ok();

const routePaint = await page.evaluate(async () => {
  // pdf.js comes from a CDN and this container has no network, so the canvas
  // is stood in for. The painter only ever reads its box.
  const wrap = document.getElementById('map-pdf-wrap');
  let c = document.getElementById('map-pdf-canvas');
  if (!c) { c = document.createElement('canvas'); c.id = 'map-pdf-canvas'; wrap.appendChild(c); }
  c.style.width = '1818px'; c.style.height = '1459px';
  const rm = _texts.pistes.route_map;
  _mapCurrentType = rm.map;
  mapShowRoute('grand_tour');
  const svg = document.getElementById('map-route-layer');
  if (!svg) return 'no overlay was created';
  if (svg.style.display === 'none') return 'the overlay stayed hidden on the right sheet';
  if (svg.getAttribute('viewBox') !== '0 0 ' + rm.page.w + ' ' + rm.page.h)
    return 'the viewBox is not the pdf page, so the lines will not follow a zoom';
  if (svg.style.width !== c.style.width || svg.style.height !== c.style.height)
    return 'the overlay is not the size of the canvas';
  const n = svg.querySelectorAll(':scope > path').length;
  if (n !== rm.routes_drawn.grand_tour.layers.length)
    return 'drew ' + n + ' paths for ' + rm.routes_drawn.grand_tour.layers.length + ' layers';
  // the subtitle has to follow the route that is showing
  if (!document.getElementById('map-route-sub').textContent.includes(rm.routes_drawn.grand_tour.title))
    return 'the caption does not name the route on screen';
  mapShowRoute('ventina');
  if (document.getElementById('map-route-layer').querySelectorAll(':scope > path').length
      !== rm.routes_drawn.ventina.layers.length)
    return 'switching route did not redraw the lines';
  _mapCurrentType = 'piste-swiss';
  _mapPaintRoute();
  if (svg.style.display !== 'none') return 'the lines stayed on after switching sheet';
  _mapCurrentType = rm.map; mapShowRoute('ventina');
  if (document.getElementById('map-route-layer').style.display !== 'none')
    return 'pressing the same route again did not clear it';
  return 'ok';
});
if (routePaint !== 'ok') fail('the lines ride the sheet and only that sheet', routePaint); else ok();

const routeCaption = await page.evaluate(() => {
  const cap = document.getElementById('map-route-caption');
  if (!cap) return 'there is no caption';
  // and the panel's own legend follows the route on screen, same rule
  const rd = _texts.pistes.route_map.routes_drawn;
  for (const id of Object.keys(rd)) {
    mapShowRoute(id);
    const leg = document.getElementById('map-route-legend').innerHTML;
    for (const l of rd[id].layers) {
      if (!leg.includes('color:' + l.c + ';'))
        return id + ': the panel legend is missing ' + l.kind + ' in ' + l.c;
    }
    mapShowRoute(id);
  }
  // leave one lit: the legend only exists while a route is showing
  mapShowRoute('grand_tour');
  const t = cap.textContent;
  // It used to have to say these were NOT the piste line. They are now, so
  // what it must explain instead is which colour means what.
  if (/אינו קו הגלישה|לא קו הגלישה/.test(t))
    return 'the caption still apologises for not being the piste line';
  if (!/גלישה/.test(t) || !/רכבל/.test(t))
    return 'the caption does not say which colour is skiing and which is a lift';
  return 'ok';
});
if (routeCaption !== 'ok') fail('the caption explains the colours', routeCaption); else ok();

const routeButtons = await page.evaluate(() => {
  const ids = [...document.querySelectorAll('.map-route-btn')].map(b => b.getAttribute('data-route'));
  const want = Object.keys(_texts.pistes.route_map.routes_drawn);
  const missing = want.filter(w => !ids.includes(w));
  return missing.length ? 'no button for: ' + missing.join(', ') : 'ok';
});
if (routeButtons !== 'ok') fail('every drawn route has a button', routeButtons); else ok();

// ── 12p. the route card shows the mountain, not a diagram ──────────────
// It used to draw a schematic from OpenStreetMap polylines - an abstraction
// with no mountain in it, sitting under a card that already carried the
// length, the drop and the prose. Yossi: "במקום הציורים הפרימיטיביים".
const routeCard = await page.evaluate(() => {
  const rd = _texts.pistes.route_map.routes_drawn;
  const bad = [];
  for (const id of Object.keys(rd)) {
    const html = _routeMapSvg({ id: id, title: rd[id].title });
    if (!html) { bad.push(id + ': the card draws nothing'); continue; }
    if (!html.includes('maps/route-' + id + '.jpg'))
      bad.push(id + ': the card does not show its map crop');
    if (!/routeToMap\('/.test(html))
      bad.push(id + ': tapping the map does not open the full sheet');
    // The legend has to name the colours THIS route is drawn in. It was
    // hardcoded purple for skiing while the Ventina is green, so the card
    // told the reader the wrong colour and every test still passed.
    for (const l of rd[id].layers) {
      if (!html.includes('color:' + l.c + ';'))
        bad.push(id + ': the legend does not show ' + l.kind + ' in ' + l.c);
    }
    if (!/גלישה|המסלול/.test(html)) bad.push(id + ': no legend under the map');
  }
  // the schematic is gone, not merely unused
  if (/route_geom/.test(String(_routeMapSvg)))
    bad.push('the card still projects the OpenStreetMap polylines');
  return bad;
});
if (routeCard.length) fail('the route card shows the real map', routeCard.join(' · ')); else ok();

// and the pictures it points at have to exist
const routeImgs = await Promise.all(Object.keys(
  JSON.parse(fs.readFileSync(TEXTS, 'utf8')).pistes.route_map.routes_drawn
).map(async id => {
  const f = near('maps/route-' + id + '.jpg');
  if (!fs.existsSync(f)) return 'maps/route-' + id + '.jpg is missing';
  const kb = fs.statSync(f).size / 1024;
  if (kb < 20)  return 'maps/route-' + id + '.jpg is only ' + Math.round(kb) + ' KB';
  if (kb > 400) return 'maps/route-' + id + '.jpg is ' + Math.round(kb) + ' KB - too heavy for a card';
  return '';
}));
const imgBad = routeImgs.filter(Boolean);
if (imgBad.length) fail('every route card has its picture', imgBad.join(' · ')); else ok();

// ── 12m. the page never hands the model a prompt of its own ─────────────
// tf-translate runs on Yossi's Anthropic key, it is called with no apikey
// and no Authorization, and its URL is in the source of a public site. While
// it accepted a free-form `prompt` it was an LLM proxy anybody could spend
// his money through. The server owns both prompts now, and the page sends
// only data - so a `prompt` field reappearing here is the hole reopening.
const noPrompt = await page.evaluate(() => {
  const bad = [];
  ['cvTranslateLive', '_lsAsk'].forEach(name => {
    const fn = window[name];
    if (typeof fn !== 'function') { bad.push(name + ' is missing'); return; }
    const src = fn.toString();
    if (/prompt\s*:/.test(src)) bad.push(name + ' still posts a prompt');
    if (!/kind\s*:/.test(src))  bad.push(name + ' does not say what kind of request it is');
  });
  if (typeof cvBuildPrompt === 'function') bad.push('cvBuildPrompt is still in the page');
  return bad;
});
if (noPrompt.length) fail('the page sends data, not prompts', noPrompt.join(' · ')); else ok();

// ── 13. the transport tab renders whole ──────────────────────────────────
const tr = await page.evaluate(() => {
  const want = (window._texts.transport.groups || []).map(g => g.title);
  const body = document.getElementById('transport-body');
  if (!body) return 'no transport panel in the page';
  if (!body.innerHTML) renderTransport(window._texts.transport);
  const html = body.innerHTML;
  const missing = want.filter(t => html.indexOf(t) === -1);
  if (missing.length) return 'these cards did not render: ' + missing.join(' · ');
  if (html.indexOf('undefined') !== -1 || html.indexOf('[object') !== -1)
    return 'the panel contains undefined or [object Object]';
  return 'ok';
});
if (tr !== 'ok') fail('the transport tab renders every card', tr); else ok();

// its three tabs each show one panel and hide the others
const parkTabs = await page.evaluate(() => {
  if (typeof switchParkTab !== 'function') return 'switchParkTab is missing';
  const names = ['parking', 'transport', 'emergency'];
  for (const n of names) {
    switchParkTab(n);
    for (const m of names) {
      const el = document.getElementById('park-panel-' + m);
      if (!el) return 'no panel ' + m;
      const shown = el.style.display !== 'none';
      if (shown !== (m === n)) return `with ${n} open, ${m} was ${shown ? 'visible' : 'hidden'}`;
    }
  }
  return 'ok';
});
if (parkTabs !== 'ok') fail('road/transport/emergency tabs switch cleanly', parkTabs); else ok();

// ── you can zoom a map until you can read it, and get back out ────────────
// "All the area" is a sheet 3412pt across. Fitted to a phone that is an
// eighth of its size, so a flat 5x limit left the lettering unreadable. The
// limit is now set by a canvas budget instead, which must hold on every sheet
// and on every screen width.
{
  // page width, page height, and the pixel width of the image inside it
  const SHEETS = {
    'all the area': [3412.39, 2425.94, 6020],
    'cervinia':     [909.08, 729.71, 5682],
    'valtournenche':[869.67, 823.1, 5436],
    'swiss':        [1965.35, 1220.13, 6006]
  };
  const r = await page.evaluate((SHEETS) => {
    const out = [];
    for (const [name, [w, h, srcPx]] of Object.entries(SHEETS)) {
      for (const containerW of [410, 1400]) {
        const base = containerW / w;
        const ceil = _mapZoomCeiling({ width: w, height: h }, base);
        const scale = base * ceil;
        out.push({ name, containerW, ceil, mp: (w * scale) * (h * scale) / 1e6,
                   pctOfSource: (w * scale) / srcPx });
      }
    }
    return { out, budget: MAP_CANVAS_BUDGET() };
  }, SHEETS);
  if (!(r.budget > 1e6)) fail('a map zooms within its canvas budget',
    'the canvas budget did not come back as a number');
  else ok();
  const over = r.out.filter(x => x.mp > r.budget / 1e6 + 0.5);
  if (over.length) fail('a map zooms within its canvas budget',
    `${over[0].name} at ${over[0].containerW}px would need ${over[0].mp.toFixed(0)} megapixels`);
  else ok();
  // the big sheet has to go well past the old flat limit of 5x
  const phone = r.out.find(x => x.name === 'all the area' && x.containerW === 410);
  if (phone.ceil < 8) fail('a map zooms until it can be read',
    `the widest sheet still stops at ${phone.ceil.toFixed(1)}x on a narrow screen`);
  else ok();
  // and on a machine with a mouse, every sheet has to reach the detail that is
  // actually in the file - stopping at two thirds of it is what made the
  // piste list unreadable
  const short = r.out.filter(x => x.pctOfSource < 0.95);
  if (short.length) fail('a map zooms until it can be read',
    `${short[0].name} stops at ${Math.round(short[0].pctOfSource * 100)}% of the detail in the file`);
  else ok();
}

// ── full screen has a way back ────────────────────────────────────────────
// The toolbar lives outside the container, so going full screen used to take
// every control away with it - no zoom, and on a phone no way back at all.
{
  const r = await page.evaluate(async () => {
    const c = () => getComputedStyle(document.getElementById('map-fs-controls')).display;
    openM('mapModal');
    const before = c();
    mapFullscreen();
    await new Promise(r => setTimeout(r, 250));
    const during = c();
    mapExitFullscreen();
    await new Promise(r => setTimeout(r, 150));
    const after = c();
    const stuck = document.getElementById('map-container').classList.contains('map-faux-full');
    closeMapModal();
    return { before, during, after, stuck };
  });
  if (r.before !== 'none' || r.during === 'none') fail('full screen has a way back',
    `the controls were "${r.before}" before and "${r.during}" during`);
  else ok();
  if (r.after !== 'none' || r.stuck) fail('full screen has a way back',
    'leaving full screen left the controls or the layout behind');
  else ok();
}

// ── no markup leaks into the text as text ─────────────────────────────────
// A field that carries a <b> and is then escaped prints the tag itself. It
// happened in the ski-pass legend, where the chip is already set in bold by
// its own markup.
{
  const leaked = await page.evaluate(() => {
    if (typeof renderSkipassAges === 'function') renderSkipassAges();
    const ids = ['skipass-legend-cervinia', 'skipass-legend-zermatt',
                 'skipass-discounts-list', 'kosher-products-list',
                 'transport-body', 'season-box'];
    const bad = [];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el && /&lt;\/?[a-zA-Z]|<[a-zA-Z]+>(?=[^<]*<\/)/.test(el.innerHTML) === false) {
        if (/<[a-z]+>|<\/[a-z]+>/i.test(el.innerText)) bad.push(id);
      } else if (el && /<[a-z]+>|<\/[a-z]+>/i.test(el.innerText)) bad.push(id);
    });
    return bad;
  });
  if (leaked.length) fail('no markup is printed as text',
    `a tag shows up as text inside: ${leaked.join(', ')}`);
  else ok();
}

// ── the counts in the bar say what the operator says ──────────────────────
// The headline used to be the figure for Cervinia alone, which the feed
// reports as 0 out of 0 - not a reading, just an absence with a slash in it.
// The operator's own front page counts the whole area, so that is the number
// in large type, and Cervinia follows in brackets when it says something.
{
  const r = await page.evaluate(() => {
    const read = () => ({
      slopes: document.getElementById('bar-slopes-local').textContent
            + document.getElementById('bar-slopes-global').textContent,
      lifts:  document.getElementById('bar-lifts-local').textContent
            + document.getElementById('bar-lifts-global').textContent
    });
    const feed = { slopes_open_global: 9, slopes_total_global: 109,
                   slopes_open_local: 0, slopes_total_local: 0,
                   lifts_open_global: 13, lifts_total_global: 47,
                   lifts_open_local: 4, lifts_total_local: 5 };
    const out = {};
    renderLiveBar(feed);                                    out.real = read();
    renderLiveBar(Object.assign({}, feed,
      { slopes_open_local: 4, slopes_total_local: 9 }));    out.withLocal = read();
    renderLiveBar(Object.assign({}, feed,
      { lifts_open_local: 9, lifts_total_local: 5 }));      out.impossible = read();
    renderLiveBar({});                                      out.empty = read();
    return out;
  });
  if (r.real.slopes !== '9/109') fail('the bar counts the whole area first',
    `the feed says 9 of 109 open, the bar says "${r.real.slopes}"`); else ok();
  if (r.real.lifts !== '13/47 (4/5)') fail('the bar counts the whole area first',
    `lifts came back as "${r.real.lifts}"`); else ok();
  if (!/\(4\/9\)/.test(r.withLocal.slopes)) fail('the bar counts the whole area first',
    `a real local figure was dropped: "${r.withLocal.slopes}"`); else ok();
  if (/\(/.test(r.impossible.lifts)) fail('the bar counts the whole area first',
    `9 open out of 5 was printed anyway: "${r.impossible.lifts}"`); else ok();
  if (r.empty.slopes !== '--' || r.empty.lifts !== '--') fail('the bar counts the whole area first',
    `with no feed at all it showed "${r.empty.slopes}" and "${r.empty.lifts}"`); else ok();

  // the caption has to describe the numbers that are on the screen: it used
  // to promise "whole area (Cervinia)" on a line with no Cervinia figure
  const cap = await page.evaluate(() => {
    const read = () => ({
      slopes: document.getElementById('bar-slopes-scope').textContent.trim(),
      lifts:  document.getElementById('bar-lifts-scope').textContent.trim(),
      slopeBracket: /\(/.test(document.getElementById('bar-slopes-global').textContent),
      liftBracket:  /\(/.test(document.getElementById('bar-lifts-global').textContent)
    });
    const feed = { slopes_open_global: 9, slopes_total_global: 109,
                   slopes_open_local: 0, slopes_total_local: 0,
                   lifts_open_global: 13, lifts_total_global: 47,
                   lifts_open_local: 4, lifts_total_local: 5 };
    const out = {};
    renderLiveBar(feed); out.real = read();
    renderLiveBar(Object.assign({}, feed,
      { slopes_open_local: 4, slopes_total_local: 9 })); out.withLocal = read();
    renderLiveBar({}); out.empty = read();
    return out;
  });
  const agrees = (c) => (c.slopes.indexOf('(') > -1) === c.slopeBracket
                     && (c.lifts.indexOf('(') > -1) === c.liftBracket;
  if (!agrees(cap.real)) fail('the caption matches the numbers',
    `caption "${cap.real.slopes}" but brackets ${cap.real.slopeBracket}`); else ok();
  if (!agrees(cap.withLocal)) fail('the caption matches the numbers',
    'with a local figure present the caption did not mention it'); else ok();
  if (cap.empty.slopes || cap.empty.lifts) fail('the caption matches the numbers',
    'with no feed at all the caption still described a scope'); else ok();

  // "13/47 (4/5)" is unreadable on its own - he said so - so the cell also
  // carries the sentence in full, for a hover and for a screen reader
  const tip = await page.evaluate(() => {
    const read = () => ({
      slopes: document.getElementById('bar-slopes-cell').getAttribute('title') || '',
      lifts:  document.getElementById('bar-lifts-cell').getAttribute('title') || ''
    });
    const feed = { slopes_open_global: 9, slopes_total_global: 109,
                   slopes_open_local: 0, slopes_total_local: 0,
                   lifts_open_global: 13, lifts_total_global: 47,
                   lifts_open_local: 4, lifts_total_local: 5 };
    const out = {};
    renderLiveBar(feed); out.real = read();
    renderLiveBar({});   out.empty = read();
    return out;
  });
  if (!/13 מתוך 47/.test(tip.real.lifts) || !/4 מתוך 5/.test(tip.real.lifts))
    fail('the counts are spelled out in full somewhere',
      `the lifts cell explains itself as "${tip.real.lifts}"`); else ok();
  if (!/9 מתוך 109/.test(tip.real.slopes) || /מתוך 0/.test(tip.real.slopes))
    fail('the counts are spelled out in full somewhere',
      `the slopes cell explains itself as "${tip.real.slopes}"`); else ok();
  if (tip.empty.slopes || tip.empty.lifts)
    fail('the counts are spelled out in full somewhere',
      'with no feed at all a stale explanation was left behind'); else ok();

  // "4/5" reads as "Cervinia has five lifts" unless the denominator is named
  // for what it is - the lifts running this period, not the resort's stock
  if (!/מופעלים בתקופה/.test(tip.real.lifts) || !/מופעלים בתקופה/.test(tip.real.slopes))
    fail('the counts say what the denominator is',
      `the explanation reads "${tip.real.lifts}"`); else ok();

  // and the same sentence has to be reachable by tapping, not only by hover,
  // because most of the readers are on a phone
  const tap = await page.evaluate(() => ['bar-lifts-cell', 'bar-slopes-cell'].map(id => {
    const el = document.getElementById(id);
    return el ? (el.getAttribute('onclick') || '') + '|' + el.style.cursor : null;
  }));
  if (!tap.every(t => t && /helpModal/.test(t) && /pointer/.test(t)))
    fail('the counts say what the denominator is',
      `the cells are not tappable: ${JSON.stringify(tap)}`); else ok();

  // the answer it opens on has to carry the correction, not the old wording
  const faq = await page.evaluate(() =>
    [...document.querySelectorAll('#helpModal p')].map(p => p.innerText).join(' ')
  );
  if (!/אינו סך כל המעליות/.test(faq))
    fail('the counts say what the denominator is',
      'the help answer still lets the reader read the total as the resort size'); else ok();
}

// ── the crossing to Zermatt says which kind of crossing is open ───────────
// The Matterhorn Alpine Crossing is a cable-car link that runs the year
// round, so the operator can report it open on a day with no piste open at
// all - that is not a contradiction, and overruling it was a mistake. But
// "open" alone invites a reader to plan a ski crossing that is not on, so the
// badge distinguishes the two.
{
  const r = await page.evaluate(() => {
    // An exception here kills the whole run and hides every assertion after
    // it - which is exactly what happened when the summer mode wiped this
    // element and never put it back. A missing element is a finding, not a
    // crash.
    const read = () => {
      const el = document.getElementById('zermatt-status');
      return el ? el.textContent.trim() : '<<missing>>';
    };
    const base = { temperature: 3, opening_hours: '08:00 - 16:45' };
    const out = {};
    renderLiveBar(Object.assign({}, base,
      { zermatt_link: 'OPEN', slopes_open_local: 0, slopes_open_global: 0 }));
    out.liftOnly = read();
    renderLiveBar(Object.assign({}, base,
      { zermatt_link: 'OPEN', slopes_open_local: 12, slopes_open_global: 40 }));
    out.skiable = read();
    renderLiveBar(Object.assign({}, base,
      { zermatt_link: 'CLOSED', slopes_open_local: 12, slopes_open_global: 40 }));
    out.closed = read();
    return out;
  });
  if (r.liftOnly !== 'רכבל בלבד') fail('the crossing says which kind it is',
    `open with no piste open showed "${r.liftOnly}" - it should say the lift link only`);
  else ok();
  if (r.skiable !== 'פתוח') fail('the crossing says which kind it is',
    `a skiable day showed "${r.skiable}"`); else ok();
  if (r.closed !== 'סגור') fail('the crossing says which kind it is',
    `a closed crossing showed "${r.closed}"`); else ok();
}

// ── the maps panel lets go of what it started ─────────────────────────────
// A map is a large download. Closing the panel has to stop it, or the next
// visit opens on a spinner that will never finish, with nothing behind it.
{
  const r = await page.evaluate(async () => {
    // On a machine with a network this would fetch pdf.js and a multi-megabyte
    // map, which is not what is under test here and makes the run slow and
    // flaky. The loader is stood down for the duration.
    const realLoader = window._loadPdfJs;
    window._loadPdfJs = function () {};
    const ph = () => document.getElementById('map-placeholder').innerText.replace(/\s+/g, ' ').trim();
    const marked = () => [...document.querySelectorAll('.map-pick')]
      .filter(b => b.style.background).map(b => b.getAttribute('data-map'));
    openM('mapModal');
    const onOpen = ph();
    loadMap('piste-cervinia');
    const loadingMark = marked().join();
    closeMapModal();
    const afterClose = ph(), afterMark = marked().join();
    openM('mapModal');
    const onReopen = ph();
    closeMapModal();
    window._loadPdfJs = realLoader;
    return { onOpen, loadingMark, afterClose, afterMark, onReopen };
  });
  if (!/בחר מפה/.test(r.onOpen)) fail('the maps panel opens at rest',
    `it opened saying "${r.onOpen}"`); else ok();
  if (r.loadingMark !== 'piste-cervinia') fail('the chosen map is marked',
    `the marked button was "${r.loadingMark}"`); else ok();
  if (!/בחר מפה/.test(r.afterClose) || !/בחר מפה/.test(r.onReopen))
    fail('closing the maps panel cancels the download',
      `reopening showed "${r.onReopen}" - a load was left running`); else ok();
  if (r.afterMark !== '') fail('closing the maps panel cancels the download',
    'a button stayed marked after the panel closed'); else ok();
}

// ── the verdict on a chosen week ──────────────────────────────────────────
// The verdict is only ever a count of how the days fall across periods a
// human wrote, so the thing that can go wrong is the arithmetic and the
// promise: a move offered as clearing the crowd has to actually clear it.
{
  const r = await page.evaluate(() => {
    const el = document.getElementById('season-hint');
    const say = (a, b) => { seasonHint(a, b); return el.innerText; };
    const out = {};
    out.peak   = say('2026-12-26', '2027-01-02');
    out.best   = say('2027-03-12', '2027-03-19');
    out.closed = say('2027-06-01', '2027-06-08');
    // a shift that claims to clear the crowd, checked against the tally
    const sh = _seasonBetterShift('2026-12-26', '2027-01-02');
    out.shiftClean = sh && sh.clean ? _seasonTally(sh.from, sh.to).busy : -1;
    out.plural = [1, 2, 5].map(n => _seasonDaysHe(n));
    out.leftover = /\{\w+\}/.test(out.peak + out.best + out.closed);
    return out;
  });
  const V = T.season.verdict;
  if (!r.peak.includes(V.busy.label))   fail('the verdict reads the week right',
    'Christmas week did not come back as a crowded one');  else ok();
  if (!r.best.includes(V.good.label))   fail('the verdict reads the week right',
    'mid-March did not come back as a good week');          else ok();
  if (!r.closed.includes(V.closed.label)) fail('the verdict reads the week right',
    'a week in June was not reported as out of season');     else ok();
  if (r.shiftClean !== 0) fail('a suggested move keeps its promise',
    `it offered a move "out of the crowd" that still has ${r.shiftClean} crowded days`);
  else ok();
  if (r.plural.join('|') !== 'יום אחד|יומיים|5 ימים') fail('the verdict reads the week right',
    `days are counted as: ${r.plural.join(', ')}`);          else ok();
  if (r.leftover) fail('the verdict reads the week right',
    'an unfilled {placeholder} reached the screen');         else ok();
}

// ── "install" can still be found after the banner is gone ─────────────────
// The banner shows once, and a tap on the X sets a flag that keeps it away
// for good. If the only way in disappears with it, the offline copy - the
// whole point of the thing on a mountain - is unreachable. It also has to
// survive _applyTexts, which rewrites the help panel's FAQ wholesale.
{
  const r = await page.evaluate(() => {
    localStorage.setItem('pwaDismissed', '1');
    _applyTexts(window._texts);                 // the rewrite that ate it once
    openM('helpModal');
    const el = document.getElementById('help-install');
    const txt = el ? el.innerText : '';
    closeM('helpModal');
    const box = document.getElementById('global-search-results');
    globalSearch('התקנה');
    const hits = box.querySelectorAll('div[onclick]').length;
    globalSearch('');
    localStorage.removeItem('pwaDismissed');
    return { present: !!el, txt, hits };
  });
  if (!r.present) fail('install can be found again',
    'the help panel has no install section - _applyTexts probably overwrote it');
  else ok();
  if (!/בלי קליטה/.test(r.txt)) fail('install can be found again',
    'the section does not say what installing is actually for');
  else ok();
  if (!r.hits) fail('install can be found again',
    'searching for "התקנה" finds nothing');
  else ok();
}

// ── the search bar knows what the site holds ──────────────────────────────
// Every panel is reachable by a button, but only what the index names is
// reachable by typing. A section nobody can find is a section nobody has.
{
  const r = await page.evaluate(() => {
    const box = document.getElementById('global-search-results');
    const hits = (q) => { globalSearch(q); return box.querySelectorAll('div[onclick]').length; };
    const words = ['מתי', 'עונה', 'שלג', 'אוטובוס', 'נחתתי', 'שרשראות', 'מונית', 'תחבורה'];
    const missed = words.filter(w => hits(w) === 0);
    // every entry's action has to name something that exists
    const broken = SEARCH_INDEX.map(i => i.action)
      .map(a => (String(a).match(/^([A-Za-z_$][\w$]*)\s*\(/) || [])[1])
      .filter(fn => fn && typeof window[fn] !== 'function');
    globalSearch('');
    return { missed, broken };
  });
  if (r.missed.length) fail('the search bar finds the newer sections',
    `nothing comes back for: ${r.missed.join(', ')}`);
  else ok();
  if (r.broken.length) fail('the search bar finds the newer sections',
    `an entry calls ${r.broken.join(', ')}, which does not exist`);
  else ok();
  // The season table was a fold inside the planner's single column, and this
  // checked that the search prised it open. It is a screen of its own now, so
  // what matters is that the entry lands on that screen with the table on it -
  // no fold left to open, and nothing else showing beside it.
  const deep = await page.evaluate(async () => {
    openWhenToGo();
    await new Promise(r => setTimeout(r, 400));
    const pane = document.getElementById('pane-when');
    const box  = document.getElementById('season-box');
    const out = {
      onScreen: !!(pane && getComputedStyle(pane).display !== 'none'),
      hasTable: !!(box && box.textContent.trim().length > 200),
      noFold:   !document.querySelector('#season-box details'),
      alone:    ['pane-prep', 'pane-search'].every(id => {
        const e = document.getElementById(id);
        return e && getComputedStyle(e).display === 'none';
      })
    };
    closeM('hotelModal');
    return out;
  });
  const TW = 'the search bar finds the newer sections';
  if (!deep.onScreen) fail(TW, '"when to go" no longer lands on its own screen'); else ok();
  if (!deep.hasTable) fail(TW, '"when to go" lands on an empty screen'); else ok();
  if (!deep.noFold) fail(TW,
    'the season table is a fold again, so the screen opens showing a heading ' +
    'and one closed row'); else ok();
  if (!deep.alone) fail(TW, '"when to go" shows another screen alongside it'); else ok();
}

// ── the date picker's season hint ─────────────────────────────────────────
// The picker hands over Date objects and everything else holds plain
// YYYY-MM-DD. A string compared against a Date matches nothing and the hint
// just does not appear, which looks like no hint being due.
{
  const r = await page.evaluate(() => {
    const el = document.getElementById('season-hint');
    const run = (a, b) => { seasonHint(a, b); return el.innerText.trim(); };
    const mid = (p) => { const f = p.from.split('-'), t = p.to.split('-');
      return [new Date(+f[0], +f[1] - 1, +f[2]), new Date(+t[0], +t[1] - 1, +t[2])]; };
    const p = window._texts.season.periods[0];
    const [d1, d2] = mid(p);
    return {
      asText:  run(p.from, p.to).length > 0,
      asDate:  run(d1, d2).length > 0,
      // out of season names no period, only the verdict
      quietWhenOutside: !/\u05d2\u05e9\u05e8 \u05d4\u05d0\u05d9\u05de\u05e7\u05d5\u05dc\u05d8\u05d4|Settimana|\u05d0\u05de\u05e6\u05e2 \u05de\u05e8\u05e5/.test(run('2027-07-01', '2027-07-08'))
    };
  });
  if (!r.asText) fail('the season hint fires', 'plain YYYY-MM-DD dates matched nothing');
  else ok();
  if (!r.asDate) fail('the season hint fires', 'Date objects from the picker matched nothing');
  else ok();
  if (!r.quietWhenOutside) fail('the season hint fires', 'a week in July still produced a hint');
  else ok();
}

// ── a round trip is one decision ──────────────────────────────────────────
// You cannot ride the bus up and conjure a car for the way back, so when one
// leg has no public transport the answer covers the whole trip. Either half
// may also be left empty, and then only that half is answered.
{
  const r = await page.evaluate(() => {
    const set = (id, v) => { document.getElementById(id).value = v || ''; };
    const run = (inD, inT, outD, outT, pax) => {
      set('ap-airport', 'mxp'); set('ap-pax', String(pax || 2));
      set('ap-date', inD); set('ap-time', inT);
      set('dp-date', outD); set('dp-time', outT);
      planTrip();
      return document.getElementById('ap-out').innerText;
    };
    return {
      both:     run('2027-01-10', '08:30', '2027-01-17', '19:00'),
      halfWay:  run('2027-01-10', '11:00', '2027-01-17', '08:00'),
      neither:  run('2027-01-12', '11:00', '2027-01-19', '19:00', 4),
      inOnly:   run('2027-01-10', '15:00', '', ''),
      outOnly:  run('', '', '2027-01-14', '21:00'),
      nothing:  run('', '', '', '')
    };
  });
  const want = [
    ['both',    /עובדת בשני הכיוונים/,  'two legs that both work were not called out as such'],
    ['halfWay', /עובדת בתחבורה ציבורית/, 'a trip with one dead leg got no combined verdict'],
    // the cheapest answer to one dead leg is usually a bus one way and a
    // single transfer the other, and it has to be offered rather than hidden
    // behind an all-or-nothing choice
    ['halfWay', /אפשר לשלב/,             'the mixed bus-and-transfer option was not offered'],
    ['halfWay', /אין חובה להחליט על כל הטיול/, 'it still framed this as a whole-trip decision'],
    ['neither', /בשני הכיוונים אין/,    'a trip with no bus either way was not called out'],
    ['inOnly',  /נחיתה ביום/,           'an arrival-only query lost its arrival'],
    ['outOnly', /טיסה ביום/,            'a return-only query lost its return'],
    ['nothing', /לפחות בכיוון אחד/,     'an empty form gave no guidance']
  ];
  want.forEach(([k, re, why]) => {
    if (!re.test(r[k])) fail('a round trip is judged as one decision', why); else ok();
  });
  // a one-way question must not sprout the other leg
  if (/טיסה ביום/.test(r.inOnly)) fail('a round trip is judged as one decision',
    'an arrival-only query answered about the return as well'); else ok();
  if (/נחיתה ביום/.test(r.outOnly)) fail('a round trip is judged as one decision',
    'a return-only query answered about the arrival as well'); else ok();
}

// ── one sentence, both legs ───────────────────────────────────────────────
{
  const r = await page.evaluate(() => {
    const pl = window._texts.transport.planner;
    const a = _apParse('נוחת במלפנסה 10 בינואר 3 אחה"צ. חוזר ב 15 בינואר ב 4 בבוקר', pl);
    const b = _apParse('חוזר ב 15 בינואר ב 4 בבוקר ממלפנסה', pl);
    const c = _apParse('נוחת במלפנסה ב-10 בינואר ב-14:00', pl);
    return { a, b, c };
  });
  if (r.a.time !== '15:00' || r.a.outTime !== '04:00' || !/01-15$/.test(r.a.outDate || ''))
    fail('one sentence can hold both legs',
      `got ${r.a.date} ${r.a.time} -> ${r.a.outDate} ${r.a.outTime}`);
  else ok();
  if (r.b.outTime !== '04:00' || r.b.time)
    fail('one sentence can hold both legs',
      'a return-only sentence was read as an arrival'); else ok();
  if (r.c.outDate || r.c.outTime)
    fail('one sentence can hold both legs',
      'an arrival-only sentence invented a return'); else ok();
}

// ── the journey home ──────────────────────────────────────────────────────
// The way back is the leg that breaks. The coach runs on four days of the
// week, the first one of the day leaves Châtillon at 2:25 - long before any
// local bus comes down the valley - and an early flight is simply not
// reachable by bus. Each of those has to be said plainly rather than guessed
// at by the reader.
{
  const r = await page.evaluate(() => {
    const run = (date, time, pax) => {
      document.getElementById('ap-airport').value = 'mxp';
      document.getElementById('ap-date').value = '';     // the return leg only
      document.getElementById('ap-time').value = '';
      document.getElementById('dp-date').value = date;
      document.getElementById('dp-time').value = time;
      document.getElementById('ap-pax').value = String(pax || 2);
      planTrip();
      return document.getElementById('ap-out').innerText;
    };
    const out = {
      sundayEvening: run('2027-01-10', '19:00'),   // works, with a long wait
      sundayMorning: run('2027-01-10', '08:00'),   // coach runs, nothing reaches it
      tuesday:       run('2027-01-12', '19:00'),   // no coach at all
      thursday:      run('2027-01-14', '21:00', 5),// a tight but real connection
      tooEarly:      run('2027-01-10', '06:00')    // first coach lands too late
    };
    return out;
  });
  const want = [
    ['sundayEvening', /11:25/,                 'the Sunday coach that works was not offered'],
    ['sundayMorning', /לא מגיעים אליו/,         'a coach nobody can reach was offered as an option'],
    ['tuesday',       /אינו פועל כלל/,          'Tuesday, when the line does not run, was not called out'],
    ['thursday',      /15:55/,                 "Thursday's own coach was missed"],
    ['thursday',      /חיבור צמוד/,             'a ten-minute change between two stations went unflagged'],
    ['tooEarly',      /לא הפעם/,                'a flight no bus can reach was not refused']
  ];
  want.forEach(([key, re, why]) => {
    if (!re.test(r[key])) fail('the journey home is worked out backwards', why);
    else ok();
  });
  // every answer must still offer the two that always work
  const missing = Object.entries(r).filter(([, txt]) =>
    !/הסעה פרטית/.test(txt) || !/ברכב שכור/.test(txt)).map(([k]) => k);
  if (missing.length) fail('the journey home is worked out backwards',
    `no fallback offered for: ${missing.join(', ')}`);
  else ok();
}

// ── the planner's two new controls ────────────────────────────────────────
// A reader left at Chatillon after the last bus up has one option left, and
// it has to be on the screen. And an answer that cannot be put away stays on
// the screen until the next search, which is not the same as being current.
{
  const r = await page.evaluate(() => {
    const set = (id, v) => { document.getElementById(id).value = v; };
    // Friday, landing 16:30: catches the 18:05 coach, reaches Chatillon at
    // 19:40, and the last bus up has gone at 19:35.
    set('ap-airport', 'mxp'); set('ap-date', '2027-01-08');
    set('ap-time', '16:30'); set('ap-pax', '3');
    planTrip();
    const out = document.getElementById('ap-out');
    const state = {
      taxi: /מונית/.test(out.innerText),
      resetShown: getComputedStyle(document.getElementById('ap-reset')).display !== 'none'
    };
    resetArrival();
    state.cleared = document.getElementById('ap-out').innerHTML === ''
                 && document.getElementById('ap-date').value === ''
                 && getComputedStyle(document.getElementById('ap-reset')).display === 'none';
    return state;
  });
  if (!r.taxi) fail('a taxi when the last bus has gone',
    'the planner left the reader at Chatillon with no way on');
  else ok();
  if (!r.resetShown) fail('the answer can be put away', 'no clear control appeared');
  else ok();
  if (!r.cleared) fail('the answer can be put away', 'clearing left the form or the answer behind');
  else ok();
}

// ── reading a landing out of a sentence ───────────────────────────────────
// Dates are relative to the day the suite runs, so the cases that say "today"
// or name a weekday are computed here rather than written down.
{
  const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
                   + '-' + String(d.getDate()).padStart(2, '0');
  const shift = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
  const nextDow = (want) => { const d = new Date();
    let add = (want - d.getDay() + 7) % 7; d.setDate(d.getDate() + (add === 0 ? 7 : add));
    return iso(d); };
  const CASES = [
    ['נוחת במלפנסה ב-10 בינואר ב-14:00, ארבעה נוסעים', { airport:'mxp', time:'14:00', pax:4 }],
    ['אני נוחת בטורינו ביום ראשון בשעה 9',             { airport:'trn', date:nextDow(0), time:'09:00' }],
    ['landing at Malpensa 15/01/2027 at 18:30, 5 passengers',
                                                       { airport:'mxp', date:'2027-01-15', time:'18:30', pax:5 }],
    ['מגיע לברגמו מחר ב-8 בערב',                       { airport:'bgy', date:shift(1), time:'20:00' }],
    ['לינאטה 3.2 ב-7:45 שני נוסעים',                   { airport:'lin', time:'07:45', pax:2 }],
    ['מלפנסה היום',                                     { airport:'mxp', date:shift(0) }],
    ['נוחת ב-14:00',                                    { airport:null, date:null, time:'14:00' }]
  ];
  const got = await page.evaluate((cs) => cs.map(c =>
      _apParse(c[0], window._texts.transport.planner)), CASES);
  CASES.forEach(([sentence, want], i) => {
    const bad = Object.keys(want).filter(k => (got[i][k] || null) !== (want[k] || null));
    if (bad.length) fail('a landing read out of a sentence',
      `"${sentence}" -> ${bad.map(k => k + '=' + got[i][k]).join(', ')}`);
    else ok();
  });
  // A bare day and month is the next time that date comes round, never the
  // one that has just gone.
  const fwd = await page.evaluate(() => {
    const r = _apParse('מלפנסה ב-1 בינואר ב-10:00', window._texts.transport.planner);
    return r.date && r.date >= new Date().toISOString().slice(0, 10);
  });
  if (!fwd) fail('a landing read out of a sentence', 'a bare date resolved into the past');
  else ok();
}

// ── the page can still render everything the content file holds ──────────
// A page rolled back to an older copy keeps passing its own tests: it is
// internally consistent, it has simply lost a section. The content file is
// what moves ahead, so each block in it is matched against the element that
// is supposed to show it. A block with nowhere to go means the two files
// have drifted apart - almost always a stale index.html.
{
  const WIRED = [
    ['kosher.cervinia_group',  'kosher-group-box',  (T) => T.kosher && T.kosher.cervinia_group],
    ['transport.groups',       'transport-body',    (T) => T.transport && T.transport.groups],
    ['transport.planner',      'arrival-planner',   (T) => T.transport && T.transport.planner],
    ['season.periods',         'season-box',        (T) => T.season && T.season.periods],
    ['pistes.routes',          'park-tab-transport',(T) => T.pistes && T.pistes.routes]
  ];
  for (const [block, id, has] of WIRED) {
    if (!has(T)) continue;
    const seen = await page.evaluate((i) => !!document.getElementById(i), id);
    if (!seen) fail('content file and page agree',
      `texts.json carries ${block} but index.html has no #${id} - the page is older than the content`);
    else ok();
  }
  const filled = await page.evaluate(() => {
    const e = document.getElementById('kosher-group-box');
    // textContent, not innerText: the card is folded away behind its heading
    // now, and innerText would only report the heading.
    return e ? (e.style.display !== 'none' && e.textContent.trim().length > 200) : false;
  });
  if (T.kosher && T.kosher.cervinia_group && !filled)
    fail('content file and page agree', 'the kosher group box exists but stayed empty or hidden');
  else ok();
}

// ── the live data bar on a desktop width ──────────────────────────────────
// Every cell is a value over a grey label. The opening-hours cell kept
// breaking that shape: a smaller value font made the cell taller, and
// centring lifted it off the line the other readings sit on. The group also
// used to hug its content and leave a dead strip before the Matterhorn.
//
// What is NOT asserted is that it all fits on one line. How wide the readings
// come out depends on the Hebrew fonts the machine happens to have, so a
// runner with wider fonts wraps where we do not - and wrapping is fine. What
// has to hold either way: cells sharing a line are level with each other, the
// gaps along a line are equal, and no dead strip is left over.
{
  const wide = await browser.newPage({ viewport: { width: 1440, height: 760 } });
  await wide.goto('file://' + PAGE);
  await wide.waitForTimeout(900);
  const r = await wide.evaluate((T) => {
    _applyTexts(T);
    const put = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    put('bar-temp', '-12°');  put('bar-slopes-local', '109'); put('bar-slopes-global', '(109/109)');
    put('bar-lifts-local', '47'); put('bar-lifts-global', '(47/47)');
    put('bar-wind', '123 km/h'); put('bar-gust', '123 km/h'); put('bar-snow', '215');
    put('bar-weather-desc', 'שלג כבד'); put('bar-hours', '08:00–16:45');
    const cn = document.getElementById('bar-closed-notice');
    if (cn) cn.style.display = 'inline-block';
    const lb = document.getElementById('bar-hours-label');
    const grp = document.querySelector('#live-data-bar > div > div:first-child');
    const right = document.querySelector('#live-data-bar > div > div:last-child');
    const kids = [...grp.children];
    const cells = kids.filter(e => !(e.getAttribute('style') || '').includes('width:1px'));

    // group the cells into the lines they actually render on
    const lines = {};
    cells.forEach(e => {
      const b = e.getBoundingClientRect();
      const key = Math.round(b.top / 8);
      (lines[key] = lines[key] || []).push(b.top);
    });
    const worstDrop = Math.max(...Object.values(lines)
      .map(tops => Math.max(...tops) - Math.min(...tops)));

    // gaps between neighbours that share a line
    const gaps = [];
    for (let i = 0; i < kids.length - 1; i++) {
      const a = kids[i].getBoundingClientRect(), c = kids[i + 1].getBoundingClientRect();
      if (Math.abs(a.top - c.top) < 3) gaps.push(Math.round(a.left - c.right));
    }
    return {
      worstDrop: Math.round(worstDrop),
      gapSpread: Math.max(...gaps) - Math.min(...gaps),
      slack: Math.round(grp.getBoundingClientRect().left - right.getBoundingClientRect().right),
      labelShown: !!lb && getComputedStyle(lb).display !== 'none'
    };
  }, T);
  if (r.worstDrop > 1) fail('the data bar sits on its line',
    `cells sharing a line are ${r.worstDrop}px apart vertically - one is off the line`);
  else ok();
  if (r.gapSpread > 1) fail('the data bar spacing is even',
    `gaps along a line differ by ${r.gapSpread}px`);
  else ok();
  if (r.slack > 40) fail('the data bar fills its width',
    `${r.slack}px of dead space between the readings and the Matterhorn`);
  else ok();
  if (!r.labelShown) fail('the hours cell keeps its label',
    'the closed badge replaced the label instead of joining it');
  else ok();
  await wide.close();
}

// ── the contact form asks what the subject needs ─────────────────────────
// Choosing "recommend an instructor" used to leave the previous subject's
// template in the box, so someone recommending an instructor was asked for
// their own dates, group size and ski level. The template follows the
// subject now, and a message somebody has typed is never overwritten.
{
  const r = await page.evaluate(async () => {
    const out = {};
    openM('contactModal');
    const sel = document.getElementById('cf-subject');
    const msg = document.getElementById('cf-message');
    const pick = (v) => { sel.value = v; sel.dispatchEvent(new Event('change')); };

    pick('בקשת פרטי מדריך'); out.ask = msg.value;
    pick('הוספת מדריך מומלץ'); out.suggest = msg.value;
    // something typed by hand must survive a change of subject
    msg.value = 'שלום, יש לי שאלה אחרת לגמרי.';
    pick('נתונים שגויים'); out.typed = msg.value;

    // and the form the user gets back after sending has to be the same form
    out.before = document.querySelectorAll('#cf-subject option').length;
    resetContactForm();
    out.after = document.querySelectorAll('#cf-subject option').length;
    out.afterHasSuggest = !!document.querySelector('#cf-subject option[value="הוספת מדריך מומלץ"]');
    out.afterWired = !!(document.getElementById('cf-subject') || {}).getAttribute('onchange');
    closeM('contactModal');
    return out;
  });
  if (!/תאריכים משוערים/.test(r.ask)) fail('the contact form asks what the subject needs',
    `asking for an instructor offered "${r.ask.slice(0, 40)}"`); else ok();
  if (!/שם המדריך/.test(r.suggest) || /תאריכים משוערים/.test(r.suggest))
    fail('the contact form asks what the subject needs',
      `recommending an instructor offered "${r.suggest.slice(0, 60)}"`); else ok();
  if (!/שאלה אחרת לגמרי/.test(r.typed)) fail('the contact form asks what the subject needs',
    'a message the user had typed was overwritten by a template'); else ok();
  if (r.after !== r.before || !r.afterHasSuggest) fail('the contact form asks what the subject needs',
    `after one send the subject list went from ${r.before} options to ${r.after}`); else ok();
  if (!r.afterWired) fail('the contact form asks what the subject needs',
    'the rebuilt form lost the handler that fills the template'); else ok();
}

// ── an address printed as text is a dead end ─────────────────────────────
// The huts and apres-ski bars carried lines like "rifugioteodulo.com" as
// plain text: the reader sees the address and has to retype it. Every bare
// domain that reaches the page is turned into a link, wherever it renders.
{
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(res => setTimeout(res, ms));
    const RE = /(^|[^@\w.\/-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|it|ch|org|net|eu|info))(?![\w@.\/-])/i;
    const bare = [];
    let linked = 0;
    const scan = (where) => {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        const m = (n.nodeValue || '').match(RE);
        if (!m) continue;
        const el = n.parentElement;
        if (!el || !el.offsetParent) continue;
        if (el.closest('a')) { linked++; continue; }
        if (el.closest('script,style,textarea,input')) continue;
        bare.push(where + ': ' + m[2]);
      }
    };
    scan('home');
    for (const id of [...document.querySelectorAll('.modal')].map(m => m.id).filter(Boolean)) {
      try { openM(id); } catch (e) { continue; }
      await wait(200);
      scan(id);
      // the huts are behind their own chip and get a pass of their own below,
      // so this walk leaves that filter alone rather than toggling it
      try { closeM(id); } catch (e) {}
    }
    return { bare: [...new Set(bare)], linked };
  });
  if (r.bare.length) fail('an address printed as text is a dead end',
    r.bare.slice(0, 6).join(' · ')); else ok();
  // And the sweep itself, tested directly rather than through a list whose
  // filter chip is a toggle: a bare address put into the page has to come
  // back as a link, and a phone number has to come back isolated. This is
  // what actually fails when either sweep is disabled.
  const sweep = await page.evaluate(async () => {
    const probe = document.createElement('div');
    probe.id = 'sweep-probe';
    probe.textContent = 'בדיקה rifugioteodulo.com · 0166 949400 · סוף';
    document.body.appendChild(probe);
    await new Promise(res => setTimeout(res, 400));   // the observer is debounced
    const html = probe.innerHTML;
    const out = {
      linked: /<a [^>]*href="https:\/\/rifugioteodulo\.com"/.test(html),
      isolated: /<bdi dir="ltr">0166 949400<\/bdi>/.test(html)
    };
    probe.remove();
    return out;
  });
  if (!sweep.linked) fail('an address printed as text is a dead end',
    'an address added to the page was left as plain text'); else ok();
  if (!sweep.isolated) fail('an address printed as text is a dead end',
    'a phone number added to the page was left without an isolate'); else ok();
}

// ── the Cervino sits behind the readings, not instead of them ────────────
// A hero band of its own would push the eight live readings below the fold,
// and those readings are the reason the page gets opened at all. The photo
// is the bar's own background, darkened hard enough to keep every figure
// legible, and the bar falls back to its flat gradient if the file is gone.
{
  if (!fs.existsSync(path.join(path.dirname(PAGE), 'hero-cervino.jpg')))
    fail('the Cervino sits behind the readings', 'hero-cervino.jpg is not next to index.html');
  else ok();
  const r = await page.evaluate(() => {
    const bar = document.getElementById('live-data-bar');
    const inner = bar.querySelector('.bar-inner');
    const before = getComputedStyle(inner, '::before');
    const after = getComputedStyle(inner, '::after');
    const kid = inner.firstElementChild;
    return {
      hasHero: bar.classList.contains('has-hero'),
      image: before.backgroundImage,
      imgZ: before.zIndex, dimZ: after.zIndex,
      kidZ: kid ? getComputedStyle(kid).zIndex : null,
      // the readings must still be on top of both layers
      overflow: getComputedStyle(inner).overflow
    };
  });
  if (!r.hasHero || !/hero-cervino/.test(r.image)) fail('the Cervino sits behind the readings',
    `the bar is not carrying the photo: ${r.image}`); else ok();
  if (r.imgZ !== '0' || r.dimZ !== '0' || r.kidZ !== '1')
    fail('the Cervino sits behind the readings',
      `layers came out photo ${r.imgZ}, dim ${r.dimZ}, readings ${r.kidZ}`
      + ' - the darkening has to sit over the photo and under the figures'); else ok();
  if (r.overflow === 'visible') fail('the Cervino sits behind the readings',
    'the photo is not clipped to the bar'); else ok();
}

// ── the camera card shows the mountain ───────────────────────────────────
// Nothing on the home page moved, and the service cards were ten identical
// boxes. This one carries the Plan Maison camera behind its text. A camera
// that is down has to leave an ordinary card, not a dark empty rectangle.
{
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(res => setTimeout(res, ms));
    // Fixed waits made this the one gate that cried wolf: 500 ms for an
    // image to decode and 700 ms for a bad host to FAIL are both guesses,
    // and on 9 November it reported red on a build that was fine. A gate
    // nobody trusts is worse than no gate - the red was waved through.
    // So it waits for the state it is about to assert, up to a generous
    // ceiling, and the assertions below are unchanged.
    const until = async (fn, ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { if (fn()) return true; await wait(40); }
      return false;
    };
    const card = document.getElementById('svc-webcam');
    const out = {};
    // a picture that loads
    const good = 'data:image/svg+xml;base64,' + btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="24">'
      + '<rect width="40" height="24" fill="#9fd0f5"/></svg>');
    SVC_CAM_URL = good;
    refreshServiceCam();
    await until(() => card.classList.contains('has-live'), 6000);
    out.live = card.classList.contains('has-live');
    out.layer = !!card.querySelector('.svc-live');
    out.dot = !!card.querySelector('.svc-livedot');
    out.painted = /url\(/.test((card.querySelector('.svc-live') || {}).style?.backgroundImage || '');
    // the rule that lifts the card's children above the picture also catches
    // the picture itself, and then the darkening overlay ends up underneath
    // it and the Hebrew sits on a bright photo
    const layerEl = card.querySelector('.svc-live');
    out.layerZ = layerEl ? getComputedStyle(layerEl).zIndex : null;
    out.textZ = getComputedStyle(card.querySelector('.svc-txt')).zIndex;
    // and one that does not
    // A host that cannot resolve fails whenever the resolver gets round to
    // it, which is not a number anyone can pick in advance.
    SVC_CAM_URL = 'https://example.invalid/none.jpg';
    refreshServiceCam();
    await until(() => !card.classList.contains('has-live'), 12000);
    out.fellBack = !card.classList.contains('has-live');
    return out;
  });
  if (!r.live || !r.layer || !r.painted) fail('the camera card shows the mountain',
    `the live layer did not appear: ${JSON.stringify(r)}`); else ok();
  if (!r.dot) fail('the camera card shows the mountain',
    'nothing marks the card as live'); else ok();
  if (r.layerZ !== '0' || r.textZ !== '1') fail('the camera card shows the mountain',
    `the picture is at z-index ${r.layerZ} and the text at ${r.textZ} - the`
    + ' overlay that keeps the Hebrew readable ends up under the photo'); else ok();
  if (!r.fellBack) fail('the camera card shows the mountain',
    'a camera that is down left the card dark and empty'); else ok();
}

// ── the forum shows faces, and says it is there ──────────────────────────
// The avatars were uploaded, cropped and stored, and the forum never looked
// them up - every post was a name in a list. And the forum itself sits below
// ten service cards, so nobody landing on the page knew it existed.
{
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(res => setTimeout(res, ms));
    allPosts = [1, 2, 3, 4, 5].map(i => ({
      id: 'p' + i, user: 'משתמש ' + i, content: 'הודעה ' + i,
      timestamp: Date.now() - i * 3600e3, replies: [], reactions: {}, _userReacts: {}
    }));
    window.FORUM_AVATARS = { 'משתמש 2': 'https://example.com/face.jpg' };
    renderPosts('');
    await wait(250);
    const box = document.getElementById('forum-peek');
    const names = () => [...document.querySelectorAll('.peek-card b')].map(b => b.textContent);

    const out = {
      peekShown: box && box.style.display === 'block',
      per: peekPerView(),
      cards: document.querySelectorAll('.peek-card').length,
      // The markup is what is checked, not the loaded page: the test URL is
      // not a real image, so the <img> fires onerror and the circle falls
      // back to the initial - which is the behaviour wanted in production and
      // would hide the bug here.
      avatarMarkup: /<img [^>]*src="https:\/\/example\.com\/face\.jpg"/.test(_postAvatar('משתמש 2')),
      fallbackMarkup: /<span data-ini="[^"]+"[^>]*>[^<]+<\/span>/.test(_postAvatar('משתמש 9')),
      postShowsCircle: !!document.querySelector('#posts-list span[data-ini]')
    };

    // A window, not a scroller: whatever is on show must be whole cards and
    // there must be nothing outside the box waiting to be dragged into view.
    const track = document.getElementById('forum-peek-track');
    out.noOverflow = track.scrollWidth <= track.clientWidth + 1;
    out.noScrollbarCss = getComputedStyle(track).overflowX !== 'auto';

    // the arrows change which posts are shown, and change them back
    const first = names();
    peekMove(1); await wait(80);
    const second = names();
    out.moved = first.length > 0 && second.length > 0 && first.join('|') !== second.join('|');
    peekMove(-1); await wait(80);
    out.returned = names().join('|') === first.join('|');

    // at the newest post there is nowhere further to go, and the arrow says so
    out.prevDisabledAtStart = document.getElementById('peek-prev').disabled === true;

    // with nothing to show the strip stays - it is the only door to the forum
    // now - but it says so instead of drawing empty husks
    allPosts = [];
    renderForumPeek();
    out.staysWhenEmpty = box.style.display === 'block';
    out.emptyCards = document.querySelectorAll('.peek-card').length;
    out.saysEmpty = document.getElementById('peek-empty').style.display !== 'none';
    return out;
  });

  const T = 'the forum shows faces, and says it is there';
  if (!r.peekShown || r.cards !== r.per) fail(T,
    `the strip drew ${r.cards} cards where ${r.per} fit (shown: ${r.peekShown})`); else ok();
  if (!r.avatarMarkup) fail(T,
    'a post whose author has a photo is drawn without it'); else ok();
  if (!r.fallbackMarkup) fail(T,
    'a post whose author has no photo lost its initial circle'); else ok();
  if (!r.postShowsCircle) fail(T,
    'the posts themselves carry no avatar at all'); else ok();
  if (!r.noOverflow) fail(T,
    'the strip overflows its box - a scrollbar and a sliced card are back'); else ok();
  if (!r.noScrollbarCss) fail(T,
    'the track still declares overflow-x:auto'); else ok();
  if (!r.moved || !r.returned) fail(T,
    `the arrows changed the posts: ${r.moved}, and changed them back: ${r.returned}`); else ok();
  if (!r.prevDisabledAtStart) fail(T,
    'the arrow at the newest post is still enabled, pointing nowhere'); else ok();
  if (!r.staysWhenEmpty) fail(T,
    'with no posts the strip vanished, taking the only way into the forum'); else ok();
  if (r.emptyCards !== 0) fail(T,
    `with no posts the strip still drew ${r.emptyCards} husks`); else ok();
  if (!r.saysEmpty) fail(T,
    'with no posts the strip says nothing at all'); else ok();
}

// ── the start of a run says it is the start of a run ─────────────────────
// The button read "נקודת היציאה", which in Hebrew is either the point a run
// ends at or the way you get to it. It is neither: it is where the run
// BEGINS, which for nearly every run here is the top of a lift. It also
// pointed at a Google Maps SEARCH for a place name, on a map that draws no
// lifts and no pistes - so the one thing the reader wanted to see was the
// one thing that map could not show.
{
  const pistes = (() => {
    const t = JSON.parse(fs.readFileSync(TEXTS, 'utf8')).pistes || {};
    return ['beginner','intermediate','advanced','zermatt','valtournenche','nearby']
      .flatMap(k => t[k] || []).filter(o => o && o.trail);
  })();

  const r = await page.evaluate((rows) => {
    const out = { n: rows.length, swapped: [], outside: [], noPlace: [], notWinter: [],
                  noMarker: [], guards: [] };
    // bad input must produce nothing at all, not a half-built link
    ['', 'abc', '45.9', null, '1,2,3'].forEach(v => {
      if (_mapyPoint(v) !== '') out.guards.push(String(v));
    });
    for (const o of rows) {
      const src = o.start_latlon || o.latlon || '';
      const url = _mapyPoint(src);
      const m = /[?&]center=([^&]+)/.exec(url || '');
      if (!m) { out.swapped.push(o.name); continue; }
      const [lon, lat] = decodeURIComponent(m[1]).split(',').map(Number);
      const [slat, slon] = String(src).split(',').map(Number);
      // the content file stores latitude first; the URL must store it second
      if (!(Math.abs(lon - slon) < 1e-9 && Math.abs(lat - slat) < 1e-9)) out.swapped.push(o.name);
      // and the result has to be in the Alps, not its mirror image
      if (!(lat > 45 && lat < 46.5 && lon > 7 && lon < 8.2)) out.outside.push(o.name);
      if (!/mapset=winter/.test(url)) out.notWinter.push(o.name);
      if (!/marker=true/.test(url)) out.noMarker.push(o.name);
      if (!_startPlace(o)) out.noPlace.push(o.name);
    }
    return out;
  }, pistes);

  const T = 'the start of a run says it is the start of a run';
  if (r.n < 50) fail(T, `only ${r.n} runs carry a trail - the content file looks wrong`); else ok();
  if (r.guards.length) fail(T,
    `_mapyPoint built a link from junk input: ${r.guards.join(', ')}`); else ok();
  if (r.swapped.length) fail(T,
    `latitude and longitude are the wrong way round for ${r.swapped.length} runs `
    + `(${r.swapped.slice(0,3).join(', ')})`); else ok();
  if (r.outside.length) fail(T,
    `${r.outside.length} start points fall outside the Alps (${r.outside.slice(0,3).join(', ')})`); else ok();
  if (r.notWinter.length) fail(T,
    'the start point opens a map with no lifts or pistes on it'); else ok();
  if (r.noMarker.length) fail(T,
    'the map opens with nothing marked on it'); else ok();
  if (r.noPlace.length) fail(T,
    `${r.noPlace.length} runs cannot name the station they start from`); else ok();

  // and the wording itself
  // The page is opened over file://, where its own fetch of texts.json is
  // blocked, so PISTES stays empty and the guide draws its chips and no
  // cards at all. Every earlier check that looked at this panel was really
  // looking at an empty panel. Hand the content in directly.
  const wording = await page.evaluate(async (t) => {
    PISTES = t.pistes;
    if (t.apres_ski) PISTES.apres_ski = t.apres_ski;
    openM('pisteModal');
    // Reset every filter the guide reads. An earlier check leaves the panel
    // on whatever chips it was exercising, and "kind" in particular decides
    // whether the list shows runs at all.
    window.pisteTab = 'list'; window.pisteArea = 'all';
    window.pisteKind = 'runs'; window.pisteDiff = 'all';
    if (typeof renderPisteGuide === 'function') renderPisteGuide();
    await new Promise(res => setTimeout(res, 600));
    const el = document.getElementById('pisteModal');
    const html = el.innerHTML;
    const cards = el.querySelectorAll('a[href*="mapy.com/fnc/v1/showmap"]').length;
    closeM('pisteModal');
    return {
      rendered: cards,
      oldLabel: /נקודת היציאה/.test(html),
      newLabel: /תחילת המסלול/.test(html),
      namesStation: /תחילת המסלול[^<]*·\s*<bdi/.test(html)
    };
  }, JSON.parse(fs.readFileSync(TEXTS, 'utf8')));

  if (!wording.rendered) fail(T,
    'the piste panel drew no start-point links at all - the check saw an empty panel'); else ok();
  if (wording.oldLabel) fail(T, 'the ambiguous "נקודת היציאה" is still on the page'); else ok();
  if (!wording.newLabel) fail(T, 'no run says where it begins any more'); else ok();
  if (!wording.namesStation) fail(T,
    'the button opens a map without naming the station the run starts from'); else ok();
}

// ── "nothing open" is not the same as "we do not know" ───────────────────
// _count treats 0/0 as an absent reading, which is right for the Cervinia
// figure standing next to a real area figure. But when both come back 0/0
// the feed is not silent - it is saying no piste is running today - and the
// bar printed "--", which a reader reads as a fault.
{
  const r = await page.evaluate(() => {
    const read = (d) => { renderLiveBar(d); return {
      main: document.getElementById('bar-slopes-local').textContent,
      scope: document.getElementById('bar-slopes-scope').textContent,
      colour: getComputedStyle(document.getElementById('bar-slopes-local')).color }; };
    return {
      shut:   read({ slopes_open_global:0, slopes_total_global:0,
                     slopes_open_local:0,  slopes_total_local:0 }),
      silent: read({}),
      open:   read({ slopes_open_global:28, slopes_total_global:46,
                     slopes_open_local:18,  slopes_total_local:22 })
    };
  });

  const T = 'nothing open is not the same as we do not know';
  if (r.shut.main === '--') fail(T,
    'a feed reporting zero pistes still prints "--"'); else ok();
  if (!r.shut.scope) fail(T,
    'the zero stands alone with no caption saying what it means'); else ok();
  if (r.silent.main !== '--') fail(T,
    `a silent feed prints "${r.silent.main}" instead of admitting it knows nothing`); else ok();
  if (r.shut.colour === r.silent.colour) fail(T,
    'shut and unknown are the same colour'); else ok();
  if (r.open.main !== '28/46') fail(T,
    `an ordinary reading broke: "${r.open.main}"`); else ok();
}

// ── the card styling stays in the grid it was built for ─────────────────
// .service-btn started as a plain white button and was borrowed all over
// the page. Turning it into a 72-pixel flex card quietly turned the six map
// pickers into six cards, each with room for an icon it does not have -
// which is how a panel of six short labels came to fill half the screen.
{
  const r = await page.evaluate(async () => {
    openM('mapModal');
    await new Promise(res => setTimeout(res, 350));
    const picks = [...document.querySelectorAll('.map-pick')];
    const out = {
      picks: picks.length,
      tallest: Math.max(0, ...picks.map(b => Math.round(b.getBoundingClientRect().height)))
    };
    closeM('mapModal');
    const cards = [...document.querySelectorAll('.services-grid .service-btn')];
    out.cards = cards.length;
    out.cardHeight = Math.min(...cards.map(c => Math.round(c.getBoundingClientRect().height)));

    // The map pickers carry .map-pick and inline padding of their own, so
    // measuring them does not answer the question - they stay short either
    // way, which is how the first version of this check passed with the
    // scoping deliberately removed. A bare borrower, with nothing to
    // protect it, is what the bare class actually does to a button.
    const probe = document.createElement('button');
    probe.className = 'service-btn';
    probe.textContent = 'בדיקה';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    document.body.appendChild(probe);
    out.bareHeight = Math.round(probe.getBoundingClientRect().height);
    out.bareDisplay = getComputedStyle(probe).display;
    probe.remove();
    return out;
  });

  const T = 'the card styling stays in the grid it was built for';
  if (r.picks < 5) fail(T, `only ${r.picks} map pickers found`); else ok();
  if (r.tallest > 48) fail(T,
    `a map picker is ${r.tallest}px tall - it is wearing the service card again`); else ok();
  if (r.cards < 8) fail(T, `only ${r.cards} service cards`); else ok();
  if (r.cardHeight < 60) fail(T,
    `the service cards collapsed to ${r.cardHeight}px - the scoping went too far`); else ok();
  if (r.bareHeight > 48) fail(T,
    `a plain button borrowing the class is ${r.bareHeight}px tall - the card `
    + 'metrics are on the bare class again'); else ok();
  if (r.bareDisplay === 'flex') fail(T,
    'a plain button borrowing the class is still a flex container'); else ok();
}

// ── the map can be dragged ───────────────────────────────────────────────
// The wrapper carried cursor:grab for a long time with nothing listening,
// so the pointer promised a gesture the page did not honour and the only
// way round a large map was the scrollbars.
{
  await page.evaluate(async () => {
    openM('mapModal');
    await new Promise(res => setTimeout(res, 300));
    const wrap = document.getElementById('map-img-wrap');
    const img  = document.getElementById('map-img');
    wrap.style.display = 'block';
    img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1700">' +
      '<rect width="2400" height="1700" fill="#ccd"/></svg>');
    img.style.width = '2400px'; img.style.maxWidth = 'none';
    wrap.scrollLeft = 0; wrap.scrollTop = 0;
    await new Promise(res => setTimeout(res, 250));
  });

  const wired = await page.evaluate(() => ({
    cursor: getComputedStyle(document.getElementById('map-img-wrap')).cursor,
    overflowing: document.getElementById('map-img-wrap').scrollWidth
               > document.getElementById('map-img-wrap').clientWidth + 10
  }));

  const box = await (await page.$('#map-img-wrap')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 200, box.y + box.height / 2 - 100, { steps: 10 });
  await page.mouse.up();
  const after = await page.evaluate(() => {
    const w = document.getElementById('map-img-wrap');
    const out = { left: Math.round(w.scrollLeft), top: Math.round(w.scrollTop),
                  cursor: getComputedStyle(w).cursor };
    w.style.display = 'none'; closeM('mapModal');
    return out;
  });

  const T = 'the map can be dragged';
  if (!wired.overflowing) fail(T,
    'the test image did not overflow, so dragging it proves nothing'); else ok();
  if (wired.cursor !== 'grab') fail(T,
    `the pointer shows "${wired.cursor}", so nothing invites the gesture`); else ok();
  if (after.left < 150) fail(T,
    `dragging left moved the map ${after.left}px - the handler is not listening`); else ok();
  if (after.top < 70) fail(T,
    `dragging up moved the map ${after.top}px vertically`); else ok();
  if (after.cursor !== 'grab') fail(T,
    `the pointer stayed "${after.cursor}" after the button came up`); else ok();
}

// ── a group appears the day it is ready, and not before ──────────────────
// The links were two hardcoded blocks of markup in two panels, so adding a
// second group meant editing the page twice. They come from texts.json now,
// and the rule that makes that safe is: an entry with no url renders
// nothing. A group announced before it exists is worse than no group - a
// link to four people and no messages says the site is abandoned.
{
  const r = await page.evaluate((texts) => {
    window._texts = JSON.parse(JSON.stringify(texts));
    const read = () => {
      renderCommunity();
      const k = document.getElementById('kosher-community');
      const w = document.getElementById('why-community');
      return {
        kosherLinks: k ? k.querySelectorAll('a').length : -1,
        whyLinks:    w ? w.querySelectorAll('a').length : -1,
        kosherShown: k ? k.style.display : null,
        hrefs: [...(k ? k.querySelectorAll('a') : [])].map(a => a.getAttribute('href'))
      };
    };
    const out = { asShipped: read() };

    // fill the whatsapp url in: both panels must pick it up, with no code change
    window._texts.community.whatsapp.url = 'https://chat.whatsapp.com/TESTINVITE';
    out.withGroup = read();

    // empty every url: both panels must go quiet rather than draw husks
    window._texts.community.whatsapp.url = '';
    window._texts.community.facebook.url = '   ';
    out.withNone = read();

    // and an injected url must not become markup
    window._texts.community.facebook.url = '" onmouseover="alert(1)';
    window._texts.community.facebook.title = '<img src=x onerror=alert(1)>';
    renderCommunity();
    const k2 = document.getElementById('kosher-community');
    out.injected = !!k2.querySelector('img');
    // the attribute itself, not the word: an escaped url still CONTAINS the
    // text "onmouseover", inertly, and testing the html string for it fails
    // a correct implementation.
    out.rawAttr = !!k2.querySelector('[onmouseover]');

    // Put the real content back. This check runs before others that look for
    // the Facebook link, and leaving a mangled _texts behind made two of them
    // fail for a reason that had nothing to do with what they test.
    window._texts = JSON.parse(JSON.stringify(texts));
    renderCommunity();
    return out;
  }, JSON.parse(fs.readFileSync(TEXTS, 'utf8')));

  const T = 'a group appears the day it is ready, and not before';
  if (r.asShipped.kosherLinks !== 1) fail(T,
    `as shipped the kosher panel drew ${r.asShipped.kosherLinks} links - only Facebook has a url`); else ok();
  if (r.asShipped.whyLinks !== 1) fail(T,
    `as shipped the why panel drew ${r.asShipped.whyLinks} links`); else ok();
  if (r.withGroup.kosherLinks !== 2 || r.withGroup.whyLinks !== 2) fail(T,
    `filling in one url gave ${r.withGroup.kosherLinks} and ${r.withGroup.whyLinks} links`); else ok();
  if (!r.withGroup.hrefs.some(h => /chat\.whatsapp\.com/.test(h || ''))) fail(T,
    'the new group did not reach the panel'); else ok();
  if (r.withNone.kosherLinks !== 0 || r.withNone.whyLinks !== 0) fail(T,
    'an empty url still drew a link'); else ok();
  if (r.withNone.kosherShown !== 'none') fail(T,
    'with nothing to show the block still takes up space'); else ok();
  if (r.injected || r.rawAttr) fail(T,
    'a url or title from the content file reached the DOM unescaped'); else ok();
}

// ── the community links have a standing door ─────────────────────────────
// The Israeli Facebook group, the video and the Hebrew write-ups lived in a
// panel reachable from a banner that shows once and never again. A reader
// who dismissed it had no way back except the search box.
{
  const r = await page.evaluate(() => ({
    inMenu: !!document.querySelector('#side-menu-links button[onclick*="\'why\'"]'),
    menuText: [...document.querySelectorAll('#side-menu-links button')]
                .map(b => b.textContent.trim()).join(' | '),
    actionExists: typeof SIDE_MENU_ACTIONS === 'object' && typeof SIDE_MENU_ACTIONS.why === 'function',
    fbInWhy: !!document.querySelector('#whyModal a[href*="facebook.com/groups"]'),
    fbInKosher: !!document.querySelector('#kosherModal a[href*="facebook.com/groups"]'),
    whatsappClaim: /קבוצות הווטסאפ/.test(
      (document.getElementById('kosher-cervinia-text') || {}).textContent || '')
  }));

  const T = 'the community links have a standing door';
  if (!r.inMenu) fail(T,
    `the side menu has no way to the community panel: ${r.menuText}`); else ok();
  if (!r.actionExists) fail(T, 'the menu entry is wired to nothing'); else ok();
  if (!r.fbInWhy) fail(T, 'the Facebook group link left the why panel'); else ok();
  if (!r.fbInKosher) fail(T,
    'the kosher panel describes the community without linking to it'); else ok();
  if (r.whatsappClaim) fail(T,
    'the village text still sends readers to WhatsApp groups'); else ok();
}

// ── the kosher product list can be found ─────────────────────────────────
// Fifty-five products with their certifying body sat folded inside the tips
// box behind a <summary> with list-style:none - which strips the disclosure
// triangle. The heading looked like a line of bold text, and a reader
// reported the list as missing. It was never missing; it was invisible.
{
  const r = await page.evaluate(async (t) => {
    window._texts = t;
    if (typeof _applyTexts === 'function') _applyTexts(t);
    openM('kosherModal');
    // The panel runs its own set-up on a timer after opening and lands on
    // the Shabbat tab; switching before that fires is undone by it.
    await new Promise(res => setTimeout(res, 400));
    if (typeof switchKoshMain === 'function') switchKoshMain('kosher');
    if (typeof switchKoshTab === 'function') switchKoshTab('cervinia');
    await new Promise(res => setTimeout(res, 300));
    const su = document.getElementById('kosher-products-title');
    const li = document.getElementById('kosher-products-list');
    const out = {
      inJson: (t.kosher.cervinia_products || []).filter(
                x => String(x).slice(0, 2) !== '##').length,
      // The groups are folds now, so the product rows are no longer children
      // of the list - counting children counted eight folds and called it
      // eight products. Each rendered line carries k-prod, at any depth.
      items: li ? li.querySelectorAll('.k-prod').length : 0,
      groups: li ? li.querySelectorAll('details').length : 0,
      summaryHeight: su ? Math.round(su.getBoundingClientRect().height) : 0,
      summaryText: su ? su.textContent : '',
      marker: su ? getComputedStyle(su, '::before').content : '',
      isFold: !!(su && su.parentElement.classList.contains('fold'))
    };
    const d = su && su.parentElement;
    if (d) { d.open = true; await new Promise(res => setTimeout(res, 150));
             out.openHeight = Math.round(li.getBoundingClientRect().height); }
    closeM('kosherModal');
    return out;
  }, JSON.parse(fs.readFileSync(TEXTS, 'utf8')));

  const T = 'the kosher product list can be found';
  if (r.inJson < 20) fail(T, `only ${r.inJson} products in the content file`); else ok();
  if (r.items < r.inJson) fail(T,
    `${r.items} rows rendered for ${r.inJson} products`); else ok();
  if (r.groups < 5) fail(T,
    `the list is not split into groups - ${r.groups} folds inside it`); else ok();
  if (r.summaryHeight < 10) fail(T,
    'the heading that opens the list is not on screen at all'); else ok();
  if (!r.isFold) fail(T,
    'the list is not using the site fold, so it has no arrow of its own'); else ok();
  if (!r.marker || r.marker === 'none') fail(T,
    'nothing marks the heading as something you can open'); else ok();
  if (!/\d+\s*מוצרים/.test(r.summaryText)) fail(T,
    `the heading does not say how many are behind it: "${r.summaryText}"`); else ok();
  if (!r.openHeight) fail(T, 'opening the fold reveals nothing'); else ok();
}

// ── the search box does not carry text in, or markup out ─────────────────
// Two faults in one dropdown: the field kept coming back holding a name the
// page never put there (the browser restores it, and autocomplete="off" is
// only a hint), and a post's HTML was sliced at fifty characters and poured
// into innerHTML - a cut-open tag swallowed the row, which is the blank
// white box that appeared under the field.
{
  const r = await page.evaluate(async () => {
    const inp = document.getElementById('global-search-input');
    const box = document.getElementById('global-search-results');

    allPosts = [{ id: 'x1', user: 'יוסי',
      content: '<p>הראשון שלג <b>ירד</b> היום בבוקר והיה נהדר לגלוש שם</p>',
      timestamp: Date.now(), replies: [], reactions: {}, _userReacts: {} },
      { id: 'x2', user: '<img src=x onerror=alert(1)>',
      content: 'ניסיון הזרקה', timestamp: Date.now(), replies: [], reactions: {}, _userReacts: {} }];

    globalSearch('שלג');
    const rows = [...box.querySelectorAll('div[onclick]')];
    const out = {
      rowCount: rows.length,
      rowText: rows.map(x => x.textContent.trim()).join(' | '),
      anyEmptyRow: rows.some(x => !x.textContent.trim()),
      // Not a scan for tag text: the dropdown writes its own <b> around a
      // panel's name. What must never appear is an ELEMENT built out of a
      // post's content.
      leftATag: !!box.querySelector('p, img, script, iframe'),
      goesToPost: rows.some(x => /peekOpenPost/.test(x.getAttribute('onclick') || ''))
    };

    globalSearch('הזרקה');
    out.injectedNode = !!box.querySelector('img');

    // the field must come back empty however the browser restores it
    inp.value = 'יוסי';
    window.dispatchEvent(new Event('pageshow'));
    out.valueAfterPageshow = inp.value;
    out.boxAfterPageshow = box.style.display;

    allPosts = []; globalSearch('');
    return out;
  });

  const T = 'the search box does not carry text in, or markup out';
  if (!r.rowCount) fail(T, 'a matching post produced no row at all'); else ok();
  if (r.anyEmptyRow) fail(T,
    `a result row rendered blank: "${r.rowText}"`); else ok();
  if (r.leftATag) fail(T,
    'a post\'s HTML tags reached the dropdown unescaped'); else ok();
  if (r.injectedNode) fail(T,
    'a post built a live element inside the dropdown - that is an injection hole'); else ok();
  if (!r.goesToPost) fail(T,
    'clicking a forum hit does not open that post'); else ok();
  if (r.valueAfterPageshow !== '') fail(T,
    `the field still held "${r.valueAfterPageshow}" after the page came back`); else ok();
  if (r.boxAfterPageshow !== 'none') fail(T,
    'the dropdown stayed open across a page restore'); else ok();
}

// ── the tab carries our icon, not a globe ────────────────────────────────
// The page declared an apple-touch-icon and nothing else. apple-touch-icon
// is for an iPhone home screen; the browser tab reads rel="icon", and with
// none declared every tab showed the generic globe.
{
  const r = await page.evaluate(() => {
    const links = [...document.querySelectorAll('link[rel~="icon"]')]
      .map(l => ({ rel: l.getAttribute('rel'),
                   href: l.getAttribute('href'),
                   sizes: l.getAttribute('sizes') }));
    return {
      links,
      hasPlainIcon: links.some(l => /(^|\s)icon(\s|$)/.test(l.rel)),
      hasApple: !!document.querySelector('link[rel="apple-touch-icon"]'),
      allRelative: links.every(l => l.href && !/^https?:/i.test(l.href))
    };
  });

  const T = 'the tab carries our icon, not a globe';
  if (!r.hasPlainIcon) fail(T,
    'no rel="icon" is declared, so the tab falls back to the browser default'); else ok();
  if (r.links.length < 2) fail(T,
    `only ${r.links.length} icon link(s) - one size has to serve every display`); else ok();
  if (!r.hasApple) fail(T, 'the iPhone home-screen icon was lost'); else ok();
  if (!r.allRelative) fail(T,
    'an icon is referenced absolutely and will not follow the site between hosts'); else ok();

  // the files themselves must exist next to the page
  const fs2 = await import('fs');
  for (const f of ['favicon.ico', 'favicon-16.png', 'favicon-32.png']) {
    if (!fs2.existsSync(path.join(path.dirname(PAGE), f)))
      fail(T, `${f} is declared but not next to index.html`); else ok();
  }
}

// ── the page says how old its numbers are ────────────────────────────────
// The badge read "🟢 נתונים חיים" whenever the fetch succeeded, no matter
// when the reading was taken. GitHub's scheduler drops most of the
// half-hourly runs, and a reading from half past five in the morning was
// still being called live at a quarter to seven in the evening. A live-data
// site that lies about the age of its data is worse than one with no data.
{
  const r = await page.evaluate(() => {
    const badge = document.getElementById('data-source-badge');
    const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
    const read = (min) => {
      showDataSourceBadge('live', ago(min));
      return { text: badge.textContent, colour: badge.style.color };
    };
    const out = { fresh: read(10), hour: read(70), stale: read(200), old: read(13 * 60) };
    showDataSourceBadge('live', null);
    out.noStamp = badge.textContent;
    showDataSourceBadge('demo');
    out.demo = badge.textContent;
    return out;
  });

  const T = 'the page says how old its numbers are';
  if (!/חיים/.test(r.fresh.text)) fail(T,
    `a ten-minute-old reading reads "${r.fresh.text}"`); else ok();
  if (!/חיים/.test(r.hour.text)) fail(T,
    `a seventy-minute-old reading reads "${r.hour.text}"`); else ok();
  if (/חיים/.test(r.stale.text)) fail(T,
    `a three-hour-old reading still calls itself live: "${r.stale.text}"`); else ok();
  if (!/שעות/.test(r.stale.text)) fail(T,
    `a stale reading does not say how old it is: "${r.stale.text}"`); else ok();
  if (/חיים/.test(r.old.text)) fail(T,
    `a thirteen-hour-old reading still calls itself live: "${r.old.text}"`); else ok();
  if (!/ישנים/.test(r.old.text)) fail(T,
    `a thirteen-hour-old reading is not called old: "${r.old.text}"`); else ok();
  if (r.stale.colour === r.fresh.colour) fail(T,
    'stale and fresh are the same colour, so the glance says nothing'); else ok();
  if (r.old.colour === r.stale.colour) fail(T,
    'old and merely stale look identical'); else ok();
  if (!/לדוגמה/.test(r.demo)) fail(T,
    `the demo badge broke: "${r.demo}"`); else ok();
  if (!r.noStamp) fail(T, 'with no timestamp the badge went blank'); else ok();
}

// ── a reader chooses which alerts wake them ──────────────────────────────
// A subscription was all or nothing: the crossing, the lifts, the wind and
// every alert a person posted, or silence. The only control left to someone
// who wanted less was to turn the whole thing off.
{
  const r = await page.evaluate(async () => {
    const out = {};
    out.topics = (typeof PUSH_TOPICS !== 'undefined') ? PUSH_TOPICS.map(t => t.k) : [];
    out.hasToggle = typeof togglePushTopic === 'function';
    out.hasLoad   = typeof loadPushTopics === 'function';

    // with nothing loaded the block must draw nothing at all, not an empty
    // card promising choices the server never confirmed
    _pushTopicsCache = null;
    out.emptyWhenUnknown = _pushTopicsHtml() === '';

    // with a server answer, one checkbox per topic, ticked to match
    _pushTopicsCache = ['zermatt', 'snow'];
    const html = _pushTopicsHtml();
    const d = document.createElement('div'); d.innerHTML = html;
    const boxes = [...d.querySelectorAll('input[type="checkbox"]')];
    out.boxes = boxes.length;
    out.checked = boxes.filter(b => b.checked).length;
    out.everyTopicWired = PUSH_TOPICS.every(t => html.indexOf("togglePushTopic('" + t.k + "')") >= 0);
    out.labelled = PUSH_TOPICS.every(t => html.indexOf(t.label) >= 0);
    _pushTopicsCache = null;
    return out;
  });

  const T = 'a reader chooses which alerts wake them';
  const want = ['zermatt', 'lifts', 'weather', 'snow', 'community'];
  if (JSON.stringify(r.topics) !== JSON.stringify(want))
    fail(T, `the topic list is ${JSON.stringify(r.topics)}, not ${JSON.stringify(want)}`); else ok();
  if (!r.hasToggle || !r.hasLoad) fail(T, 'the topic functions are missing'); else ok();
  if (!r.emptyWhenUnknown) fail(T,
    'the chooser draws itself before the server has said what is on'); else ok();
  if (r.boxes !== want.length) fail(T,
    `${r.boxes} checkboxes for ${want.length} topics`); else ok();
  if (r.checked !== 2) fail(T,
    `${r.checked} boxes ticked where the server said 2`); else ok();
  if (!r.everyTopicWired) fail(T, 'a topic is drawn but wired to nothing'); else ok();
  if (!r.labelled) fail(T, 'a topic has no readable label'); else ok();

  // Turning the last one off would leave a phone subscribed and permanently
  // deaf. It must refuse and point at the button that unsubscribes properly.
  const last = await page.evaluate(async () => {
    _pushTopicsCache = ['zermatt'];
    let shown = '';
    const real = window.renderPushRow;
    window.renderPushRow = async (e) => { shown = e || ''; };
    await togglePushTopic('zermatt');
    window.renderPushRow = real;
    const left = (_pushTopicsCache || []).slice();
    _pushTopicsCache = null;
    return { shown, left };
  });
  if (!/בטל/.test(last.shown)) fail(T,
    `clearing the last topic said "${last.shown}" instead of pointing at unsubscribe`); else ok();
  if (last.left.length !== 1) fail(T,
    'clearing the last topic emptied the list anyway'); else ok();
}

// ── a signed-in reader does not retype what we already know ───────────
// Somebody who has given us their name and address should not have to type
// them again to ask a question. Two things matter beyond that it works:
// a half-written field is the person's and is never overwritten, and the
// address never reaches localStorage - the session re-reads the profile on
// every load, so writing it to the device buys nothing and leaves it there
// long after they have signed out.
{
  const r = await page.evaluate(async () => {
    const out = {};
    const name = () => document.getElementById('cf-name');
    const mail = () => document.getElementById('cf-email');

    // signed out: nothing is invented
    const setUser = o => (0, eval)('user = ' + JSON.stringify(o));
    // Each scenario starts from a form nobody has touched. Without this the
    // scenarios run into each other: a name typed in one is - correctly -
    // still the person's own in the next, and the test would be measuring
    // its own leftovers rather than the behaviour.
    const fresh = () => ['cf-name', 'cf-email', 'cf-message'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.value = ''; delete el.dataset.cfAuto; }
    });
    setUser(null);
    openM('contactModal');
    await new Promise(r2 => setTimeout(r2, 120));
    out.outName = (name()?.value || ''); out.outMail = (mail()?.value || '');
    closeM('contactModal');

    // signed in
    setUser({ name: 'יוסי', email: 'y@example.com', level: 3, sbId: 'abc' });
    openM('contactModal');
    await new Promise(r2 => setTimeout(r2, 120));
    out.inName = (name()?.value || ''); out.inMail = (mail()?.value || '');

    // a field the person has already started is theirs
    // typing, as a person does it: setting .value in code fires nothing, and
    // the mark that says "we filled this" is cleared by the input event
    if (name()) { name().value = 'שם אחר'; name().dispatchEvent(new Event('input')); }
    if (mail()) { mail().value = ''; mail().dispatchEvent(new Event('input')); }
    prefillContactForm();
    out.keptName = (name()?.value || '');
    out.refilledMail = (mail()?.value || '');
    closeM('contactModal');

    // an account with no real address on file
    fresh();
    setUser({ name: 'דני', email: '', sbId: 'xyz' });
    openM('contactModal');
    await new Promise(r2 => setTimeout(r2, 120));
    out.noMailName = (name()?.value || ''); out.noMailMail = (mail()?.value || '');
    closeM('contactModal');

    // signing out must take the identity with it
    fresh();
    setUser({ name: 'יוסי', email: 'y@example.com' });
    openM('contactModal');
    await new Promise(r2 => setTimeout(r2, 120));
    const msg = document.getElementById('cf-message');
    if (msg) msg.value = 'חצי הודעה';
    setUser(null);
    prefillContactForm();
    out.afterSignOutName = (name()?.value || '');
    out.afterSignOutMail = (mail()?.value || '');
    out.draftKept = (msg?.value || '');
    closeM('contactModal');

    // what reaches the device
    setUser({ name: 'יוסי', email: 'y@example.com', level: 3, sbId: 'abc' });
    out.stored = JSON.stringify(_userForStore());
    setUser(null);
    return out;
  });

  const T = 'a signed-in reader does not retype what we already know';

  if (r.outName || r.outMail) fail(T,
    `signed out, the form came prefilled with "${r.outName}" / "${r.outMail}"`); else ok();
  if (r.inName !== 'יוסי') fail(T,
    `the name was not filled in (got "${r.inName}")`); else ok();
  if (r.inMail !== 'y@example.com') fail(T,
    `the address was not filled in (got "${r.inMail}")`); else ok();
  if (r.keptName !== 'שם אחר') fail(T,
    `a name the person had already typed was overwritten with "${r.keptName}"`); else ok();
  if (r.refilledMail !== 'y@example.com') fail(T,
    'an empty field beside a filled one was skipped'); else ok();
  if (r.noMailName !== 'דני') fail(T,
    'an account with no address on file got no name either'); else ok();
  if (r.noMailMail !== '') fail(T,
    `an account with no address was given "${r.noMailMail}" - on a shared ` +
    `device that is the previous person's address`); else ok();
  if (r.afterSignOutName || r.afterSignOutMail) fail(T,
    `signing out left "${r.afterSignOutName}" / "${r.afterSignOutMail}" in the form`); else ok();
  if (r.draftKept !== 'חצי הודעה') fail(T,
    `a half-written message was thrown away: "${r.draftKept}"`); else ok();
  if (/y@example\.com|"email"/.test(r.stored)) fail(T,
    `the address is written to the device: ${r.stored}`); else ok();
  if (!/יוסי/.test(r.stored)) fail(T,
    'nothing at all is kept, so the reader is signed out on every reload'); else ok();
}

// ── a link opens one panel ────────────────────────────────────────────
// Every panel here is a modal, so the whole site lived at one address:
// "have a look at the kashrut section" meant "open the site, scroll, find
// the card, tap it". Each panel now has a name a person can type from
// memory out of a WhatsApp message.
{
  const r = await page.evaluate(async (t) => {
    window._texts = t;
    if (typeof _applyTexts === 'function') _applyTexts(t);
    addPanelShares();
    const out = {};

    out.names = Object.keys(PANEL_LINKS);
    out.kosher = PANEL_LINKS.kosher;
    out.link = panelLink('kosherModal');

    // EVERY link, not the two I happened to write a test for. Each one must
    // open its own panel, and the panel must have something in it - a link
    // that opens an empty box is worse than no link.
    out.each = [];
    for (const name of Object.keys(PANEL_LINKS)) {
      const id = PANEL_LINKS[name];
      location.hash = '#' + name;
      openPanelFromHash();
      await new Promise(r2 => setTimeout(r2, 90));
      const el = document.getElementById(id);
      out.each.push({
        name, id,
        open: !!(el && el.style.display === 'flex'),
        chars: el ? el.textContent.replace(/\s+/g, ' ').trim().length : 0,
        share: el ? el.querySelectorAll('.panel-share').length : 0
      });
      closeM(id);
      await new Promise(r2 => setTimeout(r2, 40));
    }

    // Every modal in the page must be either linkable or deliberately not.
    // This is the part that does not depend on anybody remembering: a new
    // modal that appears in neither list fails the gate.
    out.allModals = [...document.querySelectorAll('.modal[id]')].map(m => m.id);
    out.linked = Object.values(PANEL_LINKS);
    out.private = PANEL_PRIVATE.slice();

    // arriving at the site on a link
    location.hash = '#kosher';
    openPanelFromHash();
    await new Promise(r2 => setTimeout(r2, 150));
    const km = document.getElementById('kosherModal');
    out.openedByHash = !!(km && km.style.display === 'flex');

    // the share button sits beside the close button, once
    const sh = km ? km.querySelectorAll('.panel-share') : [];
    out.shareCount = sh.length;
    addPanelShares(); addPanelShares();
    out.shareAfterTwice = km ? km.querySelectorAll('.panel-share').length : -1;
    out.shareTitle = sh.length ? sh[0].getAttribute('title') : '';
    const cb = km ? km.querySelector('.close-btn') : null;
    // both pinned from the same physical edge, or they land in opposite corners
    out.sameEdge = !!(cb && sh.length &&
      getComputedStyle(cb).left !== 'auto' && getComputedStyle(sh[0]).left !== 'auto');

    // following a link to a different panel closes the first
    location.hash = '#pistes';
    openPanelFromHash();
    await new Promise(r2 => setTimeout(r2, 150));
    out.switched = !!(document.getElementById('pisteModal')?.style.display === 'flex');
    out.firstClosed = !!(km && km.style.display === 'none');

    // opening a panel names it in the address bar; closing takes it out
    closeM('pisteModal');
    await new Promise(r2 => setTimeout(r2, 100));
    out.hashAfterClose = location.hash;
    openM('rentalModal');
    await new Promise(r2 => setTimeout(r2, 100));
    out.hashAfterOpen = location.hash;
    closeM('rentalModal');

    // an anchor that is not a panel is left alone
    location.hash = '#some-other-anchor';
    out.unknown = openPanelFromHash();
    location.hash = '';
    return out;
  }, JSON.parse(fs.readFileSync(TEXTS, 'utf8')));

  const T = 'a link opens one panel';

  if (r.kosher !== 'kosherModal') fail(T,
    'there is no #kosher link, which is the one that was asked for'); else ok();
  if (r.names.length < 10) fail(T,
    `only ${r.names.length} panels can be linked to`); else ok();
  if (!/#kosher$/.test(r.link)) fail(T,
    `the link came out as "${r.link}"`); else ok();
  if (/\.html/.test(r.link) === false && !/^https?:|^file:/.test(r.link)) fail(T,
    'the link is not a whole address somebody could paste'); else ok();

  // every link, checked
  const dead  = r.each.filter(e => !e.open);
  // The alerts panel is legitimately near-empty when nothing is on the
  // strip, which is most of the time and is the honest state - so it is
  // the one panel not required to have content.
  const empty = r.each.filter(e => e.open && e.chars < 120 && e.id !== 'alertModal');
  const noSh  = r.each.filter(e => e.open && e.share !== 1);
  if (dead.length) fail(T,
    `these links open nothing: ${dead.map(e => '#' + e.name).join(', ')}`); else ok();
  if (empty.length) fail(T,
    `these links open an all-but-empty panel: ` +
    empty.map(e => '#' + e.name + ' (' + e.chars + ' chars)').join(', ')); else ok();
  if (noSh.length) fail(T,
    `no copy-link button in: ${noSh.map(e => '#' + e.name).join(', ')}`); else ok();

  // and the part that does not rely on remembering
  const unclassified = r.allModals.filter(
    id => r.linked.indexOf(id) < 0 && r.private.indexOf(id) < 0);
  if (unclassified.length) fail(T,
    `${unclassified.join(', ')} is neither linkable nor marked private - add it ` +
    `to PANEL_LINKS so people can send a link to it, or to PANEL_PRIVATE if it ` +
    `is a dialog nobody should land on cold`); else ok();
  const both = r.linked.filter(id => r.private.indexOf(id) >= 0);
  if (both.length) fail(T,
    `${both.join(', ')} is listed as both linkable and private`); else ok();

  if (!r.openedByHash) fail(T,
    'arriving at #kosher did not open the kashrut panel'); else ok();
  if (r.shareCount !== 1) fail(T,
    `the panel carries ${r.shareCount} share buttons`); else ok();
  if (r.shareAfterTwice !== 1) fail(T,
    `running the pass again left ${r.shareAfterTwice} buttons`); else ok();
  if (!/קישור/.test(r.shareTitle)) fail(T,
    `the share button explains itself as "${r.shareTitle}"`); else ok();
  if (!r.sameEdge) fail(T,
    'the share and close buttons are not pinned from the same edge'); else ok();

  if (!r.switched || !r.firstClosed) fail(T,
    'following a link to another panel did not swap them'); else ok();
  if (r.hashAfterOpen !== '#rental') fail(T,
    `opening a panel put "${r.hashAfterOpen}" in the address bar`); else ok();
  if (r.hashAfterClose) fail(T,
    `closing a panel left "${r.hashAfterClose}" behind`); else ok();
  if (r.unknown !== false) fail(T,
    'an anchor that is not a panel was treated as one'); else ok();
}

// ── the planner does what its buttons say ─────────────────────────────
// Four things Yossi found by using it: the engine links were on screen
// before anybody pressed חפש (because "הבן" ran the search itself, so the
// button looked broken), "נקה" left the sentence in the box, an offer row
// named a flight and left you to key the dates in by hand, and the price
// was one of three bold things in a row.
{
  const r = await page.evaluate(async (t) => {
    window._texts = t;
    const out = {};
    const results = () => ['all-results', 'flight-results', 'car-results', 'hotel-results']
      .map(id => document.getElementById(id))
      .filter(Boolean)
      .filter(e => e.style.display !== 'none' && e.innerHTML.length > 40).length;

    // understanding a sentence is not searching
    const q = document.getElementById('trip-free');
    const dt0 = document.getElementById('trip-dates');
    if (q) q.value = 'מילאנו בחנוכה לשבוע';
    ['all-results', 'flight-results', 'car-results', 'hotel-results'].forEach(id => {
      const e = document.getElementById(id);
      if (e) { e.innerHTML = ''; e.style.display = 'none'; }
    });
    out.understandSearches = /searchAll\(\)/.test(applyTripText.toString());

    // "clear" clears the sentence too
    if (q) q.value = 'מילאנו בחנוכה לשבוע';
    resetTripDates();
    out.afterClear = q ? q.value : '[no box]';
    out.resultsAfterClear = results();

    // an offer row: one bold thing, the airline named, and a way through
    window._FLIGHTS = {
      generated: new Date().toISOString(), nights: [3,4,5,6,7],
      dests: { MXP: { he: 'מילאנו מלפנסה' } },
      cal: { MXP: { 3:{}, 4:{}, 5:{}, 6:{}, 7:{} } },
      rets: { MXP: { 3:{}, 4:{}, 5:{}, 6:{}, 7:{} } },
      offers: [{ kind: 'midweek', dest: 'MXP', date: '2027-01-12', ret: '2027-01-17',
                 nights: 5, price: 380, carrier: 'Wizz Air', direct: true }]
    };
    window._flTried = true;
    const host = document.querySelector('.fl-offers');
    await paintFlightOffers();
    const html = host ? host.innerHTML : '';
    out.folded   = !!(host && host.querySelector('details.fl-fold'));
    out.foldOpen = !!(host && host.querySelector('details.fl-fold[open]'));
    out.foldTitle = host ? (host.querySelector('.fl-fold > summary')?.textContent || '') : '';
    // within the ROW, not the panel: the panel's own heading is bold and
    // should be - an earlier version of this check counted it and read the
    // row as having two bold things when it has one.
    const row = host ? host.querySelector('[data-fl-offer]')?.closest('div') : null;
    out.bolds = row ? row.querySelectorAll('b').length : -1;
    out.saysAirline = /חברת תעופה:/.test(html);
    out.offerBtn = !!(host && host.querySelector('[data-fl-offer]'));
    out.skiBoot = /🎿/.test(html);

    if (host && host.querySelector('[data-fl-offer]')) {
      // clear the engine links first, so "did pressing this draw them?" has
      // a meaningful answer
      ['flight-results', 'all-results'].forEach(id => {
        const e = document.getElementById(id);
        if (e) { e.innerHTML = ''; e.style.display = 'none'; }
      });
      host.querySelector('[data-fl-offer]').click();
      await new Promise(r2 => setTimeout(r2, 400));
      const dt = document.getElementById('trip-dates');
      out.btnCi = dt ? dt.getAttribute('data-ci') : '';
      // the dates must be ON SCREEN, not only in an attribute
      out.btnShown = dt ? (dt.value || '') : '';
      out.btnNights = (document.getElementById('trip-summary-nights') || {}).textContent || '';
      out.btnDrewLinks = results();
    }

    // "נקה" has to clear the dates everywhere they are kept, not only the
    // ones on screen - getDateRange falls back to the attributes, so a reset
    // that leaves them behind searches the dates the reader just cleared
    setTripDates('2027-02-01', '2027-02-08');
    resetTripDates();
    out.clearedRange = (typeof getDateRange === 'function') ? getDateRange() : 'no-fn';
    out.clearedCi = dt0 ? dt0.getAttribute('data-ci') : 'no-el';

    // saved searches
    try { localStorage.removeItem('cl_saved_trips'); } catch (e) {}
    // through the real entry point, not by poking the attributes: with a
    // working picker the attributes are no longer the only source of truth,
    // and setting them by hand left the picker holding the offer's dates
    const dt2 = document.getElementById('trip-dates');
    setTripDates('2027-01-10', '2027-01-17');
    if (q) q.value = 'מילאנו לשבוע';
    saveTripSearch();
    out.savedCount = JSON.parse(localStorage.getItem('cl_saved_trips') || '[]').length;
    saveTripSearch();                       // the same search twice is one
    out.savedTwice = JSON.parse(localStorage.getItem('cl_saved_trips') || '[]').length;
    const box = document.getElementById('trip-saved');
    out.savedShown = !!(box && box.style.display !== 'none' && /מילאנו/.test(box.innerHTML));
    const id = JSON.parse(localStorage.getItem('cl_saved_trips'))[0].id;
    resetTripDates();
    loadTripSearch(id);
    out.restored = q ? q.value : '';
    out.restoredCi = dt2 ? dt2.getAttribute('data-ci') : '';
    deleteTripSearch(id);
    out.afterDelete = JSON.parse(localStorage.getItem('cl_saved_trips') || '[]').length;
    try { localStorage.removeItem('cl_saved_trips'); } catch (e) {}
    return out;
  }, JSON.parse(fs.readFileSync(TEXTS, 'utf8')));

  const T = 'the planner does what its buttons say';

  if (r.understandSearches) fail(T,
    '"הבן" still runs the search, so the engine links are on screen before ' +
    'anybody presses חפש and that button appears to do nothing'); else ok();
  if (r.afterClear !== '') fail(T,
    `"נקה" left "${r.afterClear}" in the sentence box`); else ok();
  if (r.resultsAfterClear !== 0) fail(T,
    `"נקה" left ${r.resultsAfterClear} result block(s) on screen`); else ok();

  if (r.bolds !== 1) fail(T,
    `${r.bolds} bold things in an offer row - the price should be the only one`); else ok();
  if (!r.saysAirline) fail(T,
    'the carrier is a bare word with nothing saying it is an airline'); else ok();
  if (r.skiBoot) fail(T,
    'the ski boot is back beside the calendars'); else ok();
  if (!r.offerBtn) fail(T,
    'an offer names a flight and leaves the dates to be keyed in by hand'); else ok();
  // folded away, because two open panels of numbers pushed the search
  // button off the bottom of the modal
  if (!r.folded) fail(T, 'the flight block is not folded away'); else ok();
  if (r.foldOpen) fail(T, 'the fold starts open, which defeats the point'); else ok();
  if (!/מידע טיסות/.test(r.foldTitle)) fail(T,
    `the fold is headed "${r.foldTitle}"`); else ok();
  // and it says what the offers actually are, which Yossi could not tell
  if (!/כל העונה/.test(r.foldTitle)) fail(T,
    'the heading does not say the offers span the whole season'); else ok();
  if (r.clearedRange !== null) fail(T,
    `pressing "נקה" left ${JSON.stringify(r.clearedRange)} behind, so the next ` +
    'search runs on the dates the reader just cleared'); else ok();
  if (r.clearedCi) fail(T,
    `"נקה" emptied the field but left data-ci="${r.clearedCi}" on it`); else ok();
  if (r.btnCi !== '2027-01-12') fail(T,
    `the offer button filled "${r.btnCi}" instead of its own date`); else ok();
  // A results panel with no dates anywhere on it is how somebody ends up
  // looking at an answer without knowing the question.
  if (!r.btnShown) fail(T,
    'pressing an offer left the date field blank - the reader sees results ' +
    'with no dates on screen'); else ok();
  // "26-29 בדצמבר 26" reads as three dates: the trailing two-digit year
  // looks exactly like another day number.
  if (/\sב[א-ת]+ \d\d$/.test(r.btnShown)) fail(T,
    `the date field reads "${r.btnShown}" - that trailing year looks like a day`); else ok();
  if (!/20\d\d/.test(r.btnShown)) fail(T,
    `the date field shows no full year: "${r.btnShown}"`); else ok();
  if (!/לילות|לילה/.test(r.btnNights)) fail(T,
    `the nights strip says "${r.btnNights}"`); else ok();
  if (r.btnDrewLinks !== 0) fail(T,
    'pressing an offer drew the engine links as well - the same thing that ' +
    'made "חפש" look pointless'); else ok();

  if (r.savedCount !== 1) fail(T, 'the search was not saved'); else ok();
  if (r.savedTwice !== 1) fail(T,
    `saving the same search twice made ${r.savedTwice} entries`); else ok();
  if (!r.savedShown) fail(T, 'a saved search is not listed'); else ok();
  if (r.restored !== 'מילאנו לשבוע' || r.restoredCi !== '2027-01-10') fail(T,
    `restoring gave "${r.restored}" / ${r.restoredCi}`); else ok();
  if (r.afterDelete !== 0) fail(T, 'a deleted search is still there'); else ok();
}

// ── the contact form is wired to the library it loads ─────────────────
// The page loads @emailjs/browser@4 and called it in the v3 way - init
// with a bare string instead of { publicKey } - so the library never had a
// key and every send failed. The reader was then told to "ask on Facebook",
// a channel that does not exist and never did.
{
  const r = await page.evaluate(() => {
    const src = submitContactForm.toString();
    const head = document.documentElement.innerHTML;
    return {
      sdkMajor: (head.match(/@emailjs\/browser@(\d+)/) || [])[1] || '',
      initObj:  /emailjs\.init\(\s*\{\s*publicKey/.test(src),
      initBare: /emailjs\.init\(\s*EMAILJS_PUBLIC_KEY\s*\)/.test(src.replace(/catch[\s\S]*?\}/g, '')),
      sendKey:  /publicKey:\s*EMAILJS_PUBLIC_KEY\s*\}\s*\)/.test(src),
      facebook: /פייסבוק/.test(src),
      knowsSaved: /_saved/.test(src),
      checksOk: /_saved\s*=\s*_r\.ok/.test(src) && /if\s*\(_saved\)/.test(src),
      successText: (src.match(/ההודעה [^'"<]*/g) || []).join(' | ')
    };
  });

  const T = 'the contact form is wired to the library it loads';
  if (r.sdkMajor !== '4') fail(T,
    `the page loads EmailJS v${r.sdkMajor || '?'} - this check assumes 4`); else ok();
  if (!r.initObj) fail(T,
    'init is not called with { publicKey }, which is the only form v4 accepts'); else ok();
  if (!r.sendKey) fail(T,
    'the key is not passed to send() either, so a refused init is fatal'); else ok();
  if (r.facebook) fail(T,
    'the failure message still sends people to a Facebook channel that does not exist'); else ok();
  // "Sent successfully" is a claim about the post, and the post failed
  // silently once already: EmailJS accepted the message and its Gmail
  // connection then dropped it three times over. We can only say it
  // reached us.
  if (/ההודעה נשלחה/.test(r.successText)) fail(T,
    'the form claims the message was SENT, which is more than we can see'); else ok();
  if (!/ההודעה התקבלה/.test(r.successText)) fail(T,
    `the success message reads "${r.successText}"`); else ok();
  if (!r.knowsSaved || !r.checksOk) fail(T,
    'the Supabase copy is written without checking whether it worked, so a ' +
    'message can vanish while the reader is told it failed'); else ok();
}

// ── the dashboard counts what is actually there ───────────────────────
// It read `window.allPosts`, and `allPosts` is declared with `let` at the
// top level of a classic script - a LEXICAL binding, which never becomes a
// property of window. So the panel showed 0 posts and 0 replies however
// busy the forum was, and the registered-user count was a hard-coded dash
// with a note saying "Supabase later".
{
  const r = await page.evaluate(async () => {
    if (typeof populateAdminStats !== 'function') return { unreachable: true };
    const now = Date.now();
    (0, eval)('allPosts = ' + JSON.stringify([
      { id: 1, user: 'דני',  content: 'שלום',  timestamp: now, reactions: { like: 2, snow: 1 } },
      { id: 2, user: 'רבקה', content: 'תודה',  timestamp: now, reactions: { like: 3 } },
      { id: 3, user: 'אבי',  content: 'מעולה', timestamp: now - 9e8, reactions: {} }
    ]));
    // The stub goes in BEFORE populateAdminStats, because that function
    // fires _admCountUsers WITHOUT awaiting it. Stubbing afterwards left two
    // calls in flight - the stubbed one and the real one - and whichever
    // landed last won. On a loaded machine the real one (blocked network,
    // so a dash) landed second and the check failed at random. A test that
    // passes by timing is not a test.
    const realFetch = window.sbFetch;
    window.sbFetch = async () => new Array(7).fill(0).map((_, i) => ({ id: i }));
    await populateAdminStats();
    await new Promise(r2 => setTimeout(r2, 200));
    const txt = id => (document.getElementById(id) || {}).textContent || '';
    const out = { posts: txt('stat-posts'), today: txt('stat-today-posts'),
                  reactions: txt('stat-reactions'), users: txt('stat-users'),
                  usesWindow: /window\.allPosts\s*\|\|/.test(populateAdminStats.toString()) };
    // the user count, with the query answering and then refusing
    out.usersOk = txt('stat-users');
    window.sbFetch = async () => null;
    await _admCountUsers(); await new Promise(r2 => setTimeout(r2, 60));
    out.usersFail = txt('stat-users');
    window.sbFetch = realFetch;

    const x = document.querySelector('#adminModal .close-btn');
    out.closeChar = x ? x.textContent.trim() : '';
    out.closeBg   = x ? getComputedStyle(x).backgroundColor : '';
    (0, eval)('allPosts = []');
    return out;
  });

  const T = 'the dashboard counts what is actually there';
  if (r.unreachable) { warn(T, 'populateAdminStats is not reachable from the page scope'); }
  else {
    if (r.usesWindow) fail(T,
      'the stats read window.allPosts again - a top-level `let` is never on window'); else ok();
    if (r.posts !== '3') fail(T,
      `three posts in the forum, dashboard says "${r.posts}"`); else ok();
    if (r.today !== '2') fail(T,
      `two posts today, dashboard says "${r.today}"`); else ok();
    if (r.reactions !== '6') fail(T,
      `six reactions, dashboard says "${r.reactions}"`); else ok();
    // Both branches, with sbFetch stubbed: the network is blocked in this
    // container, so without a stub the catch always rescues and the real
    // behaviour is never reached.
    if (r.usersOk !== '7') fail(T,
      `seven profiles, the dashboard says "${r.usersOk}"`); else ok();
    if (r.usersFail !== '—') fail(T,
      `a refused query shows "${r.usersFail}" - "no users" and "could not ` +
      `ask" are different statements`); else ok();

    if (r.closeChar !== '×') fail(T,
      `the dashboard's close control reads "${r.closeChar}"`); else ok();
    if (!/rgba\(0, 0, 0, 0\)|transparent/.test(r.closeBg)) fail(T,
      `the close ✕ is white on a ${r.closeBg} disc - an empty circle`); else ok();
  }
}

// ── a pasted picture becomes an attachment ────────────────────────────
// Ctrl+V on a screenshot did nothing, which reads as a broken page. The
// picture is routed into the same file input the paperclip fills, so the
// test is: does the input end up holding a file, and does the label say so.
{
  const r = await page.evaluate(async () => {
    const ta = document.getElementById('new-post-text');
    const fi = document.getElementById('new-post-file');
    if (!ta || !fi) return { missing: true };
    const out = {};

    const png = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
                         { type: 'image/png' });
    const mk = (payload) => {
      const dt = new DataTransfer();
      if (payload === 'image') dt.items.add(new File([png], 'x.png', { type: 'image/png' }));
      else dt.setData('text/plain', 'שלום');
      return new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    };

    // a picture, pasted into the post box
    const ev = mk('image');
    ta.dispatchEvent(ev);
    await new Promise(r2 => setTimeout(r2, 30));
    out.attached  = !!(fi.files && fi.files.length);
    out.fileName  = fi.files && fi.files[0] ? fi.files[0].name : '';
    out.fileType  = fi.files && fi.files[0] ? fi.files[0].type : '';
    out.label     = (document.getElementById('new-post-file-name') || {}).textContent || '';
    out.swallowed = ev.defaultPrevented;

    // plain text must paste as text, as it always did
    fi.value = '';
    const ev2 = mk('text');
    ta.dispatchEvent(ev2);
    await new Promise(r2 => setTimeout(r2, 20));
    out.textUntouched = !ev2.defaultPrevented && !(fi.files && fi.files.length);

    // and a paste anywhere else must not reach into the forum's input
    const other = document.createElement('textarea');
    other.id = 'not-a-forum-box';
    document.body.appendChild(other);
    const ev3 = mk('image');
    other.dispatchEvent(ev3);
    await new Promise(r2 => setTimeout(r2, 20));
    out.elsewhere = !(fi.files && fi.files.length);
    other.remove();
    fi.value = '';

    // the name the upload will see must carry an extension the uploader allows
    out.allowed = typeof FORUM_ALLOWED !== 'undefined' && FORUM_ALLOWED.test(out.fileName);
    return out;
  });

  const T = 'a pasted picture becomes an attachment';
  if (r.missing) warn(T, 'the post composer is not on the page');
  else {
    if (!r.attached) fail(T, 'the pasted picture never reached the file input'); else ok();
    if (!r.swallowed) fail(T,
      'the paste was not intercepted, so the picture also lands as junk text'); else ok();
    if (!/^image\//.test(r.fileType)) fail(T,
      `the attached file is "${r.fileType}" and not an image`); else ok();
    if (!r.allowed) fail(T,
      `the pasted file is named "${r.fileName}", which the uploader refuses`); else ok();
    if (!r.label) fail(T,
      'nothing on screen says a file is attached, so the writer cannot tell'); else ok();
    if (!r.textUntouched) fail(T,
      'pasting text now attaches a file or is swallowed'); else ok();
    if (!r.elsewhere) fail(T,
      'a paste outside the forum fills the forum attachment'); else ok();
  }
}

// ── the password rule says what it actually enforces ──────────────────
// The field said "at least 6 characters in English" while digits and
// symbols were always accepted, and nothing told the writer that a capital
// and a symbol are worth having. A rule that misstates itself teaches
// people to ignore it.
{
  const r = await page.evaluate(async () => {
    const inp = document.getElementById('reg-pass');
    const msg = document.getElementById('pass-validity-msg');
    if (!inp || !msg || typeof checkPassValidity !== 'function') return { missing: true };
    // The rule used to live in the placeholder and now sits beside the
    // label, because inside the box it dragged the caret to the Hebrew side
    // of a field that only takes latin letters. Wherever it is, it has to
    // be on screen and it has to be true.
    const panel = document.getElementById('auth-panel-register');
    const out = { placeholder: inp.getAttribute('placeholder') || '',
                  rule: panel ? (panel.textContent || '') : '' };
    const say = (v) => { inp.value = v; checkPassValidity(); return msg.textContent || ''; };
    out.short  = say('abc');
    out.hebrew = say('סיסמה123');
    out.digits = say('123456');       // digits only - allowed, and must be ACCEPTED
    out.weak   = say('abcdef');
    out.strong = say('Abcdef!');
    inp.value = ''; checkPassValidity();
    return out;
  });

  const T = 'the password rule says what it actually enforces';
  if (r.missing) warn(T, 'the registration password field is not on the page');
  else {
    if (/באנגלית/.test(r.rule)) fail(T,
      'the box still says "באנגלית" - digits and symbols are accepted too'); else ok();
    if (!/6/.test(r.rule)) fail(T,
      'nothing in the registration box states the one rule there is'); else ok();
    if (!/לועזיות/.test(r.rule)) fail(T,
      'the box does not say the letters have to be latin, which is the thing ' +
      'a Hebrew keyboard gets wrong'); else ok();
    if (!/6 תווים/.test(r.short)) fail(T,
      `three characters are answered with "${r.short}"`); else ok();
    if (!/עברית/.test(r.hebrew)) fail(T,
      'a Hebrew password is not caught, and signing in will fail later'); else ok();
    if (/⚠️|❌/.test(r.digits)) fail(T,
      `six digits are refused ("${r.digits}") though the code accepts them`); else ok();
    if (!/מומלץ/.test(r.weak)) fail(T,
      `a valid but plain password says "${r.weak}" and recommends nothing`); else ok();
    if (/מומלץ/.test(r.strong) || !/✅/.test(r.strong)) fail(T,
      `a password that already has a capital and a symbol is still nagged: "${r.strong}"`); else ok();
  }
}

// ── the way in says it is also the way to join ────────────────────────
{
  const r = await page.evaluate(() => {
    const src = document.documentElement.innerHTML;
    return { label: /כניסה \/ הרשמה/.test(src) };
  });
  const T = 'the way in says it is also the way to join';
  if (!r.label) fail(T,
    'the header button says only "כניסה", so there is nothing telling a ' +
    'first-time visitor where to register'); else ok();
}

// ── the search box is a search box ────────────────────────────────────
// Chrome kept offering the saved username and password on it. Every hint
// that exists was already on the field; hints are advisory and the password
// manager ignored them. It cannot offer anything on an element that is not
// a form control, so neither box is an <input> any more - and the rest of
// the page still reads them through .value.
{
  const r = await page.evaluate(() => {
    const g = document.getElementById('global-search-input');
    const f = document.getElementById('search-input');
    if (!g || !f) return { missing: true };
    const out = { gTag: g.tagName, fTag: f.tagName,
                  gEditable: g.isContentEditable, fEditable: f.isContentEditable,
                  gPh: g.getAttribute('data-ph') || '', fPh: f.getAttribute('data-ph') || '' };
    // the shim the whole page depends on
    if (typeof _asTextBox === 'function') { _asTextBox(g); _asTextBox(f); }
    g.value = 'בדיקה';
    out.readsBack = g.value;
    out.inDom = g.textContent;
    g.value = '';
    out.cleared = g.value;
    return out;
  });
  const T = 'the search box is a search box';
  if (r.missing) warn(T, 'a search box is not on the page');
  else {
    if (r.gTag === 'INPUT' || r.fTag === 'INPUT') fail(T,
      'a search box is still an <input>, which the password manager may ' +
      'offer saved credentials on'); else ok();
    if (!r.gEditable || !r.fEditable) fail(T,
      'a search box cannot be typed into'); else ok();
    if (!r.gPh || !r.fPh) fail(T,
      'a search box has no placeholder, so it is a blank strip'); else ok();
    if (r.readsBack !== 'בדיקה' || r.inDom !== 'בדיקה') fail(T,
      `.value does not round-trip (read back "${r.readsBack}") - the forum ` +
      `filter and half the page read these boxes that way`); else ok();
    if (r.cleared !== '') fail(T, 'clearing the box leaves text behind'); else ok();
  }
}

// ── search reaches inside the panels ──────────────────────────────────
// The index was twenty-one hand-written rows, which is the buttons. A word
// that lives inside a panel found nothing, and the dropdown rendered white
// on white, so even what it did find looked like an empty box.
{
  const r = await page.evaluate(async () => {
    if (typeof globalSearch !== 'function') return { missing: true };
    const box = document.getElementById('global-search-results');
    const out = {};

    // a word taken from a panel's own text, so the test cannot drift
    const idx = (typeof _panelTextIndex === 'function') ? _panelTextIndex(true) : [];
    out.panels = idx.length;
    const src = idx.find(p => p.text.length > 200);
    let word = '';
    if (src) {
      const words = src.text.split(' ').filter(w => /^[֐-׿]{5,}$/.test(w));
      word = words[Math.floor(words.length / 2)] || '';
      out.word = word;
      out.fromPanel = src.id;
    }
    if (word) {
      globalSearch(word);
      out.html = box.innerHTML;
      out.shown = box.style.display;
      const row = box.querySelector('div[onclick]');
      out.rowText = row ? (row.textContent || '').trim() : '';
      out.rowColor = row ? getComputedStyle(row).color : '';
      out.boxColor = getComputedStyle(box).color;
    }
    globalSearch('סקי פס');
    out.buttonHit = (box.textContent || '').indexOf('סקי פס') !== -1;
    globalSearch('');
    return out;
  });

  const T = 'search reaches inside the panels';
  if (r.missing) warn(T, 'globalSearch is not on the page');
  else {
    if (r.panels < 10) fail(T,
      `only ${r.panels} panels are indexed; the site has far more`); else ok();
    if (!r.word) fail(T, 'no panel had enough text to search for'); else ok();
    if (r.shown !== 'block') fail(T,
      `a word taken from a panel ("${r.word}") produced no dropdown`); else ok();
    if (!r.rowText || r.rowText.length < 3) fail(T,
      'the result row carries an icon and no words'); else ok();
    // white on white: the bug that made every result look blank
    if (/rgb\(255, 255, 255\)/.test(r.rowColor || '')) fail(T,
      'the result text is white, and the dropdown is white'); else ok();
    if (/rgb\(255, 255, 255\)/.test(r.boxColor || '')) fail(T,
      'the dropdown inherits white text from the header'); else ok();
    if (!r.buttonHit) fail(T,
      'the old button index stopped working'); else ok();
  }
}

// ── a result says what it found, and opens at it ──────────────────────
// The rows read "פס — צ'רוויניה" and "בצ'רוויניה": the title had its first
// WORD stripped to drop the emoji, which ate a real word whenever the two
// were not separated by a space. The ℹ️ in each row was the share button,
// read out of the heading along with its text. And clicking a result
// opened a long panel at the top, leaving the reader to find the word.
{
  const r = await page.evaluate(async () => {
    if (typeof _panelTextIndex !== 'function') return { missing: true };
    const box = document.getElementById('global-search-results');
    const out = {};

    // titles, as the rows will show them
    const idx = _panelTextIndex(true);
    out.titles = idx.map(p => _splitTitle(p.title).title);
    out.icons  = idx.map(p => _splitTitle(p.title).icon);
    out.withGlyph = out.titles.filter(t => /[✕×ℹ️🔗]/.test(t));
    out.shortOnes = out.titles.filter(t => t.length < 4);

    // a word that lives in a panel, searched for
    const src = idx.find(p => p.text.length > 400);
    const words = src.text.split(' ').filter(w => /^[֐-׿]{5,}$/.test(w));
    const word = words[Math.floor(words.length / 2)] || '';
    out.word = word;
    globalSearch(word);
    out.marked = /<mark class="cl-hit">/.test(box.innerHTML);
    const row = [...box.querySelectorAll('div[onclick]')]
      .find(x => /openPanelAtTerm/.test(x.getAttribute('onclick') || ''));
    out.opensAtTerm = !!row;
    out.rowTitle = row ? (row.querySelector('b') || {}).textContent || '' : '';

    // and the click marks the word inside the panel and scrolls to it
    if (row) {
      eval(row.getAttribute('onclick').replace(';closeGlobalSearch()', ''));
      await new Promise(r2 => setTimeout(r2, 320));
      // scoped to the panels: the dropdown's own snippet marks the word
      // too, and counting those made this look like a leak that was not one
      const marks = document.querySelectorAll('.modal mark.cl-hit');
      out.marksInPanel = marks.length;
      out.markText = marks.length ? marks[0].textContent : '';
      out.markHits = marks.length ? _wordHit(marks[0].textContent, word) : false;
      // and they come off when the panel closes
      // a hit inside a closed fold is a hit nobody sees
      const firstMark = document.querySelector('.modal mark.cl-hit');
      let fold = firstMark ? firstMark.parentNode : null, closedFold = false;
      while (fold && fold.classList && !fold.classList.contains('modal')) {
        if (fold.tagName === 'DETAILS' && !fold.open) closedFold = true;
        fold = fold.parentNode;
      }
      out.closedFold = closedFold;

      const openId = (typeof _openModalId !== 'undefined') ? _openModalId : '';
      if (openId) closeM(openId);
      out.marksAfterClose = document.querySelectorAll('.modal mark.cl-hit').length;
    }
    globalSearch('');
    return out;
  });

  const T = 'a result says what it found, and opens at it';
  if (r.missing) warn(T, 'the panel index is not on the page');
  else {
    if (r.withGlyph.length) fail(T,
      `a result title carries the panel's own buttons: "${r.withGlyph[0]}"`); else ok();
    if (r.shortOnes.length) fail(T,
      `a title was cut down to "${r.shortOnes[0]}" - the emoji strip ate a word`); else ok();
    if (!r.marked) fail(T,
      'the searched word is not marked in the snippet, so the reader cannot ' +
      'see why the row matched'); else ok();
    if (!r.opensAtTerm) fail(T,
      'a content hit still opens the panel at the top'); else ok();
    if (!r.rowTitle || r.rowTitle.length < 4) fail(T,
      `the row's title reads "${r.rowTitle}"`); else ok();
    if (!r.marksInPanel) fail(T,
      'opening the panel does not mark the word inside it'); else ok();
    // not an exact string compare: the mark lands on the word AS WRITTEN -
    // "המוצרים" for a search of "מוצרים" - and that is the point of it
    if (r.markText && !r.markHits) fail(T,
      `the mark landed on "${r.markText}", which is not the word searched ` +
      `for ("${r.word}")`); else ok();
    if (r.closedFold) fail(T,
      'the word was marked inside a fold that is still shut, so the reader ' +
      'lands on a panel with nothing visible'); else ok();
    if (r.marksAfterClose) fail(T,
      'the marks stay in the panel after it closes'); else ok();
  }
}

// ── the search forgives how Hebrew is written ─────────────────────────
// A literal substring match answers "מחירון" and loses "מחירונים", and
// finds nothing at all for "מחירונ" while somebody is still typing.
{
  const r = await page.evaluate(() => {
    if (typeof _wordHit !== 'function') return { missing: true };
    const out = {};
    out.sameWord   = _wordHit('מחירון', 'מחירון');
    out.plural     = _wordHit('מחירונים', 'מחירון');   // the longer word is found
    out.halfTyped  = _wordHit('מחירון', 'מחירונ');     // mid-typing
    out.finalForm  = _wordHit('מחירון', 'מחירונ');     // ן vs נ
    out.oneTypo    = _wordHit('מחירון', 'מחירן');      // a letter missed
    out.notAnyTwo  = _wordHit('מחירון', 'מח');         // two letters must NOT match everything
    out.different  = _wordHit('מסלול', 'מחירון');
    out.latin      = _wordHit('Cervinia', 'cervin');
    // and the whole query has to land, not just one word of it
    out.bothWords  = _textHit('מחירון השכרה לעונה', 'מחירון השכרה');
    out.oneMissing = _textHit('מחירון השכרה לעונה', 'מחירון חניה');
    const hit = _firstHit('הנה המחירונים של העונה', 'מחירון');
    out.hitWord = hit ? hit.word : '';
    return out;
  });

  const T = 'the search forgives how Hebrew is written';
  if (r.missing) warn(T, 'the matcher is not on the page');
  else {
    if (!r.sameWord) fail(T, 'a word does not match itself'); else ok();
    if (!r.plural) fail(T,
      'searching "מחירון" does not find "מחירונים"'); else ok();
    if (!r.halfTyped) fail(T,
      'a half-typed word finds nothing, so the dropdown stays empty while ' +
      'the reader types'); else ok();
    if (!r.oneTypo) fail(T, 'one missed letter loses the result'); else ok();
    if (r.notAnyTwo) fail(T,
      'two letters match a whole word - at that point every result matches'); else ok();
    if (r.different) fail(T, 'two unrelated words match'); else ok();
    if (!r.latin) fail(T, 'Latin text stopped matching'); else ok();
    if (!r.bothWords) fail(T, 'a two-word query does not match'); else ok();
    if (r.oneMissing) fail(T,
      'a query matches when only one of its words is there'); else ok();
    if (r.hitWord !== 'המחירונים') fail(T,
      `the highlight lands on "${r.hitWord}" instead of the whole word`); else ok();
  }
}

// ── writing a review, and living with it afterwards ───────────────────
// The box sat under other people's reviews and looked like the end of the
// last one; there was no way to correct a review once posted, and no way
// to say anything about somebody else's.
{
  const r = await page.evaluate(async () => {
    const panel = document.getElementById('reviews-panel');
    if (!panel) return { missing: true };
    const kids = [...panel.children].map(n => n.id);
    const out = { order: kids };

    (0, eval)("user = { name: 'בודק', sbId: 'u1', isAdmin: false }");
    _reviews = [
      { id: 'r1', user: 'בודק', cat: '🏨 לינה', rating: 4, text: 'דירה טובה',
        timestamp: Date.now(), authorId: 'u1', reacts: { counts: {}, mine: {} } },
      { id: 'r2', user: 'אחר', cat: '⛷️ מסלולים', rating: 5, text: 'מצוין',
        timestamp: Date.now(), authorId: 'u2', reacts: { counts: { '👍': 2 }, mine: {} } }
    ];
    _reviewsOnline = true;
    renderReviews();
    const html = document.getElementById('reviews-list').innerHTML;
    out.editOnMine   = /editReview\('r1'\)/.test(html);
    out.editOnTheirs = /editReview\('r2'\)/.test(html);
    out.reacts       = /reactReview\('r2','👍'\)/.test(html);
    out.count        = /👍<span[^>]*>2</.test(html);

    // the composer is a card of its own, not a white box among white boxes
    renderReviewWriteArea();
    const comp = document.getElementById('review-write-area').firstElementChild;
    out.compBg = comp ? getComputedStyle(comp).backgroundColor : '';
    out.compBorder = comp ? getComputedStyle(comp).borderTopWidth : '';

    // editing opens on the card itself
    editReview('r1');
    const h2 = document.getElementById('reviews-list').innerHTML;
    out.editBox = !!document.getElementById('rev-edit-text');
    out.editText = (document.getElementById('rev-edit-text') || {}).value || '';
    out.editCats = (h2.match(/_revEditDraft\.cat=/g) || []).length;
    cancelEditReview();
    out.closed = !document.getElementById('rev-edit-text');

    _reviews = []; (0, eval)('user = null'); renderReviews(); renderReviewWriteArea();
    return out;
  });

  const T = 'writing a review, and living with it afterwards';
  if (r.missing) warn(T, 'the reviews panel is not on the page');
  else {
    if (r.order.indexOf('review-write-area') > r.order.indexOf('reviews-list')) fail(T,
      'the composer still sits under the list, where it reads as the end of ' +
      'the last review'); else ok();
    if (!r.editOnMine) fail(T, 'there is no way to edit your own review'); else ok();
    if (r.editOnTheirs) fail(T,
      'the edit pencil is offered on somebody else\'s review'); else ok();
    if (!r.reacts) fail(T, 'a review cannot be reacted to'); else ok();
    if (!r.count) fail(T, 'the count of a reaction is not shown'); else ok();
    if (!/rgb\(245, 249, 255\)/.test(r.compBg || '') ) fail(T,
      `the composer has no card of its own (background ${r.compBg})`); else ok();
    if (parseFloat(r.compBorder || '0') < 1) fail(T,
      'the composer has no border, so it blends into the list'); else ok();
    if (!r.editBox) fail(T, 'the edit form does not open'); else ok();
    if (r.editText !== 'דירה טובה') fail(T,
      `the edit form opens with "${r.editText}" instead of what was written`); else ok();
    if (r.editCats < 5) fail(T,
      'the edit form offers no categories to move the review to'); else ok();
    if (!r.closed) fail(T, 'cancelling leaves the edit form open'); else ok();
  }
}

// ── a review has somewhere to go ──────────────────────────────────────
// Five fixed categories in the code, and a browser alert when none was
// chosen - the one that says "cervinialive.co.il says" above it.
{
  const r = await page.evaluate(async () => {
    const out = {};
    out.hasOther = REVIEW_CATS[REVIEW_CATS.length - 1] === REVIEW_CAT_OTHER;
    out.count = REVIEW_CATS.length;

    // an admin's list is honoured, "other" is not stored twice, and an
    // empty list still leaves the reader somewhere to write
    _setReviewCats(['🎿 ציוד', '🎿 ציוד', REVIEW_CAT_OTHER]);
    out.afterSet = REVIEW_CATS.slice();
    _setReviewCats([]);
    out.afterEmpty = REVIEW_CATS.length;
    _setReviewCats(['🎿 ציוד']);

    // and the message is the site's, not the browser's
    let alerted = false;
    const realAlert = window.alert;
    window.alert = () => { alerted = true; };
    (0, eval)("user = { name: 'בודק', sbId: 'x', isAdmin: false }");
    renderReviewWriteArea();
    reviewDraft = { rating: 0, cat: '', text: '' };
    await submitReview();
    out.alerted = alerted;
    out.msg = (document.getElementById('review-msg') || {}).textContent || '';
    out.msgShown = ((document.getElementById('review-msg') || {}).style || {}).display;
    window.alert = realAlert;
    (0, eval)('user = null');
    renderReviewWriteArea();
    return out;
  });

  const T = 'a review has somewhere to go';
  if (!r.hasOther) fail(T,
    'there is no "other" category, so a subject outside the list has ' +
    'nowhere to go'); else ok();
  if (r.count < 8) fail(T,
    `only ${r.count} categories - the list is still the short fixed one`); else ok();
  if (r.afterSet.filter(c => c === '💬 אחר').length !== 1) fail(T,
    '"other" appears twice when an admin saves a list that contains it'); else ok();
  if (r.afterSet.filter(c => c === '🎿 ציוד').length !== 1) fail(T,
    'a duplicate category is kept twice'); else ok();
  if (r.afterEmpty < 2) fail(T,
    'an empty list leaves the reader with no categories at all'); else ok();
  if (r.alerted) fail(T,
    'a missing category is still reported with a browser alert'); else ok();
  if (!/קטגוריה/.test(r.msg) || r.msgShown !== 'block') fail(T,
    `the page says "${r.msg}" instead of asking for a category`); else ok();
}

// ── forgetting a password actually works now ──────────────────────────
// Three faults, all of them silent: the reset asked the database for the
// address behind a username and printed it back; it then asked Supabase to
// reset an address no account was registered with, so nothing was ever
// sent while the page said it had been; and a Supabase user could not
// change a password anywhere in the site.
{
  const r = await page.evaluate(async () => {
    const src = document.documentElement.innerHTML;
    const out = {
      usesFn:    /functions\/v1\/reset-password/.test(src),
      oldRpc:    /rpc\('cl_reset_email'/.test(src),
      printsMail: /קישור לאיפוס נשלח למייל שלך/.test(src),
      vague:     /אם שם המשתמש קיים/.test(src),
      namesUser: /לא נמצא משתמש/.test(src),
      hasBox:    !!document.getElementById('pwResetModal'),
      hasField:  !!document.getElementById('pw-reset-new'),
      updates:   /auth\.updateUser\(\{ password/.test(src),
      profileRefuses: /שינוי סיסמה לא זמין למשתמש זה/.test(src),
      profileUpdates: /sbNow\.auth\.updateUser/.test(src),
      checksOld: /signInWithPassword\(\{ email: loginEmail/.test(src)
    };
    // the reset form must say the same thing whatever name is typed
    if (typeof supabaseSendPasswordReset === 'function') {
      const realFetch = window.fetch;
      let seen = null;
      window.fetch = async (u, o) => { seen = { u: String(u), o: o }; return { ok: true, json: async () => ({ ok: true }) }; };
      const res = await supabaseSendPasswordReset('מישהו');
      window.fetch = realFetch;
      out.called = seen ? seen.u : '';
      out.body   = seen && seen.o ? String(seen.o.body || '') : '';
      out.leaks  = !!(res && res.realEmail);
    }
    // and the new-password box must refuse a password the login would
    if (typeof submitPasswordReset === 'function') {
      const f = document.getElementById('pw-reset-new');
      if (f) {
        f.value = 'abc';
        await submitPasswordReset();
        out.shortMsg = (document.getElementById('pw-reset-msg') || {}).textContent || '';
        f.value = 'סיסמה123';
        await submitPasswordReset();
        out.hebrewMsg = (document.getElementById('pw-reset-msg') || {}).textContent || '';
        f.value = '';
      }
    }
    return out;
  });

  const T = 'forgetting a password actually works now';
  if (!r.usesFn) fail(T,
    'the reset is still done from the browser; the address and the account ' +
    'it belongs to are decided in the page'); else ok();
  if (r.oldRpc) fail(T,
    'the page still looks the address up by username'); else ok();
  if (r.leaks || r.printsMail) fail(T,
    'the form prints the address back, which tells whoever typed a name ' +
    'that this person is registered and where he reads his mail'); else ok();
  // This used to require the opposite - one sentence for every name, so
  // that the box could not be used to find out who is registered. The
  // usernames are on every forum post anyway, so nothing was hidden, and
  // the person who forgot his password was left unable to tell whether the
  // name he typed had reached anything at all. The address still never
  // comes back; only whether the name exists.
  if (r.vague) fail(T,
    'the form still answers "if this name exists", which answers nothing'); else ok();
  if (!r.namesUser) fail(T,
    'the form has no answer for a name that does not exist'); else ok();
  if (!/\/functions\/v1\/reset-password$/.test(r.called || '')) fail(T,
    `the reset posts to "${r.called}"`); else ok();
  if (!/"username"/.test(r.body || '')) fail(T,
    'the request carries no username'); else ok();
  if (!r.hasBox || !r.hasField) fail(T,
    'the reset link leads to a page with nowhere to set a new password'); else ok();
  if (!r.updates) fail(T,
    'the box does not actually update the password'); else ok();
  if (!/6 תווים/.test(r.shortMsg || '')) fail(T,
    `a three-character password is answered with "${r.shortMsg}"`); else ok();
  if (!/עברית/.test(r.hebrewMsg || '')) fail(T,
    'a Hebrew password is accepted here, and the login will then refuse it'); else ok();
  if (r.profileRefuses && !r.profileUpdates) fail(T,
    'the profile still tells a Supabase user that changing a password is ' +
    'not available, which is everybody'); else ok();
  if (!r.checksOld) fail(T,
    'the profile changes the password without checking the current one'); else ok();
}

// ── the letter can be written in English too ──────────────────────────
{
  const r = await page.evaluate(async () => {
    if (typeof buildLocalStayMail !== 'function') return { missing: true };
    const pick = (v) => {
      const el = document.querySelector('input[name="ls-lang"][value="' + v + '"]');
      if (el) { el.checked = true; }
    };
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    // one range field now, not two boxes that did not know about each other
    setLocalStayDates('2027-01-10', '2027-01-15'); set('ls-guests', '5');
    pick('en'); buildLocalStayMail();
    const out = {
      en:    (document.getElementById('ls-it') || {}).value || '',
      enHe:  (document.getElementById('ls-he') || {}).textContent || '',
      label: (document.getElementById('ls-out-label') || {}).textContent || '',
      mail:  (document.getElementById('ls-send-cervino') || {}).href || ''
    };
    pick('it'); buildLocalStayMail();
    out.it = (document.getElementById('ls-it') || {}).value || '';
    return out;
  });

  const T = 'the letter can be written in English too';
  if (r.missing) warn(T, 'the local-stay panel is not on the page');
  else {
    if (!/Hello,/.test(r.en) || !/Buongiorno/.test(r.it)) fail(T,
      'the language switch does not change the letter'); else ok();
    // Not 10/01 here: plenty of English readers would take that for October.
    if (!/10 January 2027/.test(r.en)) fail(T,
      'the English letter writes the date in digits, which half its readers ' +
      'will read as another month'); else ok();
    if (!/5 nights/.test(r.en) || !/5 people/.test(r.en)) fail(T,
      'the English letter loses the nights or the number of people'); else ok();
    if (!/total price/.test(r.en)) fail(T,
      'the English letter does not ask for the total'); else ok();
    if (!/אנגלית/.test(r.label)) fail(T,
      `the label above the letter still says "${r.label}"`); else ok();
    if (!/Apartment%20request/.test(r.mail)) fail(T,
      'the send button keeps the Italian subject on an English letter'); else ok();
    if (!/5 לילות/.test(r.enHe)) fail(T,
      'the Hebrew mirror stops working when the language changes'); else ok();
  }
}

// ── the letter to the local agencies ──────────────────────────────────
// The panel's advice is worthless without it: the agencies answer in
// Italian and the reader does not write it. So the letter has to carry the
// dates in the form an Italian reads, say the same thing in Hebrew, and
// arrive at the agency already written.
{
  const r = await page.evaluate(async () => {
    if (typeof buildLocalStayMail !== 'function') return { missing: true };
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    const tick = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v; };
    // one range field now, not two boxes that did not know about each other
    setLocalStayDates('2027-01-10', '2027-01-15'); set('ls-guests', '5');
    ['ls-opt-lift','ls-opt-park','ls-opt-kitchen','ls-opt-linen'].forEach(id => tick(id, false));
    buildLocalStayMail();
    const out = {
      it: (document.getElementById('ls-it') || {}).value || '',
      he: (document.getElementById('ls-he') || {}).textContent || '',
      mail: (document.getElementById('ls-send-cervino') || {}).href || '',
      cons: (document.getElementById('ls-send-cons') || {}).href || ''
    };
    tick('ls-opt-lift', true); tick('ls-opt-park', true);
    buildLocalStayMail();
    out.itLift = (document.getElementById('ls-it') || {}).value || '';
    out.heLift = (document.getElementById('ls-he') || {}).textContent || '';
    // an unfinished form must not produce a letter that looks finished
    const _ld = document.getElementById('ls-dates');
    _ld.removeAttribute('data-ci'); _ld.removeAttribute('data-co'); _ld.value = '';
    buildLocalStayMail();
    out.empty = (document.getElementById('ls-it') || {}).value || '';
    return out;
  });

  const T = 'the letter to the local agencies';
  if (r.missing) warn(T, 'the local-stay panel is not on the page');
  else {
    // 10 January, not 1 October. The whole point of writing it out.
    if (!/10\/01\/2027/.test(r.it) || /01\/10\/2027/.test(r.it)) fail(T,
      'the date reaches an Italian reader as month/day, which is a different day'); else ok();
    if (!/15\/01\/2027/.test(r.it)) fail(T, 'the departure date is missing'); else ok();
    if (!/5 notti/.test(r.it)) fail(T,
      '10-15 January is five nights; the letter does not say so'); else ok();
    if (!/5 persone/.test(r.it)) fail(T, 'the letter does not say how many people'); else ok();
    if (!/prezzo totale/.test(r.it) || !/pulizie finali/.test(r.it)) fail(T,
      'the letter asks the price without asking what is added to it - cleaning ' +
      'and the tourist tax are what turn a quote into a different number'); else ok();
    // the Hebrew must be the same letter, not a decoration
    if (!/10\/01\/2027/.test(r.he) || !/5 לילות/.test(r.he)) fail(T,
      'the Hebrew version does not carry the same dates and nights'); else ok();
    if (!/המחיר הכולל/.test(r.he)) fail(T,
      'the Hebrew version does not say what the Italian one asks for'); else ok();
    // a tick must change BOTH languages, or the reader is signing blind
    if (!/impianti di risalita/.test(r.itLift) || !/posto auto/.test(r.itLift)) fail(T,
      'ticking a question does not add it to the Italian'); else ok();
    if (!/המרחק מהמעליות/.test(r.heLift) || !/מקום חניה/.test(r.heLift)) fail(T,
      'ticking a question adds it to the Italian but not to the Hebrew, so the ' +
      'reader sends a sentence he never read'); else ok();
    // and it must arrive already written
    if (!/^mailto:info@ilcervino\.com\?/.test(r.mail)) fail(T,
      `the send button points at "${r.mail.slice(0, 60)}"`); else ok();
    if (!/body=[^&]*Buongiorno/.test(decodeURIComponent(r.mail))) fail(T,
      'the mail opens empty instead of carrying the letter'); else ok();
    if (!/info@breuil-cervinia\.it/.test(r.cons)) fail(T,
      'the consortium button does not point at the consortium'); else ok();
    if (!/\[date\]|\[data\]/.test(r.empty)) fail(T,
      'with no dates filled in, the letter still reads as though it had them'); else ok();
  }
}

// ── the users tab lists the users ─────────────────────────────────────
// This tab was never built: it held a fixed line of text saying "full user
// management will need Supabase", and Supabase has been wired in the whole
// time. Three branches matter here - people, nobody, and could-not-ask -
// and the last two must not read the same.
{
  const r = await page.evaluate(async () => {
    if (typeof _admRenderUsers !== 'function') return { unreachable: true };
    const host = document.getElementById('admin-users-list');
    if (!host) return { noHost: true };
    const real = window.sbFetchAuth, realAnon = window.sbFetch;
    const out = {};
    // the anonymous helper must not be the one that fetches this list
    window.sbFetch = async (q) => { out.anonQuery = q; return []; };

    // a visitor who is not an admin
    (0, eval)('user = null');
    await _admRenderUsers();
    out.stranger = host.textContent;
    out.strangerAsked = !!out.anonQuery;

    (0, eval)("user = { name: 'יוסי', isAdmin: true }");
    window.sbFetchAuth = async (q) => { out.query = q; return [
      { username: 'יוסי', email: 'yossi@example.com', level: 'advanced',
        discipline: 'ski', is_admin: true,  created_at: '2026-10-02T08:00:00Z' },
      { username: 'רבקה', email: null, level: 'beginner',
        discipline: 'snowboard', is_admin: false, created_at: '2026-09-14T08:00:00Z' },
      { username: '<img src=x onerror=alert(1)>', email: '<img src=y>@x.com',
        level: null, discipline: null, is_admin: false, created_at: null }
    ]; };
    await _admRenderUsers();
    out.full = host.innerHTML;
    out.text = host.textContent;
    // Not a regex over innerHTML: the DOM re-serialises attributes with
    // quotes, so `<img src=x` never matches and the check is toothless.
    // The question is whether the typed name became an element at all.
    out.injected = host.querySelectorAll('img, script').length;

    window.sbFetchAuth = async () => [];
    await _admRenderUsers();
    out.empty = host.textContent;

    window.sbFetchAuth = async () => null;
    await _admRenderUsers();
    out.refused = host.textContent;

    window.sbFetchAuth = async () => { throw new Error('offline'); };
    await _admRenderUsers();
    out.threw = host.textContent;

    window.sbFetchAuth = real; window.sbFetch = realAnon;
    (0, eval)('user = null');

    // what the page asks for WITHOUT a signed-in person must never be the
    // table that holds the addresses
    const src = document.documentElement.innerHTML;
    out.anonTable  = /sbFetch\('profiles\?/.test(src) ||
                     /from\('profiles'\)[\s\S]{0,80}\.select\('username, level/.test(src);
    out.usesView   = /profiles_public\?select=username,avatar_url/.test(src);
    // Any column will do - the point is that the count comes from the view
    // and not from the table. Pinning the column name made this fail the day
    // `id` was taken out of the view for a reason that had nothing to do
    // with counting, which is a check testing the wrong thing.
    out.viewCount  = /profiles_public\?select=\w+/.test(src);
    out.loginRpc   = /rpc\('cl_login_email'/.test(src) &&
                     !/from\('profiles'\)\.select\('internal_email'\)/.test(src);
    out.takenRpc   = /rpc\('cl_username_taken'/.test(src);
    // The reset no longer asks the database at all - it goes to the edge
    // function, which never hands the address back. This used to require
    // the cl_reset_email RPC; requiring it now would be requiring the leak.
    out.resetGone  = !/rpc\('cl_reset_email'/.test(src) &&
                     /functions\/v1\/reset-password/.test(src);
    out.regRpc     = /rpc\('cl_register_profile'/.test(src) &&
                     !/upsert\(\{[\s\S]{0,120}internal_email/.test(src);
    out.stub = /יצטרך Supabase/.test(document.documentElement.innerHTML);
    out.staleNote = /נתוני משתמשים ב-localStorage/.test(document.documentElement.innerHTML);
    return out;
  });

  const T = 'the users tab lists the users';
  if (r.unreachable) warn(T, '_admRenderUsers is not reachable from the page scope');
  else if (r.noHost) fail(T, 'there is no #admin-users-list to fill');
  else {
    if (r.stub) fail(T,
      'the placeholder text is still in the page - the tab was not rebuilt'); else ok();
    // and the footnote that said the data lives in localStorage: it does not,
    // and a caption that contradicts what the reader sees above it is worse
    // than no caption.
    if (r.staleNote) fail(T,
      'the tab still carries the note saying the data lives in localStorage'); else ok();
    if (!/profiles\?select=/.test(r.query || '')) fail(T,
      `the list is built from "${r.query}" and not from the profiles table`); else ok();
    if (!/\bemail\b/.test(r.query || '')) fail(T,
      'the admin list no longer asks for the addresses'); else ok();
    // and it must be the token-bearing helper that asks for them
    if (r.anonQuery) fail(T,
      `the addresses are fetched with the public key (${r.anonQuery}) - RLS ` +
      `then has no person to judge, and the list answers anyone`); else ok();
    if (!/למנהלים בלבד/.test(r.stranger || '')) fail(T,
      `a visitor who is not an admin sees "${(r.stranger||'').trim().slice(0,50)}"`); else ok();
    if (r.strangerAsked) fail(T,
      'the page queries for the addresses before knowing who is asking'); else ok();
    if (!/yossi@example\.com/.test(r.text)) fail(T,
      'the address is not shown to the admin'); else ok();
    if (!/אין מייל רשום/.test(r.text)) fail(T,
      'a user with no address shows an empty gap instead of saying so'); else ok();
    if (r.anonTable) fail(T,
      'something still reads the profiles table itself without a token'); else ok();
    if (!r.usesView || !r.viewCount) fail(T,
      'the forum and the counter still read profiles instead of profiles_public'); else ok();
    if (!r.loginRpc) fail(T,
      'login still looks the internal address up in the table, which is a ' +
      'query that works before anyone signs in'); else ok();
    if (!r.takenRpc) fail(T,
      'the name-taken check still reads the table'); else ok();
    if (!r.resetGone) fail(T,
      'the password reset still looks an address up from the browser'); else ok();
    if (!r.regRpc) fail(T,
      'registration still writes internal_email from the browser'); else ok();
    if (!/יוסי/.test(r.text) || !/רבקה/.test(r.text)) fail(T,
      'a registered name is missing from the list'); else ok();
    if (!/3 משתמשים/.test(r.text)) fail(T,
      'the list does not say how many people are registered'); else ok();
    if (!/מנהל/.test(r.text)) fail(T,
      'the admin is not marked as one'); else ok();
    if (!/מתקדם/.test(r.text) || !/מתחיל/.test(r.text)) fail(T,
      'the ski level is shown in English, or not at all'); else ok();
    if (!/02\.10\.2026/.test(r.text)) fail(T,
      'the join date is missing or still in ISO order'); else ok();
    // A username is typed by whoever registered. It is rendered inside the
    // panel's own HTML, so it goes through esc or it is a script tag.
    if (r.injected) fail(T,
      'a typed username became a live element in the panel - it is written ' +
      'in unescaped'); else ok();
    if (!/אין עדיין משתמשים/.test(r.empty)) fail(T,
      `an empty table shows "${r.empty.trim().slice(0, 60)}"`); else ok();
    if (/אין עדיין משתמשים/.test(r.refused) || !/לא הצלחנו לקרוא/.test(r.refused)) fail(T,
      '"the query was refused" is shown as "nobody has registered"'); else ok();
    if (!/לא הצלחנו לקרוא/.test(r.threw)) fail(T,
      'a thrown request leaves the tab on "loading" for ever'); else ok();
  }
}

// ── four ways to buy, and the village is one of them ────────────────
// It listed three and left out the one people actually end up using: walking
// into a shop in Cervinia the morning after they land. Leaving it out made the
// page read as if buying there were impossible, when the real point is that
// the village sells a different shelf - big brands at list price in season -
// so arriving without a jacket costs about three times what it costs at home.
{
  const src = fs.readFileSync(PAGE, 'utf8');
  const T = 'four ways to buy, and the village is one of them';

  const i = src.indexOf('דרכים לקנות');
  if (i < 0) { fail(T, 'the section on where to buy is gone'); }
  else {
    ok();
    const head = src.slice(i - 40, i + 40);
    if (!/ארבע דרכים לקנות/.test(head)) fail(T,
      `the heading still counts something other than four: "${head.replace(/<[^>]*>/g,'').trim()}"`);
    else ok();

    const sec = src.slice(i, src.indexOf('</details>', i)).replace(/\s+/g, ' ');
    // the four, each by the words that name it
    for (const [re_, what] of [[/בארץ, לפני הנסיעה/, 'buying at home'],
                               [/באיטליה, בדרך ממילאנו/, 'buying on the road from Milan'],
                               [/אונליין/, 'buying online'],
                               [/בכפר, ברגע האחרון/, 'buying in the village']]) {
      if (!re_.test(sec)) fail(T, `${what} is missing from the four`); else ok();
    }

    // the heading promises four; the body has to hold four
    const ways = (sec.match(/class="prep-h"/g) || []).length;
    if (ways !== 4) fail(T,
      `the heading says four ways and the body has ${ways}`); else ok();

    // and the village is only worth a section if it says what it costs
    const vil = sec.slice(sec.indexOf('בכפר, ברגע האחרון'));
    if (!/Helly Hansen/.test(vil) || !/450/.test(vil)) fail(T,
      'the village section no longer carries a real price, so "expensive" is ' +
      'just an adjective'); else ok();
    if (!/מחירון/.test(vil)) fail(T,
      'nothing says the village charges list price, which is the actual ' +
      'mechanism'); else ok();

    // the same jacket on both sides, or the comparison proves nothing
    const ita = sec.slice(sec.indexOf('באיטליה, בדרך ממילאנו'));
    if (!/QUECHUA 500/.test(ita) || !/WEDZE 500 AM/.test(ita)) fail(T,
      'the Italy comparison no longer names the models, so it is not the same ' +
      'jacket on both sides'); else ok();

    // a converted price is only honest if the rate it used is on the page
    if (/₪/.test(vil) && !/3\.45|3,45/.test(sec)) fail(T,
      'euros are converted to shekels with no rate given'); else ok();
  }

  // Decathlon sells the jackets too - saying "base layers and accessories"
  // sent people to a specialist shop to pay double for the same category.
  const shops = src.slice(src.indexOf('function gearShops'),
                          src.indexOf('var PACK_LIST'));
  const dec = shops.slice(shops.indexOf("title: 'דקטלון'"), shops.indexOf("title: 'דקטלון'") + 400);
  if (!/מעילים/.test(dec) || !/מכנסי סקי/.test(dec)) fail(T,
    'the Decathlon entry still reads as if it only sold the small things'); else ok();
}

// ── a Hebrew term carries the English it is sold under ──────────────
// Somebody stands in a shop or types into a search box, and what is printed
// on the tag is English. The Hebrew word for a powder skirt or a pit zip is
// one most readers have never met, so the pair travels together. These are
// the ones that cost money to get wrong.
{
  const src = fs.readFileSync(PAGE, 'utf8');
  const T = 'a Hebrew term carries the English it is sold under';
  const plan = src.replace(/\s+/g, ' ');

  for (const [he, en] of [['חצאית שלג', 'Powder skirt'],
                          ['פתחי אוורור בבתי השחי', 'Pit zips'],
                          ['תפרים מודבקים', 'Taped seams'],
                          ['עמידות למים', 'Waterproof'],
                          ['נשימות', 'Breathability'],
                          ['שכבת בסיס', 'Base layer'],
                          ['שכבה אמצעית', 'Mid layer'],
                          ['כסיות', 'Mittens'],
                          ['פוטוכרומית', 'Photochromic'],
                          ['צמר מרינו', 'Merino']]) {
    const at = plan.indexOf('<b>' + he + '</b>');
    if (at < 0) { fail(T, `"${he}" is gone from the page`); continue; }
    const after = plan.slice(at, at + he.length + 80);
    if (!after.includes(en)) fail(T,
      `"${he}" no longer carries "${en}", and that is the word on the tag`);
    else ok();
  }
}

// ── the header button says what it actually opens ───────────────────
// It said "כניסה" and opened a window with two tabs, one of which is how you
// register in the first place - so somebody with no account read the header as
// "members only" and left. The label now names both, and the help text has to
// name the button the same way or it sends people looking for one that is not
// there.
{
  const src = fs.readFileSync(PAGE, 'utf8');
  const T = 'the header button says what it actually opens';

  // the label is L('Hebrew', 'English') now; the Hebrew is what is checked
  const m = src.match(/class="signin-btn">\$\{L\('([^']*)'/) || src.match(/class="signin-btn">([^<]*)<\/button>/);
  if (!m) fail(T, 'the header sign-in button is gone'); else {
    ok();
    const label = m[1].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
    if (!/כניסה/.test(label) || !/הרשמה/.test(label)) fail(T,
      `the button reads "${label}"; it has to name both, because somebody ` +
      'without an account cannot tell that it is where they sign up'); else ok();

    // and the help has to point at the button by the name on the button
    const help = src.slice(src.indexOf('איך נרשמים?'), src.indexOf('איך נרשמים?') + 400)
      .replace(/<[^>]*>/g, '');
    if (!help.includes(label)) fail(T,
      `the help tells people to press something other than "${label}"`); else ok();
  }
}

// ── the boot is buckled from the top down, and loosely at the foot ──
// This section is advice somebody follows at seven in the morning with cold
// hands, so a sentence that drifts the wrong way is worse than no section.
// Two things carry it, and both are counter-intuitive enough that an editor
// might "correct" them: the order is top down, and the two buckles over the
// foot are left loose. Reverse either and the reader gets a boot that holds
// the heel forward all day, or numb toes by eleven. So the gate asks for the
// claim AND refuses its opposite.
{
  const src = fs.readFileSync(PAGE, 'utf8');
  const T = 'the boot is buckled from the top down, and loosely at the foot';

  const i = src.indexOf('איך נועלים את המגף');
  if (i < 0) { fail(T, 'the section on buckling the boot is gone'); }
  else {
    ok();
    // tags out and whitespace flattened, so a line break inside a sentence
    // cannot make a phrase look missing
    const sec = src.slice(i, src.indexOf('מגלשיים</div>', i))
      .replace(/<[^>]*>/g, '').replace(/\s+/g, ' ');

    if (!/לסגור מלמעלה למטה/.test(sec)) fail(T,
      'the section no longer says to buckle from the top down, which is the ' +
      'one thing it exists to say'); else ok();
    if (/לסגור מלמטה למעלה|קודם.{0,20}האבזמים שעל כף הרגל/.test(sec)) fail(T,
      'the section now tells people to start at the foot, which locks the heel ' +
      'forward for the day'); else ok();

    if (!/האבזמים שעל כף הרגל — רפויים/.test(sec)) fail(T,
      'nothing says the two buckles over the foot are left loose'); else ok();
    if (/עצבים וכלי דם/.test(sec) && /אצבעות קרות/.test(sec)) ok(); else fail(T,
      'the reason for leaving them loose - nerves and vessels over the instep, ' +
      'and cold toes - has gone, so the instruction reads arbitrary');

    if (!/האבזם השני מלמעלה הוא החשוב ביותר/.test(sec)) fail(T,
      'the second buckle from the top is no longer named as the one that holds ' +
      'the heel'); else ok();

    // the heel has to be seated before anything is closed, or the rest is moot
    const heel = sec.indexOf('להושיב את העקב');
    const close = sec.indexOf('לסגור מלמעלה למטה');
    if (heel < 0 || close < 0 || heel > close) fail(T,
      'seating the heel no longer comes before closing the buckles'); else ok();

    // at a break: ease the lower two, do not throw the boot open
    if (!/לשחרר את שני האבזמים התחתונים בלבד/.test(sec)) fail(T,
      'the advice for breaks and long lifts is gone'); else ok();
    if (/לפתוח את המגף לגמרי בהפסקה|לפתוח הכל בהפסקה/.test(sec)) fail(T,
      'the page now says to open the boot fully at a break, and the foot swells ' +
      'and will not go back in'); else ok();

    // this one is only safe because the socks section says one thin pair
    if (!/בתוך המגף נמצאת רק הגרב/.test(sec)) fail(T,
      'nothing says the sock is the only thing inside the boot'); else ok();

    // The trouser goes OVER the boot. Tucked in it builds a funnel straight
    // onto the sock, and it is the mistake you can see on any piste - so the
    // page has to say it outright, and say what the wrong way actually does.
    if (!/המכנס יורד מעל המגף/.test(sec)) fail(T,
      'nothing says the trouser goes over the boot'); else ok();
    if (!/Inner gaiter/.test(sec)) fail(T,
      'the inner gaiter is not named, so the reader cannot tell which part of ' +
      'the trouser does go inside'); else ok();
    if (!/משפך/.test(sec)) fail(T,
      'the page no longer says what tucking the trouser in actually does'); else ok();
  }
}

// ── the sock drawing is measured, not eyeballed ─────────────────────
// The figure faces LEFT, so the calf is the right-hand edge of the drawing.
// Reading the left edge - the shin - once put the knee mark two thirds of the
// way down the leg, and the whole picture said the wrong thing. Anchoring on
// the sole (image row 972) and the hollow behind the knee (row 169, 46 cm up)
// gives 17.46 px per cm; the tracer then scaled by 1000/1024.
//
// The cross-check below is what makes that trustworthy: on this scale the
// drawing's own calf belly has to land where a real calf belly sits. It does,
// at 32.4 cm. If somebody re-anchors the figure and that number walks off, the
// scale is wrong and every line on it is wrong with it.
{
  const src = fs.readFileSync(PAGE, 'utf8');
  const T = 'the sock drawing is measured, not eyeballed';

  const i = src.indexOf('class="sock-fig"');
  if (i < 0) { fail(T, 'the sock drawing is gone from the page'); }
  else {
    ok();
    const fig = src.slice(i, src.indexOf('</svg>', i));
    const K = 1000 / 1024, SOLE = 972, KNEE = 169, CALF = 406;
    const S = (SOLE - KNEE) / 46;
    const at = cm => Math.round((SOLE - cm * S) * K);

    // the calf belly is the whole reason the heights are where they are
    const calfCm = (SOLE - CALF) / S;
    if (!(calfCm > 29 && calfCm < 34)) fail(T,
      `on its own scale the drawn calf belly sits ${calfCm.toFixed(1)} cm above ` +
      'the floor, which is not where a calf is - so the scale is wrong'); else ok();

    // every rule, with the colour that carries its meaning: reading the row
    // alone would pass even if the green and the red swapped places
    const rules = [...fig.matchAll(
      /d="M[\d.]+ ([\d.]+)[Hh][\d.]+"\s+stroke="(#[0-9a-f]{3,6})"/g)]
      .map(m => ({ row: Math.round(+m[1]), ink: m[2] }));
    const row = ink => (rules.find(r => r.ink === ink) || {}).row;

    for (const [want, ink, what] of [[Math.round(KNEE * K), '#90a4b7', 'the knee'],
                                     [at(42), '#0d7a42', 'the 40-45 cm sock'],
                                     [at(30), '#b03024', 'the 30 cm sock'],
                                     [Math.round(CALF * K), '#5c7a99', 'the calf belly']]) {
      const got = row(ink);
      if (got === undefined) fail(T, `${what} has no mark of its own in the figure`);
      else if (Math.abs(got - want) > 1) fail(T,
        `${what} is drawn on row ${got}; the measurement puts it on ${want}`);
      else ok();
    }

    // the order IS the lesson: a good sock clears the calf belly, a short one
    // stops on it. Read off the figure, not recomputed - recomputing would
    // only be checking the arithmetic in this file.
    if (!(row('#90a4b7') < row('#0d7a42') &&
          row('#0d7a42') < row('#5c7a99') &&
          row('#5c7a99') <= row('#b03024'))) fail(T,
      `the figure no longer reads knee (${row('#90a4b7')}), then the good sock ` +
      `(${row('#0d7a42')}), then the calf belly (${row('#5c7a99')}), then the ` +
      `short one (${row('#b03024')})`); else ok();

    if (!/בליטת השוק/.test(fig)) fail(T,
      'the calf belly is marked but not named, so the reader cannot tell what ' +
      'the sock has to clear'); else ok();
    if (!/40&#8211;45 ס&quot;מ|40–45 ס"מ/.test(fig)) fail(T,
      'the figure no longer carries the height to look for'); else ok();
    if (!/>30 ס&quot;מ|>30 ס"מ/.test(fig)) fail(T,
      'the figure no longer shows what too short looks like'); else ok();
  }

  // The photograph beside it cannot be measured - the camera is low and close,
  // so the boot is nearer the lens than the calf and comes out too big. Scale
  // it and the sock appears to pass the knee, which it plainly does not. It is
  // there to show what a ski sock looks like, and its caption must not claim
  // a height or the two pictures contradict each other.
  const j = src.indexOf('img/boot-sock.jpg');
  if (j < 0) fail(T, 'the photograph is gone'); else {
    ok();
    const cap = src.slice(j, src.indexOf('</figure>', j));
    if (/ברך|ס&quot;מ|ס"מ|סנטימ/.test(cap)) fail(T,
      'the photograph\'s caption states a height or names the knee, and that ' +
      'picture cannot be measured - the perspective makes the boot too big'); else ok();
  }

  // and the words around it must agree with the drawing
  const prose = src.slice(src.indexOf('גרבי סקי — והמלכודת שבהן'),
                          src.indexOf('בלי כותנה'));
  if (!/40–45 ס"מ/.test(prose)) fail(T,
    'the text no longer gives the height to look for in the product description');
  else ok();
  if (/מעל הברך/.test(prose)) fail(T,
    'the text says the sock goes above the knee; it goes just below it'); else ok();
}

// ── the pictures are files, and they survive losing the signal ───────
// They were base64 strings inside index.html: 1.1 MB, 47% of the page, and
// because base64 of a JPEG does not compress, 68% of what every visitor
// actually downloaded before seeing anything. As files they are fetched
// once and cached on their own - but only if the service worker is told to,
// because it handles navigations and leaves every other request alone. Left
// as it was, moving them out would have taken the piste map offline exactly
// when somebody is on the mountain with no signal.
{
  const src = fs.readFileSync(PAGE, 'utf8');
  const T = 'the pictures are files, and they survive losing the signal';

  const b64 = (src.match(/data:image\/[a-z+]+;base64,/g) || []).length;
  if (b64) fail(T,
    `${b64} picture(s) are still pasted into the page as base64`); else ok();
  if (!/_pisteMapImg = "\.\/img\/piste-map\.jpg"/.test(src)) fail(T,
    'the piste map is not pointed at its file'); else ok();
  if (!/id="brand-logo"[^>]*src="\.\/img\/logo\.png"/.test(src)) fail(T,
    'the logo is not pointed at its file'); else ok();

  for (const f of ['img/piste-map.jpg', 'img/logo.png', 'files/packing-list.pdf',
                     'img/jacket-tag.jpg', 'img/boot-sock.jpg']) {
    const abs = near(f);
    if (!fs.existsSync(abs)) { fail(T, `${f} is referenced but not on disk`); continue; }
    ok();
    const kb = fs.statSync(abs).size / 1024;
    if (f.includes('piste-map') && kb > 450) fail(T,
      `the piste map is ${kb.toFixed(0)} KB - it was meant to come down from 619`); else ok();
    if (f.includes('logo') && kb > 30) fail(T,
      `the logo is ${kb.toFixed(0)} KB`); else ok();
    if (f.includes('packing') && kb > 400) fail(T,
      `the printable list is ${kb.toFixed(0)} KB`); else ok();
    if (f.includes('jacket-tag') && kb > 120) fail(T,
      `the jacket tag picture is ${kb.toFixed(0)} KB`); else ok();
    if (f.includes('boot-sock') && kb > 60) fail(T,
      `the sock photograph is ${kb.toFixed(0)} KB`); else ok();
  }

  // the worker has to keep them, or they are gone the moment the signal is
  const swFile = near('sw.js');
  if (!fs.existsSync(swFile)) warn(T, 'sw.js is not beside the page');
  else {
    const sw = fs.readFileSync(swFile, 'utf8');
    if (!/img\/piste-map\.jpg/.test(sw)) fail(T,
      'the service worker does not precache the piste map, so it is unavailable ' +
      'with no signal - which is when it is wanted'); else ok();
    if (!/files\/packing-list\.pdf/.test(sw)) fail(T,
      'the printable list is not precached, so it cannot be downloaded without ' +
      'a signal'); else ok();
    if (!/\/files\//.test(sw.split('addEventListener(\'fetch\'')[1] || '')) fail(T,
      'the fetch handler has no rule for files/'); else ok();
    if (!/\/img\//.test(sw.split('addEventListener(\'fetch\'')[1] || '')) fail(T,
      'the fetch handler has no rule for img/, so the pictures are never ' +
      'served from the cache'); else ok();
    if (!/cervinia-v2/.test(sw)) fail(T,
      'the cache name was not bumped, so browsers keep the old cache and never ' +
      'precache the pictures'); else ok();
    // and the rule that was there before must still hold
    if (!/req\.mode !== 'navigate'/.test(sw)) fail(T,
      'the worker no longer leaves non-navigation requests alone - live data ' +
      'could now be served stale'); else ok();
  }

  // the upload script has to know about them or they never reach the site
  const proj = near('sync/projects.json');
  if (!fs.existsSync(proj)) warn(T, 'sync/projects.json is not beside the page');
  else {
    const files = JSON.parse(fs.readFileSync(proj, 'utf8')).cervinia.Files;
    for (const f of ['img/piste-map.jpg', 'img/logo.png', 'files/packing-list.pdf',
                       'img/jacket-tag.jpg']) {
      if (!files.includes(f)) fail(T,
        `${f} is not in the upload list, so the page would go live pointing at ` +
        `a file that is not there`); else ok();
    }
  }
}

// ── the plug advice, and the one line of it that is a safety line ───
// The page used to say flatly that an Israeli plug does not fit. It does:
// the two-pin one IS the europlug, and Italian sockets take it. Only the
// three-pin one is stuck, and a few-shekel adapter solves it - except that
// such an adapter drops the earth, and the things people carry for Shabbat
// are an urn and a hotplate. That caveat is the reason this section exists.
{
  const src = fs.readFileSync(PAGE, 'utf8');
  const T = 'the plug advice, and the one line of it that is a safety line';

  const i = src.indexOf('חשמל — לקרוא לפני שאורזים');
  if (i < 0) { fail(T, 'the electricity section is gone'); }
  else {
    ok();
    const sec = src.slice(i, src.indexOf('שתי שאלות לבעל הדירה', i))
      .replace(/<[^>]*>/g, '').replace(/\s+/g, ' ');

    if (/תקע ישראלי אינו נכנס/.test(sec)) fail(T,
      'the page is back to saying no Israeli plug fits, which sends people to ' +
      'buy adapters they do not need'); else ok();
    if (!/שני פינים/.test(sec) || !/נכנס/.test(sec)) fail(T,
      'nothing says the two-pin plug goes straight in'); else ok();
    if (!/שלושה פינים/.test(sec)) fail(T,
      'nothing says which plug actually needs an adapter'); else ok();

    // the safety line: an adapter that drops the earth, and the two
    // appliances on this very page that must not lose it
    if (!/הארקה/.test(sec)) fail(T,
      'the adapter is recommended without saying it gives up the earth'); else ok();
    if (!/מיחם/.test(sec) || !/פלטה/.test(sec)) fail(T,
      'the warning does not name the urn and the hotplate - the two things the ' +
      'Shabbat list tells people to bring, and the two that must stay earthed');
    else ok();
  }

  // and the list below still asks for those two, which is what makes the
  // warning above load-bearing rather than theoretical
  const list = src.slice(src.indexOf('<div class="prep-h">הרשימה</div>'),
                         src.indexOf('<div class="prep-h">הרשימה</div>') + 2500);
  if (!/מיחם/.test(list) || !/פלטה חשמלית/.test(list)) fail(T,
    'the Shabbat list no longer asks for the urn and hotplate, so check the ' +
    'earthing warning above still points at something real'); else ok();
}

// ── Shabbat is findable, and the free-text box explains itself ──────
// Two things readers could not find. Shabbat was a band inside a fold inside
// the packing section, three taps deep and filed under luggage; it now lives
// beside the candle-lighting times, with a signpost where it used to be and a
// card on the planner's menu. And the free-text box looked like an ordinary
// search field, so nobody knew they could write a sentence or what the button
// would do with it.
{
  const r = await page.evaluate(async () => {
    const out = {};

    // Shabbat, where it lives now
    openM('kosherModal');
    const apt = document.getElementById('shabbat-apartment');
    out.aptExists = !!apt;
    const t = apt ? apt.textContent : '';
    out.aptHasPower   = /חשמל/.test(t);
    out.aptHasCandles = /נרות/.test(t);
    out.aptHasFriday  = /14:00/.test(t);
    // it has to sit in the Shabbat half of that panel, not the kashrut half
    const panel = document.getElementById('kosh-main-panel-shabbat');
    out.aptInShabbatPanel = !!(panel && apt && panel.contains(apt));
    closeM('kosherModal');

    // the two doors to it
    openM('hotelModal');
    const jump = document.querySelector('.prep-jump');
    const card = document.querySelector('.plan-card-out');
    out.jumpExists = !!jump;
    out.jumpGoes = !!(jump && /openKosherShabbat/.test(jump.getAttribute('onclick') || ''));
    out.cardGoes = !!(card && /openKosherShabbat/.test(card.getAttribute('onclick') || ''));
    // And the old home holds no second copy. Tested on the substance - the
    // Friday finishing rule and the light-sensor line - not on the words
    // "שעון שבת", which the signpost's own blurb legitimately uses.
    const prep = document.getElementById('prep-fold');
    const ptxt = prep ? prep.textContent : '';
    // The light sensors appear in both places on purpose: explained in the
    // Shabbat panel, and again as a line to tick on the packing list. That is
    // a checklist, not a second copy. The Friday rule and a Shabbat band are
    // the real signals that the material came back.
    out.noDuplicate = !!prep && !/14:00/.test(ptxt) &&
                      ![...prep.querySelectorAll('.prep-group')]
                        .some(d => /שבת/.test(d.textContent));

    // the free-text box
    planGo('search');
    const free = document.getElementById('trip-free');
    const card2 = free ? free.closest('div').parentElement : null;
    out.freeLabelled = !!(card2 && /כתבו במילים שלכם/.test(card2.textContent));
    out.freeExplains = !!(card2 && /משפט אחד/.test(card2.textContent));
    const btn = card2 ? [...card2.querySelectorAll('button')]
                          .find(b => /applyTripText/.test(b.getAttribute('onclick') || '')) : null;
    out.btnSaysWhat = !!(btn && /מלא\s*בשבילי/.test(btn.textContent));

    // and the answer is a card with chips, not a line of grey text
    if (free) {
      free.value = 'מילאנו בפברואר לשבוע, 2 מבוגרים ורכב';
      try { await applyTripText(); } catch (e) {}
      await new Promise(r => setTimeout(r, 300));
    }
    const said = document.getElementById('trip-free-said');
    out.answerChips = said ? said.querySelectorAll('span').length : 0;
    // "Is there a border anywhere in there" passed even when the card was
    // reduced to a bare coloured line, because the chips inside carry borders
    // of their own. What makes it a card is the box around them: the answer's
    // own first element has to have a background and a border of its own.
    const inner = said ? said.firstElementChild : null;
    const cs = inner ? getComputedStyle(inner) : null;
    out.answerBoxed = !!(inner && cs &&
      !/^rgba\(0, 0, 0, 0\)$|^transparent$/.test(cs.backgroundColor) &&
      parseFloat(cs.borderTopWidth || '0') > 0);
    out.answerSaysFilled = !!(said && /מילאתי/.test(said.textContent));
    closeM('hotelModal');
    return out;
  });

  const T = 'Shabbat is findable, and the free-text box explains itself';
  if (!r.aptExists) fail(T, 'the Shabbat-in-the-apartment material is gone'); else ok();
  if (!r.aptInShabbatPanel) fail(T,
    'it is no longer in the Shabbat half of the kashrut panel'); else ok();
  for (const [got, what] of [[r.aptHasPower, 'the electricity advice'],
                             [r.aptHasCandles, 'the candles'],
                             [r.aptHasFriday, 'the Friday finishing time']]) {
    if (!got) fail(T, `${what} did not come across with it`); else ok();
  }
  if (!r.jumpExists) fail(T,
    'nothing is left where Shabbat used to be, so a reader in the packing ' +
    'section will not know it exists'); else ok();
  if (!r.jumpGoes) fail(T, 'the signpost does not open the Shabbat panel'); else ok();
  if (!r.cardGoes) fail(T,
    'the Shabbat card on the planner menu does not open the Shabbat panel'); else ok();
  if (!r.noDuplicate) fail(T,
    'the packing section holds a second copy of the Shabbat material, so the ' +
    'two will drift apart'); else ok();

  if (!r.freeLabelled) fail(T,
    'the free-text box has no label, so it reads as an ordinary search field');
  else ok();
  if (!r.freeExplains) fail(T,
    'nothing tells the reader to write one sentence'); else ok();
  if (!r.btnSaysWhat) fail(T,
    'the button says "understand" without saying it fills the fields below');
  else ok();
  if (r.answerChips < 3) fail(T,
    `the answer shows ${r.answerChips} parts; it should list what it took from ` +
    'the sentence'); else ok();
  if (!r.answerBoxed) fail(T,
    'the answer is a bare line again, and readers did not notice it'); else ok();
  if (!r.answerSaysFilled) fail(T,
    'the answer does not say that the fields below were filled in'); else ok();
}

// ── pressing for Shabbat lands on Shabbat ───────────────────────────
// The card on the planner's menu opened the kashrut panel at the top of the
// times table, four screens above what the reader had pressed for, with no
// sign it was there. It now lands on the section with the first fold open,
// and a small chip floats at the side while there is still somewhere to go.
//
// All of it failed silently once already - a duplicate function name meant
// every fix went into a copy nobody called - so the behaviour is checked,
// not the code.
{
  const r = await page.evaluate(async () => {
    const out = {};
    const box0 = document.querySelector('#kosherModal .modal-content');
    const sec0 = document.getElementById('shabbat-apartment');
    if (!box0 || !sec0) { out.missing = true; return out; }

    // Give the panel a height first. With no network the times table never
    // fills, so on a fresh open there is nothing to scroll and the deep link
    // would "pass" by having nothing to do. Open every fold, then close the
    // modal: the folds stay open, so the next open is tall.
    openM('kosherModal');
    switchKoshMain('shabbat');
    document.querySelectorAll('#kosh-main-panel-shabbat details')
      .forEach(d => { d.open = true; });
    await new Promise(r2 => setTimeout(r2, 80));
    out.scrollable = box0.scrollHeight > box0.clientHeight + 8;
    box0.scrollTop = 0;
    const relTop = () =>
      sec0.getBoundingClientRect().top - box0.getBoundingClientRect().top;
    out.farBefore = relTop() > box0.clientHeight - 48;
    closeM('kosherModal');
    await new Promise(r2 => setTimeout(r2, 60));

    // Now the real thing, and nothing else: whatever the card on the planner
    // menu calls, with no help from this check. Testing it by calling the
    // scroll helper directly is what let the deep link quietly stop scrolling
    // in the first place.
    openKosherShabbat();
    await new Promise(r2 => setTimeout(r2, 900));

    const box = document.querySelector('#kosherModal .modal-content');
    const sec = document.getElementById('shabbat-apartment');
    const chip = document.getElementById('shabbat-jump');
    out.hasChip = !!chip;
    out.foldOpened = !!document.querySelector('#shabbat-apartment details[open]');
    out.onScreenAfter =
      sec.getBoundingClientRect().top - box.getBoundingClientRect().top
      < box.clientHeight - 48;

    // the chip knows whether it still has anywhere to take you
    if (chip) {
      box.scrollTop = 0;
      box.dispatchEvent(new Event('scroll'));
      out.chipShownAtTop = !chip.classList.contains('is-done');
      _scrollToShabbatApartment();
      box.dispatchEvent(new Event('scroll'));
      out.chipGoneAtSection = chip.classList.contains('is-done');
      out.chipLabel = chip.textContent.trim();
      out.chipOverflows = chip.scrollWidth > chip.clientWidth + 2
                       || chip.scrollHeight > chip.clientHeight + 2;
      out.chipCandles = !!chip.querySelector('use[href="#ico-candle"]');
    }
    closeM('kosherModal');
    return out;
  });

  const T = 'pressing for Shabbat lands on Shabbat';
  if (r.missing) fail(T, 'the Shabbat section or its scroller is gone'); else {
    ok();
    if (!r.foldOpened) fail(T,
      'arriving from the planner no longer opens what the reader pressed for, ' +
      'so they land on a closed row'); else ok();
    if (!r.scrollable) fail(T,
      'the panel will not scroll even with every fold open - this check cannot ' +
      'tell whether the jump works'); else ok();
    if (!r.farBefore) fail(T,
      'the section is already on screen from the top, so there is nothing for ' +
      'the jump to do and this check proves nothing'); else ok();
    if (!r.onScreenAfter) fail(T,
      'opening from the planner card left the reader at the top of the times ' +
      'table, with no sign that what they pressed for is four screens below - ' +
      'which is exactly how this broke the first time, silently'); else ok();
    if (!r.hasChip) fail(T,
      'the chip that leads down to it is gone, so a reader who opened the ' +
      'panel for the times has no way of knowing the rest is there'); else ok();
    if (!r.chipShownAtTop) fail(T,
      'the chip hides at the top of the panel, where it is the only signpost');
    else ok();
    if (!r.chipGoneAtSection) fail(T,
      'the chip stays on screen once the section is reached, pointing at ' +
      'something already in front of the reader'); else ok();
    // It says what is down there and nothing more. "Everything you need to
    // know" overclaimed - the times are already on screen above it - and
    // repeating the section's own title said nothing the heading did not.
    // The label wraps, so match the words rather than the spacing.
    const label = (r.chipLabel || '').replace(/\s+/g, '');
    if (!/התארגנות/.test(label) || !/לשבת/.test(label)) fail(T,
      `the chip reads "${r.chipLabel}" - it has to say what it leads to`);
    else ok();
    if (r.chipOverflows) fail(T,
      'the label no longer fits inside the chip'); else ok();
    if (!r.chipCandles) fail(T,
      'the chip does not wear the drawn candles the rest of Shabbat wears');
    else ok();
  }
}

// ── one name, one function ──────────────────────────────────────────
// The whole app is one script, so two top-level `function foo()` declarations
// are not two functions: declarations hoist, the last one wins for the entire
// scope, and the earlier one is dead from the moment it is written - dead
// including for callers that sit above it.
//
// It cost an hour. A second openKosherShabbat was added without checking the
// name was free; every fix went into the copy nobody called, and the symptom
// was simply that nothing happened. _seasonISO had been quietly doubled the
// same way, the live one coping with a string argument and the dead one not.
// Neither throws, neither warns, and nothing else here would have caught it.
{
  const src = fs.readFileSync(PAGE, 'utf8');
  const T = 'one name, one function';
  const names = [...src.matchAll(/^function ([A-Za-z_$][\w$]*)\s*\(/gm)]
    .map(m => m[1]);
  const seen = new Map();
  for (const n of names) seen.set(n, (seen.get(n) || 0) + 1);
  const dups = [...seen].filter(([, c]) => c > 1);

  if (names.length < 100) fail(T,
    `only ${names.length} top-level functions found - the scan is not reading ` +
    'the file it thinks it is'); else ok();
  if (dups.length) fail(T,
    dups.map(([n, c]) => `${n}() is declared ${c} times`).join('; ') +
    ' - the last declaration wins and the others are dead, including for ' +
    'callers above them'); else ok();
}

// ── a push toggle may not disown the push ───────────────────────────
// PUSH_TOPICS is the list of things this device will be woken for. The snow
// row described itself as "not sent to the phone, only to the strip" - and
// it is sent to the phone, as a fresh-snow notification arriving on one
// proved. The same wrong belief sat as a comment beside the rule in
// scrape.js. A toggle that misdescribes what it controls is worse than no
// toggle: it decides for the reader on a false premise.
//
// Every row in this list is a push topic by definition, so none of them may
// say otherwise.
{
  const r = await page.evaluate(() => {
    if (typeof PUSH_TOPICS === 'undefined') return { missing: true };
    return {
      rows: PUSH_TOPICS.map(t => ({ k: t.k, label: t.label, sub: t.sub || '' })),
      count: PUSH_TOPICS.length
    };
  });

  const T = 'a push toggle may not disown the push';
  if (r.missing) fail(T, 'the list of push topics is gone'); else {
    ok();
    if (r.count < 3) fail(T,
      `only ${r.count} topics - the whole point is that somebody who wants ` +
      'one kind of alert does not have to take all of them'); else ok();

    // "not sent to the phone", "only on the strip", "will not be sent"
    const disowns = /לא נשלח|לא יישלח|רק לסרגל|רק בסרגל|לא לטלפון/;
    const liars = r.rows.filter(t => disowns.test(t.sub));
    if (liars.length) fail(T,
      `"${liars[0].label}" is a switch for what gets pushed to this phone, and ` +
      `its own description says "${liars[0].sub}"`); else ok();

    // and each one has to say what it will actually wake you for
    const bare = r.rows.filter(t => t.sub.trim().length < 6);
    if (bare.length) fail(T,
      `"${bare[0].label}" has no description, so the reader is guessing what ` +
      'they are turning off'); else ok();
  }
}

// ── good news does not wear the colour of bad news ──────────────────
// The crossing to Zermatt opening after a morning shut is the one alert
// people actively wait for: somebody who read at nine that it was closed
// has been checking ever since. It is urgent, and nothing is wrong - so it
// has to catch the eye without looking like an emergency. Green, with a
// glow rather than the danger pulse.
{
  const r = await page.evaluate(() => {
    const strip = document.getElementById('alert-strip');
    if (!strip) return { missing: true };
    const realA = window.getLiveAlerts, realN = window.getLiveNotices;
    const row = (key, severity) => ({
      id: 'x-' + key, key, severity, kind: 'alert', auto: true,
      text: 'בדיקה', user: 'צ׳רוויניה לייב',
      ts: new Date().toISOString(),
      expires_at: new Date(Date.now() + 36e5).toISOString()
    });
    const classFor = (key, severity) => {
      window.getLiveAlerts = () => [row(key, severity)];
      window.getLiveNotices = () => [];
      refreshAlertStrip();
      return strip.className;
    };
    const out = {
      open:   classFor('zermatt-open', 'info'),
      closed: classFor('zermatt-closed', 'danger'),
      shut:   classFor('zermatt-shut-today', 'warning')
    };
    window.getLiveAlerts = realA; window.getLiveNotices = realN;
    refreshAlertStrip();

    const css = [...document.styleSheets].flatMap(sh => {
      try { return [...sh.cssRules]; } catch (e) { return []; }
    }).filter(r2 => r2.selectorText && /severity-good/.test(r2.selectorText));
    out.goodStyled = css.length > 0;
    out.goodCss = css.map(r2 => r2.style.cssText).join(' ');
    return out;
  });

  const T = 'good news does not wear the colour of bad news';
  if (r.missing) fail(T, 'the alert strip is gone'); else {
    ok();
    if (!/severity-good/.test(r.open)) fail(T,
      `the crossing opening renders as "${r.open}" - it is the one alert ` +
      'people wait for, and it must not arrive looking like a problem'); else ok();
    if (!/severity-danger/.test(r.closed)) fail(T,
      `the crossing CLOSING renders as "${r.closed}" - that one really is bad ` +
      'news and must keep its colour'); else ok();
    if (/severity-good/.test(r.shut)) fail(T,
      'a crossing shut all day is being shown as good news'); else ok();
    if (!r.goodStyled) fail(T,
      'severity-good has no styling, so the strip falls back to the default');
    else ok();
    // the browser normalises hex to rgb(), so match on the colour itself
    // rather than on how it happened to be written
    const rgb = (r.goodCss.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/g) || [])
      .map(c => c.match(/\d+/g).map(Number));
    const green = rgb.some(([red, g, blue]) => g > red && g > blue);
    if (!green) fail(T,
      `severity-good has no colour where green leads: ${r.goodCss}`); else ok();
    if (!/alertGlow/.test(r.goodCss)) fail(T,
      'the good-news strip has no glow, so it reads as an ordinary notice ' +
      'and the person waiting for it scrolls past'); else ok();
    if (/alertPulse/.test(r.goodCss)) fail(T,
      'the good-news strip uses the danger pulse'); else ok();
  }
}

// ── the date picker is handed dates, not strings ────────────────────
// setTripDates passed flatpickr the ISO strings. Given a string, flatpickr
// parses it with the instance's own dateFormat - here 'j בF', Hebrew and
// with no year - which cannot read an ISO date. It then handed onChange an
// empty selection, onChange took its else branch, and the field stayed
// blank. So pressing a flight offer filled in nothing for every visitor
// whose browser had actually loaded flatpickr; it only ever worked where
// the CDN was blocked and the hand-written fallback ran instead. That is
// also why it passed here for months and failed on the build machine.
//
// There is no flatpickr in this environment, so the check installs a stub
// that records what it is given.
{
  const r = await page.evaluate(() => {
    const el = document.getElementById('trip-dates');
    if (!el) return { missing: true };
    const seen = [];
    const real = el._flatpickr;
    el._flatpickr = {
      selectedDates: [],
      clear() {},
      setDate(arg) {
        seen.push((Array.isArray(arg) ? arg : [arg]).map(
          x => x instanceof Date ? (isNaN(+x) ? 'Invalid Date' : 'Date') : typeof x));
      }
    };
    setTripDates('2027-01-12', '2027-01-17');
    if (real) el._flatpickr = real; else delete el._flatpickr;
    return { seen, ci: el.getAttribute('data-ci'), co: el.getAttribute('data-co') };
  });

  const T = 'the date picker is handed dates, not strings';
  if (r.missing) fail(T, 'the trip date field is gone'); else {
    ok();
    if (r.ci !== '2027-01-12' || r.co !== '2027-01-17') fail(T,
      `setTripDates recorded ${r.ci}..${r.co} rather than the dates it was given`);
    else ok();
    if (!r.seen.length) fail(T,
      'setTripDates never told the picker anything, so the calendar and the ' +
      'field will disagree'); else ok();
    const bad = r.seen.filter(call => call.some(t => t !== 'Date'));
    if (bad.length) fail(T,
      `the picker was handed ${JSON.stringify(bad[0])} - anything but a Date is ` +
      "parsed with the field's Hebrew format, which has no year, and the " +
      'selection comes back empty, so the date field stays blank'); else ok();
  }
}

// ── the season switch does not reload the page under you ────────────
// applySummerMode used to be a one-way function: it created banners and hid
// things, and a second call produced two of everything. So switching the
// season override forced location.reload() - which fired on every first
// visit whose override disagreed with the date. Those visitors downloaded
// the whole page twice and watched it flash, and the reload raced this very
// gate and destroyed its execution context, which is how it was found.
//
// The function now undoes its own last run. That property is the fix, so it
// is what gets checked: three calls must leave the page exactly as one call
// does, and switching back must restore what was there before.
{
  const r = await page.evaluate(() => {
    const snap = () => ({
      made: document.querySelectorAll('[data-season-made]').length,
      hid:  document.querySelectorAll('[data-season-hid]').length,
      grid: document.querySelectorAll('.services-grid > *').length
    });
    const before = snap();
    const keep = _seasonOverride;
    let out_status_before, out_status_after;

    // the Zermatt bar is repainted rather than created, and the element the
    // live bar writes into lives inside the markup it replaces
    const status = () => !!document.getElementById('zermatt-status');
    out_status_before = status();

    _seasonOverride = 'summer'; applySummerMode(); const once = snap();
    applySummerMode(); applySummerMode();          const thrice = snap();
    _seasonOverride = 'winter'; applySummerMode(); const back = snap();

    _seasonOverride = keep; applySummerMode();
    out_status_after = status();
    return { before, once, thrice, back,
             statusBefore: out_status_before, statusAfter: out_status_after };
  });

  const T = 'the season switch does not reload the page under you';
  const same = (a, b) => a.made === b.made && a.hid === b.hid && a.grid === b.grid;

  if (!(r.once.made > 0 && r.once.grid > r.before.grid)) fail(T,
    'switching to summer changed nothing, so this is not testing anything');
  else ok();
  if (!same(r.once, r.thrice)) fail(T,
    `three calls left ${r.thrice.made} created and ${r.thrice.grid} cards where ` +
    `one call left ${r.once.made} and ${r.once.grid} - the function is building ` +
    'up again, which is what the page reload used to paper over'); else ok();
  if (!same(r.before, r.back)) fail(T,
    `switching back left ${r.back.made} created and ${r.back.grid} cards, but the ` +
    `page started with ${r.before.made} and ${r.before.grid} - summer is leaking ` +
    'into winter'); else ok();

  if (!r.statusBefore) fail(T,
    'the live bar had no status element to begin with'); else ok();
  if (!r.statusAfter) fail(T,
    'leaving summer did not put the winter bar back, so #zermatt-status is ' +
    'gone and the next live update throws'); else ok();

  // and the reload itself has to stay gone
  const src = fs.readFileSync(PAGE, 'utf8');
  if (/seasonReloaded/.test(src)) fail(T,
    'the sessionStorage reload flag is back, which means the page reloads ' +
    'itself on load again'); else ok();
}

// ── the planner opens on a menu, not on a wall of text ──────────────
// It used to be one column holding three unrelated things: when to come,
// what to bring, and where to book. The middle one runs to tens of thousands
// of words, so opening it buried the other two, and the only way back was to
// scroll up past everything you had just opened. Now it opens on a menu and
// shows one screen at a time, with a bar that stays on screen.
{
  const r = await page.evaluate(async () => {
    const out = {};
    const vis = id => {
      const e = document.getElementById(id);
      return e ? getComputedStyle(e).display !== 'none' : null;
    };
    const panes = ['pane-when', 'pane-prep', 'pane-search'];
    out.strips = document.querySelectorAll('#plan-hub .plan-strip').length;

    openM('hotelModal');
    out.landsOnMenu = vis('plan-hub') === true && panes.every(p => vis(p) === false);
    out.barHiddenOnMenu = vis('plan-bar') === false;

    // a card per screen, and the card says what is behind it
    const hub = document.getElementById('plan-hub');
    out.cards = hub ? hub.querySelectorAll('.plan-card').length : 0;
    // three screens plus one door out, to Shabbat in the kashrut panel
    out.cardsOut = hub ? hub.querySelectorAll('.plan-card-out').length : 0;
    out.cardsDescribe = hub
      ? [...hub.querySelectorAll('.plan-card')].every(c => (c.querySelector('small') || {}).textContent)
      : false;

    // one screen at a time, and never two
    out.oneAtATime = true;
    out.barOnEveryPane = true;
    for (const k of ['when', 'prep', 'search']) {
      planGo(k);
      const shown = panes.filter(p => vis(p));
      if (shown.length !== 1 || shown[0] !== 'pane-' + k) out.oneAtATime = false;
      if (!vis('plan-bar') || vis('plan-hub')) out.barOnEveryPane = false;
    }

    // the way out, and the way sideways, without going back to the menu
    planGo('prep');
    const bar = document.getElementById('plan-bar');
    out.hasBack = !!(bar && bar.querySelector('.plan-back'));
    out.chips = bar ? bar.querySelectorAll('.plan-chip').length : 0;
    out.barNamesPane = /הכנות/.test(
      (document.getElementById('plan-bar-title') || {}).textContent || '');

    // the bar has to stay put while the reader scrolls, or it is just a heading
    out.barSticky = bar ? getComputedStyle(bar).position === 'sticky' : false;

    // going back really does put the menu up again
    planGo('hub');
    out.backToMenu = vis('plan-hub') === true && panes.every(p => vis(p) === false);

    // the doors other panels open: each has to land on the right screen
    openWhenToGo();
    out.whenDeepLink = vis('pane-when') === true;
    openPlanner('prep');
    out.prepDeepLink = vis('pane-prep') === true;

    // and the order of the screens still matches how a trip is planned
    const w = document.getElementById('pane-when'), pr = document.getElementById('pane-prep');
    out.order = !!(w && pr &&
      (w.compareDocumentPosition(pr) & Node.DOCUMENT_POSITION_FOLLOWING));
    return out;
  });

  const T = 'the planner opens on a menu, not on a wall of text';
  if (!r.landsOnMenu) fail(T,
    'opening the planner no longer shows the menu - it is back to dropping the ' +
    'reader into the middle of a section'); else ok();
  if (!r.barHiddenOnMenu) fail(T, 'the back bar shows on the menu itself'); else ok();
  if (r.cards !== 6) fail(T, `the menu offers ${r.cards} cards, not six`); else ok();
  if (r.strips !== 1) fail(T,
    `the menu carries ${r.strips} whole-trip strips, not one - the trip is a ` +
    'different kind of thing from the three searches and has to look like it'); else ok();
  if (r.cardsOut !== 1) fail(T,
    'the menu no longer carries the door to Shabbat, which is the one thing ' +
    'on it that is not a screen of the planner'); else ok();
  if (!r.cardsDescribe) fail(T,
    'a menu card no longer says what is behind it, so the menu is a guess'); else ok();
  if (!r.oneAtATime) fail(T,
    'the screens are no longer exclusive - two can be open at once, which is ' +
    'the pile this replaced'); else ok();
  if (!r.barOnEveryPane) fail(T, 'a screen shows with no bar on it'); else ok();
  if (!r.hasBack) fail(T,
    'there is no way back to the menu, so leaving a long screen means ' +
    'scrolling all of it again'); else ok();
  if (r.chips !== 2) fail(T,
    `the bar offers ${r.chips} ways sideways; it should offer the other two ` +
    'screens'); else ok();
  if (!r.barNamesPane) fail(T, 'the bar does not say which screen you are on'); else ok();
  if (!r.barSticky) fail(T,
    'the bar scrolls away with the content, so on a long screen there is ' +
    'again no way out without scrolling back'); else ok();
  if (!r.backToMenu) fail(T, 'the back button does not restore the menu'); else ok();
  if (!r.whenDeepLink) fail(T,
    '"when to go" from elsewhere no longer lands on that screen'); else ok();
  if (!r.prepDeepLink) fail(T,
    'the preparations link from elsewhere no longer lands on that screen'); else ok();
  if (!r.order) fail(T,
    'the preparations screen now comes before "when to go"'); else ok();
}

// ── a single search is the whole screen ───────────────────────
// The three searches used to be tabs inside one card of the menu, opening on
// "הכל" - so somebody who came for a flight went two levels down and landed
// on a combined search he never asked for. They are screens of the menu now.
// The strip of steps is what makes the three into a trip: without it each is
// alone on the screen, and nothing on it belongs to a plan the reader did not
// ask to make. Same screens, two frames.
{
  const r = await page.evaluate(async () => {
    const out = {};
    const vis = id => {
      const e = document.getElementById(id);
      return e ? getComputedStyle(e).display !== 'none' : null;
    };
    const panel = t => vis('tpanel-' + t);

    openM('hotelModal');
    const hub = document.getElementById('plan-hub');
    const txt = [...hub.querySelectorAll('.plan-card b')].map(b => b.textContent.trim());
    out.namesThree = ['טיסות', 'לינה', 'רכב'].every(n => txt.includes(n));
    out.noOldCard = !txt.some(t => /^חיפוש טיסה/.test(t));

    out.solo = {};
    for (const k of ['flight', 'hotel', 'car']) {
      planGo(k);
      out.solo[k] = {
        onSearch: vis('pane-search') === true,
        panel: panel(k) === true,
        others: ['all', 'flight', 'car', 'hotel'].filter(x => x !== k && panel(x)).length,
        steps: vis('trip-steps'),
        ask: vis('trip-ask'),
        chips: document.querySelectorAll('#plan-bar-chips .plan-chip').length,
        title: (document.getElementById('plan-bar-title') || {}).textContent || ''
      };
    }

    planGo('trip');
    out.trip = {
      onSearch: vis('pane-search') === true,
      all: panel('all') === true,
      steps: vis('trip-steps'),
      ask: vis('trip-ask'),
      chips: document.querySelectorAll('#plan-bar-chips .plan-chip').length
    };

    // the older name still has to reach the combined screen, and must not put
    // the same screen into the bar twice
    planGo('search');
    out.aliasLands = panel('all') === true && vis('trip-steps') === true;
    const chipTxt = [...document.querySelectorAll('#plan-bar-chips .plan-chip')]
      .map(c => c.textContent.trim());
    out.aliasNoDup = new Set(chipTxt).size === chipTxt.length;

    // the door from the parking panel lands on a screen of its own
    planGo('hub');
    openCarSearch();
    await new Promise(res => setTimeout(res, 150));
    out.carDoor = panel('car') === true && vis('trip-steps') === false;
    return out;
  });

  const T = 'one search is the whole screen; the trip is the frame around it';
  if (!r.namesThree) fail(T,
    'the planner menu no longer offers flights, lodging and the car by name - ' +
    'they are back behind one card, which is the two-levels-down this fixed'); else ok();
  if (!r.noOldCard) fail(T,
    'the old combined search card is on the menu again'); else ok();
  for (const k of ['flight', 'hotel', 'car']) {
    const g = r.solo[k];
    if (!g.onSearch || !g.panel) fail(T,
      `the ${k} card does not land on the ${k} search`); else ok();
    if (g.others !== 0) fail(T,
      `${g.others} other search panels are on screen beside ${k}`); else ok();
    if (g.steps !== false) fail(T,
      `the step strip shows on the ${k} search alone - the reader is being ` +
      'shown a trip he never asked to plan'); else ok();
    if (g.ask !== true) fail(T,
      `the ${k} search offers no way up to the whole trip`); else ok();
    if (g.chips !== 0) fail(T,
      `the bar offers ${g.chips} chips on the ${k} search alone, rebuilding ` +
      'the tab strip it was promoted out of'); else ok();
    if (!g.title.trim()) fail(T, `the bar does not name the ${k} search`); else ok();
  }
  if (!r.trip.onSearch || !r.trip.all) fail(T,
    'the whole-trip strip does not land on the combined search'); else ok();
  if (r.trip.steps !== true) fail(T,
    'the whole trip shows without its step strip, so the three searches are ' +
    'no longer stages of one plan'); else ok();
  if (r.trip.ask !== false) fail(T,
    'the trip screen still offers the way up to the trip - there is nowhere ' +
    'to go, it is this screen'); else ok();
  // Decided 10/11: the step strip walks the stages; chips there as well would
  // offer the same choice twice on one screen.
  if (r.trip.chips !== 0) fail(T,
    `the trip screen offers ${r.trip.chips} chips beside its own step strip - ` +
    'the same choice twice on one screen'); else ok();
  if (!r.aliasLands) fail(T,
    "planGo('search') no longer reaches the combined screen, so every older " +
    'door into the planner is broken'); else ok();
  if (!r.aliasNoDup) fail(T,
    'the bar offers the same screen twice - the alias is a second key in ' +
    'PLAN_PANES instead of a lookup'); else ok();
  if (!r.carDoor) fail(T,
    'the car door from the parking panel no longer lands on a screen of its own'); else ok();
}

// ── each screen speaks of its own business ───────────────────────────
// A search on its own is about that search and nothing else: the flight
// screen promises no car and no room, the lodging screen knows of no flight,
// the car screen of neither. Read off what is actually on screen (innerText
// skips hidden blocks), so a word that comes back anywhere visible fails.
{
  const r = await page.evaluate(async () => {
    const out = {};
    const vis = id => {
      const e = document.getElementById(id);
      return e ? getComputedStyle(e).display !== 'none' : null;
    };
    const seen = () => (document.getElementById('pane-search') || {}).innerText || '';
    openM('hotelModal');

    planGo('flight');
    const free = document.getElementById('trip-free');
    out.flightText = seen();
    out.flightHint = free ? free.placeholder : '';
    out.flightEx = [...document.querySelectorAll('#trip-free-ex .ftx')].map(s => s.textContent);

    // the sentence is read for the flight only, and children fly too
    const cc = document.getElementById('all-car-check');
    if (cc && cc.checked) { cc.checked = false; toggleCarDetails('all-car-details', false); }
    if (free) {
      free.value = 'משפחה בפברואר לשבוע עם רכב';
      try { await applyTripText(); } catch (e) {}
      await new Promise(res => setTimeout(res, 300));
    }
    out.flightSaid = (document.getElementById('trip-free-said') || {}).textContent || '';
    out.flightCarTicked = !!(cc && cc.checked);
    out.flightPax = +(document.getElementById('fl-adults') || {}).textContent;
    if (free) free.value = '';
    document.getElementById('trip-free-said').innerHTML = '';

    planGo('hotel');
    out.hotelText = seen();
    out.hotelBanner = vis('hotel-vs-flight');

    planGo('car');
    out.carText = seen();

    // inside the trip the same lodging screen does have a flight to differ from
    planGo('trip');
    switchTripTab('hotel');
    out.tripHotelBanner = vis('hotel-vs-flight');
    switchTripTab('all');
    out.tripEx = [...document.querySelectorAll('#trip-free-ex .ftx')].map(s => s.textContent);
    out.tripHint = free ? free.placeholder : '';
    closeM('hotelModal');
    return out;
  });

  const T = 'each screen speaks of its own business';
  // "כרטיס" (card, ticket) carries the letters of "טיס" and is no flight
  const STAY = /לינה|דירה|מלון|צ'ק-אין/, CAR = /רכב|השכרה/, FLY = /(?<!כר)טיס|תעופה|✈/;
  // the whole line, so a failure says where on the screen the word sits
  const hit = (txt, re) => txt.split('\n').find(l => re.test(l)) || '';
  let w;
  if ((w = hit(r.flightText, CAR) || hit(r.flightText, STAY))) fail(T,
    `the flight screen alone shows "${w}"`); else ok();
  if ((w = hit(r.flightHint, CAR) || hit(r.flightHint, STAY))) fail(T,
    `the flight screen's free-text hint offers "${w}"`); else ok();
  if (r.flightEx.length !== 3) fail(T,
    `the flight screen has ${r.flightEx.length} examples, not 3`); else ok();
  if ((w = r.flightEx.find(s => CAR.test(s) || STAY.test(s)))) fail(T,
    `a flight example promises more than a flight: "${w}"`); else ok();
  if (CAR.test(r.flightSaid) || r.flightCarTicked) fail(T,
    'the flight screen read "עם רכב" and reported or ticked a car it does not search for'); else ok();
  if (!/מילאתי/.test(r.flightSaid)) fail(T,
    'the flight screen understood nothing of a plain family sentence'); else ok();
  if (r.flightPax !== 4) fail(T,
    `a family of 2+2 came out as ${r.flightPax} passengers - children fly too`); else ok();
  if ((w = hit(r.hotelText, FLY) || hit(r.hotelText, CAR))) fail(T,
    `the lodging screen alone shows "${w}"`); else ok();
  if (r.hotelBanner !== false) fail(T,
    '"nights different from the flight" shows on the lodging screen alone'); else ok();
  if ((w = hit(r.carText, FLY) || hit(r.carText, STAY))) fail(T,
    `the car screen alone shows "${w}"`); else ok();
  if (r.tripHotelBanner !== true) fail(T,
    'inside the trip the lodging screen lost its note about differing from the flight'); else ok();
  if (!r.tripEx.some(s => CAR.test(s)) || !CAR.test(r.tripHint)) fail(T,
    'the whole-trip examples did not come back after the flight screen - the ' +
    'trip is the one place a car belongs in the sentence'); else ok();
}

// ── Shabbat is the same two candles everywhere ───────────────────────
// U+1F56F is one dripping wax candle, and every system draws it its own way.
// The kashrut card has always carried a drawing of two Shabbat candles; the
// rest of the site typed the emoji, so the same thing looked different from
// one panel to the next.
{
  const r = await page.evaluate(async () => {
    const out = {};
    const CANDLE = /\u{1F56F}/u;
    const drawn = (el) => !!(el && el.querySelector('use[href="#ico-candle"]'));

    // Shabbat moved out of the packing section into the kashrut panel. The
    // rule did not move with it: every place Shabbat is named wears the same
    // two drawn candles, never the emoji. That is now three places - the
    // heading in the panel, the signpost left behind in the packing section,
    // and the card on the planner's menu.
    openM('kosherModal');
    const apt  = document.getElementById('shabbat-apartment');
    const band = apt ? [...apt.querySelectorAll('.prep-group')]
                         .find(d => /שבת/.test(d.textContent)) : null;
    const fold = apt ? [...apt.querySelectorAll('summary')]
                         .find(d => /מה להביא/.test(d.textContent)) : null;
    out.bandDrawn = drawn(band);
    out.foldDrawn = drawn(fold);
    out.aptEmoji  = apt ? CANDLE.test(apt.textContent) : false;
    closeM('kosherModal');

    openM('hotelModal');
    const prep = document.getElementById('prep-fold');
    const jump = document.querySelector('.prep-jump');
    const card = document.querySelector('.plan-card-out');
    out.jumpDrawn = drawn(jump);
    out.cardDrawn = drawn(card);
    out.prepEmoji = prep ? CANDLE.test(prep.textContent) : false;
    closeM('hotelModal');

    openM('kosherModal');
    const k = document.getElementById('kosherModal');
    const h = k.querySelector('h1, h2, h3');
    const btn = document.getElementById('kosher-btn-shabbat-label');
    out.kosherTitleDrawn = drawn(h);
    out.kosherBtnDrawn   = drawn(btn);
    out.kosherBtnEmoji   = btn ? CANDLE.test(btn.textContent) : false;
    closeM('kosherModal');

    // The zmanim are built in script, so the only honest check is to build
    // them and look. A regex over the source matched one shape of string and
    // let another through - the sabotage passed and the check was worthless.
    openM('kosherModal');
    const kb = document.getElementById('kosher-btn-shabbat-label');
    const clickable = kb && (kb.closest('button') || kb.closest('[onclick]'));
    if (clickable) clickable.click();
    await new Promise(r => setTimeout(r, 1200));
    const kk = document.getElementById('kosherModal');
    out.zmanimEmoji = CANDLE.test(kk.textContent);
    out.zmanimDrawn = kk.querySelectorAll('use[href="#ico-candle"]').length;
    closeM('kosherModal');
    return out;
  });

  const T = 'Shabbat is the same two candles everywhere';
  if (!r.bandDrawn) fail(T,
    'the Shabbat band in the preparations still uses the emoji'); else ok();
  if (!r.foldDrawn) fail(T,
    'the Shabbat fold heading still uses the emoji'); else ok();
  if (r.prepEmoji) fail(T,
    'a candle emoji survives somewhere in the preparations'); else ok();
  if (!r.kosherTitleDrawn) fail(T,
    'the kashrut panel heading lost its drawing'); else ok();
  if (!r.kosherBtnDrawn) fail(T,
    'the Shabbat button in the kashrut panel does not carry the drawing'); else ok();
  if (r.kosherBtnEmoji) fail(T,
    'the Shabbat button shows the emoji as well as the drawing'); else ok();
  if (r.zmanimEmoji) fail(T,
    'the zmanim print the candle emoji instead of the drawing'); else ok();
  if (!r.zmanimDrawn || r.zmanimDrawn < 3) fail(T,
    `the zmanim show ${r.zmanimDrawn} drawn candles`); else ok();
}

// ── nothing offers a coupon that has expired ─────────────────────────
// The Ski 2.0 discount was for the 2025/26 season. Taking out the picture
// and the modal is easy to do and easy to half-do: a badge reading "discount
// coupon" stayed on the shop card, promising something that no longer opens.
{
  const r = await page.evaluate(() => {
    openM('rentalModal');
    const t = document.getElementById('rentalModal').textContent;
    const out = {
      says: /קופון/.test(t),
      wiring: typeof window.openCouponModal === 'function'
           || typeof window._couponImg !== 'undefined'
           || !!document.getElementById('coupon-modal')
           || !!document.getElementById('coupon-thumb')
    };
    closeM('rentalModal');
    return out;
  });
  const T = 'nothing offers a coupon that has expired';
  if (r.says) fail(T,
    'the hire panel still mentions a coupon'); else ok();
  if (r.wiring) fail(T,
    'the coupon modal or its image is still wired into the page'); else ok();
}

// ── what you buy before you go, and what you hire there ──────────────
// This was one panel of its own; its two halves now live where each is
// acted on - the buying, the insurance and the Shabbat list in the trip
// planner, where somebody is still deciding; the heavy gear in the hire
// panel, where the question is what to ask for at the counter. The checks
// follow the content, and two of the things said here are not advice but
// Italian law.
{
  const r = await page.evaluate(async () => {
    const out = {};
    const plan = document.getElementById('hotelModal');
    const hire = document.getElementById('rentalModal');
    if (!plan || !hire) return { missing: true };
    openM('hotelModal');
    const ptext = plan.textContent;
    const htext = hire.textContent;

    // the law, in the box at the top of the preparations
    const law = document.getElementById('gear-law');
    const lawText = law ? law.textContent : '';
    out.hasLawBox     = !!law && plan.contains(law);
    out.helmetAllAges = /קסדה[\s\S]{0,40}לכל הגילים/.test(lawText) && /CE/.test(lawText);
    out.liability     = /צד שלישי/.test(lawText) && /100–150|100-150/.test(lawText);
    out.notMedical    = /אינו ביטוח רפואי/.test(lawText);

    // winter-sports cover: the extension has to be named, and the trap with
    // it - "extreme sports" is a different extension and does not cover skiing
    out.winterNamed   = /ספורט חורף/.test(ptext);
    // Not the heading - the heading says "ספורט אתגרי" too, and an assertion
    // that the heading still exists is an assertion about nothing. What has
    // to survive is the claim: they are two separate extensions.
    // The clause numbers and the quotes came out: they belong in the sources
    // register, not in the middle of advice somebody is reading while they
    // plan. What has to survive is the claim itself.
    out.notExtreme    = /שתי הרחבות\s*\n?\s*נפרדות/.test(ptext) &&
                        /אינו מכסה סקי/.test(ptext);
    out.rescue        = /חיפוש וחילוץ/.test(ptext);
    // Not a general caution - the policy's own wording, which is what makes
    // it worth printing. If it ever softens back into "most insurers do not
    // cover", the clause has been lost.
    out.offPiste      = /מחוץ למסלולים המסומנים/.test(ptext) &&
                        /אינה מכוסה/.test(ptext);
    out.clause58      = /בלי הרחבת ספורט חורף/.test(ptext) &&
                        /אינה מכוסה כלל/.test(ptext);
    out.boardIncluded = /וגם סנובורד/.test(ptext);
    out.price         = /\$31\.9|\$63\.8/.test(ptext);
    // The free days on a credit card are the thing people assume covers them.
    // They cover the basic policy and the baggage, and nothing else.
    out.cardDays      = /הכיסוי הבסיסי בלבד/.test(ptext) &&
                        /תמיד תוספת בתשלום/.test(ptext) &&
                        /היקר מבין השניים/.test(ptext);

    // the buying half
    out.lensCats = ['S0', 'S1', 'S2', 'S3', 'S4'].filter(c => ptext.includes(c)).length;
    out.vlt      = /80–100%|43–80%|8–18%/.test(ptext);
    out.oneSock  = /זוג אחד/.test(ptext) && /לא שניים/.test(ptext);
    out.noCotton = /כותנה אסורה|לא כותנה/.test(ptext);
    out.noWipe   = /לא לנגב את הצד הפנימי/.test(ptext);
    out.threeKw  = /3 קילוואט/.test(ptext);
    out.plugL    = /סוג L/.test(ptext);

    const shopHost = document.getElementById('gear-shops');
    const shopCards = shopHost ? shopHost.children : [];
    out.shopCount  = shopCards.length;
    out.shopHrefs  = shopHost ? [...shopHost.querySelectorAll('a[href^="https"]')]
                                  .map(a => a.getAttribute('href')) : [];
    out.shopsHttps = out.shopHrefs.every(h => /^https:\/\//.test(h));
    // A shop card with no telephone and no map is a name, not a shop
    out.withTel    = shopHost ? shopHost.querySelectorAll('a[href^="tel:"]').length : 0;
    out.withMap    = shopHost ? [...shopHost.querySelectorAll('a[href]')]
                                  .filter(a => /google\.com\/maps/.test(a.href)).length : 0;

    const pl = document.getElementById('gear-packlist');
    out.inPlanner   = !!pl && plan.contains(pl);
    out.packLen     = pl ? pl.textContent.length : 0;
    out.packShabbat = pl ? /שעון שבת/.test(pl.textContent) && /פלטה/.test(pl.textContent) : false;
    out.packLaw     = pl ? /CE/.test(pl.textContent) && /צד שלישי/.test(pl.textContent) : false;
    out.packPlugs   = pl ? /מתאמים/.test(pl.textContent) : false;

    out.copied = null;
    if (typeof copyPackList === 'function') {
      const realNav = navigator.clipboard;
      let got = null;
      try {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: (t) => { got = t; return Promise.resolve(); } }
        });
        copyPackList();
        await new Promise(r2 => setTimeout(r2, 30));
        out.copied = got ? got.length : 0;
        Object.defineProperty(navigator, 'clipboard',
                              { configurable: true, value: realNav });
      } catch (e) { out.copyErr = String(e && e.message); }
    }
    closeM('hotelModal');

    // the hiring half
    out.hireTitle = (document.getElementById('rental-modal-title') || {}).textContent || '';
    out.flex      = /פלקס/.test(htext) && /110–130|110-130/.test(htext);
    out.mondo     = /Mondopoint/i.test(htext);
    out.din       = /DIN/.test(htext) && /לעולם לא לכוון בעצמכם/.test(htext);
    out.ownSocks  = /עם גרבי הסקי שלכם/.test(htext);
    // snowboard
    out.wrist     = /מגני פרקי כף יד/.test(htext);
    out.regular   = /Regular/.test(htext) && /Goofy/.test(htext);
    out.byWeight  = /לפי <b>משקל<\/b>|לפי משקל/.test(htext);
    out.wide      = /wide/.test(htext);
    out.dragLift  = /ט-בר|מושכי חבל/.test(htext);
    out.firstDays = /יגיע רחוק יותר בסקי/.test(htext);

    // reachable
    // It sits at the top of the planner now, beside "when to travel" - not
    // under the search boxes, where somebody picking flights has already
    // scrolled past the moment when any of this can still be acted on.
    const prep = document.getElementById('prep-fold');
    const seasonBox = document.getElementById('season-box');
    out.prepExists = !!prep;
    out.prepHigh = !!(prep && seasonBox &&
      (seasonBox.compareDocumentPosition(prep) & Node.DOCUMENT_POSITION_FOLLOWING));
    out.groups = prep ? prep.querySelectorAll('.prep-group').length : 0;
    out.subHeads = prep ? prep.querySelectorAll('.prep-h').length : 0;
    // the words he did not know, and the ones that were wrong
    // The gloss in brackets after a Hebrew term is the house style now - the
    // English is what is printed on the tag and typed into a search box - so
    // the check has to step over it rather than break on it.
    out.edgeExplained  = /הקנט<\/b>(\s*\([^)]{0,30}\))?\s*הוא[\s\S]{0,60}פס המתכת/.test(plan.innerHTML);
    out.balaclava      = /בָּלָקְלָבָה/.test(ptext) && /פתח לעיניים/.test(ptext);
    out.neckName       = /מגן צוואר/.test(ptext);
    out.warmers        = /חבילות חימום/.test(ptext) && /מתחמם מעצמו/.test(ptext);
    out.noTelemark     = !/טלמרק/.test(ptext);
    out.midLayer       = /לא תמיד/.test(ptext) && /פליז דק/.test(ptext);
    out.fabricWeight   = /משקל הבד למטר מרובע/.test(ptext) && /לא משקל הבגד/.test(ptext);
    out.whereToRead    = /תווית הנייר התלויה/.test(ptext);
    const tag = plan.querySelector('img[src$="jacket-tag.jpg"]');
    out.tagShown = !!tag && !!tag.getAttribute('alt') && tag.getAttribute('loading') === 'lazy';
    out.tagCaption = /15,000 מ"מ/.test(ptext) && /80 g\/m²/.test(ptext);
    out.passPocket     = /כיס אנכי צר בגובה החזה/.test(ptext);
    out.shellWhy       = /מעיל לכל החורף/.test(ptext) && !/למי שחוזר<\/b> —/.test(plan.innerHTML);
    out.italy          = /באיטליה, בדרך ממילאנו/.test(ptext) && /זול שם משמעותית/.test(ptext);
    out.amazonOk       = /יש שם גוגלס טובים/.test(ptext);
    out.aliFast        = /כשבועיים/.test(ptext);
    // The height is the whole test, and "above the knee" was wrong - a ski
    // sock stops just below it, over the bony bump at the top of the shin.
    // That landmark is what makes the instruction checkable in a shop.
    // The height is the whole test, and the checkable form of it is the word
    // in the product description plus a figure in centimetres - not a
    // description of the leg, which the reader cannot measure in a shop.
    // The cuff used to be a written label. It is now the drawn boot itself,
    // which is better - but it means the figure is only readable if the two
    // heights and the knee are all marked on it, and if the sentence that
    // explains them sits with it rather than somewhere else on the page.
    out.sockFig        = (() => {
      const f = plan.querySelector('svg.sock-fig');
      if (!f) return false;
      const t = f.textContent || '';
      const box = f.closest('figure');
      const cap = box?.querySelector('figcaption')?.textContent || '';
      return /הברך/.test(t) && /40–45 ס"מ/.test(t) && /30 ס"מ/.test(t) &&
             /בליטת השוק/.test(t) &&
             /גובה השוק/.test(cap) && /בליטת שריר השוק/.test(cap);
    })();
    out.sockPhoto      = (() => {
      const im = plan.querySelector('img[src*="boot-sock"]');
      if (!im) return false;
      return (im.getAttribute('alt') || '').length > 20 &&
             im.getAttribute('loading') === 'lazy';
    })();
    out.sockTest       = /ואינן כאלה/.test(ptext) &&
                         /Over the Calf/.test(ptext) &&
                         /40–45 ס"מ|40-45 ס"מ/.test(ptext) &&
                         /עד ממש מתחת\s*\n?\s*לברך/.test(ptext) &&
                         !/מעל הברך/.test(ptext);
    // Shabbat lives in the kashrut panel now, not in the packing section, so
    // these two read it where it is. Both still have to exist somewhere a
    // reader will meet them - that is what the signpost assertions below are
    // for - but the words themselves belong to that panel.
    const shabApt = document.getElementById('shabbat-apartment');
    const stext = shabApt ? shabApt.textContent : '';
    out.sensors        = /חיישני תאורה אוטומטיים/.test(stext);
    out.finishEarly    = /14:00 לכל\s*\n?\s*המאוחר/.test(stext) && /שעתיים/.test(stext);
    out.pdf            = !!plan.querySelector('a[href$="packing-list.pdf"][download]');
    // and the duplicated "compare the two ways" line is gone
    out.compareOnce    = (ptext.match(/היקר מבין השניים/g) || []).length === 1;

    out.hash   = PANEL_LINKS.gear === 'hotelModal';
    out.search = SEARCH_INDEX.filter(i => /hotelModal|rentalModal/.test(i.action)).length >= 4;
    out.gone   = !document.getElementById('gearModal') && !document.getElementById('svc-gear');
    return out;
  });

  const T = 'equipment: what to buy before, what to hire there';
  if (r.missing) fail(T, 'the planner or the hire panel is gone');
  else {
    if (!r.gone) fail(T,
      'the old equipment panel or its card is still in the page as well - the ' +
      'same content now lives in two places'); else ok();
    if (!r.hasLawBox) fail(T,
      'the box with the two legal requirements is not in the preparations'); else ok();
    if (!r.helmetAllAges) fail(T,
      'it does not say a CE helmet is required at every age - the rule that ' +
      'changed in 2025/26'); else ok();
    if (!r.liability) fail(T,
      'third-party insurance is not stated with what it costs to skip it'); else ok();
    if (!r.notMedical) fail(T,
      'nothing separates the compulsory liability cover from medical and ' +
      'rescue cover, which it does not include'); else ok();
    if (!r.winterNamed) fail(T,
      'the winter-sports extension is never named, and it is the words on the ' +
      'policy that decide whether a broken leg is covered'); else ok();
    if (!r.notExtreme) fail(T,
      'nothing warns that an "extreme sports" extension does not cover skiing'); else ok();
    if (!r.rescue) fail(T,
      'mountain search and rescue is not named, and it is the reason to buy ' +
      'the extension at all'); else ok();
    if (!r.offPiste) fail(T,
      'the off-piste exclusion is no longer quoted from the policy itself'); else ok();
    if (!r.clause58) fail(T,
      'the clause that excludes winter sports without the extension is not cited'); else ok();
    if (!r.boardIncluded) fail(T,
      'nothing says the winter-sports extension covers snowboarding too'); else ok();
    if (!r.price) fail(T, 'what the extension costs is not stated'); else ok();
    if (!r.cardDays) fail(T,
      'nothing says the free days on a credit card cover only the basic policy ' +
      'and the baggage - which is what makes people think they are insured'); else ok();
    if (r.lensCats < 5) fail(T,
      `only ${r.lensCats} of the five lens categories are listed`); else ok();
    if (!r.vlt) fail(T,
      'the lens categories are listed without the light they pass'); else ok();
    if (!r.oneSock) fail(T, 'the one-pair-of-socks rule is missing'); else ok();
    if (!r.noCotton) fail(T, 'nothing warns against cotton'); else ok();
    if (!r.noWipe) fail(T,
      'nothing says not to wipe the inside of a goggle lens'); else ok();
    if (!r.threeKw) fail(T,
      'the 3 kW limit on an Italian flat is missing'); else ok();
    if (!r.plugL) fail(T, 'the Italian plug type is not named'); else ok();
    if (!r.shopCount || r.shopCount < 5) fail(T,
      `only ${r.shopCount} shops are listed`); else ok();
    if (!r.shopsHttps) fail(T, 'a shop link is not https'); else ok();
    if (!r.withTel || r.withTel < 3) fail(T,
      `only ${r.withTel} shops give a telephone number`); else ok();
    if (!r.withMap || r.withMap < 3) fail(T,
      `only ${r.withMap} shops give a map link`); else ok();
    if (!r.inPlanner) fail(T,
      'the packing list did not travel with the rest into the planner'); else ok();
    if (!r.packLen || r.packLen < 600) fail(T,
      `the packing list reaches the page as ${r.packLen} characters`); else ok();
    if (!r.packShabbat) fail(T,
      'the packing list leaves out the Shabbat half'); else ok();
    if (!r.packLaw) fail(T,
      'the packing list does not carry the two legal requirements'); else ok();
    if (!r.packPlugs) fail(T, 'the packing list forgets the plug adapters'); else ok();
    if (r.copyErr) fail(T, `the copy button threw: ${r.copyErr}`); else ok();
    if (!r.copied || r.copied < 600) fail(T,
      `the copy button put ${r.copied} characters on the clipboard`); else ok();

    if (!/ציוד והשכרה/.test(r.hireTitle)) fail(T,
      `the hire panel is still titled "${r.hireTitle.trim()}"`); else ok();
    if (!r.flex) fail(T, 'the boot flex scale is not in the hire panel'); else ok();
    if (!r.mondo) fail(T, 'boot sizing in Mondopoint is not explained'); else ok();
    if (!r.din) fail(T,
      'the DIN setting is described without saying never to set it yourself'); else ok();
    if (!r.ownSocks) fail(T,
      'nothing says to bring your own ski socks to the fitting'); else ok();
    if (!r.wrist) fail(T,
      'wrist guards are missing - the commonest break in snowboarding'); else ok();
    if (!r.regular) fail(T, 'regular and goofy are not explained'); else ok();
    if (!r.byWeight) fail(T,
      'board length is given without saying it follows weight, not height'); else ok();
    if (!r.wide) fail(T,
      'nothing says a large boot needs a wide board'); else ok();
    if (!r.dragLift) fail(T,
      'the drag lift, which is the thing nobody warns a snowboarder about, is ' +
      'not mentioned'); else ok();
    if (!r.firstDays) fail(T,
      'the first-days difference between ski and board is missing, and it is ' +
      'what decides which to hire for a short trip'); else ok();
    if (!r.prepExists) fail(T, 'the preparations fold is gone'); else ok();
    if (!r.prepHigh) fail(T,
      'the preparations are no longer at the top of the planner, beside "when ' +
      'to travel"'); else ok();
    if (r.groups < 4) fail(T,
      `only ${r.groups} group headings - the fold reads as one long run again`); else ok();
    if (r.subHeads < 10) fail(T,
      `only ${r.subHeads} sub-headings use the visible style`); else ok();
    if (!r.edgeExplained) fail(T,
      'the trousers mention the ski edge without saying what an edge is'); else ok();
    if (!r.balaclava) fail(T,
      'balaclava is named but never explained'); else ok();
    if (!r.neckName) fail(T,
      'the neck gaiter is not given its Hebrew name'); else ok();
    if (!r.warmers) fail(T,
      'hand warmers are listed without saying what they are'); else ok();
    if (!r.noTelemark) fail(T,
      'telemark is still in the text - a word almost no reader here knows, in ' +
      'a box meant to be read fast'); else ok();
    if (!r.midLayer) fail(T,
      'the layers section still implies three layers are always needed'); else ok();
    if (!r.fabricWeight) fail(T,
      'the thermal "weight" is given without saying it is the fabric, not the ' +
      'garment'); else ok();
    if (!r.whereToRead) fail(T,
      'nothing says where on the garment these numbers are found'); else ok();
    if (!r.tagShown) fail(T,
      'the picture of a real hang tag is gone, or it has no alt text, or it ' +
      'loads eagerly inside a closed fold'); else ok();
    if (!r.tagCaption) fail(T,
      'the tag is shown without saying which numbers on it to read'); else ok();
    if (!r.passPocket) fail(T,
      'the ski-pass pocket is still described only as a clear window'); else ok();
    if (!r.shellWhy) fail(T,
      '"the right choice for somebody who comes back" is still there, or the ' +
      'plain explanation that replaced it is not'); else ok();
    if (!r.italy) fail(T,
      'buying on the road from Milan is missing, and it is the cheapest of the ' +
      'three ways'); else ok();
    if (!r.amazonOk) fail(T,
      'the page still tells people not to buy goggles online at all'); else ok();
    if (!r.aliFast) fail(T,
      'the delivery time from Asia is still given as three to six weeks'); else ok();
    if (!r.sockTest) fail(T,
      'nothing says how to tell a real ski sock from one that only says so'); else ok();
    if (!r.sockFig) fail(T,
      'the height diagram is gone, or it no longer carries the knee, both ' +
      'heights and the sentence that explains them'); else ok();
    if (!r.sockPhoto) fail(T,
      'the photograph of a sock in a boot is gone, or it loads eagerly, or it ' +
      'has no description for somebody who cannot see it'); else ok();
    if (!r.sensors) fail(T,
      'the Shabbat list asks about a mechanical key but not about automatic ' +
      'light sensors'); else ok();
    if (!r.finishEarly) fail(T,
      'Friday is not given a finishing time, only a Shabbat time'); else ok();
    if (!r.pdf) fail(T,
      'there is no printable packing list to download'); else ok();
    if (!r.compareOnce) fail(T,
      'the "compare the two ways" advice appears more than once'); else ok();
    if (!r.hash) fail(T,
      'the old #gear link leads nowhere now'); else ok();
    if (!r.search) fail(T, 'the search no longer reaches this content'); else ok();
  }
}

// ── the category chips over the reviews actually filter ───────────────
// They did nothing at all, and the reason was the order of two lines:
// setRevFilter called renderReviews() first, which rebuilt the list and
// threw away the very button that had been clicked, then added the active
// class to an element no longer in the page - and the second render read
// the choice back off the DOM, where nothing carried it. The choice is a
// variable now.
{
  const r = await page.evaluate(async () => {
    if (typeof renderReviews !== 'function' || typeof setRevFilter !== 'function')
      return { missing: true };
    const host = document.getElementById('reviews-list');
    if (!host) return { noHost: true };
    const keep = (typeof _reviews !== 'undefined') ? _reviews : [];
    const now = Date.now();
    const cats = REVIEW_CATS.slice(0, 2);
    (0, eval)('_revCatFilter = "all"');
    (0, eval)('_reviewsOnline = true');
    _reviews = [
      { id: '1', user: 'אבי',  rating: 5, cat: cats[0], text: 'ראשון',
        timestamp: now, authorId: 'a', reacts: { counts: {}, mine: {} } },
      { id: '2', user: 'בני',  rating: 4, cat: cats[1], text: 'שני',
        timestamp: now, authorId: 'b', reacts: { counts: {}, mine: {} } },
      { id: '3', user: 'גדי',  rating: 3, cat: 'קטגוריה שנמחקה', text: 'יתום',
        timestamp: now, authorId: 'c', reacts: { counts: {}, mine: {} } }
    ];
    renderReviews();
    const chips = () => [...host.querySelectorAll('.rev-filter-btn')];
    const text  = () => host.textContent;
    const out = {};
    out.chipCount = chips().length;
    out.allShowsEveryone = /אבי/.test(text()) && /בני/.test(text()) && /גדי/.test(text());

    const first = chips().find(b => b.dataset.cat === cats[0]);
    out.chipFound = !!first;
    if (first) {
      first.click();
      out.afterClick = { a: /אבי/.test(text()), b: /בני/.test(text()) };
      out.activeChip = (host.querySelector('.rev-filter-btn.rev-active') || {}).dataset?.cat;
      out.chipsSurvive = chips().length;
    }
    // a review whose category was removed from the dashboard must still be
    // reachable, not only under "all"
    const other = chips().find(b => b.dataset.cat === REVIEW_CAT_OTHER);
    if (other) { other.click(); out.orphanReachable = /גדי/.test(text()); }
    // back to all
    const all = chips().find(b => b.dataset.cat === 'all');
    if (all) { all.click(); out.backToAll = /בני/.test(text()); }
    // an empty category keeps the chips, or there is no way back. The page
    // may be carrying a short category list, so the empty one is MADE here
    // rather than hunted for among the chips.
    _reviews = _reviews.filter(x => x.cat !== cats[0]);
    renderReviews();
    const nowEmpty = chips().find(b => b.dataset.cat === cats[0]);
    if (nowEmpty) {
      nowEmpty.click();
      out.emptySays  = /אין ביקורות עדיין/.test(text());
      out.emptyChips = chips().length;
    } else { out.noEmptyChip = true; }
    (0, eval)('_revCatFilter = "all"');
    _reviews = keep;
    renderReviews();
    return out;
  });

  const T = 'the category chips over the reviews filter the list';
  if (r.missing) warn(T, 'the reviews are not reachable from the page');
  else if (r.noHost) fail(T, 'there is no #reviews-list');
  else {
    if (!r.chipCount || r.chipCount < 3) fail(T,
      `only ${r.chipCount} chips are drawn`); else ok();
    if (!r.allShowsEveryone) fail(T,
      '"הכל" does not show every review'); else ok();
    if (!r.chipFound) fail(T, 'a chip carries no category'); else ok();
    if (!r.afterClick || !r.afterClick.a) fail(T,
      'clicking a category hides the reviews that belong to it'); else ok();
    if (!r.afterClick || r.afterClick.b) fail(T,
      'clicking a category changes nothing - the other categories are still ' +
      'listed'); else ok();
    if (!r.activeChip) fail(T,
      'after the click no chip is marked as the chosen one'); else ok();
    if (!r.chipsSurvive || r.chipsSurvive < 3) fail(T,
      'the chips disappear once one is clicked'); else ok();
    if (!r.orphanReachable) fail(T,
      'a review whose category was removed from the dashboard can no longer ' +
      'be reached from any chip'); else ok();
    if (!r.backToAll) fail(T,
      '"הכל" does not bring the other reviews back'); else ok();
    if (!r.emptySays) fail(T,
      'an empty category shows a blank panel instead of saying it is empty'); else ok();
    if (r.noEmptyChip) fail(T,
      'the chosen category lost its chip once it had no reviews'); else ok();
    if (!r.emptyChips || r.emptyChips < 3) fail(T,
      'an empty category drops the chips, so there is no way back'); else ok();
  }
}

// ── every link the trip planner builds reaches the page ───────────────
// The three boxes were filled by filtering on the icon STRING: '✈️' went to
// flights, '🏨' and '🏠' to lodging, '🚗' to the car. So the day Kosher Fly's
// candle became an inline SVG, our own engine matched nothing, fell out of
// all three and vanished from the results - and so, unnoticed, did the four
// local agencies, whose icons were never in the list to begin with. A link
// that matches no box is not shown and raises nothing. The planner now
// routes on an explicit kind, and this counts the links in against the
// links out.
{
  const r = await page.evaluate(async () => {
    if (typeof searchAll !== 'function') return { missing: true };
    const out = {};
    const realRange = window.getDateRange;
    window.getDateRange = () => ({ ci: '2027-01-10', co: '2027-01-15' });
    const hotel = document.getElementById('all-hotel-check');
    const car   = document.getElementById('all-car-check');
    if (hotel) hotel.checked = true;
    if (car)   car.checked   = true;
    // A link that matches no box reaches makeResultLinks exactly as often as
    // it reaches the page - never - so counting there compares the survivors
    // with themselves. The planner itself is what knows: it reports a link
    // with no kind, and that report is what we listen for.
    const realErr = console.error;
    const errs = [];
    console.error = function () { errs.push([].slice.call(arguments).join(' ')); };
    try { searchAll(); } catch (e) { out.err = String(e && e.message); }
    console.error = realErr;
    window.getDateRange = realRange;
    out.orphans = errs.filter(m => /link with no kind/.test(m));

    const host = document.getElementById('all-results');
    out.shown  = host ? [...host.querySelectorAll('.rl-title')].map(t => t.textContent.trim()) : [];
    out.hrefs  = host ? [...host.querySelectorAll('a.result-link')].map(a => a.getAttribute('href')) : [];
    out.sections = host ? [...host.querySelectorAll(':scope > div')].length : 0;
    return out;
  });

  const T = 'the trip planner shows every link it builds';
  if (r.missing) warn(T, 'searchAll is not reachable from the page');
  else if (r.err) fail(T, `searchAll threw: ${r.err}`);
  else {
    // our own engine, by the address it points at - a title can be renamed,
    // the destination is the thing that matters
    if (!r.hrefs.some(h => /ykrauss1\.github\.io\/trip-finder/.test(h))) fail(T,
      `Kosher Fly is missing from the results; what is offered is ` +
      `${r.shown.join(', ') || '(nothing)'}`); else ok();
    // and it is offered FIRST, before the three foreign engines
    if (!/trip-finder/.test(r.hrefs[0] || '')) fail(T,
      `the first flight result points at "${(r.hrefs[0] || '').slice(0, 50)}" and ` +
      `not at our own engine`); else ok();
    if (!r.hrefs.some(h => /kayak\.com\/flights/.test(h))) fail(T,
      'the flight box lost Kayak'); else ok();
    // the local agencies travel with the lodging box or they are lost in the
    // same silence
    if (!r.hrefs.some(h => /immobiliaremontecervino|hellochalet/.test(h))) fail(T,
      'the local lodging agencies are built but never shown'); else ok();
    if (!r.hrefs.some(h => /kayak\.com\/cars/.test(h))) fail(T,
      'the car box is empty although a car was asked for'); else ok();
    // nothing may be dropped on the way from the array to the page
    if (r.orphans && r.orphans.length) fail(T,
      `a link reaches no box and is dropped without a word: ${r.orphans[0]}`); else ok();
    // and the three boxes together must hold every flight, stay and car link
    if (r.shown.length < 10) fail(T,
      `only ${r.shown.length} links reached the page: ${r.shown.join(', ')}`); else ok();
    if (r.sections < 3) fail(T,
      `only ${r.sections} of the three boxes were drawn`); else ok();
  }
}

// ── forgetting a password, and coming back from the link ──────────────
// Four separate failures sat on this one road. The name typed into the
// login box was not carried into the reset box. auth-err lives outside the
// three panels, so a failed login left "יש למלא שם משתמש וסיסמה" sitting
// under a form that asks for neither. The server answered every name with
// the same "if this name exists" sentence, which told the person nothing.
// And the link itself landed on a page that signed him in and said nothing
// at all - because createClient reads the recovery hash and wipes it before
// DOMContentLoaded, so the check for it always came up empty.
//
// Then a walk through the whole road on 7.11 found the rest: the name came
// back inside an editable box, which is a question, and he had already
// answered it; the button said "...שולח" with the dots on the Hebrew side;
// the form that asked stayed on screen under the answer; the box at the end
// of the link took the new password once, with no second field to catch a
// typo; its Hebrew sat on the left; and when the link had expired, the
// header still carried his name over a session that no longer existed.
{
  const r = await page.evaluate(async () => {
    const out = {};
    const src = document.documentElement.innerHTML;

    // ── the flag has to be taken BEFORE the client is built, or the hash
    //    it looks for is already gone
    const iFlag   = src.indexOf('_CAME_FROM_RECOVERY =');
    const iClient = src.indexOf('supabase.createClient(');
    out.flagFirst = iFlag > -1 && iClient > -1 && iFlag < iClient;
    // and _recoveryWanted must survive a wiped hash
    try {
      (0, eval)('_CAME_FROM_RECOVERY = true');
      history.replaceState(null, '', location.pathname);
      out.survives = _recoveryWanted() === true;
      (0, eval)('_CAME_FROM_RECOVERY = false');
      out.quietOtherwise = _recoveryWanted() === false;
    } catch (e) { out.recErr = String(e && e.message); }
    out.listens = /PASSWORD_RECOVERY/.test(src);

    // what Supabase actually sends back when the link is spent
    try {
      out.readsExpired = _readRecoveryError(
        '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
      out.readsPlain   = _readRecoveryError('#access_token=abc&type=recovery');
      out.readsNothing = _readRecoveryError('');
      out.readsQuery   = _readRecoveryError('#&?error=server_error&error_code=unexpected_failure');
    } catch (e) { out.readErr = String(e && e.message); }

    // ⏏ has to end the session, not just our copy of it
    try {
      let signedOut = false;
      (0, eval)('getSB = function () { return WIN_LOGOUT_SB; }');
      window.WIN_LOGOUT_SB = { auth: { signOut: async () => { signedOut = true; return {}; } } };
      (0, eval)("user = { name: 'מוישה_זוכמיר' }");
      logout();
      await new Promise((r) => setTimeout(r, 30));
      out.logoutSignsOut = signedOut;
      out.logoutClears   = (typeof user === 'undefined' || user === null);
    } catch (e) { out.logoutErr = String(e && e.message); }

    // the Hebrew placeholders in the registration box, which nothing
    // reorders for them at open time
    try {
      showAuthTab('register');
      for (const id of ['reg-pass', 'reg-pass2']) {
        const el = document.getElementById(id);
        if (!el) { out['dir_' + id] = 'missing'; continue; }
        el.value = '';
        out['dir_' + id] = getComputedStyle(el).direction;
        out['ph_' + id]  = el.placeholder || '';
      }
      const rp = document.getElementById('auth-panel-register');
      out.regRuleShown = rp ? /לועזיות/.test(rp.textContent) : false;
      showAuthTab('login');
    } catch (e) { out.regDirErr = String(e && e.message); }

    // ── the typed name travels to the reset box - as a sentence, not as a
    //    question handed back to the person who just answered it
    const login  = document.getElementById('login-name');
    const forgot = document.getElementById('forgot-email');
    const row    = document.getElementById('forgot-name-row');
    const hello  = document.getElementById('forgot-hello');
    const err    = document.getElementById('auth-err');
    if (!login || !forgot || !row || !hello || !err) { out.noForm = true; return out; }
    forgot.value = '';
    login.value = 'מוישה_זוכמיר';
    err.textContent = 'יש למלא שם משתמש וסיסמה';
    err.style.display = 'block';
    showForgotPassword();
    out.helloText  = hello.textContent || '';
    out.helloHtml  = hello.innerHTML   || '';
    out.rowHidden  = getComputedStyle(row).display === 'none';
    out.staleGone  = getComputedStyle(err).display === 'none' || err.textContent === '';

    // ── and when the page does NOT know the name, the box comes back
    login.value = '';
    const reg = document.getElementById('reg-name');
    const regWas = reg ? reg.value : '';
    if (reg) reg.value = '';
    showForgotPassword();
    out.rowShownWhenUnknown = getComputedStyle(row).display !== 'none';
    out.helloWhenUnknown = hello.textContent || '';
    if (reg) reg.value = regWas;

    // ── the escape hatch: "not מוישה?" reopens the field
    login.value = 'מוישה_זוכמיר';
    showForgotPassword();
    out.escapeOffered = /_forgotAskForName/.test(hello.innerHTML);
    _forgotAskForName();
    out.escapeWorks = getComputedStyle(row).display !== 'none';

    // ── what the box says back, for each of the four answers
    const real = window.supabaseSendPasswordReset;
    const say = async (status) => {
      window.supabaseSendPasswordReset = async () => ({ status });
      login.value = 'מוישה_זוכמיר';
      showForgotPassword();                       // name known, field hidden
      const btn = document.getElementById('forgot-btn');
      if (btn) btn.disabled = false;
      await sendPasswordReset();
      const m = document.getElementById('forgot-msg');
      const ask  = document.getElementById('forgot-ask');
      const sent = document.getElementById('forgot-sent');
      return {
        text: m ? m.textContent : '',
        red:  m ? m.style.color : '',
        askGone:  ask  ? getComputedStyle(ask).display  === 'none'  : null,
        sentShown: sent ? getComputedStyle(sent).display !== 'none' : null,
        sentText: sent ? sent.textContent : ''
      };
    };
    out.sent     = await say('sent');
    out.noUser   = await say('no-user');
    // a wrong name has to bring the field back, or there is no way to fix it
    out.noUserRowBack = getComputedStyle(row).display !== 'none';
    out.noEmail  = await say('no-email');
    out.failed   = await say('send-failed');
    window.supabaseSendPasswordReset = async () => ({ error: 'אין רשת' });
    login.value = 'מוישה_זוכמיר';
    showForgotPassword();
    await sendPasswordReset();
    out.offline = (document.getElementById('forgot-msg') || {}).textContent || '';

    // ── the label while it is in flight. Hebrew reads right to left, so
    //    dots written before the word land on its right.
    let release = null;
    window.supabaseSendPasswordReset = () =>
      new Promise((res) => { release = () => res({ status: 'sent' }); });
    login.value = 'מוישה_זוכמיר';
    showForgotPassword();
    const flight = sendPasswordReset();
    out.sendingLabel = (document.getElementById('forgot-btn') || {}).textContent || '';
    if (release) release();
    await flight;
    window.supabaseSendPasswordReset = real;
    showForgotPassword();

    // ── the box at the end of the link
    try {
      (0, eval)("user = { name: 'מוישה_זוכמיר' }");
      await openPasswordReset();
      const intro = document.getElementById('pw-reset-intro');
      const f1 = document.getElementById('pw-reset-new');
      const f2 = document.getElementById('pw-reset-new2');
      const hid = document.getElementById('pw-reset-user');
      out.intro     = intro ? intro.textContent : '';
      out.introDir  = intro ? getComputedStyle(intro).direction : '';
      out.introAlign= intro ? getComputedStyle(intro).textAlign : '';
      out.hasSecond = !!f2;
      out.emptyDir  = f1 ? getComputedStyle(f1).direction : '';
      if (f1) { f1.value = 'Abc123!'; out.filledDir = getComputedStyle(f1).direction; f1.value = ''; }
      // the rule has to be ON SCREEN, not inside the box: a placeholder is
      // gone the moment typing starts, and in the box it dragged the caret
      // to the Hebrew side
      const mc = document.querySelector('#pwResetModal .modal-content');
      out.ruleShown = mc ? /לועזיות/.test(mc.textContent) : false;
      out.rulePlaceholder = f1 ? /עברית|לועזיות|תווים/.test(f1.placeholder || '') : false;
      out.hiddenUser   = hid ? hid.value : null;
      out.hiddenUnseen = hid ? (hid.offsetHeight === 0 || getComputedStyle(hid).opacity === '0') : null;

      // two different passwords must not be saved
      if (f1 && f2) {
        f1.value = 'Abc123!'; f2.value = 'Abc123?';
        await submitPasswordReset();
        const m = document.getElementById('pw-reset-msg');
        out.mismatch = m ? m.textContent : '';
        f1.value = ''; f2.value = '';
      }
      closeM('pwResetModal');
      (0, eval)('_pwResetOpen = false');
    } catch (e) { out.introErr = String(e && e.message); }

    // ── once a password has been chosen, the box is finished ────────
    //
    // It reopened on 8.11 on somebody who had already reset his password
    // and was reading the forum: the success path released the guard, and
    // Supabase emits PASSWORD_RECOVERY again when it refreshes the token.
    try {
      (0, eval)("sessionStorage.removeItem('cl.pwResetDone')");
      (0, eval)('_pwResetDone = false; _pwResetOpen = false');
      // As it is when the link has just been opened, so that clearing the
      // flag afterwards is something the check can actually see. Left at
      // false - as it is on an ordinary page - the assertion passed whether
      // the line that clears it was there or not.
      (0, eval)('_CAME_FROM_RECOVERY = true');
      (0, eval)("user = { name: 'מוישה_זוכמיר' }");
      let live = true;
      window.WIN_DONE_SB = {
        auth: {
          updateUser: async () => ({ data: {}, error: null }),
          getSession: async () => ({ data: { session: live ? { user: {} } : null } }),
          signOut:    async () => ({})
        }
      };
      (0, eval)('getSB = function () { return WIN_DONE_SB; }');
      await openPasswordReset();
      const f1 = document.getElementById('pw-reset-new');
      const f2 = document.getElementById('pw-reset-new2');
      f1.value = 'Abc123!'; f2.value = 'Abc123!';
      await submitPasswordReset();
      out.savedOk    = /עודכנה/.test((document.getElementById('pw-reset-msg') || {}).textContent || '');
      out.doneFlag   = _pwResetDone === true;
      out.doneSticks = (() => { try { return sessionStorage.getItem('cl.pwResetDone') === '1'; }
                                catch (e) { return false; } })();
      out.recoveryCleared = _CAME_FROM_RECOVERY === false;
      // the modal closes on a timer; pretend that has happened
      closeM('pwResetModal');
      // ...and now the page is reloaded in the same tab, which is the case
      // that _pwResetOpen cannot help with: it starts false again, and only
      // the stored flag stands between the reader and a box asking for a
      // password he set two minutes ago. Dropping _pwResetDone from the
      // guard passed this check until the line below was added.
      (0, eval)('_pwResetOpen = false');
      await openPasswordReset();
      const m = document.getElementById('pwResetModal');
      out.stayedShut = !m || getComputedStyle(m).display === 'none';
      (0, eval)("sessionStorage.removeItem('cl.pwResetDone')");
      (0, eval)('_pwResetDone = false; _pwResetOpen = false; user = null');
      closeM('pwResetModal');
    } catch (e) { out.doneErr = String(e && e.message); }

    // ── a link that was already spent says so on arrival, instead of
    //    taking a password it cannot save
    try {
      (0, eval)('_pwResetOpen = false');
      (0, eval)("_RECOVERY_ERROR = 'expired'");
      out.wantedOnError = _recoveryWanted() === true;
      await openPasswordReset();
      const di = document.getElementById('pw-reset-intro');
      const db = document.getElementById('pw-reset-btn');
      const d1 = document.getElementById('pw-reset-new');
      out.spentText    = di ? di.textContent : '';
      out.spentBtn     = db ? db.textContent : '';
      out.spentLocked  = d1 ? d1.disabled : null;
      closeM('pwResetModal');
      (0, eval)("_RECOVERY_ERROR = ''");
      (0, eval)('_pwResetOpen = false');
    } catch (e) { out.spentErr = String(e && e.message); }

    // ── an expired link must not leave his name in the header
    try {
      (0, eval)("user = { name: 'מוישה_זוכמיר' }");
      renderHeader();
      (0, eval)('_pwResetOpen = false');
      let alive = true;
      const fake = {
        auth: {
          updateUser: async () => ({ error: { message: 'invalid claim: missing sub claim' } }),
          getSession: async () => ({ data: { session: alive ? { user: {} } : null } }),
          signOut:    async () => ({})
        }
      };
      (0, eval)('getSB = function () { return WIN_FAKE_SB; }');
      window.WIN_FAKE_SB = fake;
      await openPasswordReset();
      out.liveBoxOpen = !document.getElementById('pw-reset-new').disabled;
      out.introAfterSpent = (document.getElementById('pw-reset-intro') || {}).textContent || '';
      alive = false;                               // the link dies mid-form
      const f1 = document.getElementById('pw-reset-new');
      const f2 = document.getElementById('pw-reset-new2');
      f1.value = 'Abc123!'; f2.value = 'Abc123!';
      await submitPasswordReset();
      out.deadMsg    = (document.getElementById('pw-reset-msg') || {}).textContent || '';
      out.deadLogged = (typeof user === 'undefined' || user === null);
      out.deadHeader = (document.getElementById('auth-area') || {}).textContent || '';
      // and a password the server merely refuses must NOT sign him out
      (0, eval)("user = { name: 'מוישה_זוכמיר' }");
      alive = true;
      fake.auth.updateUser = async () => ({ error: { message: 'New password should be different from the old password.' } });
      f1.value = 'Abc123!'; f2.value = 'Abc123!';
      await submitPasswordReset();
      out.sameMsg  = (document.getElementById('pw-reset-msg') || {}).textContent || '';
      out.sameKept = !!(typeof user !== 'undefined' && user);
      (0, eval)('user = null');
      closeM('pwResetModal');
    } catch (e) { out.deadErr = String(e && e.message); }
    return out;
  });

  const T = 'forgetting a password, and coming back from the link';
  if (r.noForm) fail(T, 'the login or the reset form is not on the page');
  else {
    if (!r.flagFirst) fail(T,
      'the recovery flag is read after createClient - by then the client has ' +
      'already wiped the hash, so the reset box never opens'); else ok();
    if (r.recErr) fail(T, `_recoveryWanted threw: ${r.recErr}`); else ok();
    if (!r.survives) fail(T,
      'with the hash gone, the page no longer knows the person came from the ' +
      'reset link'); else ok();
    if (!r.quietOtherwise) fail(T,
      'the reset box would open for every ordinary visit'); else ok();
    if (!r.listens) fail(T,
      'nothing listens for PASSWORD_RECOVERY, so a link in another shape is ' +
      'missed'); else ok();
    if (r.readErr) fail(T, `_readRecoveryError threw: ${r.readErr}`); else ok();
    if (r.readsExpired !== 'expired') fail(T,
      `the hash Supabase sends back for a spent link is read as ` +
      `"${r.readsExpired}" - so nothing tells him the link was spent`); else ok();
    if (r.readsPlain !== '') fail(T,
      `a good recovery hash is read as the error "${r.readsPlain}"`); else ok();
    if (r.readsNothing !== '') fail(T,
      `an ordinary visit is read as the error "${r.readsNothing}"`); else ok();
    if (!r.readsQuery) fail(T,
      'an error that is not otp_expired is read as no error at all'); else ok();

    if (r.logoutErr) fail(T, `logout threw: ${r.logoutErr}`); else ok();
    if (!r.logoutSignsOut) fail(T,
      '⏏ clears our copy of the user and leaves the session itself alive, so ' +
      'the name comes back by itself on the next load'); else ok();
    if (!r.logoutClears) fail(T,
      '⏏ leaves the page holding the user'); else ok();

    if (r.regDirErr) fail(T, `the registration box threw: ${r.regDirErr}`); else ok();
    for (const id of ['reg-pass', 'reg-pass2']) {
      if (r['dir_' + id] === 'ltr') ok(); else fail(T,
        `${id} runs ${r['dir_' + id]}, so the caret waits on the Hebrew side ` +
        `of a field that only takes latin letters`);
      if (!/עברית|לועזיות|תווים/.test(r['ph_' + id] || '')) ok(); else fail(T,
        `${id} keeps the rule in its placeholder: "${r['ph_' + id]}"`);
    }
    if (r.regRuleShown) ok(); else fail(T,
      'the registration box no longer says what the password has to look like');

    // the name: carried, said, and not asked again
    if (!/מוישה_זוכמיר/.test(r.helloText)) fail(T,
      `the reset box greets with "${r.helloText.slice(0, 60)}" - the name typed ` +
      `one box ago never arrived`); else ok();
    if (!r.rowHidden) fail(T,
      'the name comes back inside a box that can be typed in, which asks him ' +
      'again for what he just answered'); else ok();
    if (/<script|<img/i.test(r.helloHtml)) fail(T,
      'a username is written into the greeting unescaped'); else ok();
    if (!r.rowShownWhenUnknown) fail(T,
      'with no name to work from, the box to type one never appears'); else ok();
    if (/שלום\s*$/.test(r.helloWhenUnknown.trim()) || /שלום <b><\/b>/.test(r.helloWhenUnknown)) fail(T,
      `with no name it still greets: "${r.helloWhenUnknown.slice(0, 50)}"`); else ok();
    if (!r.escapeOffered) fail(T,
      'the greeting offers no way to correct a wrong name'); else ok();
    if (!r.escapeWorks) fail(T,
      'the way back to the name field does not open it'); else ok();
    if (!r.staleGone) fail(T,
      'a failed login leaves its red line under the reset form, where it reads ' +
      'as though the reset failed'); else ok();

    // a sent link closes the question instead of sitting under the answer
    if (!r.sent.sentShown) fail(T,
      'after the link is sent nothing confirms it'); else ok();
    if (!r.sent.askGone) fail(T,
      'the form that asked stays on screen under the answer to it'); else ok();
    if (!/שלחנו קישור/.test(r.sent.sentText)) fail(T,
      `the confirmation reads "${r.sent.sentText.trim().slice(0, 60)}"`); else ok();
    if (/מוישה_זוכמיר/.test(r.sent.sentText)) fail(T,
      'the confirmation names him back at himself - he is the only person it ' +
      'has been talking to'); else ok();
    if (!/אישור/.test(r.sent.sentText)) fail(T,
      'the confirmation has no way out of it'); else ok();

    // the three failures keep the form, and say what went wrong
    if (!/לא נמצא משתמש/.test(r.noUser.text)) fail(T,
      `an unknown name reports "${r.noUser.text.slice(0, 60)}"`); else ok();
    if (/שלחנו/.test(r.noUser.text)) fail(T,
      'an unknown name is told a link was sent, and will wait for mail that ' +
      'is not coming'); else ok();
    if (r.noUser.sentShown) fail(T,
      'an unknown name is shown the confirmation of a link that was never ' +
      'sent'); else ok();
    if (!r.noUserRowBack) fail(T,
      'the name was wrong and the field to fix it stays shut'); else ok();
    if (!/אין בחשבון כתובת מייל/.test(r.noEmail.text)) fail(T,
      `a user with no address reports "${r.noEmail.text.slice(0, 60)}"`); else ok();
    if (!/נכשלה/.test(r.failed.text)) fail(T,
      `a failed send reports "${r.failed.text.slice(0, 60)}"`); else ok();
    if (/שלחנו/.test(r.failed.text) || r.failed.sentShown) fail(T,
      'a failed send is reported as a successful one'); else ok();
    if (!/שגיאה/.test(r.offline) || /שלחנו/.test(r.offline)) fail(T,
      `with no network the box says "${r.offline.slice(0, 60)}"`); else ok();
    for (const [k, v] of [['no-user', r.noUser], ['no-email', r.noEmail],
                          ['send-failed', r.failed]]) {
      if (!/c62828|rgb\(198, 40, 40\)/.test(v.red)) fail(T,
        `"${k}" is shown in the colour of a success`); else ok();
    }

    // the in-flight label
    if (!/שולח/.test(r.sendingLabel)) fail(T,
      `while it sends the button reads "${r.sendingLabel}"`); else ok();
    if (/^\s*[.…]/.test(r.sendingLabel)) fail(T,
      `the button reads "${r.sendingLabel}" - dots written before a Hebrew ` +
      `word land on its right, which is where English puts them`); else ok();

    // the box at the end of the link
    if (r.introErr) fail(T, `openPasswordReset threw: ${r.introErr}`); else ok();
    if (!/בחר סיסמה חדשה/.test(r.intro)) fail(T,
      `the box says "${r.intro.trim().slice(0, 70)}" instead of asking for the ` +
      `password`); else ok();
    if (/הגעת לכאן/.test(r.intro)) fail(T,
      'the box explains where he came from, which he knows - he clicked the ' +
      'link a second ago'); else ok();
    if (r.intro.trim().length > 70) fail(T,
      `the box opens with ${r.intro.trim().length} characters of explanation ` +
      `over a field with one thing to do`); else ok();
    if (r.introDir !== 'rtl') fail(T,
      `the Hebrew in the box runs ${r.introDir}`); else ok();
    if (r.introAlign !== 'right' && r.introAlign !== 'start') fail(T,
      `the Hebrew in the box is aligned ${r.introAlign}, so it sits away from ` +
      `the edge it is read from`); else ok();
    if (!r.hasSecond) fail(T,
      'the new password is typed once and never shown back - a typo becomes a ' +
      'password he does not know'); else ok();
    if (!/אינן תואמות/.test(r.mismatch || '')) fail(T,
      `two different passwords were answered with "${(r.mismatch || '').slice(0, 50)}"`); else ok();
    // Two goes at this. The field began left-to-right with a Hebrew
    // placeholder stranded on the wrong side; flipping it while empty put
    // the placeholder right and the caret with it - blinking on the Hebrew
    // side of a box whose own text said "not in Hebrew". The rule moved out
    // of the box instead, and the box is plainly latin from the start.
    if (r.filledDir !== 'ltr') fail(T,
      'a latin password is typed right to left'); else ok();
    if (r.emptyDir === 'ltr') ok(); else fail(T,
      `the empty password field runs ${r.emptyDir}, so the caret sits on the ` +
      `Hebrew side of a box that only takes latin letters`);
    if (r.ruleShown) ok(); else fail(T,
      'nothing on screen says what the password has to look like'); 
    if (!r.rulePlaceholder) ok(); else fail(T,
      'the rule is back inside the placeholder, where it disappears at the ' +
      'first keystroke and pulls the caret to the wrong side');
    if (r.hiddenUser !== 'מוישה_זוכמיר') fail(T,
      `the browser is told the password belongs to "${r.hiddenUser}" - with no ` +
      `name beside the field it offers whichever account it has`); else ok();
    if (!r.hiddenUnseen) fail(T,
      'the field that tells the browser whose password this is shows on the ' +
      'screen'); else ok();

    // once a password has been chosen
    if (r.doneErr) fail(T, `the finished-reset path threw: ${r.doneErr}`); else ok();
    if (r.savedOk) ok(); else fail(T,
      'a password that saved cleanly is not reported as saved');
    if (r.doneFlag) ok(); else fail(T,
      'nothing records that the reset is over, so the guard is whatever the ' +
      'last caller left it at');
    if (r.doneSticks) ok(); else fail(T,
      'the record does not survive a reload, and the recovery session does');
    if (r.recoveryCleared) ok(); else fail(T,
      'the page still believes it arrived from a reset link');
    if (r.stayedShut) ok(); else fail(T,
      'the box reopens after the password was already changed - on a reader ' +
      'who is signed in, with nothing to do in it and no way to tell why');

    // a link that was already spent
    if (r.spentErr) fail(T, `the spent-link path threw: ${r.spentErr}`); else ok();
    if (!r.wantedOnError) fail(T,
      'a link that came back with an error opens nothing, so he lands on the ' +
      'ordinary site with no word about the link he just clicked'); else ok();
    if (!/פג|נוצל/.test(r.spentText || '')) fail(T,
      `a spent link opens a box that says "${(r.spentText || '').slice(0, 60)}"`); else ok();
    if (/בחר סיסמה חדשה/.test(r.spentText || '')) fail(T,
      'a spent link still invites him to choose a password it cannot save'); else ok();
    if (!r.spentLocked) fail(T,
      'the field is open on a link that cannot save what is typed into it'); else ok();
    if (!/קישור חדש/.test(r.spentBtn || '')) fail(T,
      `the only button on a dead box reads "${r.spentBtn}" - it leads nowhere`); else ok();

    // the expired link
    if (r.deadErr) fail(T, `the expired-link path threw: ${r.deadErr}`); else ok();
    if (!r.liveBoxOpen) fail(T,
      'a live link opens a box with its fields locked'); else ok();
    if (!/בחר סיסמה חדשה/.test(r.introAfterSpent || '')) fail(T,
      `after a dead link the box keeps saying "${(r.introAfterSpent || '').slice(0, 50)}" ` +
      `over a link that is perfectly good`); else ok();
    if (!/פג/.test(r.deadMsg || '')) fail(T,
      `an expired link reports "${(r.deadMsg || '').slice(0, 60)}"`); else ok();
    if (!r.deadLogged) fail(T,
      'the update failed and the page still holds him as signed in'); else ok();
    if (/מוישה_זוכמיר/.test(r.deadHeader || '')) fail(T,
      'the header keeps his name over a session that no longer exists, so the ' +
      'screen says he is in and nothing he presses will agree'); else ok();
    if (!/זהה לקודמת/.test(r.sameMsg || '')) fail(T,
      `reusing the old password reports "${(r.sameMsg || '').slice(0, 60)}"`); else ok();
    if (!r.sameKept) fail(T,
      'a password the server merely refused signs him out of a session that is ' +
      'still alive'); else ok();
  }
}

// ── the price box can be acted on, and says what it is ───────────────
//
// A big number on a dark card, with no airline, no link and nothing to
// press. Yossi asked what it was for, which is the right question: it is a
// daily scan, and the one thing in it anybody can use - a nearby date that
// costs a third as much - was written as a sentence to be remembered and
// typed back into the picker by hand.
{
  const T = 'the price box can be acted on, and says what it is';
  const r = await page.evaluate(() => {
    if (typeof flightForDatesHtml !== 'function') return { missing: true };
    const real = _FLIGHTS;
    window.WIN_FIX = {
      generated: new Date().toISOString(),
      nights: [3, 4, 7],
      dests: { MXP: { he: 'מילאנו מלפנסה' } },
      // within six days of the chosen date, which is as far as
      // _flCheaperNearby looks
      cal: { MXP: { '7': { '2026-12-08': 444, '2026-12-03': 145 } } }
    };
    (0, eval)('_FLIGHTS = WIN_FIX');
    // The fixture is in the shape the real _flLookup reads, so nothing here
    // is stubbed: the box is built by the page's own code.
    const html = flightForDatesHtml('MXP', '2026-12-08', '2026-12-15', 2);
    const box = document.createElement('div');
    box.innerHTML = html;
    const btn = box.querySelector('button[onclick*="setTripDates"]');
    const out = {
      says: box.textContent || '',
      hasButton: !!btn,
      onclick: btn ? btn.getAttribute('onclick') : '',
      // the trip is seven nights, so the alternative must be seven too
      nights: 7
    };
    window.WIN_REAL = real;
    (0, eval)('_FLIGHTS = WIN_REAL');
    return out;
  });

  if (r.missing) warn(T, 'the flight price box is not on this page');
  else {
    if (/הזול שנמצא/.test(r.says)) ok(); else fail(T,
      `the box opens with "${r.says.trim().slice(0, 50)}" - a number this big ` +
      `has to say what kind of number it is`);
    if (/לא הזמנה/.test(r.says)) ok(); else fail(T,
      'nothing says this is a scan rather than a seat - a price in a dark ' +
      'card with no airline reads as an offer');
    if (r.hasButton) ok(); else fail(T,
      'the cheaper date is a sentence, not something to press: the reader has ' +
      'to carry the date back to the picker themselves');
    if (/2026-12-03/.test(r.onclick)) ok(); else fail(T,
      `pressing it sets "${r.onclick}" - not the date it just named`);
    // 3.12 + 7 nights = 10.12
    if (/2026-12-10/.test(r.onclick)) ok(); else fail(T,
      `the return date does not keep the trip at ${r.nights} nights: "${r.onclick}"`);
    if (/145/.test(r.says) && /444/.test(r.says)) ok(); else fail(T,
      'the box lost one of the two prices it is comparing');
    // A button that reads only "on the 3rd it is $145" is still a sentence,
    // whatever element it is made of - nothing on it says it can be pressed.
    if (/עדכן לתאריכים/.test(r.says)) ok(); else fail(T,
      'the cheaper date can be pressed but does not say so');
  }
}

// ── somebody has to be told the notifications exist ───────────────────
//
// The offer to switch them on was written months ago, with good wording and
// a working button, and put inside the alerts panel behind the bell at the
// foot of the screen. On 8.11 the person who built the site discovered he
// had never subscribed his own phone, because he did not know he had to go
// there. Nobody else was going to find it either.
{
  const T2 = 'the notifications have a door that is always open';
  const menu = await page.evaluate(() => {
    const btn = document.querySelector('#side-menu-links #sm-push');
    return {
      there: !!btn,
      label: btn ? btn.textContent.trim() : '',
      action: typeof SIDE_MENU_ACTIONS.push === 'function',
      // and nowhere on the page may either earlier phrasing survive
      stale: (document.documentElement.innerHTML
                .match(/כשהאתר סגור|כשאינך באתר/g) || []).length,
      // All three places say it the same way. Counted by their own wording,
      // not by how many times the phrase occurs: the rendered card puts a
      // fourth copy in the DOM, and a count cannot tell a source string
      // from its own output.
      said: [
        /נודיע לך בטלפון, גם כשהאפליקציה סגורה/,
        /תקבל הודעה על התראות דחופות, גם כשהאפליקציה סגורה/,
        /רכבל שנעצר - גם כשהאפליקציה סגורה/
      ].filter((re) => re.test(document.documentElement.innerHTML)).length
    };
  });
  // The card at the top shows once and never returns once it is dismissed.
  // Somebody who says "not now" in October and wants them in January has to
  // have somewhere to go.
  if (menu.there) ok(); else fail(T2,
    'the side menu has no way to reach the notifications, so a reader who ' +
    'turned the invitation down once can never turn them on again');
  if (/התראות/.test(menu.label)) ok(); else fail(T2,
    `the menu entry reads "${menu.label}"`);
  if (menu.action) ok(); else fail(T2,
    'the menu entry is wired to nothing');
  if (menu.stale === 0) ok(); else fail(T2,
    `an earlier, vaguer wording for "with the app shut" still appears ` +
    `${menu.stale} time(s)`);
  if (menu.said === 3) ok(); else fail(T2,
    `only ${menu.said} of the three places say "כשהאפליקציה סגורה" - the ` +
    `invitation, and the panel card both when notifications are on and off`);
}

{
  const T = 'somebody has to be told the notifications exist';
  const r = await page.evaluate(async () => {
    const out = {};
    const el = document.getElementById('push-invite');
    if (!el) { out.noSlot = true; return out; }

    // The browser's own permission prompt must never be raised by the page
    // on its own: fired without a press it is denied, and denied is forever.
    let asked = 0;
    const realAsk = window.Notification && Notification.requestPermission;
    try { Notification.requestPermission = () => { asked++; return Promise.resolve('default'); }; } catch (e) {}

    const show = async (state) => {
      (0, eval)('pushState = async function () { return WIN_PUSH_STATE; }');
      window.WIN_PUSH_STATE = state;
      el.innerHTML = '';
      try { localStorage.removeItem(PUSH_INVITE_KEY); } catch (e) {}
      await maybeOfferPush();
      return el.innerHTML;
    };

    out.offShown     = (await show('off')).length > 0;
    out.offText      = el.textContent || '';
    out.hasButton    = !!el.querySelector('button[onclick*="acceptPushInvite"]');
    out.hasDismiss   = !!el.querySelector('button[onclick*="dismissPushInvite"]');

    // iOS before the site is on the home screen: there is nothing to press,
    // so it explains instead of offering a button that cannot work.
    const iosHtml    = await show('ios-install');
    out.iosShown     = iosHtml.length > 0;
    out.iosText      = el.textContent || '';
    out.iosNoButton  = !el.querySelector('button[onclick*="acceptPushInvite"]');

    out.onHidden      = (await show('on')).length === 0;
    out.blockedHidden = (await show('blocked')).length === 0;
    out.unsupHidden   = (await show('unsupported')).length === 0;

    // asked once and turned down: never again
    await show('off');
    dismissPushInvite();
    await new Promise((res) => setTimeout(res, 320));
    out.goneAfterDismiss = (el.innerHTML || '') === '';
    out.remembered = !!localStorage.getItem(PUSH_INVITE_KEY);
    el.innerHTML = '';
    await maybeOfferPush();
    out.staysGone = (el.innerHTML || '') === '';

    out.askedOnItsOwn = asked;
    try { localStorage.removeItem(PUSH_INVITE_KEY); } catch (e) {}
    try { if (realAsk) Notification.requestPermission = realAsk; } catch (e) {}
    return out;
  });

  if (r.noSlot) fail(T, 'there is nowhere on the page for the invitation to appear');
  else {
    if (r.offShown) ok(); else fail(T,
      'a reader who could turn notifications on is never asked - the offer ' +
      'stays behind the bell, where the site\'s own author did not find it');
    if (/המעבר|שלג|רכבל/.test(r.offText)) ok(); else fail(T,
      `the invitation says "${r.offText.trim().slice(0, 60)}" - it has to say ` +
      `what they would actually be told about`);
    if (r.hasButton) ok(); else fail(T, 'the invitation has nothing to press');
    if (r.hasDismiss) ok(); else fail(T,
      'the invitation cannot be turned down, so it is not an invitation');
    if (r.iosShown) ok(); else fail(T,
      'on an iPhone before the site is installed, nothing explains why there ' +
      'are no notifications');
    if (/מסך הבית/.test(r.iosText)) ok(); else fail(T,
      `the iPhone wording does not say what to do: "${r.iosText.trim().slice(0, 60)}"`);
    if (r.iosNoButton) ok(); else fail(T,
      'the iPhone version offers a button that cannot work until the site is ' +
      'on the home screen');
    if (r.onHidden) ok(); else fail(T,
      'somebody who already has notifications is asked to turn them on');
    if (r.blockedHidden) ok(); else fail(T,
      'a reader who blocked notifications in the browser is asked again, ' +
      'which the page cannot do anything about');
    if (r.unsupHidden) ok(); else fail(T,
      'a browser that cannot do push at all is offered push');
    if (r.goneAfterDismiss) ok(); else fail(T,
      'pressing ✕ leaves the invitation on screen');
    if (r.remembered) ok(); else fail(T,
      'the refusal is not remembered, so it asks again on the next visit');
    if (r.staysGone) ok(); else fail(T,
      'it comes back after being turned down - the one behaviour that makes ' +
      'people block notifications outright');
    // Two attempts at this line. "גם כשהאתר סגור" reads, in a ski app, as
    // the resort being shut - the opposite of what it means. "גם כשאינך
    // באתר" fixed the ambiguity and said nothing concrete in its place.
    // The longer "גם כשהאפליקציה סגורה" is the one a reader does not have
    // to work out, and it is the word the menu already uses.
    if (/כשהאפליקציה סגורה/.test(r.offText)) ok(); else fail(T,
      `the invitation says "${r.offText.trim().slice(0, 70)}" - it has to say ` +
      `plainly that the notification arrives with the app shut`);

    if (r.askedOnItsOwn === 0) ok(); else fail(T,
      `the page raised the browser's permission prompt ${r.askedOnItsOwn} time(s) ` +
      `by itself; unasked it is denied, and denied cannot be undone from here`);
  }
}

// ── the page asks the public view only for what it carries ───────────
//
// profiles_public was rebuilt without `id` and without `is_admin`, because a
// stranger holding the public key has no business learning either. The page
// had one call asking it for `id` - the user count on the admin panel - and
// it broke silently, inside a try/catch, showing a dash. The view's shape
// lives in a database this gate cannot reach, so it is written down here
// instead: a column asked for and not listed is a 400 that nobody sees.
{
  const T = 'the page asks the public view only for what it carries';
  const VIEW = ['username', 'level', 'discipline', 'visits', 'bio',
                'avatar_url', 'created_at'];
  const src = await page.content();
  const asks = [...src.matchAll(/profiles_public\?select=([a-z_,]+)/g)].map(m => m[1])
    .concat([...src.matchAll(/profiles_public'\)[\s\S]{0,60}?\.select\('([^']+)'/g)].map(m => m[1]));
  if (asks.length >= 2) ok(); else fail(T,
    `only ${asks.length} call(s) to the public view were found - either the ` +
    `forum stopped showing faces, or this check looks in the wrong place`);
  for (const a of asks) {
    for (const col of a.split(',').map(c => c.trim()).filter(Boolean)) {
      if (VIEW.includes(col)) ok();
      else fail(T,
        `the page asks profiles_public for "${col}", which the view does not ` +
        `carry - the request comes back 400 and the caller shows a dash`);
    }
  }
  if (!/profiles_public[^;]{0,120}is_admin/.test(src)) ok();
  else fail(T,
    'the page reads is_admin from the public view - admin status is read ' +
    'from the table, for the reader own row, and nowhere else'); 
}

// ── the server says which of the four things happened ─────────────────
{
  const T = 'the reset function answers with what actually happened';
  const f = near('supabase/functions/reset-password/index.ts');
  if (!fs.existsSync(f)) warn(T, 'the edge function is not beside the page');
  else {
    const fn = fs.readFileSync(f, 'utf8');
    for (const st of ['no-user', 'no-email', 'send-failed', 'sent']) {
      if (!new RegExp(`ok\\('${st}'\\)`).test(fn)) fail(T,
        `the function never answers "${st}"`); else ok();
    }
    // a bare ok() would fall back to 'sent' and report a failure as a success
    if (/return ok\(\)/.test(fn)) fail(T,
      'somewhere the function still answers with no status at all, which the ' +
      'page reads as "sent"'); else ok();
    if (!/ok: true, status/.test(fn)) fail(T,
      'the status is not in the body the page reads'); else ok();

    // The letter. It explained that pressing the button would return him to
    // the site and that he would choose a password there - which is what a
    // button called "בחירת סיסמה חדשה" already says, twice.
    if (!/שלום \$\{name\},/.test(fn)) fail(T,
      'the letter no longer greets him by name'); else ok();
    if (!/לבחירת סיסמה חדשה לחץ על הכפתור/.test(fn)) fail(T,
      'the letter does not say, in one line, what the button is for'); else ok();
    if (/תחזיר אותך לאתר|ושם תבחר/.test(fn)) fail(T,
      'the letter still narrates what will happen after the click'); else ok();
    if (/סיסמא(?!ות)/.test(fn)) fail(T,
      'the letter spells it "סיסמא" where the site settled on the standard ' +
      '"סיסמה" - the plural "סיסמאות" is the one form that keeps the alef'); else ok();
    if (!/action_link/.test(fn)) fail(T,
      'the letter carries no link'); else ok();
  }
}

// ── the tab title ─────────────────────────────────────────────────────
// It read "צ׳רוויניה לייב · CerviniaLive — מדריך הסקי לצ׳רוויניה בעברית":
// the name twice, the place twice, and in a right-to-left tab the pieces
// reorder into something that looks like a string of unrelated words.
{
  const T = 'the tab title is a name, not a pile of words';
  const title = await page.title();
  if (title.length > 42) fail(T,
    `the title is ${title.length} characters: "${title}"`); else ok();
  if ((title.match(/צ׳רוויניה|צ'רוויניה/g) || []).length > 1) fail(T,
    `"צ׳רוויניה" appears twice in the title: "${title}"`); else ok();
  if (/CerviniaLive/.test(title) && /צ׳רוויניה לייב/.test(title)) fail(T,
    `the title carries the name in both languages: "${title}"`); else ok();
  if (!/צ׳רוויניה לייב/.test(title)) fail(T,
    `the title does not carry the site's name: "${title}"`); else ok();

  // Installed as an app, the window already carries the name from the
  // manifest, and the page title said it again beside it. On the open web
  // the title stays whole - that is the line Google shows - so the short
  // one is set only when the page is actually running as an app.
  const src2 = await page.content();
  const sm = src2.match(/\(display-mode: standalone\)[\s\S]{0,300}?document\.title\s*=\s*'([^']+)'/);
  if (!sm) fail(T,
    'nothing shortens the title when the page runs as an installed app, so ' +
    'the window bar carries the name twice'); else ok();
  if (sm && /צ׳רוויניה|צ'רוויניה|CerviniaLive/.test(sm[1])) fail(T,
    `as an app the page titles itself "${sm[1]}" - beside the app's own name ` +
    `that is the brand twice`); else ok();

  const mf = near('manifest.json');
  if (!fs.existsSync(mf)) warn(T, 'manifest.json is not beside the page');
  else {
    const man = JSON.parse(fs.readFileSync(mf, 'utf8'));
    if (/CerviniaLive/.test(man.name) && /צ׳רוויניה|צ'רוויניה/.test(man.name)) fail(T,
      `the app installs itself as "${man.name}" - the name in both languages, ` +
      `on a home screen with room for neither`); else ok();
    if (!man.name) fail(T, 'the app has no name to install under'); else ok();
  }
}

// ── the icons say the right thing ─────────────────────────────────────
// The Kosher Fly row wore 🕯️, a single dripping wax candle, while the
// kashrut card it belongs with wears two Shabbat candles. And the passenger
// counter was headed by an aeroplane, which is the journey, not the people.
{
  const r = await page.evaluate(() => {
    const row = _svcIcon('ico-candle');
    const lab = [...document.querySelectorAll('label')]
      .filter(l => /נוסעים/.test(l.textContent))[0];
    const sprite = !!document.getElementById('ico-candle');
    // the drawing must actually resolve against the sprite on the page
    const probe = document.createElement('div');
    probe.innerHTML = row;
    document.body.appendChild(probe);
    const used = probe.querySelector('use');
    const href = used ? used.getAttribute('href') : '';
    probe.remove();
    return { row, href, sprite, label: lab ? lab.textContent.trim() : '' };
  });

  const T = 'the icons say the right thing';
  if (!r.sprite) fail(T, 'there is no candle drawing in the sprite'); else ok();
  if (r.href !== '#ico-candle') fail(T,
    `the Kosher Fly row points at "${r.href}"`); else ok();
  if (/ὖF|🕯/.test(r.row)) fail(T,
    'the single wax candle is back on the Kosher Fly row'); else ok();
  if (!/👥/.test(r.label)) fail(T,
    `the passenger counter is headed "${r.label}" - it counts people`); else ok();
  if (/✈/.test(r.label)) fail(T,
    'the passenger counter still shows an aeroplane'); else ok();
}

// ── a crowded week is offered a way out in both directions ────────────
// The old suggester returned whichever shift it happened to find first, so
// a reader was steered by the search order rather than by anything about
// skiing. Later in the winter usually means better snow, so both the later
// and the earlier option are offered - later first - and each carries the
// button that moves the dates rather than leaving them to retype them.
{
  const r = await page.evaluate((t) => {
    window._texts = t;
    const out = {};
    // Christmas week: the busiest stretch of the season
    const both = _seasonBetterShifts('2026-12-26', '2027-01-02');
    out.dirs  = both.map(x => x.dir);
    out.days  = both.map(x => x.days);
    out.clean = both.map(x => !!x.clean);

    seasonHint('2026-12-26', '2027-01-02');
    const el = document.getElementById('season-hint');
    out.html = el ? el.innerHTML : '';
    out.buttons = el ? el.querySelectorAll('button[onclick^="applySeasonShift"]').length : 0;

    // pressing one must actually move the dates
    const b = el && el.querySelector('button[onclick^="applySeasonShift"]');
    if (b) b.click();
    const dt = document.getElementById('trip-dates');
    out.ci = dt ? dt.getAttribute('data-ci') : '';
    out.co = dt ? dt.getAttribute('data-co') : '';

    // a quiet week needs no way out
    seasonHint('2027-01-10', '2027-01-17');
    out.quiet = document.getElementById('season-hint').innerHTML;
    return out;
  }, JSON.parse(fs.readFileSync(TEXTS, 'utf8')));

  const T = 'a crowded week is offered a way out in both directions';

  if (r.dirs.length < 2) fail(T,
    `only ${r.dirs.length} way(s) out offered for Christmas week`); else ok();
  if (r.dirs[0] !== 'fwd') fail(T,
    'the later option is not offered first, though deeper into winter is the better snow'); else ok();
  if (new Set(r.dirs).size !== r.dirs.length) fail(T,
    'the same direction was offered twice'); else ok();
  if (r.days.some(d => d < 1 || d > 14)) fail(T,
    `a shift of ${r.days.join(', ')} days is outside the fortnight searched`); else ok();

  if (r.buttons !== r.dirs.length) fail(T,
    `${r.dirs.length} suggestions but ${r.buttons} buttons - one of them has to be retyped`); else ok();
  if (!/חפש/.test(r.html)) fail(T, 'the button does not say what it does'); else ok();
  if (!r.ci || !r.co) fail(T,
    'pressing the button did not move the dates'); else ok();
  if (!/^2026-|^2027-/.test(r.ci) || r.ci >= r.co) fail(T,
    `the dates came out as ${r.ci}–${r.co}`); else ok();
  if (r.ci === '2026-12-26') fail(T,
    'the button put back the very dates it was offering to change'); else ok();

  if (/applySeasonShift/.test(r.quiet)) fail(T,
    'a quiet week is told to move anyway'); else ok();
}

// ── "when to travel" says when ────────────────────────────────────────
// Every row carried from/to in the content file and not one of them reached
// the screen: "the Snowboard Cross World Cup is on" with no date beside it
// is the one thing a person planning a trip cannot use. And a date is only
// true for the season it was checked in, so when the file's season has
// passed an "annual" row must lose its dates rather than print last year's.
{
  const r = await page.evaluate((t) => {
    window._texts = t;
    renderSeason(t.season);
    const box = document.getElementById('season-box');
    const txt = box ? box.textContent.replace(/\s+/g, ' ') : '';

    // the same panel, rendered as it will look once the season has turned
    const future = JSON.parse(JSON.stringify(t.season));
    future.season = '2020/21';
    renderSeason(future);
    const old = document.getElementById('season-box').textContent.replace(/\s+/g, ' ');
    renderSeason(t.season);

    return {
      txt, old,
      season: t.season.season,
      rules: (t.season.periods || []).map(p => p.rule || ''),
      spans: (t.season.periods || []).map(p => (p.from && p.to) ? 1 : 0),
      // the season the page works out for itself, at three points in a year
      names: [new Date(2026, 10, 2), new Date(2027, 2, 1), new Date(2027, 7, 1)]
               .map(d => _currentSeason(d))
    };
  }, JSON.parse(fs.readFileSync(TEXTS, 'utf8')));

  const T = '"when to travel" says when';

  if (!r.season) fail(T,
    'the content file does not say which season its dates were checked for'); else ok();
  if (r.rules.some(x => x !== 'fixed' && x !== 'annual')) fail(T,
    'a row does not say whether its dates repeat every year'); else ok();
  if (r.spans.some(x => !x)) fail(T, 'a row carries no dates at all'); else ok();

  // the dates themselves, on screen
  if (!/11–13 בדצמבר/.test(r.txt)) fail(T,
    'the World Cup is listed with no date beside it'); else ok();
  if (!/30–31 בינואר/.test(r.txt)) fail(T,
    'the Sant\'Orso fair does not show its two days'); else ok();
  if (!/21 בנובמבר – 6 בינואר/.test(r.txt)) fail(T,
    'a span that crosses a month is not written out'); else ok();

  // once the season has turned
  if (!/נבדקו לעונת/.test(r.old)) fail(T,
    'a stale file says nothing about being stale'); else ok();
  if (/11–13 בדצמבר/.test(r.old)) fail(T,
    'a stale file still prints last season\'s race dates as fact'); else ok();
  if (!/30–31 בינואר/.test(r.old)) fail(T,
    'a date that repeats every year was dropped along with the rest'); else ok();
  if (!/טרם אומת/.test(r.old)) fail(T,
    'a row with no usable date says nothing in its place'); else ok();

  // a season is named for the year it starts in
  if (JSON.stringify(r.names) !== JSON.stringify(['2026/27', '2026/27', '2027/28']))
    fail(T, `the season came out as ${JSON.stringify(r.names)}`); else ok();

  // Not a failure: the page already degrades honestly on its own, and a gate
  // that goes red every June would be a gate nobody reads. A warning is the
  // reminder to go and look up next season's dates.
  const nowSeason = (() => {
    const d = new Date(), y = d.getFullYear() - (d.getMonth() < 6 ? 1 : 0);
    return y + '/' + String((y + 1) % 100).padStart(2, '0');
  })();
  if (r.season !== nowSeason) {
    warn(T, `the "when to travel" dates were checked for ${r.season} and we are ` +
            `now in ${nowSeason} - the panel is hiding the ones that move. ` +
            `Look up the new dates, update texts.json, and set season to ${nowSeason}.`);
  } else ok();
}

// ── the flight snapshot answers from the file, never from the network ──
// A live pricing call is about nine seconds and is metered per call, so a
// reader who picks dates is answered out of data/flights.json. What is
// checked here is everything that can go wrong in reading it: a trip
// length the daily job does not cover, a carrier name carrying markup, a
// nearby day that is cheaper, and the case of no file at all.
{
  const r = await page.evaluate(async () => {
    const snap = {
      generated: new Date(Date.now() - 3.6e6).toISOString(),
      origin: 'TLV', adults: 2, currency: 'USD', nights: [4, 5, 6, 7],
      dests: { MXP: { he: 'מילאנו מלפנסה', km: 175 }, TRN: { he: 'טורינו', km: 100 } },
      cal: {
        MXP: { 3: { '2027-02-04': 310 },
               4: {}, 5: { '2027-01-10': 520, '2027-01-12': 380, '2027-03-28': 400 },
               6: {}, 7: {} },
        TRN: { 3: {}, 4: {}, 5: {}, 6: {}, 7: {} }
      },
      rets: { MXP: { 3: {}, 4: {}, 5: {}, 6: {}, 7: {} },
              TRN: { 3: {}, 4: {}, 5: {}, 6: {}, 7: {} } },
      offers: [
        { kind: 'midweek', bandHe: 'אמצע שבוע', dest: 'MXP', date: '2027-01-12',
          ret: '2027-01-17', nights: 5, price: 380, carrier: 'Wizz Air', direct: false },
        { kind: 'weekend', bandHe: 'סוף שבוע', dest: 'MXP', date: '2027-01-08',
          ret: '2027-01-11', nights: 3, price: 420, carrier: 'ITA', direct: true },
        { kind: 'israeli', bandHe: 'אמצע שבוע', dest: 'MXP', date: '2027-01-12',
          ret: '2027-01-17', nights: 5, price: 540, carrier: '<img src=x onerror=alert(1)>', direct: true }
      ]
    };
    window._FLIGHTS = snap; window._flTried = true;

    const out = {};
    // a date the snapshot holds
    out.hit = flightForDatesHtml('MXP', '2027-01-10', '2027-01-15', '2');
    // the same, where a nearby day is much cheaper
    out.hasTip = /💡/.test(out.hit);
    out.tipDay = (out.hit.match(/ביציאה ב-([0-9.]+)/) || [])[1] || '';
    // a trip length the daily job does not cover
    out.uncovered = flightForDatesHtml('MXP', '2027-01-10', '2027-01-19', '2');
    // a cheap date with nothing cheaper beside it
    out.noTip = !/💡/.test(flightForDatesHtml('MXP', '2027-01-12', '2027-01-17', '2'));
    // a date with no stored price at all
    out.gap = flightForDatesHtml('MXP', '2027-02-02', '2027-02-07', '2');
    // a party that is not two
    out.four = flightForDatesHtml('MXP', '2027-01-10', '2027-01-15', '4');

    out.offers = flightOffersHtml();
    out.months    = flightMonthsHtml();
    out.monthRows = flightMonths().map(r => r.month + '=' + r.typical + '/' + r.low);

    // the home card: painted, then painted again - the second pass must
    // not stack a second price onto the same line
    const card = document.getElementById('svc-travel');
    const sub  = card && card.querySelector('.svc-txt small');
    if (sub) [...sub.querySelectorAll('.fl-teaser')].forEach(e => e.remove());
    await paintTravelTeaser(); await paintTravelTeaser();
    out.teaser = sub ? sub.textContent : '';
    out.teaserTwice = sub ? sub.querySelectorAll('.fl-teaser').length : -1;

    // the panel must reach the tab the modal actually opens on
    openM('hotelModal');
    await new Promise(r => setTimeout(r, 200));
    const slots = [...document.querySelectorAll('.fl-offers')];
    out.slots      = slots.length;
    out.slotsFilled = slots.filter(h => h.innerHTML.length > 50).length;
    const allPanel = document.getElementById('tpanel-all');
    out.inAllTab   = !!(allPanel && allPanel.querySelector('.fl-offers'));
    out.allSnapshotSlot = !!document.getElementById('all-snapshot');

    // the teaser is a door: dates on hover, and a click that fills them in
    const t = document.querySelector('.fl-teaser');
    out.teaserTitle = t ? (t.getAttribute('title') || '') : '';
    out.teaserRole  = t ? t.getAttribute('role') : '';
    out.teaserRects = t ? t.getClientRects().length : -1;
    if (t) {
      t.click();
      await new Promise(r => setTimeout(r, 250));
      const dt = document.getElementById('trip-dates');
      out.filledCi = dt ? dt.getAttribute('data-ci') : '';
      out.filledCo = dt ? dt.getAttribute('data-co') : '';
      out.onFlightTab = !!document.getElementById('ttab-flight')
        ?.classList.contains('ttab-active');
    }
    closeM('hotelModal');

    // no file at all: every surface must come back empty, not broken
    window._FLIGHTS = null;
    if (sub) [...sub.querySelectorAll('.fl-teaser')].forEach(e => e.remove());
    await paintTravelTeaser();
    out.teaserBare = sub ? sub.querySelectorAll('.fl-teaser').length : -1;
    out.bareDates  = flightForDatesHtml('MXP', '2027-01-10', '2027-01-15', '2');
    out.bareOffers = flightOffersHtml();
    out.bareMonths = flightMonthsHtml();

    // nights across the European DST change (29 March 2027)
    out.dst = _flNights('2027-03-26', '2027-03-31');
    out.plain = _flNights('2027-01-10', '2027-01-15');
    return out;
  });

  const T = 'the flight snapshot answers from the file';

  if (!/380|520/.test(r.hit)) fail(T, 'a stored date showed no price'); else ok();
  if (!/5 לילות/.test(r.hit)) fail(T, 'the trip length is not stated'); else ok();
  // The calendar answers for ONE traveller - the call carries no passenger
  // count at all - so a label saying "for two" was simply false. The first
  // snapshot proved it: 126 in the calendar, 252 from the pricing call for
  // the same flight on the same date, exactly 2.00x.
  if (!/לנוסע אחד/.test(r.hit)) fail(T,
    'the price does not say it is per traveller'); else ok();
  if (/לשני נוסעים/.test(r.hit) || /לשני נוסעים/.test(r.offers)) fail(T,
    'the page still claims the per-person figure covers two people'); else ok();
  if (!/עודכן היום/.test(r.hit)) fail(T, 'the price carries no age'); else ok();

  if (!r.hasTip) fail(T, 'a nearby day 27% cheaper was not offered'); else ok();
  if (r.tipDay !== '12.1') fail(T,
    `the cheaper day shows as "${r.tipDay}", wanted 12.1`); else ok();
  if (!r.noTip) fail(T,
    'the cheapest day in the month was told there is something cheaper'); else ok();

  // The honest answer to an uncovered trip length. Silence here reads as
  // "there are no flights", which is a different and false statement.
  if (!/9/.test(r.uncovered) || !/4–5–6–7|4.5.6.7/.test(r.uncovered)) fail(T,
    `an uncovered trip length must name the lengths covered - got "${r.uncovered.slice(0, 140)}"`); else ok();
  if (!r.gap || !/אין מחיר שמור/.test(r.gap)) fail(T,
    'a date with no stored price says nothing at all'); else ok();
  if (!/בחרת 4 נוסעים/.test(r.four)) fail(T,
    'a party of four is not told the figure is for one'); else ok();
  // and no invented total: four times the cheapest seat is not a fare
  if (/1512|1680/.test(r.four)) fail(T,
    'the page multiplied the fare out into a total nobody can check'); else ok();

  if (!/Wizz Air/.test(r.offers)) fail(T, 'the offers carry no airline'); else ok();
  // The explanatory line about Israeli carriers was removed at Yossi's
  // request - "הישראלים יודעים את זה" - so its absence is now the check.
  if (/ממשיכות לטוס|בהוראת הממשלה/.test(r.offers)) fail(T,
    'the Israeli-carrier explanation is back'); else ok();
  // Only an UNESCAPED tag is the hole. The words "onerror=alert(1)" survive
  // inside the neutralised text and are harmless there, so testing for them
  // fails on correct output - which is exactly what it did.
  if (/<img|<script|<\/b>\s*<img/i.test(r.offers)) fail(T,
    'a carrier name from the file reached the page as live markup'); else ok();
  if (!/&lt;img/.test(r.offers)) fail(T,
    'the carrier name was dropped rather than escaped'); else ok();

  // ── the season, month by month, straight out of the calendar ──────
  // Three offers all landing on the same Christmas week is what this
  // answers; it needs no extra call, because every priced day is already
  // in the file.
  if (!/ינואר/.test(r.months) || !/פברואר/.test(r.months) || !/מרץ/.test(r.months))
    fail(T, 'the month strip is missing a month of the season'); else ok();
  // the cheapest day of each month, whatever trip length it was found at
  // The TYPICAL price, not the lowest: in the real snapshot the lowest was
  // the same 126 in four months out of five - one airline's floor fare, a
  // statistic that cannot tell December from February.
  if (JSON.stringify(r.monthRows) !==
      JSON.stringify(['2027-01=450/380', '2027-02=310/310', '2027-03=400/400']))
    fail(T, `the months came out as ${JSON.stringify(r.monthRows)}`); else ok();
  // and the cheapest month of all is marked, so the strip says something
  if (!/#0f6b3f/.test(r.months)) fail(T,
    'no month is marked as the cheapest, so the strip is just numbers'); else ok();
  // "the middle price" is not a statistic anybody can check. It is the
  // median, it is deliberately not the mean, and the panel says so.
  if (!/חציון/.test(r.months)) fail(T,
    'the strip does not name the statistic it is showing'); else ok();
  if (/המחיר האמצעי/.test(r.months)) fail(T,
    'the strip still calls it "the middle price"'); else ok();
  // A "from" price equal to the typical one is a discount tag with nothing
  // behind it. February in the fixture has a single price, so its cell must
  // not claim a range; January's 380 against a typical 450 must show one.
  if (!/מ-<bdi>380/.test(r.months)) fail(T,
    'a month with a real spread does not show what it starts at'); else ok();
  if (/מ-<bdi>310/.test(r.months)) fail(T,
    'a month whose cheapest day IS its typical day still claims a range'); else ok();
  // and it must not make a claim in that gap instead. "No variation" was
  // false: a month can run 126 to 254 and still have its middle at 131.
  if (/ללא תנודה|אין תנודה|קבוע/.test(r.months)) fail(T,
    'the strip makes a claim about variation it cannot support'); else ok();
  if (r.bareMonths !== '') fail(T,
    'with no snapshot the month strip still paints'); else ok();

  // ── the panel is where people land, and the teaser is a door ──────
  // The modal opens on the "הכל" tab. The offers lived only in the flight
  // tab, so the one place nobody had to click was the one place they were
  // not - Yossi searched, got the links, and never saw the panel.
  if (r.slots < 2) fail(T,
    `only ${r.slots} panel(s) have a slot for the offers`); else ok();
  if (r.slotsFilled !== r.slots) fail(T,
    `${r.slots - r.slotsFilled} of the slots were left empty`); else ok();
  if (!r.inAllTab) fail(T,
    'the tab the modal opens on has no offers panel'); else ok();
  if (!r.allSnapshotSlot) fail(T,
    'the combined tab has nowhere to show the stored price'); else ok();

  if (!/יציאה/.test(r.teaserTitle) || !/לילות/.test(r.teaserTitle)) fail(T,
    `hovering the card price says "${r.teaserTitle}" - it should name the dates`); else ok();
  // One box, not two: an inline highlight that wraps leaves a green stub at
  // the end of the line above it, which is what Yossi photographed.
  if (r.teaserRects !== 1) fail(T,
    `the fare highlight is drawn as ${r.teaserRects} boxes - it has wrapped`); else ok();
  if (r.teaserRole !== 'button') fail(T,
    'the card price does not announce itself as something to press'); else ok();
  if (r.filledCi !== '2027-01-12' || r.filledCo !== '2027-01-17') fail(T,
    `clicking it filled ${r.filledCi}–${r.filledCo}, not the offer's own dates`); else ok();
  if (!r.onFlightTab) fail(T,
    'clicking the price did not land on the flight tab'); else ok();

  if (r.bareDates !== '' || r.bareOffers !== '') fail(T,
    'with no snapshot the page still paints something'); else ok();

  // the home card carries the cheapest fare, and carries it only once
  if (!/טיסה מ-/.test(r.teaser)) fail(T,
    'the travel card shows no fare'); else ok();
  if (!/380/.test(r.teaser)) fail(T,
    `the card should show the lowest of the offers, got: "${r.teaser}"`); else ok();
  if (/אמצע שבוע/.test(r.offers) === false) fail(T,
    'the offers do not say which kind of trip each one is'); else ok();
  if (!/3 לילות/.test(r.offers)) fail(T,
    'an offer does not say how many nights it covers'); else ok();
  if (r.teaserTwice !== 1) fail(T,
    `painting twice left ${r.teaserTwice} fares on the card`); else ok();
  if (r.teaserBare !== 0) fail(T,
    'with no snapshot the card still shows a fare'); else ok();

  if (r.dst !== 5) fail(T,
    `a trip across the clock change counted ${r.dst} nights, not 5`); else ok();
  if (r.plain !== 5) fail(T, `an ordinary trip counted ${r.plain} nights`); else ok();
}

// ── the price ceiling reaches the hotel sites as a ceiling ──────────────
// Booking took "nflt=price=USD-0-150-1" as a filter and still accepted the
// link, so nothing looked broken - but it read 1500 as a FLOOR, and a search
// for apartments under $150 a night came back with no places at all. Price
// is not an nflt key there: it is a parameter of its own, and its order runs
// the other way round, min-max-CUR.
{
  const r = await page.evaluate(() => {
    const out = [];
    const cases = [
      { f: { cur: 'USD', max: 150 },            want: 'price=0-150-USD' },
      { f: { cur: 'USD', min: 100, max: 200 },  want: 'price=100-200-USD' },
      { f: { cur: 'EUR', max: 90, kitchen: 1 }, want: 'price=0-90-EUR' }
    ];
    for (const c of cases) {
      const u = _bookingUrl('2027-01-10', '2027-01-15', 2, 0, 1, 0, 'apt', c.f);
      out.push({ want: c.want, has: u.indexOf('&' + c.want) >= 0,
                 inNflt: /nflt=[^&]*price/.test(u), url: u });
    }
    // and no filter at all when nothing was typed
    const bare = _bookingUrl('2027-01-10', '2027-01-15', 2, 0, 1, 0, 'apt', { cur: 'USD' });
    return { out, bareHasPrice: /[?&]price=/.test(bare),
             // the label the reader sees must say which way the bound runs
             label: _stayDesc('דירות', 'apt', { cur: 'USD', max: 150 }) };
  });

  const T = 'the price ceiling reaches the hotel sites as a ceiling';
  const miss = r.out.filter(o => !o.has);
  const nflt = r.out.filter(o => o.inNflt);
  if (miss.length) fail(T,
    `missing ${miss.map(o => o.want).join(', ')} - got ${miss[0].url}`); else ok();
  if (nflt.length) fail(T,
    'the price is back inside nflt, where Booking misreads it'); else ok();
  if (r.bareHasPrice) fail(T,
    'an empty budget still sends a price filter'); else ok();
  if (!/^דירות · עד 150 \$ ללילה$/.test(r.label)) fail(T,
    `the button reads "${r.label}" - a bare dash reads as a price missing its other half`); else ok();
}

// ── a panel wears the picture of the card that opened it ────────────────
// The cards became drawings and their panel headings stayed emoji
// characters, so tapping a pair of skis landed the reader on a page headed
// by a skier - the same contradiction the drawings were meant to end, moved
// one screen along.
//
// What the expectation is read FROM is the whole point. MODAL_ICONS is what
// the code applies, so asking MODAL_ICONS what the heading should show
// compares the map to itself and passes whatever it contains. The honest
// source is the card the reader actually tapped: its own <use href> is set
// in the markup, by hand, nowhere near the map.
{
  const r = await page.evaluate(async (t) => {
    window._texts = t;
    if (typeof _applyTexts === 'function') _applyTexts(t);

    // card -> the panel it opens, straight from the home page
    const cards = [...document.querySelectorAll('.services-grid .service-btn')]
      .map(el => {
        const m  = (el.getAttribute('onclick') || '').match(/openM\(\s*'([^']+)'/);
        const u  = el.querySelector('.svc-ico use');
        return m && u
          ? { id: m[1], want: (u.getAttribute('href') || '').replace('#', '') }
          : null;
      })
      .filter(Boolean);

    const out = { panels: [], cards: cards.length, doubled: false };
    for (const c of cards) {
      openM(c.id);
      await new Promise(res => setTimeout(res, 90));
      const md  = document.getElementById(c.id);
      const h   = md && md.querySelector('h1, h2, h3');
      const ico = h && h.querySelector('.ttl-ico use');
      out.panels.push({
        id: c.id,
        want: c.want,
        sym: ico ? (ico.getAttribute('href') || '').replace('#', '') : null,
        leftover: h ? /[☀-➿]|[\uD83C-\uDBFF][\uDC00-\uDFFF]/.test(h.textContent) : true,
        words: h ? h.textContent.replace(/\s+/g, ' ').trim().length : 0
      });
      closeM(c.id);
      await new Promise(res => setTimeout(res, 40));
    }
    // the pass runs on every open and after every content load, so running
    // it again must change nothing
    applyModalIcons(); applyModalIcons();
    out.doubled = [...document.querySelectorAll('h1, h2, h3')]
      .some(h => h.querySelectorAll('.ttl-ico').length > 1);
    return out;
  }, JSON.parse(fs.readFileSync(TEXTS, 'utf8')));

  const T = 'a panel wears the picture of the card that opened it';
  const missing = r.panels.filter(p => !p.sym);
  const wrong   = r.panels.filter(p => p.sym && p.sym !== p.want);
  const left    = r.panels.filter(p => p.leftover);
  const empty   = r.panels.filter(p => p.words < 3);

  if (r.cards < 10) fail(T,
    `only ${r.cards} cards on the home page carry both a panel and a drawing`); else ok();
  if (missing.length) fail(T,
    `no drawing in: ${missing.map(p => p.id).join(', ')}`); else ok();
  if (wrong.length) fail(T,
    wrong.map(p => `${p.id} is headed by ${p.sym}, but its card shows ${p.want}`).join(' ; ')); else ok();
  if (left.length) fail(T,
    `an emoji survived beside the drawing in: ${left.map(p => p.id).join(', ')}`); else ok();
  if (empty.length) fail(T,
    `the heading text was eaten in: ${empty.map(p => p.id).join(', ')}`); else ok();
  if (r.doubled) fail(T, 'running the pass twice stacked two drawings'); else ok();
}

// The two blocks that used to live here tested the <input>: readonly on
// blur, type=search, a name of its own, autocomplete=off, and a stylesheet
// guard against the colour Chrome paints when it autofills anyway. Every
// one of those is a hint, and the password manager went on ignoring all of
// them. The field is not a form control any more, which is the thing those
// five attributes were trying to approximate - see "the search box is a
// search box", which tests that directly.

// ── the forum opens on request, and closes again ─────────────────────────
// It used to sit open on the home page directly under the strip that
// summarises it: the same posts twice, and no way to put the second copy
// away. The strip is the home page now.
{
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(res => setTimeout(res, ms));
    const card = document.getElementById('forum-card');
    const btn  = document.getElementById('peek-open-btn');
    try { localStorage.removeItem('forumOpen'); } catch (e) {}

    allPosts = [1, 2, 3].map(i => ({
      id: 'q' + i, user: 'כותב ' + i, content: 'הודעה ' + i,
      timestamp: Date.now() - i * 3600e3, replies: [], reactions: {}, _userReacts: {}
    }));
    renderPosts('');
    restoreForumOpenState();
    await wait(60);

    const out = { closedAtStart: card.style.display === 'none',
                  labelClosed: (btn.textContent || '').trim() };

    peekOpenForum(); await wait(60);
    out.openedByButton = card.style.display !== 'none';
    out.labelOpen = (btn.textContent || '').trim();
    let saved = null; try { saved = localStorage.getItem('forumOpen'); } catch (e) {}
    out.remembered = saved === '1';

    peekOpenForum(); await wait(60);
    out.closedAgain = card.style.display === 'none';
    let cleared = 'x'; try { cleared = localStorage.getItem('forumOpen'); } catch (e) {}
    out.forgotten = (cleared === null);

    // there is a visible × inside the card, not only the toggle underneath
    forumOpen(false); await wait(40);
    out.hasCloseControl = !!card.querySelector('button[onclick="forumClose()"]');
    forumClose(); await wait(40);
    out.closeControlWorks = card.style.display === 'none';

    // opening a single post from the strip must open the forum first,
    // or it scrolls to something that is not on the page
    peekOpenPost('q1'); await wait(60);
    out.postOpensForum = card.style.display !== 'none';

    forumClose();
    try { localStorage.removeItem('forumOpen'); } catch (e) {}
    return out;
  });

  const T = 'the forum opens on request, and closes again';
  if (!r.closedAtStart) fail(T,
    'the whole forum is still open on the home page under its own summary'); else ok();
  if (!r.openedByButton) fail(T, 'the button under the strip does not open it'); else ok();
  if (!r.closedAgain) fail(T, 'once open there is no way to close it'); else ok();
  if (!r.hasCloseControl) fail(T, 'the forum carries no close control of its own'); else ok();
  if (!r.closeControlWorks) fail(T, 'the × inside the forum does not close it'); else ok();
  if (!r.postOpensForum) fail(T,
    'clicking a post in the strip scrolls to a forum that is still hidden'); else ok();
  if (!r.remembered || !r.forgotten) fail(T,
    `the choice is not remembered (saved: ${r.remembered}, cleared: ${r.forgotten})`); else ok();
  if (r.labelClosed === r.labelOpen) fail(T,
    `the toggle reads "${r.labelClosed}" whether it opens or closes`); else ok();
}

// ── the colour answers before the digits are read ────────────────────────
// Every live number was the same blue, so "0 of 9 slopes" and "14 of 15"
// looked identical at a glance - which is the one thing somebody checking
// the bar at 8am wants to know without reading.
{
  const r = await page.evaluate(async () => {
    const read = () => getComputedStyle(document.getElementById('bar-slopes-local')).color;
    const base = { lifts_open_global: 10, lifts_total_global: 15 };
    const out = {};
    renderLiveBar(Object.assign({}, base, { slopes_open_global: 0, slopes_total_global: 9 }));
    out.shut = read();
    renderLiveBar(Object.assign({}, base, { slopes_open_global: 2, slopes_total_global: 9 }));
    out.some = read();
    renderLiveBar(Object.assign({}, base, { slopes_open_global: 9, slopes_total_global: 9 }));
    out.open = read();
    return out;
  });
  const distinct = new Set([r.shut, r.some, r.open]).size;
  if (distinct !== 3) fail('the colour answers before the digits are read',
    `nothing open, partly open and all open came back as ${distinct} colour(s): ${JSON.stringify(r)}`); else ok();
  // red for shut, green for open - not the other way round
  const redish = (c) => { const n = c.match(/\d+/g).map(Number); return n[0] > 200 && n[1] < 150; };
  const greenish = (c) => { const n = c.match(/\d+/g).map(Number); return n[1] > 150 && n[0] < 150; };
  if (!redish(r.shut)) fail('the colour answers before the digits are read',
    `with nothing open the number is ${r.shut}`); else ok();
  if (!greenish(r.open)) fail('the colour answers before the digits are read',
    `with everything open the number is ${r.open}`); else ok();
}

// ── a long panel says what is inside it ──────────────────────────────────
// Opening "kosher -> Milan" used to drop the reader into restaurants with no
// sign that synagogues and places to stay followed further down. Each long
// panel now opens with chips naming its sections, built from the headings
// themselves so the strip cannot drift away from the content.
{
  const r = await page.evaluate(async () => {
    const wait = (ms) => new Promise(res => setTimeout(res, ms));
    const out = {};
    openM('kosherModal'); await wait(250);
    switchKoshMain('kosher'); await wait(200);
    for (const t of ['cervinia', 'milan']) {
      switchKoshTab(t); await wait(200);
      const strip = document.querySelector('#kosh-panel-' + t + ' .panel-toc');
      out['kosher/' + t] = strip ? [...strip.children].map(c => c.textContent.trim()) : null;
    }
    // a chip has to actually move the panel to its section
    switchKoshTab('milan'); await wait(200);
    const box = document.querySelector('#kosherModal .modal-content');
    box.scrollTop = 0;
    const chips = [...document.querySelectorAll('#kosh-panel-milan .panel-toc button')];
    if (chips.length) {
      chips[chips.length - 1].click();
      await wait(700);
      out.scrolled = box.scrollTop;
    } else {
      out.scrolled = -1;          // nothing to tap: reported as a failure below
    }
    closeM('kosherModal');

    openM('parkingModal'); await wait(400);
    switchParkTab('transport'); await wait(500);
    const st = document.querySelector('#park-panel-transport .panel-toc');
    out.transport = st ? [...st.children].map(c => c.textContent.trim()) : null;
    closeM('parkingModal');
    return out;
  });
  const want = { 'kosher/cervinia': 3, 'kosher/milan': 4, transport: 6 };
  const thin = Object.keys(want).filter(k => !r[k] || r[k].length < want[k]);
  if (thin.length) fail('a long panel says what is inside it',
    thin.map(k => `${k}: ${r[k] ? r[k].length + ' chips' : 'no strip'}`).join(' · ')); else ok();
  // the chips have to name the sections a reader would not guess are there
  const milan = (r['kosher/milan'] || []).join(' ');
  if (!/בתי כנסת/.test(milan) || !/לינה/.test(milan)) fail('a long panel says what is inside it',
    `the Milan strip reads ${JSON.stringify(r['kosher/milan'])}`); else ok();
  if (!(r.scrolled > 100)) fail('a long panel says what is inside it',
    `tapping the last chip moved the panel to ${r.scrolled}px`); else ok();
}

// ── every phone number on the page can be dialled ────────────────────────
// Printed straight into a right-to-left line, "+39 02 48519326" is laid out
// group by group from the right and read back as "48519326 02 39+". The
// Milan and Torino lists were doing exactly that. This walks every panel,
// including the sub-tabs that only render when you click them, and fails on
// any number that is not inside a left-to-right isolate.
{
  const r = await page.evaluate(async () => {
    const PHONE = /\+?\d{1,4}(?:[ \u00a0]\d{2,7}){1,4}/g;
    const bad = [], seen = new Set();
    let total = 0;
    const scan = (where) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const m = (n.nodeValue || '').match(PHONE);
        if (!m) continue;
        for (const num of m) {
          if ((num.match(/\d/g) || []).length < 8) continue;
          const el = n.parentElement;
          if (!el || !el.offsetParent) continue;
          let e = el, ok = false;
          for (let i = 0; i < 6 && e; i++, e = e.parentElement) {
            const cs = getComputedStyle(e);
            // Chrome reports unicode-bidi:isolate on every block container,
            // so testing for it passes everything and proves nothing. What
            // actually keeps the digit groups in order is a left-to-right
            // direction, which means a <bdi dir="ltr"> or dir="ltr".
            if (cs.direction === 'ltr') { ok = true; break; }
          }
          total++;
          if (ok) continue;
          const key = where + '|' + num;
          if (seen.has(key)) continue;
          seen.add(key);
          bad.push(where + ': ' + num);
        }
      }
    };
    const wait = (ms) => new Promise(res => setTimeout(res, ms));
    const sub = {
      kosherModal: async () => {
        for (const m of ['shabbat', 'kosher']) {
          switchKoshMain(m); await wait(110);
          if (m === 'kosher') for (const t of ['cervinia', 'delivery', 'milan', 'torino']) {
            switchKoshTab(t); await wait(110); scan('kosher/' + t);
          } else scan('kosher/shabbat');
        }
      },
      skipassModal: async () => {
        for (const t of ['cervinia', 'zermatt']) { switchPassTab(t); await wait(110); scan('skipass/' + t); }
      },
      lessonsModal: async () => {
        for (const t of ['group', 'private', 'kids']) { switchLessonTab(t); await wait(110); scan('lessons/' + t); }
      },
      parkingModal: async () => {
        for (const t of ['parking', 'transport', 'emergency']) {
          try { switchParkTab(t); } catch (e) {}
          await wait(110); scan('parking/' + t);
        }
      }
    };
    scan('home');
    for (const id of [...document.querySelectorAll('.modal')].map(m => m.id).filter(Boolean)) {
      try { openM(id); } catch (e) { continue; }
      await wait(160);
      scan(id);
      if (sub[id]) { try { await sub[id](); } catch (e) { bad.push(id + ': subtab ' + e.message); } }
      try { closeM(id); } catch (e) {}
    }
    return { bad, total };
  });
  if (r.bad.length) fail('every phone number on the page can be dialled',
    r.bad.slice(0, 6).join(' · ')); else ok();
  // and the walk has to be finding numbers at all, or it proves nothing
  if (r.total < 40) fail('every phone number on the page can be dialled',
    `only ${r.total} phone numbers were reached - the walk is not opening the panels`); else ok();
}

// ── the link looks like something when it is forwarded ───────────────────
// Most of the traffic this site will ever get arrives as a link somebody
// pasted into a WhatsApp group. Without these tags that paste is a bare URL:
// no title, no sentence, no picture, and far fewer taps.
{
  const head = await page.evaluate(() => {
    const m = (sel, attr) => {
      const e = document.querySelector(sel);
      return e ? (e.getAttribute(attr || 'content') || '') : null;
    };
    return {
      title: document.title,
      desc: m('meta[name="description"]'),
      ogTitle: m('meta[property="og:title"]'),
      ogDesc: m('meta[property="og:description"]'),
      ogImage: m('meta[property="og:image"]'),
      ogW: m('meta[property="og:image:width"]'),
      ogH: m('meta[property="og:image:height"]'),
      ogUrl: m('meta[property="og:url"]'),
      twCard: m('meta[name="twitter:card"]'),
      canonical: m('link[rel="canonical"]', 'href'),
      lang: document.documentElement.lang,
      dir: document.documentElement.dir
    };
  });
  const missing = Object.keys(head).filter(k => !head[k]);
  if (missing.length) fail('the link looks like something when it is forwarded',
    `missing: ${missing.join(', ')}`); else ok();
  // a bare "CerviniaLive" tells a Hebrew reader nothing about what it is
  if (!/צ׳רוויניה/.test(head.title)) fail('the link looks like something when it is forwarded',
    `the page title is "${head.title}"`); else ok();
  if (!/^https:\/\//.test(head.ogImage || '') || !/og-image\.png$/.test(head.ogImage || ''))
    fail('the link looks like something when it is forwarded',
      `og:image is "${head.ogImage}" - it has to be an absolute URL`); else ok();
  if (head.ogW !== '1200' || head.ogH !== '630')
    fail('the link looks like something when it is forwarded',
      `og:image is declared ${head.ogW}x${head.ogH}, not 1200x630`); else ok();
  if ((head.ogDesc || '').length < 40) fail('the link looks like something when it is forwarded',
    'the one line under the title is too short to say what the site is'); else ok();
  // and the file it points at has to exist beside the page
  if (!fs.existsSync(path.join(path.dirname(PAGE), 'og-image.png')))
    fail('the link looks like something when it is forwarded',
      'og-image.png is not next to index.html'); else ok();
}

// ── the rental prices come from a published list ─────────────────────────
// The page used to carry ranges like "~€25-35 a day" that no shop published
// and that were too low: Genzianella's cheapest adult ski-and-boots package
// is €41 a day, and €25 is the skis on their own. Checked 28.10.2026 against
// genzianellasport.it/it/listini.html, which is the only Cervinia shop
// publishing a full list for the current season - nolski.it still serves a
// PDF for 2025-26. One shop's list, named on the page, beats a made-up range.
{
  const r = T.rental || {};
  const rows = r.price_rows || [];
  if (rows.length < 8) fail('the rental prices come from a published list',
    `the table has ${rows.length} rows`); else ok();

  const byLabel = {};
  rows.forEach(row => { byLabel[row.label] = (row.v || []).join('|'); });
  const expect = {
    '🎿 סקי + מגפיים — מבוגר':     '€41|€97|€175',
    '🎿 סקי + מגפיים — ילדים':     '€19|€50|€90',
    '🏂 סנובורד + נעליים — מבוגר': '€51|€120|€205',
    '🪖 קסדה':                      '€8|€16|€25'
  };
  const wrong = Object.keys(expect).filter(k => byLabel[k] !== expect[k]);
  if (wrong.length) fail('the rental prices come from a published list',
    wrong.map(k => `${k}: ${byLabel[k] || 'missing'} (list says ${expect[k]})`).join(' · ')); else ok();

  // the reader has to be told whose list this is, or it is another anonymous range
  if (!/Genzianella/.test(r.price_sub || '')) fail('the rental prices come from a published list',
    'the table does not say which shop publishes these prices'); else ok();
  // and that other shops differ
  if (!/לכל חנות מחירון משלה/.test(r.price_sub || '')) fail('the rental prices come from a published list',
    'the table reads as if it covered every shop in the village'); else ok();

  // Turning up in peak season without a booking can mean no equipment at
  // all - Yossi has had it happen. The shop's own FAQ says the booking
  // "guarantees availability", which is the same thing said politely.
  const shown = await page.evaluate(() => {
    openM('rentalModal');
    const w = document.getElementById('rental-booking-warning');
    // the headline is the summary of the fold the explanation sits in
    const fold = w && w.closest('details');
    const head = fold && fold.querySelector('summary');
    return !!(w && w.textContent.trim().length > 60
              && head && /הזמינו מראש/.test(head.textContent)
              && !fold.open);
  });
  if (!shown) fail('the rental prices come from a published list',
    'the booking warning, or the headline above it, is missing'); else ok();

  // the morning of the first ski day is the longest queue of the week
  if (!(r.tips || []).some(t => /ביום שלפני/.test(t))) fail('the rental prices come from a published list',
    'the tip about fitting the equipment the afternoon before is gone'); else ok();

  // the third "shop" was Genzianella's own second branch under a wrong name
  // Via Bich holds two shops with near-identical signs, a few doors apart.
  // The page carried one card that mixed the name of the first with the
  // phone number of the second, so a reader ringing "Ski Service" reached
  // Cretaz. Both are listed now, each with its own number.
  const shops = await page.evaluate(() => {
    openM('rentalModal');
    return document.body.innerText;
  });
  const wantShops = ['Genzianella Sport', 'Cervinia Ski Service', 'Noleggio Cretaz',
                     'Ski 2.0', 'Adriano Sport'];
  const missing = wantShops.filter(n => shops.indexOf(n) === -1);
  if (missing.length) fail('every rental shop is listed under its own name',
    `missing from the list: ${missing.join(', ')}`); else ok();
  // the number that used to sit under the wrong name
  const pairs = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('#rentalModal a[href^="tel:"]').forEach(a => {
      const card = a.closest('div[style*="border-radius:11px"]');
      const name = card ? (card.querySelector('div[style*="font-weight:bold"]') || {}).textContent : '';
      out[(name || '').trim()] = a.getAttribute('href');
    });
    return out;
  });
  const expectTel = {
    '🎿 Cervinia Ski Service': 'tel:+393398511092',
    '🎿 Noleggio Cretaz':      'tel:+390166949484',
    '🎿 Genzianella Sport':    'tel:+390166550102'
  };
  const badTel = Object.keys(expectTel).filter(k => pairs[k] !== expectTel[k]);
  if (badTel.length) fail('every rental shop is listed under its own name',
    badTel.map(k => `${k} rings ${pairs[k] || 'nothing'}`).join(' · ')); else ok();

  // Two of the four village shops close at midday and two do not, and the
  // two that do are the same company. "Most of them close" was a guess.
  const hoursTip = (r.tips || []).find(t => /12:30/.test(t)) || '';
  if (!hoursTip) fail('every rental shop is listed under its own name',
    'the page does not say which shops close at midday'); else ok();
  if (!/Cervinia Ski Service/.test(hoursTip) || !/Ski 2\.0/.test(hoursTip))
    fail('every rental shop is listed under its own name',
      'the hours line does not name the shops that stay open through midday'); else ok();
  if (/רובן|רוב החנויות/.test(hoursTip)) fail('every rental shop is listed under its own name',
    'the hours line still generalises from two shops to most of them'); else ok();

  // Renting a jacket and trousers costs more than buying them within two
  // days, which is the kind of sum a reader should not have to do.
  if (!/€70/.test(r.buy_vs_rent || '') || !/יומיים/.test(r.buy_vs_rent || ''))
    fail('every rental shop is listed under its own name',
      'the buy-or-rent comparison is missing its conclusion'); else ok();
  const cmp = await page.evaluate(() => {
    const el = document.getElementById('rental-buy-vs-rent');
    return !!(el && el.textContent.trim().length > 150 && el.closest('details'));
  });
  if (!cmp) fail('every rental shop is listed under its own name',
    'the buy-or-rent comparison is not drawn, or is not behind a fold'); else ok();

  // the three long blocks sit behind their own headings now, so the panel
  // opens on the shops rather than on a wall of text
  const folded = await page.evaluate(() => ['rental-price-table', 'rental-ski-tips',
      'rental-buy-vs-rent'].filter(id => {
    const el = document.getElementById(id);
    const d = el && el.closest('details');
    return !(d && !d.open);
  }));
  if (folded.length) fail('every rental shop is listed under its own name',
    `not folded away: ${folded.join(', ')}`); else ok();

  // Renting up at Plan Maison costs you two things, and the page used to
  // name neither properly: on a windy day the gear is out of reach even if
  // another sector is open, and every day has to end at the gondola, before
  // it stops - no last run down to the village, no run after an apres-ski.
  const pm = await page.evaluate(() => {
    // the smallest div that holds the whole card, not just its heading
    const cards = [...document.querySelectorAll('#rentalModal div')]
      .filter(d => /Adriano Sport/.test(d.textContent) && /Plan Maison 1/.test(d.textContent));
    const card = cards.reduce((a, b) =>
      (a.textContent.length <= b.textContent.length ? a : b), cards[0]);
    return card ? card.textContent.replace(/\s+/g, ' ') : '';
  });
  const pmNeeds = { 'wind': /רוח/, 'another sector': /ולטורננש/,
                    'must end at the gondola': /לסיים כל יום/, 'apres-ski': /אפרה סקי/,
                    // Google listed it as opening at 07:30. Nobody can be up
                    // there at 07:30: the gondola does not run until 08:30,
                    // and the shop's own reply to a review says 09:00.
                    'the first gondola': /הגונדולה הראשונה/ };
  const pmGaps = Object.keys(pmNeeds).filter(k => !pmNeeds[k].test(pm));
  if (pmGaps.length) fail('every rental shop is listed under its own name',
    `the Plan Maison card does not mention: ${pmGaps.join(', ')}`); else ok();
  if (/07:30/.test(pm)) fail('every rental shop is listed under its own name',
    'the Plan Maison shop is shown opening before the gondola that reaches it'); else ok();

  // the three tabs are gone: they switched two cards while the shop list
  // below them never changed, so every tab looked like the same screen
  const ui = await page.evaluate(() => ({
    tabs: ['ski', 'snowboard', 'other'].filter(t => document.getElementById('rent-tab-' + t)).length,
    switcher: typeof switchRentTab,
    tableRows: (function () {
      openM('rentalModal');
      return document.querySelectorAll('#rental-price-table tbody tr').length;
    })()
  }));
  if (ui.tabs || ui.switcher !== 'undefined') fail('the rental prices come from a published list',
    `${ui.tabs} rental tabs are still in the page`); else ok();
  if (ui.tableRows !== rows.length) fail('the rental prices come from a published list',
    `the content file has ${rows.length} rows but ${ui.tableRows} were drawn`); else ok();
}

// ── the lesson prices are the ones the schools publish ───────────────────
// Checked against the 2026/27 tariffs on 28.10.2026:
//   scuolacervino.com/lezioni-di-sci-cervinia  - 2h €115/110, 3h €170/150,
//     half day €230/210, full day €450; top season €130/190/255/500;
//     group half day 3d €180 / 5d €210, full day 3d €400 / 5d €600
//   ride-em.com/tariffe-...  - identical for 1 to 4 students
//   scuoladiscibreuil.com/en/private-lessons - the only school publishing a
//     single-hour rate: €70 at 9:00, €65 at 13:00, €75 high, €80 peak
// The single hour was missing from the page, which is why a reader worked it
// out from the two-hour price, got €57.50 and was surprised to be quoted €70.
{
  const les = T.lessons || {};
  const priv = les.private || {};
  const grp = les.group || {};
  const flat = (o) => Object.values(o).join(' ');
  const want = (where, hay, needles) => {
    const missing = needles.filter(n => hay.indexOf(n) === -1);
    if (missing.length) fail('the lesson prices are the ones the schools publish',
      `${where} no longer carries ${missing.join(', ')}`); else ok();
  };
  want('the single hour',  flat(priv), ['€70', '€65', '€75', '€80']);
  want('the private rates', flat(priv), ['€115', '€110', '€170', '€230', '€450']);
  want('the group rates',   flat(grp),  ['€180', '€210', '€400', '€600']);

  // the hour has to say whose price it is and that it is sold by availability
  if (!/ברויל/.test(flat(priv)) || !/זמינות/.test(flat(priv)))
    fail('the lesson prices are the ones the schools publish',
      'the single-hour price is shown without saying which school publishes it'); else ok();
  // and a freelance instructor is not bound by any of it
  if (!/מדריך עצמאי/.test(flat(priv)))
    fail('the lesson prices are the ones the schools publish',
      'nothing warns that an independent instructor sets his own price'); else ok();

  // Booking a named instructor direct is an unwritten agreement: no refund
  // rule, no insurance, nobody to appeal to. Booking through a school buys
  // those terms and costs you the choice of who turns up. Both halves have
  // to be on the page, or the recommendation is only half honest.
  const note = les.instructors_note || '';
  const needs = { 'ביטול': /מבטלים|ביטול/, 'תשלום': /תשלום/, 'מזג אוויר': /מזג אוויר/,
                  '72 שעות': /72 שעות/, 'choice of instructor': /בוחרים/,
                  'assigned at a school': /מוקצה/ };
  const gaps = Object.keys(needs).filter(k => !needs[k].test(note));
  if (gaps.length) fail('the instructor note weighs both ways',
    `the note says nothing about: ${gaps.join(', ')}`); else ok();
  if (!/<b>/.test(note) || note.length < 200) fail('the instructor note weighs both ways',
    `the note is ${note.length} characters - too short to carry both sides`); else ok();

  // the school whose own site no longer lists Cervinia is gone from the page
  const r = await page.evaluate(() => document.body.innerHTML.indexOf('gr-mountain') > -1);
  if (r) fail('the lesson prices are the ones the schools publish',
    'the page still links to a school whose own site does not list Cervinia'); else ok();
}

// ── the instructors section shows nothing about the instructors ──────────
// It used to render one blurred row per instructor and a count underneath.
// Six smudges and a number prove nothing, and the line about not publishing
// contact details drew attention to what was being withheld. Heading, one
// sentence, and the request button.
{
  const r = await page.evaluate(async () => {
    openM('lessonsModal');
    await new Promise(res => setTimeout(res, 200));
    if (typeof renderInstructors === 'function') renderInstructors();
    const list = document.querySelector('.instructors-list');
    const sub = document.getElementById('les-ins-sub');
    const note = document.getElementById('les-ins-note');
    const out = {
      listHtml: (list ? list.innerHTML : 'NO LIST').trim(),
      sub: sub ? sub.textContent.trim() : '',
      noteShown: !!(note && note.textContent.trim().length > 100),
      blurred: [...document.querySelectorAll('.instructors-list *')]
        .filter(e => /blur\(/.test(e.getAttribute('style') || '')).length
    };
    closeM('lessonsModal');
    return out;
  });
  if (r.listHtml !== '') fail('the instructors section shows nothing about the instructors',
    `the list still renders: "${r.listHtml.slice(0, 70)}"`); else ok();
  if (r.blurred) fail('the instructors section shows nothing about the instructors',
    `${r.blurred} blurred rows are still being drawn`); else ok();
  if (/איננו מפרסמים/.test(r.sub) || /ברשימה/.test(r.sub))
    fail('the instructors section shows nothing about the instructors',
      `the subtitle reads "${r.sub}"`); else ok();
  if (!/שלחו בקשה מפורטת/.test(r.sub))
    fail('the instructors section shows nothing about the instructors',
      `the subtitle no longer asks for a request: "${r.sub}"`); else ok();
  if (!r.noteShown) fail('the instructors section shows nothing about the instructors',
    'the instructor-versus-school note is in the content file but never rendered'); else ok();
}

// ── the standing links are reachable without scrolling ───────────────────
// "About", "contact", "help" and the sources register lived at the very
// bottom of a long page. A copy was put under the services, where it read as
// part of the forum underneath it. Both are wrong: they belong in a menu
// that is one tap away wherever the reader happens to be.
{
  const r = await page.evaluate(async () => {
    const out = {};
    const btn = document.getElementById('menu-btn');
    out.inHeader = !!(btn && btn.closest('#sticky-header'));

    openSideMenu();
    const menu = document.getElementById('side-menu');
    // Waiting a fixed 300 ms for a CSS transition is a coin toss on a loaded
    // machine: this check failed about one run in ten, which makes the whole
    // gate untrustworthy. Wait for the drawer to actually arrive instead.
    const onScreen = () => {
      const b = menu.getBoundingClientRect();
      return b.right > 0 && b.left < window.innerWidth && menu.classList.contains('on');
    };
    for (let i = 0; i < 60 && !onScreen(); i++) {
      await new Promise(res => setTimeout(res, 50));
    }
    out.onScreen = onScreen();
    out.items = [...document.querySelectorAll('#side-menu-links button')].filter(b => getComputedStyle(b).display !== 'none').map(b => b.textContent.trim());

    // the drawer has to get out of the way before what it opens appears
    smGo('install');
    // Both things have to happen: the drawer slides away AND the panel it
    // chose opens. Waiting only for the drawer races the panel.
    const help = document.getElementById('helpModal');
    const settled = () => !menu.classList.contains('on') && help.style.display === 'flex';
    for (let i = 0; i < 80 && !settled(); i++) {
      await new Promise(res => setTimeout(res, 50));
    }
    out.closedAfterGo = !menu.classList.contains('on');
    out.helpOpen = help.style.display === 'flex';
    // and it has to land on the install block, not at the top of the panel
    const ins = document.getElementById('help-install');
    out.installFilled = !!(ins && ins.textContent.trim().length > 60);
    closeM('helpModal');

    // and the duplicate row above the forum is gone
    const forum = document.getElementById('forum-section') || document.body;
    out.strayRow = [...document.querySelectorAll('span')]
      .filter(e => e.textContent.trim() === 'מקורות ואמינות').length;
    return out;
  });
  if (!r.inHeader) fail('the standing links are reachable without scrolling',
    'there is no menu button in the header'); else ok();
  if (!r.onScreen) fail('the standing links are reachable without scrolling',
    'the side menu did not slide into view'); else ok();
  // Not an exact count: the menu is where things go when they need a
  // standing door, and pinning it to five made adding one a test failure
  // rather than a decision. What matters is that the four that must be
  // there are there, and that the list stays short enough to read.
  {
    const must = ['עלינו', 'צור קשר', 'עזרה', 'מקורות'];
    const joined = r.items.join(' | ');
    const missing = must.filter(m => joined.indexOf(m) < 0);
    if (missing.length) fail('the standing links are reachable without scrolling',
      `the menu lost ${missing.join(', ')}: ${JSON.stringify(r.items)}`); else ok();
    if (r.items.length < 4 || r.items.length > 8)
      fail('the standing links are reachable without scrolling',
        `the menu holds ${r.items.length} items`); else ok();
  }
  // The install prompt shows once and never again. On a phone the side menu
  // is the only way back to it, so it gets its own line rather than hiding
  // in the middle of the help panel.
  if (!r.items.some(t => /התקנת האפליקציה/.test(t)))
    fail('the standing links are reachable without scrolling',
      'there is no way back to the install prompt'); else ok();
  if (!r.closedAfterGo || !r.helpOpen) fail('the standing links are reachable without scrolling',
    `choosing an item left the drawer open (${!r.closedAfterGo}) or opened nothing (${!r.helpOpen})`); else ok();
  if (!r.installFilled) fail('the standing links are reachable without scrolling',
    'the install panel opened empty'); else ok();
  // one copy on the page - the footer's - not two
  if (r.strayRow !== 1) fail('the standing links are reachable without scrolling',
    `"מקורות ואמינות" appears ${r.strayRow} times on the page, not once`); else ok();
}

// ── the × goes back, not out ─────────────────────────────────────────────
// A panel opened from inside another panel closed to the home page, so
// cancelling "ask about an instructor" threw the reader out of ski lessons
// altogether. The × now returns to wherever the panel was opened from.
{
  const r = await page.evaluate(async () => {
    const shown = (id) => {
      const m = document.getElementById(id);
      return !!(m && m.style.display && m.style.display !== 'none');
    };
    const out = {};
    openM('lessonsModal');
    askForInstructor();
    await new Promise(res => setTimeout(res, 120));
    out.contactOpen = shown('contactModal');
    closeM('contactModal');
    out.backInLessons = shown('lessonsModal');
    closeM('lessonsModal');
    out.allClosed = !shown('lessonsModal') && !shown('contactModal');

    // the same for the car search, which hands over from parking to the planner
    openM('parkingModal');
    openCarSearch();
    await new Promise(res => setTimeout(res, 120));
    out.plannerOpen = shown('hotelModal');
    closeM('hotelModal');
    out.backInParking = shown('parkingModal');
    closeM('parkingModal');

    // and a panel opened on its own must still close to the page
    openM('helpModal');
    closeM('helpModal');
    out.plainClose = !shown('helpModal');
    return out;
  });
  if (!r.contactOpen) fail('the × goes back, not out',
    'the contact form did not open from the lessons panel'); else ok();
  if (!r.backInLessons) fail('the × goes back, not out',
    'closing the contact form left the reader outside the lessons panel'); else ok();
  if (!r.allClosed) fail('the × goes back, not out',
    'the lessons panel would not close afterwards'); else ok();
  if (!r.plannerOpen || !r.backInParking) fail('the × goes back, not out',
    'the car search did not return to the parking panel'); else ok();
  if (!r.plainClose) fail('the × goes back, not out',
    'a panel opened on its own no longer closes'); else ok();
}

// ── zooming the map makes the map bigger ─────────────────────────────────
// It did not. The canvas carried max-width:100%, so every zoom level drew a
// finer bitmap inside a box pinned to the container's width and the picture
// on screen never changed - the wheel, the + button and full screen all
// looked broken in the same way. The real PDF comes from a CDN this test
// cannot reach, so a stand-in page supplies the geometry; what is under test
// is the sizing, not the decoding.
{
  await page.evaluate(() => openM('mapModal'));
  await page.waitForTimeout(250);
  const r = await page.evaluate(async () => {
    const W = 3412, H = 1596;        // the "whole area" sheet, in points
    window._mapCurrentPdf = {
      getPage: () => Promise.resolve({
        getViewport: (o) => ({ width: W * o.scale, height: H * o.scale }),
        render: () => ({ promise: Promise.resolve(), cancel() {} })
      })
    };
    window._mapCurrentPage = 1;
    const wrap = document.getElementById('map-pdf-wrap');
    const canvas = document.getElementById('map-pdf-canvas');
    const settle = () => new Promise(res => setTimeout(res, 150));
    const read = () => ({
      css: Math.round(canvas.getBoundingClientRect().width),
      wrapW: Math.round(wrap.getBoundingClientRect().width),
      scrollW: wrap.scrollWidth
    });
    const out = {};
    window._mapZoomLevel = 1;  _applyMapZoom(); await settle(); out.fit = read();
    window._mapZoomLevel = 3;  _applyMapZoom(); await settle(); out.x3  = read();
    out.ceiling = Math.round(_mapMaxZoom * 100) / 100;
    return out;
  });
  if (r.x3.css < r.fit.css * 2.5) fail('zooming the map makes the map bigger',
    `at 300% the canvas is ${r.x3.css}px wide, at 100% it is ${r.fit.css}px`); else ok();
  // and the part that moved off screen has to be reachable
  if (r.x3.scrollW < r.x3.css - 2) fail('zooming the map makes the map bigger',
    `the map is ${r.x3.css}px wide but only ${r.x3.scrollW}px of it can be scrolled to`); else ok();
  if (r.fit.css > r.fit.wrapW) fail('zooming the map makes the map bigger',
    `at 100% the map overflows its box: ${r.fit.css}px inside ${r.fit.wrapW}px`); else ok();
  // a ceiling that stops at 1.5x would make the lettering unreadable again
  if (!(r.ceiling >= 4)) fail('zooming the map makes the map bigger',
    `the zoom ceiling came out at ${r.ceiling}x`); else ok();

  // One wheel listener, reached by bubbling from whichever viewer is on
  // screen. Hanging it on the children as well would zoom twice per notch;
  // hanging it only on the children left full screen without a wheel.
  const notch = await page.evaluate(async () => {
    window._mapZoomLevel = 1;
    const wrap = document.getElementById('map-pdf-wrap');
    const box = wrap.getBoundingClientRect();
    wrap.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -120, bubbles: true, cancelable: true,
      clientX: box.left + box.width / 2, clientY: box.top + box.height / 2
    }));
    return window._mapZoomLevel;
  });
  if (Math.abs(notch - 1.12) > 0.005) fail('zooming the map makes the map bigger',
    `one notch of the wheel took the zoom to ${notch} instead of 1.12`); else ok();
}

// ── a reading is marked as a reading ─────────────────────────────────────
// The scraper now raises its own alerts: a closed crossing, a gust past 70,
// every lift stopped in the middle of the day. Those rows have no author, and
// the card used to print "👤" beside whatever name they carried, which reads
// as a person standing at the lift saying so. The two deserve different kinds
// of trust in opposite directions, so the card says which it is.
{
  const r = await page.evaluate(() => {
    const sys = _rowToAlert({
      id: 'sys-1', author_id: null, author_name: 'צ׳רוויניה לייב',
      text: 'המעבר לצ׳רמט סגור.', severity: 'danger', kind: 'alert',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 36e5).toISOString()
    });
    const human = _rowToAlert({
      id: 'hum-1', author_id: '11111111-1111-1111-1111-111111111111',
      author_name: 'יוסי', text: 'תור ארוך בפלאן מזון.', severity: 'info',
      kind: 'alert', created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 36e5).toISOString()
    });
    // the badge counter reads authorId; a null author must not break it
    let badgeThrew = '';
    try {
      _alerts = [sys, human];
      updateAlertBadge();
    } catch (e) { badgeThrew = e.message; }
    return {
      sysAuto:   sys.auto === true,
      humanAuto: human.auto === false,
      sysCard:   _alertCardHtml(sys),
      humanCard: _alertCardHtml(human),
      badgeThrew
    };
  });

  const T = 'a reading is marked as a reading';
  if (!r.sysAuto)   fail(T, 'an authorless row was not flagged as automatic'); else ok();
  if (!r.humanAuto) fail(T, "a person's alert was flagged as automatic"); else ok();
  if (!/📡/.test(r.sysCard))
    fail(T, 'the system card shows no instrument mark'); else ok();
  if (/👤/.test(r.sysCard))
    fail(T, 'the system card still shows the person icon'); else ok();
  if (!/הודעה אוטומטית/.test(r.sysCard))
    fail(T, 'the system card does not say it is a measurement'); else ok();
  if (!/👤/.test(r.humanCard))
    fail(T, "a person's card lost its person icon"); else ok();
  if (/הודעה אוטומטית/.test(r.humanCard))
    fail(T, "a person's card is labelled a measurement"); else ok();
  if (r.badgeThrew)
    fail(T, 'the unread badge crashes on an authorless alert: ' + r.badgeThrew); else ok();

  // The mark lived only in the card's grey footer line, which most people
  // never reach: the banner at the top of the page is where an alert is
  // actually met, and many readers never open the panel at all. It has to
  // survive there, and it has to be above the fold inside the card.
  const places = await page.evaluate(() => {
    const now = Date.now();
    const mk = (id, author, name, text) => _rowToAlert({
      id, author_id: author, author_name: name, text,
      severity: 'warning', kind: 'alert',
      created_at: new Date(now - 6e4).toISOString(),
      expires_at: new Date(now + 36e5).toISOString() });
    _alerts = [mk('s1', null, 'צ׳רוויניה לייב', 'רוח חזקה בהר.'),
               mk('s2', '11111111-1111-1111-1111-111111111111', 'דוד', 'תור ארוך בפלאן מזון.')];
    refreshAlertStrip();
    const strip = document.getElementById('alert-strip');
    const out = {
      stripChip: !!strip.querySelector('.auto-chip'),
      stripShown: getComputedStyle(strip).display !== 'none',
      stripHeight: strip.getBoundingClientRect().height
    };
    // The rows that unfold under the banner show everything AFTER the first,
    // so the system alert has to be second for this to test anything at all.
    _alerts = [mk('h1', '11111111-1111-1111-1111-111111111111', 'דוד', 'תור ארוך.'),
               mk('s3', null, 'צ׳רוויניה לייב', 'רוח חזקה בהר.')];
    _alertMoreOpen = true; refreshAlertStrip();
    const more = document.getElementById('alert-more');
    out.moreRows = more ? more.querySelectorAll('.amore-row').length : 0;
    out.moreChip = !!(more && more.querySelector('.auto-chip'));
    _alertMoreOpen = false;
    _alerts = [mk('s1', null, 'צ׳רוויניה לייב', 'רוח חזקה בהר.'),
               mk('s2', '11111111-1111-1111-1111-111111111111', 'דוד', 'תור ארוך בפלאן מזון.')];

    // inside the card: at the top with the severity tag, not in the footer
    const html = _alertCardHtml(_alerts[0]);
    const tagAt  = html.indexOf('הודעה אוטומטית');
    const textAt = html.indexOf('רוח חזקה בהר');
    out.chipBeforeText = tagAt >= 0 && textAt >= 0 && tagAt < textAt;
    out.humanCardClean = _alertCardHtml(_alerts[1]).indexOf('הודעה אוטומטית') < 0;
    _alerts = [];
    refreshAlertStrip();
    return out;
  });

  if (!places.stripShown || places.stripHeight < 10)
    fail(T, 'the banner did not render, so the check saw nothing'); else ok();
  if (!places.stripChip) fail(T,
    'the banner gives no sign that the alert is a measurement'); else ok();
  if (places.moreRows !== 1) fail(T,
    `the unfolded rows did not render (${places.moreRows}), so the check saw nothing`); else ok();
  if (!places.moreChip) fail(T,
    'the rows unfolded under the banner lose the mark'); else ok();
  if (!places.chipBeforeText) fail(T,
    'the mark sits below the text, where it is only found by scrolling'); else ok();
  if (!places.humanCardClean) fail(T,
    "a person's report is labelled a measurement"); else ok();
}

// ── the local reader knows a head count ──────────────────────────────
// It is the fallback when the model call fails, and it understood "2 מבוגרים"
// and "משפחה" but not the commonest way anyone writes it: "4 נוסעים".
{
  const r = await page.evaluate(() => {
    const P = t => { const o = window.parseTripText(t); return [o.adults, o.children]; };
    return {
      digits:   P('מילאנו בחנוכה לשבוע, 4 נוסעים'),
      word:     P('מילאנו בחנוכה לשבוע, לארבעה אנשים'),
      one:      P('מילאנו בחנוכה, נוסע אחד'),
      total:    P('מילאנו בחנוכה, 5 נוסעים מהם 2 ילדים'),
      explicit: P('מילאנו בחנוכה, 2 מבוגרים ו-2 ילדים'),
      none:     P('מילאנו בחנוכה לשבוע')
    };
  });
  const T = 'the local reader knows a head count';
  const eq = (a, b) => a[0] === b[0] && a[1] === b[1];
  if (r.digits[0] !== 4) fail(T, `"4 נוסעים" read as ${r.digits[0]} passengers`); else ok();
  if (r.word[0] !== 4)   fail(T, `"לארבעה אנשים" read as ${r.word[0]} passengers`); else ok();
  if (r.one[0] !== 1) fail(T, `"נוסע אחד" read as ${r.one[0]} passengers`); else ok();
  if (r.total[0] !== 3 || r.total[1] !== 2) fail(T,
    `"5 נוסעים מהם 2 ילדים" read as ${r.total} - should be 3 adults and 2 children`); else ok();
  if (!eq(r.explicit, [2, 2])) fail(T,
    `an explicit 2 adults + 2 children read as ${r.explicit}`); else ok();
  if (r.none[0] != null) fail(T,
    `a sentence with no head count invented ${r.none[0]} adults`); else ok();
}

// ── the trip is said once; what a hand changed is never overwritten ──
// Stage 2 of the planner redesign. The strip holds dates and travellers;
// every search in the trip frame is born from it and free from then on.
// "A hand" is simulated the way flatpickr sees one: the calendar was opened.
// That needs the real calendar, which the page loads from a CDN this run
// cannot reach - so this block loads the same version from node_modules
// (selfcheck.yml installs it next to playwright) and builds the pickers.
{
  const fpPath = near('node_modules/flatpickr/dist/flatpickr.min.js');
  if (!fs.existsSync(fpPath)) {
    fail('the trip is said once; what a hand changed is never overwritten',
      'flatpickr is not installed - run: npm install --no-save flatpickr@4.6.13');
  } else {
  await page.addScriptTag({ path: fpPath });
  await page.evaluate(() => { initFlatpickr(); });
  const r = await page.evaluate(async () => {
    const out = {};
    const D = (y, m, d) => new Date(y, m - 1, d);
    const $ = id => document.getElementById(id);
    const ci = id => $(id).getAttribute('data-ci');
    const shown = id => { const m = $(id + '-diff'); return !!m && m.style.display !== 'none'; };
    const byHand = (id, a, b) => {
      const el = $(id); el._picking = true;
      el._flatpickr.setDate([a, b], true);
      el._picking = false;
    };
    openM('hotelModal');
    planGo('trip');
    // a clean trip
    TRIP.from = TRIP.to = null; TRIP.adults = 2; TRIP.children = 0;
    TRIP_DATE_IDS.concat(Object.keys(TRIP_PAX)).forEach(id => $(id).removeAttribute('data-touched'));

    out.stripShown = getComputedStyle($('trip-strip')).display !== 'none';

    stripSetDates(D(2027, 1, 10), D(2027, 1, 17));
    out.born = TRIP_DATE_IDS.map(id => [id, ci(id)]);
    out.nights = $('strip-nights').textContent;

    byHand('hotel-dates', D(2027, 1, 12), D(2027, 1, 16));
    stripSetDates(D(2027, 1, 20), D(2027, 1, 27));
    out.hotelKept = ci('hotel-dates');
    out.carFollowed = ci('car-dates');
    out.hotelMarked = shown('hotel-dates');
    out.carMarked = shown('car-dates');
    out.markText = ($('hotel-dates-diff') || {}).textContent || '';
    _tripRejoin('hotel-dates');
    out.hotelBack = ci('hotel-dates');
    out.hotelUnmarked = !shown('hotel-dates');
    // back means back: it follows the trip again from now on
    stripSetDates(D(2027, 1, 21), D(2027, 1, 27));
    out.hotelFollowsAgain = ci('hotel-dates');
    stripSetDates(D(2027, 1, 20), D(2027, 1, 27));

    adjStrip('adults', 1);
    out.paxBorn = [$('h-adults').textContent, $('fl-adults').textContent];
    adjField('h-children', 1, 0);
    adjStrip('children', 2);
    out.paxKept = $('h-children').textContent;
    out.flightPax = $('fl-adults').textContent;
    out.paxMarked = shown('h-children');

    // a hand on the flight: no force, an offer
    byHand('trip-dates', D(2027, 2, 1), D(2027, 2, 8));
    out.tripAfterFlightHand = _isoDay(TRIP.from);
    out.flightOffer = /עדכן את הטיול לפי הטיסה/.test(($('trip-dates-diff') || {}).textContent || '');
    _tripAdoptFlight();
    out.tripAfterAdopt = _isoDay(TRIP.from);
    out.carAfterAdopt = ci('car-dates');
    out.flightUnmarked = !shown('trip-dates');

    // a program on the flight (an offer, a sentence) sets the trip
    setTripDates('2027-03-07', '2027-03-14');
    out.tripAfterProgram = _isoDay(TRIP.from);
    out.flightUntouched = !$('trip-dates').getAttribute('data-touched');

    // a stage passed, and the way on from the foot of its results
    ['all', 'flight', 'hotel', 'car'].forEach(t => $('ttab-' + t).classList.remove('ttab-done'));
    switchTripTab('car');
    out.nextBefore = getComputedStyle($('trip-next')).display !== 'none';
    searchCar();
    out.carDone = $('ttab-car').classList.contains('ttab-done');
    out.nextAfterCar = $('trip-next').textContent;
    $('ttab-flight').classList.add('ttab-done');
    switchTripTab('car');
    out.nextSkipsDone = $('trip-next').textContent;
    $('trip-next').querySelector('button').click();
    out.wentTo = _tripTab();
    ['flight', 'hotel', 'car'].forEach(t => $('ttab-' + t).classList.add('ttab-done'));
    switchTripTab('car');
    out.nextWhenAllDone = getComputedStyle($('trip-next')).display !== 'none';

    // a search alone: no strip, no marks, no bounds, no stage marks
    byHand('car-dates', D(2027, 3, 1), D(2027, 3, 3));
    planGo('car');
    out.soloStrip = getComputedStyle($('trip-steps')).display !== 'none';
    out.soloMarked = shown('car-dates');
    out.soloMax = $('car-dates')._flatpickr.config.maxDate || null;
    $('ttab-hotel').classList.remove('ttab-done');
    planGo('hotel'); searchHotel();
    out.soloDone = $('ttab-hotel').classList.contains('ttab-done');
    out.soloNext = getComputedStyle($('trip-next')).display !== 'none';

    // up from a search alone: what was typed goes on
    TRIP.from = TRIP.to = null;
    TRIP_DATE_IDS.forEach(id => $(id).removeAttribute('data-touched'));
    byHand('hotel-dates', D(2027, 2, 3), D(2027, 2, 8));
    planGo('trip');
    out.carriedUp = TRIP.from ? _isoDay(TRIP.from) : null;
    out.carriedCar = ci('car-dates');
    closeM('hotelModal');
    return out;
  });

  const T = 'the trip is said once; what a hand changed is never overwritten';
  if (!r.stripShown) fail(T, 'the trip frame shows no strip'); else ok();
  const notBorn = r.born.filter(([, v]) => v !== '2027-01-10').map(([id]) => id);
  if (notBorn.length) fail(T, `not born from the strip: ${notBorn.join(', ')}`); else ok();
  if (!/7 לילות/.test(r.nights)) fail(T, `the strip counts "${r.nights}", not 7 nights`); else ok();
  if (r.hotelKept !== '2027-01-12') fail(T,
    `lodging changed by hand was overwritten by the strip (now ${r.hotelKept})`); else ok();
  if (r.carFollowed !== '2027-01-20') fail(T,
    `the untouched car did not follow the strip (still ${r.carFollowed})`); else ok();
  if (!r.hotelMarked || !/תאריכים שונים מהטיול/.test(r.markText)) fail(T,
    'lodging differs from the trip and says nothing'); else ok();
  if (r.carMarked) fail(T, 'a search that matches the trip is marked as different'); else ok();
  if (r.hotelBack !== '2027-01-20' || !r.hotelUnmarked) fail(T,
    '"חזרה לתאריכי הטיול" did not bring lodging back'); else ok();
  if (r.hotelFollowsAgain !== '2027-01-21') fail(T,
    'after "חזרה לתאריכי הטיול" lodging no longer follows the trip'); else ok();
  if (r.paxBorn[0] !== '3' || r.paxBorn[1] !== '3') fail(T,
    `travellers not born from the strip: lodging ${r.paxBorn[0]}, flight ${r.paxBorn[1]}`); else ok();
  if (r.paxKept !== '1' || !r.paxMarked) fail(T,
    `children changed by hand: now ${r.paxKept}, marked ${r.paxMarked}`); else ok();
  if (r.flightPax !== '5') fail(T, `3 adults + 2 children flew as ${r.flightPax}`); else ok();
  if (r.tripAfterFlightHand !== '2027-01-20' || !r.flightOffer) fail(T,
    'a flight picked by hand moved the trip by force, or offered nothing'); else ok();
  if (r.tripAfterAdopt !== '2027-02-01' || r.carAfterAdopt !== '2027-02-01' || !r.flightUnmarked) fail(T,
    'taking the flight\'s dates did not move the trip and what follows it'); else ok();
  if (r.tripAfterProgram !== '2027-03-07' || !r.flightUntouched) fail(T,
    'an offer or a sentence writing the flight dates did not set the trip'); else ok();
  if (!r.carDone) fail(T, 'a search that ran left no mark on its stage'); else ok();
  if (r.nextBefore) fail(T, '"השלב הבא" shows before the stage was searched'); else ok();
  if (!/השלב הבא: ✈️ טיסה/.test(r.nextAfterCar)) fail(T,
    `after the car the next stage offered is "${r.nextAfterCar}", not the flight`); else ok();
  if (!/השלב הבא: 🏨 לינה/.test(r.nextSkipsDone) || r.wentTo !== 'hotel') fail(T,
    `"השלב הבא" does not skip a stage already done, or does not go there (${r.nextSkipsDone} → ${r.wentTo})`); else ok();
  if (r.nextWhenAllDone) fail(T, '"השלב הבא" still offered when every stage is done'); else ok();
  if (r.soloNext) fail(T, 'a search alone offers a next stage of a trip nobody planned'); else ok();
  if (r.soloStrip || r.soloMarked) fail(T, 'a search alone shows the trip or its marks'); else ok();
  if (r.soloMax) fail(T, 'a search alone is still bounded by trip dates'); else ok();
  if (r.soloDone) fail(T, 'a search alone marks a stage of a trip nobody planned'); else ok();
  if (r.carriedUp !== '2027-02-03' || r.carriedCar !== '2027-02-03') fail(T,
    `dates typed in a search alone did not carry up into the trip (${r.carriedUp})`); else ok();
  }
}

// ── lodging is a list of stays ───────────────────────────────────────
// Stage 3. Four nights in Cervinia and two in Milan are two stays, each
// with its own nights, place and way of being found; the letter works on a
// stay, not on the trip; and the list says when a night is missing.
{
  const fpPath3 = near('node_modules/flatpickr/dist/flatpickr.min.js');
  if (!fs.existsSync(fpPath3)) {
    fail('lodging is a list of stays',
      'flatpickr is not installed - run: npm install --no-save flatpickr@4.6.13');
  } else {
  const r = await page.evaluate(async () => {
    if (typeof flatpickr === 'undefined') return { noFp: true };
    const out = {};
    const D = (y, m, d) => new Date(y, m - 1, d);
    const $ = id => document.getElementById(id);
    const vis = id => !!$(id) && getComputedStyle($(id)).display !== 'none';
    const cov = () => ($('stay-coverage') || {}).textContent || '';
    const byHand = (id, a, b) => {
      const el = $(id); el._picking = true;
      el._flatpickr.setDate([a, b], true);
      el._picking = false;
    };
    initFlatpickr();
    openM('hotelModal');
    planGo('trip');
    TRIP.from = TRIP.to = null; TRIP.adults = 2; TRIP.children = 1;
    TRIP.stays = []; TRIP.stayAt = 0;
    TRIP_DATE_IDS.concat(Object.keys(TRIP_PAX)).forEach(id => $(id).removeAttribute('data-touched'));
    stripSetDates(D(2027, 1, 10), D(2027, 1, 17));
    _tripSetPax(2, 1);
    switchTripTab('hotel');

    out.listShown = vis('stay-list');
    out.first = JSON.stringify(TRIP.stays.map(s => [s.ci, s.co]));
    stripSetDates(D(2027, 1, 11), D(2027, 1, 18));
    out.firstFollows = TRIP.stays[0] && TRIP.stays[0].ci;
    stripSetDates(D(2027, 1, 10), D(2027, 1, 17));

    byHand('hotel-dates', D(2027, 1, 10), D(2027, 1, 14));
    out.firstByHand = TRIP.stays[0].co + '/' + TRIP.stays[0].touched;
    out.covHole = cov();

    _stayAdd();
    out.added = TRIP.stays[1] ? TRIP.stays[1].ci + '/' + TRIP.stays[1].co : null;
    out.addedActive = TRIP.stayAt;
    out.fieldShowsNew = $('hotel-dates').getAttribute('data-ci');
    out.covFull = cov();

    byHand('hotel-dates', D(2027, 1, 14), D(2027, 1, 16));
    out.covMissing = cov();

    $('stay-place').value = 'milano'; _stayEdit();
    searchHotel();
    const links = [...$('hotel-results').querySelectorAll('a')].map(a => a.href);
    out.milanLinks = {
      booking: links.some(h => /booking\.com.*ss=Milano/.test(h)),
      airbnb: links.length === 0 || true,
      notCervinia: !links.some(h => /Breuil-Cervinia/.test(h)),
      header: /שהייה 2/.test($('hotel-results').textContent)
    };
    document.querySelector('input[name="stay-way"][value="direct"]').checked = true;
    _stayEdit();
    out.milanDirectRefused = TRIP.stays[1].way;

    // stay 1: by letter
    _stayPick(0);
    out.pickedField = $('hotel-dates').getAttribute('data-ci') + '/' + $('hotel-dates').getAttribute('data-co');
    out.pickedPlace = $('stay-place').value;
    document.querySelector('input[name="stay-way"][value="direct"]').checked = true;
    _stayEdit();
    out.letterBtn = vis('stay-letter-btn');
    out.searchBtn = vis('hotel-search-btn');
    $('stay-letter-btn').click();
    await new Promise(res => setTimeout(res, 50));
    const ld = $('ls-dates');
    out.letter = {
      open: getComputedStyle($('localStayModal')).display !== 'none',
      dates: ld.getAttribute('data-ci') + '/' + ld.getAttribute('data-co'),
      guests: $('ls-guests').value
    };
    closeM('localStayModal');

    // the strip moves; stays a hand set do not
    stripSetDates(D(2027, 1, 11), D(2027, 1, 18));
    out.handStaysKept = TRIP.stays.map(s => s.ci).join(',');
    stripSetDates(D(2027, 1, 10), D(2027, 1, 17));

    // two stays on one night
    _stayPick(1);
    byHand('hotel-dates', D(2027, 1, 13), D(2027, 1, 17));
    out.covDouble = cov();

    _stayDrop(1);
    out.afterDrop = TRIP.stays.length + '/' + TRIP.stayAt + '/' + $('hotel-dates').getAttribute('data-ci');

    // a search alone is one stay, in Cervinia, found on the sites
    TRIP.stays[0].place = 'milano';
    TRIP.stays[0].way = 'direct';
    planGo('hotel');
    out.solo = {
      list: vis('stay-list'), edit: vis('stay-edit'),
      search: vis('hotel-search-btn'), letter: vis('stay-letter-btn')
    };
    searchHotel();
    out.soloCervinia = [...$('hotel-results').querySelectorAll('a')]
      .some(a => /booking\.com.*ss=Breuil-Cervinia/.test(a.href));
    TRIP.stays[0].place = 'cervinia'; TRIP.stays[0].way = 'site';
    closeM('hotelModal');
    return out;
  });

  const T = 'lodging is a list of stays';
  if (r.noFp) { fail(T, 'flatpickr did not load'); }
  else {
  if (!r.listShown) fail(T, 'the trip\'s lodging screen shows no list of stays'); else ok();
  if (r.first !== '[["2027-01-10","2027-01-17"]]') fail(T,
    `the first stay was not born from the trip: ${r.first}`); else ok();
  if (r.firstFollows !== '2027-01-11') fail(T,
    'the first stay, untouched, did not follow the strip'); else ok();
  if (r.firstByHand !== '2027-01-14/true') fail(T,
    `the lodging field moved by hand did not move its stay (${r.firstByHand})`); else ok();
  if (!/חסרים 3 לילות/.test(r.covHole)) fail(T,
    `a stay of 4 nights in a 7-night trip does not say 3 are missing: "${r.covHole}"`); else ok();
  if (r.added !== '2027-01-14/2027-01-17' || r.addedActive !== 1 || r.fieldShowsNew !== '2027-01-14') fail(T,
    `"הוסף שהייה" did not open on the first uncovered nights (${r.added}, active ${r.addedActive})`); else ok();
  if (!/כל 7 הלילות מכוסים/.test(r.covFull)) fail(T,
    `two stays covering the trip do not say so: "${r.covFull}"`); else ok();
  if (!/חסר לילה אחד: 16\.1/.test(r.covMissing)) fail(T,
    `one night left uncovered is not named: "${r.covMissing}"`); else ok();
  if (!r.milanLinks.booking || !r.milanLinks.notCervinia) fail(T,
    'a stay in Milan still searches Breuil-Cervinia'); else ok();
  if (!r.milanLinks.header) fail(T, 'the results do not say which stay they are for'); else ok();
  if (r.milanDirectRefused !== 'site') fail(T,
    'a stay in Milan took "פנייה ישירה" - the letter is for agencies in the valley'); else ok();
  if (r.pickedField !== '2027-01-10/2027-01-14' || r.pickedPlace !== 'cervinia') fail(T,
    `picking stay 1 did not bring its own dates and place back (${r.pickedField}, ${r.pickedPlace})`); else ok();
  if (!r.letterBtn || r.searchBtn) fail(T,
    'a stay found by letter still shows a search, or no letter'); else ok();
  if (!r.letter.open || r.letter.dates !== '2027-01-10/2027-01-14' || r.letter.guests !== '3') fail(T,
    `the letter is not for this stay: ${JSON.stringify(r.letter)}`); else ok();
  if (r.handStaysKept !== '2027-01-10,2027-01-14') fail(T,
    `stays set by hand moved with the strip (${r.handStaysKept})`); else ok();
  if (!/לילה אחד מכוסה פעמיים: 13\.1/.test(r.covDouble)) fail(T,
    `a night booked twice is not named: "${r.covDouble}"`); else ok();
  if (r.afterDrop !== '1/0/2027-01-10') fail(T,
    `removing stay 2 left the wrong stay on screen (${r.afterDrop})`); else ok();
  if (r.solo.list || r.solo.edit || !r.solo.search || r.solo.letter) fail(T,
    `a search alone shows the trip's stays (${JSON.stringify(r.solo)})`); else ok();
  if (!r.soloCervinia) fail(T,
    'a search alone took its place from a stay in the trip'); else ok();
  }
  }
}

// ── how much it really costs ─────────────────────────────────────────
// Stage 4. Exact where we know (the ski pass, from the operator's tariff),
// a range where we guess (gear, flights, lodging), empty where we have
// nothing (food) - and every row the reader's to change. Two doors, one
// panel: the side menu asks; the trip strip reads the trip.
{
  const r = await page.evaluate(async () => {
    const out = {};
    const $ = id => document.getElementById(id);
    const T = window._texts;
    const P = T.skipass.prices, cols = P.columns;
    const price = (pass, band, days) => {
      const row = P[pass].rows.find(x => { const m = String(x[0]).match(/(\d+)\s*ימים/); return (m ? +m[1] : (/יום אחד/.test(x[0]) ? 1 : 0)) === days; });
      return parseFloat(row[cols.indexOf(band) + 1]);
    };
    const rent = T.rental.price_rows;
    const rv = re => rent.find(x => re.test(x.label + ' ' + x.note)).v.map(v => parseFloat(v.replace(/[^\d.]/g, '')));
    out.expect = {
      adult6: 2 * price('cervinia', 'Adult', 6),
      zermatt6: 2 * price('zermatt', 'Adult', 6),
      gearLo: 2 * rv(/מבוגר.*Superior/)[2],
      gearHi: 2 * (rv(/מתקדם.*Top/)[2] + rv(/קסדה/)[2])
    };
    // no network here: a rate and a snapshot of our own
    COST.fx = { ILS: 4, USD: 1.25, CHF: 1 }; COST.fxTried = true;
    // a trip on file and a snapshot that prices it - the side-menu door must
    // still not use them: it was not asked about that trip
    window._flTried = true;
    TRIP.from = new Date(2027, 0, 10); TRIP.to = new Date(2027, 0, 17);
    window._FLIGHTS = { currency: 'USD', nights: [7], cal: { MXP: { '7': { '2027-01-10': 200 } } } };
    COST.rows = {}; COST.bands = null; COST.bandsTouched = false; COST.pass = 'cervinia'; COST.skiDays = null;

    // ── door 1: the side menu ──
    out.inMenu = !![...document.querySelectorAll('#side-menu-links button')].find(b => /תכל'ס, כמה יעלה לנו/.test(b.textContent));
    // Yossi's order (11.11): why, cost, install, notifications, sources, help, contact, about
    // the language switch stays hidden in Hebrew until the English is ready
    const order = [...document.querySelectorAll('#side-menu-links button')].map(b => (b.getAttribute('onclick') || '').replace(/.*smGo\('([a-z]+)'\).*/, '$1')).join(',');
    out.menuOrder = order === 'why,cost,install,push,sources,help,contact,about' ? 'ok' : order;
    out.pushLabel = /התראות — הפעלה וביטול/.test(document.getElementById('sm-push').textContent);
    SIDE_MENU_ACTIONS.cost();
    await new Promise(res => setTimeout(res, 60));
    out.freeOpen = getComputedStyle($('costModal')).display !== 'none';
    out.freeAsks = !!$('cost-nights');
    out.freeDays = COST.skiDays;
    out.skipass = [COST.rows.skipass.min, COST.rows.skipass.max, COST.rows.skipass.exact];
    out.gear = [COST.rows.gear.min, COST.rows.gear.max];
    // the panel itself: short fields for short numbers, one choice wraps as one,
    // adults and children first and the rest behind a box each
    const sd = $('cost-skidays');
    out.skiWidth = sd ? sd.getBoundingClientRect().width : 999;
    const pr = [...document.querySelectorAll('input[name="cost-pass"]')].map(i => i.closest('label').getBoundingClientRect().top);
    out.passTogether = pr.length === 2 && Math.abs(pr[0] - pr[1]) < 4;
    // one flex item: the two passes cannot be split between two lines of the row
    out.passNoWrap = $('cost-pass-group').parentElement === $('cost-skidays').closest('div')
      && $('cost-pass-group').querySelectorAll('input[name="cost-pass"]').length === 2;
    const shownBands = () => [...document.querySelectorAll('#cost-inputs .cost-band')].map(e => e.dataset.band);
    out.bandsAtFirst = shownBands().join(',');
    const box = document.querySelector('.cost-band-box[data-band="Senior"]');
    box.checked = true; box.dispatchEvent(new Event('change'));
    out.bandsAfterTick = shownBands().join(',');
    _costBand('Senior', 1);
    out.seniorCounted = /גמלאים/.test(COST.rows.skipass.note);
    const box2 = document.querySelector('.cost-band-box[data-band="Senior"]');
    box2.checked = false; box2.dispatchEvent(new Event('change'));
    out.untickRemoves = (COST.bands.Senior || 0) === 0 && !shownBands().includes('Senior');
    out.noEnglishBands = !/Adult|Junior/.test(COST.rows.skipass.note);
    out.gearCheaper = /זולות יותר/.test(COST.rows.gear.note) && /הנחה/.test(COST.rows.gear.note);
    out.freeFlights = COST.rows.flights.min;
    const ref = T.cost_ref;
    out.ref = ref;
    out.food = [COST.rows.food.min, COST.rows.food.max, /הערכה לפי ממוצעים/.test(COST.rows.food.note)];
    out.freeLodging = [COST.rows.lodging.min, COST.rows.lodging.max];
    out.freeCar = [COST.rows.car.min, COST.rows.car.max, /הערכה לפי ממוצעים/.test(COST.rows.car.note)];
    // a car is one way of three: the transfer and the bus come from the transport card's data
    const PL = T.transport.planner, MX = PL.airports.find(a => a.id === 'mxp');
    out.waysShown = document.querySelectorAll('input[name="cost-transport"]').length;
    _costTransport('transfer');
    out.transfer2 = [COST.rows.car.min, MX.t_small * 2, /הלוך וחזור/.test(COST.rows.car.note)];
    _costBand('Junior', 1);
    out.transfer3 = [COST.rows.car.min, MX.t_big * 2];
    _costBand('Junior', -1);
    _costTransport('bus');
    out.bus2 = [COST.rows.car.min, (PL.lines.mxp.price + PL.lines.blu.price) * 2 * 2, /שלישי וברביעי/.test(COST.rows.car.note)];
    out.busLabel = /הגעה ותחבורה/.test($('cost-row-car').textContent);
    _costTransport('car');
    out.estimateSaid = /הערכה, לא מחיר סופי/.test($('costModal').textContent);
    // Yossi's review, 10.11
    out.freeFlightsNote = /תכנון טיול שלם/.test(COST.rows.flights.note);
    out.miscNote = /שיעורי סקי/.test(COST.rows.misc.note) && !/העברות/.test(COST.rows.misc.note);
    out.babyLabel = /פעוטות וילדים עד 8/.test($('cost-inputs').textContent) && /חינם בסקי פס/.test($('cost-inputs').textContent);
    out.placeholderRtl = $('cost-misc-min').getAttribute('dir') === 'rtl' && $('cost-misc-min').placeholder === 'מ-';
    const totRect = $('cost-total').getBoundingClientRect();
    out.totalOnScreen = totRect.height > 0 && totRect.bottom <= window.innerHeight + 1 && totRect.top < window.innerHeight;
    out.totalMid = ($('cost-total-mid') || {}).textContent || '';
    out.totalRange = ($('cost-total-eur') || {}).textContent || '';
    // one currency for every field: shown in dollars, typed in dollars, kept in euros
    $('cost-cur').value = 'USD'; $('cost-cur').dispatchEvent(new Event('change'));
    out.usdShown = [$('cost-skipass-min').value, Math.round(COST.rows.skipass.min * 1.25)];
    out.usdSym = [...document.querySelectorAll('.cost-sym')].every(e => e.textContent === '$');
    out.usdTotal = /\$/.test(($('cost-total-mid') || {}).textContent) && /₪/.test(($('cost-total-ils') || {}).textContent);
    const mi = $('cost-misc-min'); mi.value = '125'; mi.dispatchEvent(new Event('input'));
    out.usdTypedKeptEur = COST.rows.misc.min;
    _costReset('misc');
    $('cost-cur').value = 'ILS'; $('cost-cur').dispatchEvent(new Event('change'));
    out.ilsOther = /€/.test(($('cost-total-ils') || {}).textContent);
    $('cost-cur').value = 'EUR'; $('cost-cur').dispatchEvent(new Event('change'));

    _costPass('zermatt');
    out.zermatt = COST.rows.skipass.min;
    _costPass('cervinia');
    _costBand('Baby', 1);
    out.babyFree = COST.rows.skipass.min === out.expect.adult6 && /עד גיל 8 חינם/.test(COST.rows.skipass.note);
    _costBand('Baby', -1);
    _costSet('skiDays', 9);
    out.over8 = [COST.rows.skipass.min, /מעל 8 ימים/.test(COST.rows.skipass.note)];
    _costSet('skiDays', 6);

    // a row typed into is the reader's
    _costEdit('food', 'min', '300'); _costEdit('food', 'max', '500');
    _costEdit('skipass', 'min', '600'); _costEdit('skipass', 'max', '600');
    _costSet('skiDays', 5);
    out.handKept = [COST.rows.food.min, COST.rows.skipass.min];
    out.total = $('cost-total').innerText;
    _costReset('skipass');
    out.resetBack = COST.rows.skipass.exact && COST.rows.skipass.min === 2 * price('cervinia', 'Adult', 5);
    _costReset('food');
    out.foodBack = COST.rows.food.min;

    // save or splurge: priced against this trip, and applied by the button
    COST.skiDays = 6; COST.pass = 'cervinia'; COST.transport = 'car'; COST.rows = {};
    _costRecalc(); _costRender();
    const ideasBtn = [...$('cost-total').querySelectorAll('button')].find(b => /לחסוך\? או להתפנק/.test(b.textContent));
    ideasBtn && ideasBtn.click();
    out.ideasOpen = $('cost-ideas').open;
    const ideaText = () => $('cost-ideas-body').textContent;
    const p6 = 2 * price('cervinia', 'Adult', 6), p5 = 2 * price('cervinia', 'Adult', 5);
    out.dayLess = new RegExp('יום סקי אחד פחות.*חוסך כ-€' + Math.round(p6 - p5)).test(ideaText());
    // lodging is the big saving and comes first; bringing gear from home is gone
    const firstSave = $('cost-ideas-body').querySelector('.cost-idea[data-kind="save"]');
    out.valtIdea = !!firstSave && /החיסכון הגדול ביותר — הלינה/.test(firstSave.textContent)
      && /Cielo Alto/.test(firstSave.textContent) && /ולטורננש/.test(firstSave.textContent)
      && !!firstSave.querySelector('a[onclick*="lodgingModal"]');
    out.noOwnGear = !/מביאים ציוד מהארץ/.test(ideaText()) && !/Genzianella/.test(ideaText()) && /חפשו חנות השכרה זולה/.test(ideaText());
    // half a day is always said: for 6 days the extra day costs less than a half-day ticket
    const SP = window._texts.skipass.prices;
    const half2 = 2 * parseFloat(SP.cervinia.rows.find(r => /חצי יום/.test(r[0]))[1 + SP.columns.indexOf('Adult')]);
    out.halfIdea = /חצי יום/.test(ideaText()) && ideaText().includes('€' + Math.round(half2));
    out.fancyNew = /ספא/.test(ideaText()) && /שדרוג הרכב/.test(ideaText());
    const apply = what => { const b = [...$('cost-ideas-body').querySelectorAll('button')].find(x => (x.getAttribute('onclick') || '').includes("'" + what + "'")); b && b.click(); return !!b; };
    out.applyDay = apply('day-less') && COST.skiDays === 5;
    out.applyBus = apply('bus') && COST.transport === 'bus' && /אוטובוס/.test(COST.rows.car.note);
    out.applyZermatt = apply('pass-zermatt') && COST.pass === 'zermatt';
    out.thenCervinia = /פס צ'רוויניה במקום הבינלאומי/.test(ideaText());
    COST.pass = 'cervinia'; COST.transport = 'car'; COST.skiDays = 6; COST.rows = {}; _costRecalc(); _costRender();
    out.foodBackExpect = 2 * 7 * ref.food_person_day[0];
    closeM('costModal');

    // ── the car tab knows the car is optional ──
    openM('hotelModal'); planGo('car');
    out.carAlt = !!$('car-alt') && getComputedStyle($('car-alt')).display !== 'none';
    $('car-alt').click();
    await new Promise(res => setTimeout(res, 120));
    out.altOpens = getComputedStyle($('parkingModal')).display !== 'none'
      && getComputedStyle($('hotelModal')).display === 'none';
    const tb = $('park-tab-transport');
    out.altTab = !!tb && /active|on|sel/.test(tb.className + ' ' + (tb.getAttribute('aria-selected') || ''));
    closeM('parkingModal');
    out.altBack = getComputedStyle($('hotelModal')).display !== 'none';
    closeM('hotelModal');

    // ── door 2: the trip ──
    openM('hotelModal'); planGo('trip');
    TRIP.stays = []; TRIP.stayAt = 0;
    TRIP_DATE_IDS.concat(Object.keys(TRIP_PAX)).forEach(id => $(id).removeAttribute('data-touched'));
    stripSetDates(new Date(2027, 0, 10), new Date(2027, 0, 17));
    _tripSetPax(2, 1);
    switchTripTab('hotel');
    TRIP.stays = [{ ci: '2027-01-10', co: '2027-01-14', place: 'cervinia', way: 'site', touched: true },
                  { ci: '2027-01-14', co: '2027-01-16', place: 'milano', way: 'site', touched: true }];
    const hb = document.querySelector('#tpanel-hotel .stay-filters');
    hb.querySelector('.sf-min').value = '100'; hb.querySelector('.sf-max').value = '150';
    hb.querySelector('.sf-cur').value = 'EUR';
    window._FLIGHTS = { currency: 'USD', nights: [7], cal: { MXP: { '7': {
      '2027-01-08': 260, '2027-01-10': 200, '2027-01-12': 225 } } } };
    // as on a fresh page: the panel has never been drawn, and the door is the trip
    $('cost-rows').innerHTML = ''; COST.mode = 'free';
    $('strip-cost').click();
    await new Promise(res => setTimeout(res, 60));
    out.tripMode = COST.mode;
    out.tripNights = COST.nights;
    out.tripAsksNot = !$('cost-nights');
    out.tripBands = [COST.bands.Adult, COST.bands.Junior];
    out.lodging = [COST.rows.lodging.min, COST.rows.lodging.max];
    // no budget typed: the reference, by where each stay is
    hb.querySelector('.sf-min').value = ''; hb.querySelector('.sf-max').value = '';
    _costReset('lodging');
    out.lodgingRef = [COST.rows.lodging.min, COST.rows.lodging.max, /הערכה לפי ממוצעים/.test(COST.rows.lodging.note)];
    out.lodgingRefExpect = [4 * ref.lodging_valley[0] + 2 * ref.lodging_city[0], 4 * ref.lodging_valley[1] + 2 * ref.lodging_city[1]];
    out.tripCar = [COST.rows.car.min, 7 * ref.car_day[0]];
    out.flights = [COST.rows.flights.min, COST.rows.flights.max];
    out.coverage = ($('cost-coverage').textContent || '');
    out.ils = $('cost-total-ils') ? $('cost-total-ils').textContent : '';
    window._FLIGHTS = { currency: 'USD', nights: [3, 4], cal: { MXP: {} } };
    _costReset('flights');
    out.noSnapshot = [COST.rows.flights.min, /אין מחיר יומי/.test(COST.rows.flights.note)];
    closeM('costModal'); closeM('hotelModal');
    hb.querySelector('.sf-min').value = ''; hb.querySelector('.sf-max').value = '';
    TRIP.stays = []; window._FLIGHTS = null;
    return out;
  });

  const T = 'how much it really costs';
  const near1 = (a, b) => a != null && Math.abs(a - b) < 0.6;
  if (!r.inMenu) fail(T, 'the side menu has no way to the calculator'); else ok();
  if (r.menuOrder !== 'ok' || !r.pushLabel) fail(T, `the side menu is not in Yossi's order: ${r.menuOrder} (push label ${r.pushLabel})`); else ok();
  if (!r.freeOpen || !r.freeAsks) fail(T, 'the side-menu door does not open a panel that asks for nights'); else ok();
  if (r.freeDays !== 6) fail(T, `7 nights default to ${r.freeDays} ski days, not 6`); else ok();
  if (!near1(r.skipass[0], r.expect.adult6) || r.skipass[0] !== r.skipass[1] || !r.skipass[2]) fail(T,
    `the ski pass is not the tariff's exact price: ${r.skipass} vs ${r.expect.adult6}`); else ok();
  if (!near1(r.zermatt, r.expect.zermatt6)) fail(T,
    `the international pass is not priced from the Zermatt table (${r.zermatt})`); else ok();
  if (!r.babyFree) fail(T, 'a child under 8 is charged, or the panel does not say why it is free'); else ok();
  if (r.over8[0] != null || !r.over8[1]) fail(T,
    '9 ski days got a price the tariff does not have'); else ok();
  if (!near1(r.gear[0], r.expect.gearLo) || !near1(r.gear[1], r.expect.gearHi)) fail(T,
    `gear is not the rental list's range: ${r.gear} vs ${r.expect.gearLo}-${r.expect.gearHi}`); else ok();
  if (r.skiWidth > 64) fail(T, `the ski-days field is ${Math.round(r.skiWidth)}px wide for two digits`); else ok();
  if (!r.passTogether || !r.passNoWrap) fail(T, 'the two passes are one choice and split across two lines'); else ok();
  if (r.bandsAtFirst !== 'Adult,Junior') fail(T,
    `the panel opens on every age band (${r.bandsAtFirst}), not adults and children`); else ok();
  if (r.bandsAfterTick !== 'Adult,Junior,Senior' || !r.seniorCounted) fail(T,
    `ticking a band does not open its counter or count it (${r.bandsAfterTick})`); else ok();
  if (!r.untickRemoves) fail(T, 'unticking a band leaves its people in the sum'); else ok();
  if (!r.noEnglishBands) fail(T, 'the ski-pass line names the bands in English'); else ok();
  if (!r.gearCheaper) fail(T,
    'gear is priced from one shop\'s list and does not say others cost less, or that a discount can be asked'); else ok();
  if (r.freeFlights != null) fail(T, 'the side-menu door invented a flight price with no dates'); else ok();
  if (!r.ref || !near1(r.food[0], 2 * 7 * r.ref.food_person_day[0]) || !near1(r.food[1], 2 * 7 * r.ref.food_person_day[1]) || !r.food[2]) fail(T,
    `food is not people × days × the reference, or does not say it is a suggestion: ${r.food}`); else ok();
  if (!near1(r.freeLodging[0], 7 * r.ref.lodging_valley[0]) || !near1(r.freeLodging[1], 7 * r.ref.lodging_valley[1])) fail(T,
    `the side-menu door's lodging is not nights × the valley reference: ${r.freeLodging}`); else ok();
  if (!near1(r.freeCar[0], 7 * r.ref.car_day[0]) || !near1(r.freeCar[1], 7 * r.ref.car_day[1]) || !r.freeCar[2]) fail(T,
    `the car is not days × the daily reference, or does not say it is a suggestion: ${r.freeCar}`); else ok();
  if (r.waysShown !== 3 || !r.busLabel) fail(T,
    'the transport row does not offer a hired car, a transfer and the bus'); else ok();
  if (!near1(r.transfer2[0], r.transfer2[1]) || !r.transfer2[2]) fail(T,
    `a transfer for 2 is not the operator's 1–2 price both ways: ${r.transfer2}`); else ok();
  if (!near1(r.transfer3[0], r.transfer3[1])) fail(T,
    `a transfer for 3 is not the operator's 3–8 price both ways: ${r.transfer3}`); else ok();
  if (!near1(r.bus2[0], r.bus2[1]) || !r.bus2[2]) fail(T,
    `the bus is not (Malpensa bus + Linea Blu) × 2 directions × people, or hides the days it does not run: ${r.bus2}`); else ok();
  if (!r.estimateSaid) fail(T, 'the panel does not say "הערכה, לא מחיר סופי"'); else ok();
  if (!r.freeFlightsNote) fail(T, 'the side-menu flights row does not say where the trip\'s price comes from'); else ok();
  if (!r.miscNote) fail(T, '"שונות" still lists transfers, or not "שיעורי סקי"'); else ok();
  if (!r.babyLabel) fail(T, 'the free bands are not named "פעוטות וילדים עד 8" and marked free on the pass'); else ok();
  if (!r.placeholderRtl) fail(T, 'the amount fields read "-מ" instead of "מ-"'); else ok();
  if (!r.totalOnScreen) fail(T, 'the total is not on screen when the panel opens'); else ok();
  if (!/^כ-/.test(r.totalMid) || !/^בין .* ל-/.test(r.totalRange)) fail(T,
    `the total does not lead with the middle and give the range under it: "${r.totalMid}" / "${r.totalRange}"`); else ok();
  if (+r.usdShown[0] !== r.usdShown[1] || !r.usdSym) fail(T,
    `in dollars the fields do not show dollars: ${r.usdShown}`); else ok();
  if (!r.usdTotal) fail(T, 'in dollars the total is not in dollars with shekels under it'); else ok();
  if (!near1(r.usdTypedKeptEur, 100)) fail(T,
    `$125 typed at 1.25 was not kept as €100 (${r.usdTypedKeptEur})`); else ok();
  if (!r.ilsOther) fail(T, 'in shekels the second line is not in euros'); else ok();
  if (r.handKept[0] !== 300 || r.handKept[1] !== 600) fail(T,
    `rows typed into were recomputed: ${r.handKept}`); else ok();
  if (!/לא נכלל:.*טיסות/.test(r.total) || !/₪/.test(r.total)) fail(T,
    `the total does not say what it leaves out, or has no shekels: "${r.total}"`); else ok();
  if (!r.ideasOpen) fail(T, 'the total has no way to the save-or-splurge ideas'); else ok();
  if (!r.dayLess) fail(T, 'one ski day fewer is not offered at what it saves in this trip'); else ok();
  if (!r.valtIdea) fail(T, 'lodging is not the first saving, with Cielo Alto, Valtournenche and a way to the guide'); else ok();
  if (!r.noOwnGear) fail(T, 'bringing gear from home is offered as a saving again'); else ok();
  if (!r.halfIdea) fail(T, 'the half-day ticket is not mentioned with its price'); else ok();
  if (!r.fancyNew) fail(T, 'the splurges lack the spa hotel or the car upgrade'); else ok();
  if (!r.applyDay || !r.applyBus || !r.applyZermatt) fail(T,
    `an idea's button does not apply it: day ${r.applyDay}, bus ${r.applyBus}, zermatt ${r.applyZermatt}`); else ok();
  if (!r.thenCervinia) fail(T, 'with the international pass, the Cervinia pass is not offered as a saving'); else ok();
  if (!r.resetBack || !near1(r.foodBack, r.foodBackExpect)) fail(T, '"↺" does not give the row back to the calculation'); else ok();
  if (!r.carAlt || !r.altOpens) fail(T, 'the car search does not point at the transfer and the bus'); else ok();
  if (!r.altTab) fail(T, 'the car tab opens the transport card on the wrong tab'); else ok();
  if (!r.altBack) fail(T, 'closing the transport card does not return to the car search'); else ok();
  if (r.tripMode !== 'trip') fail(T,
    'opened first from the trip strip, the calculator came up in side-menu mode'); else ok();
  if (r.tripNights !== 7 || !r.tripAsksNot) fail(T,
    'the trip door asks for nights the trip already has'); else ok();
  if (r.tripBands[0] !== 2 || r.tripBands[1] !== 1) fail(T,
    `the trip's 2 adults and 1 child came in as ${r.tripBands}`); else ok();
  if (!near1(r.lodging[0], 600) || !near1(r.lodging[1], 900)) fail(T,
    `6 nights in two stays at €100-150 came out ${r.lodging}`); else ok();
  if (!near1(r.lodgingRef[0], r.lodgingRefExpect[0]) || !near1(r.lodgingRef[1], r.lodgingRefExpect[1]) || !r.lodgingRef[2]) fail(T,
    `with no budget, 4 valley nights and 2 city nights are not priced from the reference: ${r.lodgingRef} vs ${r.lodgingRefExpect}`); else ok();
  if (!near1(r.tripCar[0], r.tripCar[1])) fail(T,
    `the car in the trip is not the car's 7 days × the reference: ${r.tripCar}`); else ok();
  if (!near1(r.flights[0], 200 * 3 / 1.25) || !near1(r.flights[1], 260 * 3 / 1.25)) fail(T,
    `flights are not the snapshot's day and its week around, for 3, in euros: ${r.flights}`); else ok();
  if (!/חסר לילה אחד: 16\.1/.test(r.coverage)) fail(T,
    `the calculator does not see the night nobody covers: "${r.coverage}"`); else ok();
  if (!/₪/.test(r.ils)) fail(T, 'no shekels in the total'); else ok();
  if (r.noSnapshot[0] != null || !r.noSnapshot[1]) fail(T,
    'with no snapshot for the dates, flights still show a number'); else ok();
}

// ── the transport card, after Yossi's walk-through (10.11) ───────────
// Getting there first; chips that say which was pressed and land on the
// start of their section, not under the sticky strip; the bus up from
// Valtournenche; links that say they are the operator's; timetables folded;
// car hire that leads with the excess insurance and drops the essay.
{
  const r = await page.evaluate(async () => {
    const out = {};
    const $ = id => document.getElementById(id);
    const vis = el => !!el && getComputedStyle(el).display !== 'none';
    if (!$('transport-body').innerHTML && window._texts) renderTransport(window._texts.transport);
    openM('parkingModal');
    await new Promise(res => setTimeout(res, 150));
    const tabs = [...document.querySelectorAll('#parkingModal .ttab-btn')].map(b => b.id);
    out.firstTab = tabs[0];
    out.opensOn = vis($('park-panel-transport')) && !vis($('park-panel-parking'))
      && $('park-tab-transport').classList.contains('ttab-active');
    const body = $('park-panel-transport');
    out.title = /מתי מגיעים ומתי חוזרים/.test(body.textContent) && !/מתי להגיע ומתי לצאת/.test(body.textContent);

    // the chips
    if (typeof buildPanelToc === 'function') buildPanelToc('park-panel-transport');
    const strip = body.querySelector('.panel-toc');
    const chips = [...strip.querySelectorAll('button')];
    const secs = [...body.querySelectorAll('[data-toc]')];
    const box = $('parkingModal').querySelector('.modal-content');
    out.chips = chips.length;
    out.landed = [];
    for (let i = 0; i < Math.min(5, chips.length); i++) {
      box.scrollTo({ top: 0 });
      chips[i].click();
      await new Promise(res => setTimeout(res, 900));
      const gap = secs[i].getBoundingClientRect().top - strip.getBoundingClientRect().bottom;
      const on = chips.filter(c => c.classList.contains('on'));
      out.landed.push([Math.round(gap), on.length === 1 && on[0] === chips[i]]);
    }

    // one row on a phone (this page is 430 wide), and a pressed chip in view
    const tops = new Set(chips.map(c => Math.round(c.getBoundingClientRect().top)));
    out.oneRow = [tops.size, Math.round(strip.getBoundingClientRect().height), strip.scrollWidth > strip.clientWidth];
    const far = chips[chips.length - 1];
    far.click(); await new Promise(res => setTimeout(res, 700));
    const sr = strip.getBoundingClientRect(), fr = far.getBoundingClientRect();
    out.farInView = fr.left >= sr.left - 1 && fr.right <= sr.right + 1;
    // the corner ×: big enough to see, and a finger slightly off still hits it
    const x = $('parkingModal').querySelector('.close-btn');
    box.scrollTo({ top: 0, behavior: 'instant' }); await new Promise(res => setTimeout(res, 250));   // the × scrolls with the panel
    const xr = x.getBoundingClientRect();
    const hit = document.elementFromPoint(xr.left + xr.width / 2, xr.bottom + 6);
    out.xSize = Math.round(xr.width);
    out.xNearHit = hit === x;
    const t = body.textContent;
    out.valtBus = /מוולטורננש לצ'רוויניה באוטובוס/.test(t) && /מסלולים אדומים/.test(t);
    const labels = [...body.querySelectorAll('a, button')].map(a => a.textContent);
    out.linksSay = labels.some(l => /הלוח הרשמי/.test(l)) && labels.some(l => /אתר המפעיל/.test(l))
      && /פותחים את האתר הרשמי של המפעיל/.test(t);
    const folds = [...body.querySelectorAll('details.tr-fold')];
    out.folds = folds.length;
    out.foldsClosed = folds.every(d => !d.open && d.querySelector('table'));
    out.notesOutside = /95 דקות/.test(t) && !folds.some(d => /95 דקות/.test(d.textContent));
    out.insurance = /ביטוח ביטול השתתפות עצמית — חובה/.test(t) && /AIG/.test(t) && /ביטוח הנסיעות/.test(t);
    out.essayGone = !/ההבדל אינו בביטוח אלא בהשתתפות/.test(t) && !/השאלה הראשונה בהזמנה/.test(t);
    out.widestGone = !/הרחב ביותר/.test(t);
    out.chainsAlways = /עובדות תמיד/.test(t) && /צמיגי חורף — כמעט אין/.test(t);
    // the fitting videos have a button of their own, not only a link in a sentence
    out.chainsButton = [...body.querySelectorAll('a')].some(a => /snowchains\.com/.test(a.href) && /סרטוני הרכבת שרשראות/.test(a.textContent));
    closeM('parkingModal');

    // the search entry for parking still lands on parking
    const ent = (typeof SEARCH_INDEX !== 'undefined' ? SEARCH_INDEX : []).find(e => /חניה כביש/.test(e.text || ''));
    if (ent) {
      new Function(ent.action)();
      await new Promise(res => setTimeout(res, 100));
      out.searchParking = vis($('park-panel-parking'));
      closeM('parkingModal');
    } else out.searchParking = 'no-entry';
    return out;
  });

  const T = 'the transport card, after the walk-through';
  if (r.firstTab !== 'park-tab-transport' || !r.opensOn) fail(T,
    `getting there is not the first tab and the one that opens (${r.firstTab})`); else ok();
  if (!r.title) fail(T, 'the planner is not titled "מתי מגיעים ומתי חוזרים"'); else ok();
  const bad = r.landed.map((x, i) => [i, x]).filter(([, x]) => x[0] < 0 || x[0] > 40 || !x[1]);
  if (r.chips < 5 || bad.length) fail(T,
    `chips land under the strip or do not show which was pressed: ${JSON.stringify(bad)}`); else ok();
  if (r.oneRow[0] !== 1 || r.oneRow[1] > 60 || !r.oneRow[2]) fail(T,
    `on a phone the chips are not one row that scrolls (rows ${r.oneRow[0]}, ${r.oneRow[1]}px)`); else ok();
  if (!r.farInView) fail(T, 'a chip pressed at the end of the row is left half out of view'); else ok();
  if (r.xSize < 34) fail(T, `the corner × is ${r.xSize}px on a phone - too small to find`); else ok();
  if (!r.xNearHit) fail(T, 'a tap just below the corner × misses it'); else ok();
  if (!r.valtBus) fail(T, 'Valtournenche to Cervinia offers no bus, or hides that the ski way is long and red'); else ok();
  if (!r.linksSay) fail(T, 'the timetable buttons do not say they are the operator\'s official pages'); else ok();
  if (r.folds !== 2 || !r.foldsClosed) fail(T,
    `the full timetables are not folded away (${r.folds} folds)`); else ok();
  if (!r.notesOutside) fail(T, 'folding the timetables hid the notes that go with them'); else ok();
  if (!r.insurance) fail(T, 'car hire does not lead with the excess insurance, where to buy it and the AIG experience'); else ok();
  if (!r.essayGone) fail(T, 'the deductible comparison or "the first question" is still there'); else ok();
  if (!r.widestGone) fail(T, 'Malpensa is still "the widest of the four"'); else ok();
  if (!r.chainsButton) fail(T, 'the chain-fitting videos have no button of their own'); else ok();
  if (!r.chainsAlways) fail(T, 'car hire does not say winter tyres are rare and chains always work'); else ok();
  if (r.searchParking !== true) fail(T, `the search entry for parking does not open on parking (${r.searchParking})`); else ok();
}

// ── a skier rides the recommended route ──────────────────────────────
// Yossi, 11.11: colour and movement - a marker that rides each recommended
// route on the piste map, up in the lifts and down the runs, in order.
{
  const T = 'a skier rides the recommended route';
  const r = await page.evaluate(async () => {
    const rd = _mapRouteData(), out = { routes: {} };
    for (const id of Object.keys(rd.routes_drawn)) {
      const legs = _mapRideLegs(rd.routes_drawn[id]);
      const gaps = legs.slice(1).map((g, i) => {
        const e = legs[i].pts.slice(-1)[0];
        return Math.hypot(g.pts[0][0] - e[0], g.pts[0][1] - e[1]);
      });
      out.routes[id] = {
        n: legs.length,
        firstLift: legs[0] && legs[0].kind === 'lift',
        liftsUp: legs.filter(g => g.kind === 'lift').every(g => g.pts.slice(-1)[0][1] < g.pts[0][1]),
        noAlt: legs.every(g => g.kind !== 'alt'),
        maxGap: Math.round(Math.max(0, ...gaps))
      };
    }
    // on a stand-in sheet: it appears, moves, and stops once the route is off
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + rd.page.w + ' ' + rd.page.h);
    svg.style.cssText = 'position:fixed;left:0;top:0;width:360px;height:290px';
    document.body.appendChild(svg);
    // it rides even when the system asks for less motion
    const mm = window.matchMedia;
    window.matchMedia = q => /reduced-motion/.test(q) ? { matches: true } : mm.call(window, q);
    _mapRideRoute(svg, rd.routes_drawn.ventina);
    window.matchMedia = mm;
    const pos = () => (svg.querySelector('.map-rider') || { getAttribute: () => '' }).getAttribute('transform');
    const p0 = pos();
    await new Promise(res => setTimeout(res, 700));
    const p1 = pos();
    out.moves = !!p0 && p0 !== p1;
    out.icon = (svg.querySelector('.map-rider text') || {}).textContent;
    out.onScreen = Math.round(svg.querySelector('.map-rider circle').getBoundingClientRect().width);
    svg.style.display = 'none';
    await new Promise(res => setTimeout(res, 150));
    out.stops = _mapRideRaf === 0;
    svg.remove();
    out.inPaint = /_mapRideRoute\(svg, route\)/.test(String(_mapPaintRoute));
    // the drawn layers are still exactly the route's layers
    mapShowRoute('grand_tour');
    out.layersOnly = document.getElementById('map-route-layer').querySelectorAll(':scope > path').length === rd.routes_drawn.grand_tour.layers.length;
    mapShowRoute('grand_tour');
    return out;
  });
  const bad = Object.entries(r.routes).filter(([, x]) => !x.n || !x.firstLift || !x.liftsUp || !x.noAlt || x.maxGap > 60);
  if (bad.length) fail(T, `a route is ridden wrong: ${JSON.stringify(bad)}`); else ok();
  if (!r.moves || !r.inPaint) fail(T, `the marker does not ride (moves ${r.moves}, drawn with the route ${r.inPaint})`); else ok();
  if (r.icon !== '\u{1F6A1}') fail(T, `the ride starts with "${r.icon}", not the lift`); else ok();
  if (r.onScreen < 22 || r.onScreen > 36) fail(T, `the marker is ${r.onScreen}px on a phone sheet`); else ok();
  if (!r.stops) fail(T, 'the animation keeps running after the route is hidden'); else ok();
  if (!r.layersOnly) fail(T, 'the rider\'s guide paths are counted among the drawn layers'); else ok();
}

// ── how many days of pass to buy ─────────────────────────────────────
// Yossi, 11.11: the weather turns, a closed day is not refunded, and the
// link opens day by day - so the local pass plus a day supplement, and our
// own record of closures, are said where the pass is bought and in the
// calculator.
{
  const T = 'how many days of pass to buy';
  const r = await page.evaluate(async () => {
    const $ = id => document.getElementById(id);
    const out = {};
    openM('skipassModal');
    const box = $('skipass-howmany');
    out.txt = box ? box.innerText : '';
    const fold = $('skipass-prices-fold');
    out.before = !!box && !!fold && !!(box.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING);
    out.visible = !!box && box.offsetParent !== null;
    closeM('skipassModal');
    openCost('free');
    COST.skiDays = 6; COST.pass = 'zermatt'; COST.rows = {}; _costRecalc(); _costRender();
    const t1 = $('cost-ideas-body').textContent;
    out.supp = /תוספת יום לצ'רמט/.test(t1) && /€52/.test(t1);
    out.link = !!$('cost-ideas-body').querySelector('a[onclick*="skipassModal"]');
    COST.pass = 'cervinia'; COST.rows = {}; _costRecalc(); _costRender();
    const halfIdea = [...$('cost-ideas-body').querySelectorAll('.cost-idea')].find(x => /חצי יום/.test(x.textContent));
    out.halfCaveat = !!halfIdea && /אין החזר/.test(halfIdea.textContent);
    // the Zermatt days calculator, against the tariff by hand: 5 days, 2 in Zermatt
    const C = d => _costPassPrice('cervinia', 'Adult', d), I = d => _costPassPrice('zermatt', 'Adult', d);
    const sup = _texts.skipass.prices.zermatt.day_supplement.Adult;
    const pl = zcPlans(5, 2), by = id => (pl.find(x => x.id === id) || {}).cost;
    out.zcMath = by('local') === C(5) + 2 * sup && by('intl') === I(5) && by('daily') === 3 * C(1) + 2 * I(1)
      && pl[0].cost === Math.min(...pl.map(x => x.cost))
      && by('forecast') <= Math.min(by('local'), by('daily'));
    out.zcSays = (pl.find(x => x.id === 'forecast') || {}).label || '';
    openM('skipassModal'); ZC.n = 5; ZC.z = 2; zcRender();
    out.zcShown = $('zc-out').querySelectorAll('.zc-plan').length === pl.length && /🏆/.test($('zc-out').textContent);
    zcAdj('z', 9); out.zcCap = ZC.z === 5; zcAdj('n', -9); out.zcCap = out.zcCap && ZC.n === 1 && ZC.z === 1;
    closeM('skipassModal');
    // a percent sign stays with its number on a Hebrew line
    out.pct = /<span dir="ltr">12%<\/span>/.test(_fixNums('כ-12% פחות'));
    closeM('costModal');
    return out;
  });
  const need = [/אין החזר/, /4 ימים קדימה/, /14 ימים/, /שבוע שלם ברצף/, /€52/, /בכל בוקר כרטיס יומי/, /היעזרו במחשבון/, /ולטורננש/];
  const miss = need.filter(re => !re.test(r.txt)).map(String);
  if (!r.visible || !r.before) fail(T, `the advice is not shown above the tariff (shown ${r.visible}, before ${r.before})`); else ok();
  if (miss.length) fail(T, `the advice lacks: ${miss.join(' ')}`); else ok();
  if (!r.supp || !r.link) fail(T, `the calculator does not offer the local pass with the day supplement (${r.supp}) or the way to the advice (${r.link})`); else ok();
  if (!r.halfCaveat) fail(T, 'keeping the half day in the pass is offered without the no-refund caveat'); else ok();
  if (!r.zcMath) fail(T, 'the Zermatt days calculator does not add up against the tariff'); else ok();
  if (!/פס בינלאומי ל-2 ימים|תוספת צ'רמט|בינלאומי ליום אחד/.test(r.zcSays)) fail(T, `the forecast plan does not say which pass covers Zermatt: "${r.zcSays}"`); else ok();
  if (!r.zcShown || !r.zcCap) fail(T, `the calculator does not show its plans (${r.zcShown}) or keep its days in range (${r.zcCap})`); else ok();
  if (!r.pct) fail(T, 'a percent sign is left outside its number on a Hebrew line'); else ok();
}

// ── the live reading outranks an older crossing notice ───────────────
// Yossi, 11.11: the strip said the crossing had opened while the mountain
// badge and the operator said shut. A newer reading takes the notice off.
{
  const T = 'the live reading outranks an older crossing notice';
  const r = await page.evaluate(() => {
    const keep = { a: _alerts, z: _zLive };
    const now = Date.now(), hour = 3600e3;
    const mk = (id, text, auto, ts) => ({ id, text, auto, ts, until: now + 5 * hour, kind: 'alert', severity: 'info', user: '', authorId: auto ? '' : 'u1' });
    _alerts = [
      mk('open-auto', 'המעבר לצ׳רמט נפתח — אפשר לעבור לצד השוויצרי.', true, now - hour),
      mk('open-person', 'המעבר לצ׳רמט נפתח, ראיתי בעצמי', false, now - hour),
      mk('shut-auto', 'המעבר לצ׳רמט נסגר. מי שתכנן לחצות היום — בדקו לפני שאתם עולים.', true, now - 2 * hour)
    ];
    const ids = () => getAlerts().map(a => a.id).sort().join(',');
    const out = {};
    _zLive = { s: 'NEXT UPDATE', t: now };        out.placeholder = ids();
    _zLive = { s: 'CLOSED', t: now };             out.closed = ids();
    _zLive = { s: 'OPEN', t: now };               out.open = ids();
    _zLive = { s: 'CLOSED', t: now - 3 * hour };  out.older = ids();
    // and the live bar is what sets it
    _zLive = null;
    renderLiveBar(Object.assign({}, window._lastLive || {}, { zermatt_link: 'CLOSED', updated_at: new Date(now).toISOString() }));
    out.fromBar = !!_zLive && _zLive.s === 'CLOSED' && _zLive.t === now - (now % 1000) + (now % 1000);
    _alerts = keep.a; _zLive = keep.z;
    return out;
  });
  if (r.placeholder !== 'open-person,shut-auto') fail(T, `NEXT UPDATE after the opening notice leaves: ${r.placeholder}`); else ok();
  if (r.closed !== 'open-person,shut-auto') fail(T, `CLOSED after the opening notice leaves: ${r.closed}`); else ok();
  if (r.open !== 'open-auto,open-person') fail(T, `OPEN after the closing notice leaves: ${r.open}`); else ok();
  if (r.older !== 'open-auto,open-person,shut-auto') fail(T, `an older reading took notices off: ${r.older}`); else ok();
  if (!r.fromBar) fail(T, 'the live bar does not hand its reading to the strip'); else ok();
}

// ── English (Yossi, 12.11): the main screen, and the Hebrew left alone ──
{
  const T_EN = JSON.parse(fs.readFileSync(path.join(path.dirname(TEXTS), 'texts.en.json'), 'utf8'));
  const he = await page.evaluate(() => ({
    dir: document.documentElement.dir, lang: document.documentElement.lang,
    // the corner button is open (13.11): EN on the Hebrew page, leading to English
    switchHidden: !document.getElementById('lang-btn').classList.contains('soon')
               && document.getElementById('lang-btn').textContent === 'EN' && LANG_OPEN === true,
    L: L('א', 'a'), logo: /logo\.png$/.test(document.getElementById('brand-logo').src)
  }));
  const T0 = 'the Hebrew site is as it was';
  if (he.dir !== 'rtl' || he.lang !== 'he') fail(T0, `dir=${he.dir} lang=${he.lang}`); else ok();
  if (!he.switchHidden) fail(T0, 'the corner language button does not offer the English site'); else ok();
  if (he.L !== 'א') fail(T0, 'L() gives English on the Hebrew page'); else ok();
  if (!he.logo) fail(T0, 'the Hebrew logo was replaced'); else ok();

  for (const [w, h] of [[390, 860], [1366, 860]]) {
    const T1 = `the English main screen at ${w}px`;
    const p3 = await browser.newPage({ viewport: { width: w, height: h } });
    const errs = []; p3.on('pageerror', e => errs.push(String(e).split('\n')[0]));
    await p3.goto('file://' + PAGE + '?lang=en');
    await p3.waitForTimeout(1200);
    const r = await p3.evaluate(([T, E]) => {
      const t = _overlayTexts(T, E);
      window._texts = t; window.PISTES = t.pistes; _applyTexts(t);
      const out = { dir: document.documentElement.dir, lang: document.documentElement.lang };
      out.logo = /logo-en\.png$/.test(document.getElementById('brand-logo').src);
      const lb = document.getElementById('lang-btn');
      out.switch = lb.textContent === 'עב' && !lb.classList.contains('soon') && lb.getBoundingClientRect().width > 0;
      out.card = document.querySelector('#svc-webcam .svc-txt b').textContent;
      // visible Hebrew outside the panels and outside what users wrote
      const heb = /[֐-׿]/, left = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
      while ((n = w.nextNode())) {
        const el = n.parentElement, s = n.textContent.trim();
        if (!s || !heb.test(s) || !el) continue;
        if (el.closest('.modal, [id$="Modal"], #side-menu, .ugc, #forum-section, #lang-btn')) continue;
        const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
        if (!b.width || !b.height || cs.visibility === 'hidden') continue;
        left.push((el.id || el.tagName) + ': ' + s.slice(0, 40));
      }
      out.left = left;
      // the overlay matches by id, so the order of the Hebrew cannot misplace it
      const o = _overlayTexts({ a: [{ id: 'x', l: 'א', k: 1 }, { id: 'y', l: 'ב' }] }, { a: [{ id: 'y', l: 'B' }] });
      out.overlay = o.a[0].l === 'א' && o.a[0].k === 1 && o.a[1].l === 'B';
      return out;
    }, [T, T_EN]);
    if (r.dir !== 'ltr' || r.lang !== 'en') fail(T1, `dir=${r.dir} lang=${r.lang}`); else ok();
    if (!r.logo) fail(T1, 'the Hebrew logo is shown'); else ok();
    if (!r.switch) fail(T1, 'no way back to Hebrew in the corner'); else ok();
    if (r.card !== 'Webcams') fail(T1, `the webcam card reads "${r.card}"`); else ok();
    if (r.left.length) fail(T1, 'Hebrew left on screen: ' + r.left.slice(0, 6).join(' | ')); else ok();
    if (!r.overlay) fail(T1, 'texts.en.json is not laid over by id'); else ok();
    const real = errs.filter(e => !NOISE.test(e));
    if (real.length) fail(T1, 'errors: ' + real.slice(0, 3).join(' | ')); else ok();
    await p3.close();
  }
}

// ── Yossi (12.11, evening): the flight search reaches other ski areas ──
{
  const T = 'the flight search offers the airports of other ski areas';
  const r = await page.evaluate(async () => {
    const $ = id => document.getElementById(id), out = {};
    openPlanner('flight');
    await new Promise(res => setTimeout(res, 200));
    setTripDates('2027-01-10', '2027-01-17');
    const sel = $('airport-select-flight');
    const codes = [...sel.options].map(o => o.value);
    out.has = ['GVA', 'ZRH', 'VIE', 'SOF', 'TBS'].every(c => codes.includes(c));
    out.cerviniaFirst = codes.slice(0, 3).join() === 'MXP,BGY,TRN';
    // the other tabs are about reaching Cervinia, and stay so
    out.othersClean = !['airport-select', 'airport-select-car'].some(id =>
      [...$(id).options].some(o => o.value === 'GVA'));
    sel.value = 'GVA';
    searchFlight();
    await loadFlights(); await new Promise(res => setTimeout(res, 100));
    const res = $('flight-results');
    out.head = /ז׳נבה \(GVA\)/.test(res.textContent) && !/ברירת מחדל: מילאנו/.test(res.textContent);
    out.noDirectClaim = !/ללא ישיר/.test(res.textContent);
    const kf = [...res.querySelectorAll('a')].map(a => a.href).find(h => /trip-finder/.test(h)) || '';
    out.kf = /to=GVA/.test(kf) && decodeURIComponent(kf).includes('label=ז׳נבה');
    out.sky = [...res.querySelectorAll('a')].some(a => /skyscanner.*\/tlv\/gva\//.test(a.href));
    out.noMissingPrice = !/אין מחיר שמור/.test($('fl-snapshot').textContent);
    // and Milan is as it was
    sel.value = 'MXP'; searchFlight();
    const kf2 = [...$('flight-results').querySelectorAll('a')].map(a => a.href).find(h => /trip-finder/.test(h)) || '';
    out.milan = /ברירת מחדל: מילאנו/.test($('flight-results').textContent) && decodeURIComponent(kf2).includes('label=מילאנו');
    resetTripDates();
    closeM('hotelModal');
    return out;
  });
  const want = { has: 'the list lacks Geneva, Zurich, Vienna, Sofia or Tbilisi',
    cerviniaFirst: 'the Cervinia airports are no longer first',
    othersClean: 'the car or "all" tab offers Geneva - they are about reaching Cervinia',
    head: 'the results do not name Geneva, or still say "default Milan"',
    noDirectClaim: 'Geneva is said to have no direct flight - an unverified claim',
    kf: 'Kosher Fly does not get GVA with the Hebrew name',
    sky: 'Skyscanner does not search to Geneva',
    noMissingPrice: 'Geneva shows "no saved price" - the price list is only for Cervinia',
    milan: 'Milan lost its heading or its Kosher Fly label' };
  for (const k in want) if (!r[k]) fail(T, want[k]); else ok();
}

// ── Yossi's notes of 12.11: the clock, and a crossing notice without "today" ──
{
  const T = "Yossi's notes of 12.11";
  const r = await page.evaluate(() => {
    const $ = id => document.getElementById(id), out = {};
    const box = $('local-clock');
    out.shown = !!box && box.style.display !== 'none';  // on a scrolled phone it hides on purpose
    const want = new Date().toLocaleTimeString('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false });
    out.time = $('local-clock-time') && $('local-clock-time').textContent;
    // the clock ticks every 15s, so a minute may turn between the two reads
    const before = new Date(Date.now() - 20e3).toLocaleTimeString('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false });
    out.want = out.time === before ? before : want;
    out.inHeader = !!box && $('sticky-header').contains(box);
    // the new wording is still retired by a live OPEN reading
    const keep = _zLive, now = Date.now();
    _zLive = { s: 'OPEN', t: now };
    out.staleNew = _zStale({ auto: true, ts: now - 60e3, text: 'המעבר לצ׳רמט סגור. המעליות בצ׳רוויניה פועלות ו־23 מסלולים פתוחים.' });
    _zLive = { s: 'CLOSED', t: now };
    out.keptNew = !_zStale({ auto: true, ts: now - 60e3, text: 'המעבר לצ׳רמט סגור. המעליות בצ׳רוויניה פועלות.' });
    _zLive = keep;
    return out;
  });
  if (!r.shown) fail(T, 'the Cervinia clock is not shown in the header'); else ok();
  if (!r.inHeader) fail(T, 'the clock is not inside the header'); else ok();
  if (r.time !== r.want) fail(T, `the clock reads ${r.time}, Cervinia is at ${r.want}`); else ok();
  if (!r.staleNew) fail(T, 'a "closed" notice in the new wording is not retired by a live OPEN'); else ok();
  if (!r.keptNew) fail(T, 'a "closed" notice is dropped while the crossing is still closed'); else ok();
}
for (const [w, h] of [[360, 740], [390, 800], [1366, 800]]) {
  const T = `the Cervinia clock fits the header at ${w}px`;
  const p2 = await browser.newPage({ viewport: { width: w, height: h } });
  await p2.goto(page.url(), { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(800);
  const r = await p2.evaluate(() => {
    const c = document.getElementById('local-clock').getBoundingClientRect();
    const hit = ['brand-logo', 'global-search-bar', 'auth-area', 'menu-btn'].filter(id => {
      const b = document.getElementById(id).getBoundingClientRect();
      return b.width && !(c.right <= b.left || c.left >= b.right || c.bottom <= b.top || c.top >= b.bottom);
    });
    return { w: c.width, hit, inView: c.left >= 0 && c.right <= innerWidth };
  });
  if (!r.w) fail(T, 'not shown'); else if (r.hit.length) fail(T, 'overlaps ' + r.hit.join(', '));
  else if (!r.inView) fail(T, 'off screen'); else ok();
  await p2.close();
}

// ── Yossi's notes of 11.11, midday ───────────────────────────────────
{
  const T = "Yossi's notes of 11.11, midday";
  const r = await page.evaluate(async () => {
    const $ = id => document.getElementById(id), out = {};
    // close every alert at once, offered only when there is more than one
    const keep = { a: _alerts, d: localStorage.getItem(ALERTS_DISMISS_KEY) };
    const now = Date.now();
    const mk = (id, text) => ({ id, text, auto: true, ts: now - 60e3, until: now + 3600e3, kind: 'alert', severity: 'warning', user: 'x', authorId: '' });
    _alerts = [mk('n1', 'אחת'), mk('n2', 'שתיים'), mk('n3', 'שלוש')];
    refreshAlertStrip();
    const btn = $('alert-strip').querySelector('.alert-closeall');
    out.closeAllShown = !!btn;
    out.chip = /הודעה אוטומטית/.test($('alert-strip-text').innerHTML) && !/מדידה אוטומטית/.test(document.body.innerHTML);
    btn && btn.click();
    out.allGone = $('alert-strip').style.display === 'none';
    _alerts = [mk('n4', 'רק אחת')]; refreshAlertStrip();
    out.notForOne = !$('alert-strip').querySelector('.alert-closeall');
    _alerts = keep.a; if (keep.d === null) localStorage.removeItem(ALERTS_DISMISS_KEY); else localStorage.setItem(ALERTS_DISMISS_KEY, keep.d);
    refreshAlertStrip();
    // the tutorials are announced at the top of the lessons card
    openM('lessonsModal');
    const vb = $('les-videos-btn');
    out.videosBtn = !!vb && vb.offsetParent !== null && vb.getBoundingClientRect().top < $('les-videos').getBoundingClientRect().top;
    out.pizza = /מ"פיצה" לסקי פרללי/.test($('les-videos').innerText) && /רמת ביניים ומתקדמים/.test($('les-videos').innerText) && !/ממשיכים/.test($('les-videos').innerText);
    closeM('lessonsModal');
    // rental: booking ahead among the tips; one place for "buy it on the way"
    openM('rentalModal');
    const tips = $('rental-ski-tips').closest('details');
    out.bookingInTips = !!tips && tips.contains($('rental-booking-summary'));
    out.oneBuyOnWay = !$('rental-buy-on-way-tip') && /בעצם הכול/.test($('rental-shops-way-sub').innerText)
      && (document.getElementById('rentalModal').innerText.match(/כדאי לקנות בדרך/g) || []).length === 1
      && !!$('rental-buy-vs-rent-title');
    closeM('rentalModal');
    // the contents strip stands in two even columns wider than a phone
    openM('lodgingModal');
    const toc = $('lodgingModal').querySelector('.panel-toc');
    out.tocGrid = innerWidth > 600 ? getComputedStyle(toc).display === 'grid' : true;
    out.giomein = /הירידה מהשכונה ואל השכונה אינה מסלול רשמי/.test($('lodging-body').innerText);
    closeM('lodgingModal');
    // the routes are chosen in the pistes card only; the map puts one away
    out.noPickRow = getComputedStyle($('map-route-pick')).display === 'none';
    _mapCurrentType = _texts.pistes.route_map.map;
    mapShowRoute('ventina');
    const offBtn = $('map-route-off');
    out.offShown = !!offBtn && offBtn.offsetParent !== null;
    offBtn && offBtn.click();
    out.offWorks = !_mapRoute;
    closeM('mapModal');
    return out;
  });
  if (!r.closeAllShown || !r.allGone || !r.notForOne) fail(T, `close all: shown ${r.closeAllShown}, closes all ${r.allGone}, hidden for one ${r.notForOne}`); else ok();
  if (!r.chip) fail(T, 'the automatic chip still says מדידה'); else ok();
  if (!r.videosBtn || !r.pizza) fail(T, `the lessons card: videos button ${r.videosBtn}, wording ${r.pizza}`); else ok();
  if (!r.bookingInTips || !r.oneBuyOnWay) fail(T, `rental: booking in tips ${r.bookingInTips}, buy-on-the-way said once ${r.oneBuyOnWay}`); else ok();
  if (!r.tocGrid) fail(T, 'the contents strip is not an even grid on a wide screen'); else ok();
  if (!r.giomein) fail(T, 'the Giomein descent wording is not the one Yossi gave'); else ok();
  if (!r.noPickRow || !r.offShown || !r.offWorks) fail(T, `routes on the map: row hidden ${r.noPickRow}, hide button ${r.offShown}, hides ${r.offWorks}`); else ok();
}

// ── snow, and where it was measured ──────────────────────────────────
// Yossi, 11.11: "20 ס"מ" sat over "שלג ס"מ" and nothing said where. The
// label names the station; a tap lists every station.
{
  const T = 'snow, and where it was measured';
  const r = await page.evaluate(async () => {
    const $ = id => document.getElementById(id), out = {};
    renderLiveBar(Object.assign({}, window._lastLive || {}, {
      snow_depth: '20 cm', last_snowfall: '06/11/2026', updated_at: new Date().toISOString(),
      snow_points: [
        // out of order on purpose: the panel sorts them, top first
        { station: 'mid', altitude: 2600, depth: 20, name: 'Plan Maison' }, // a reading's wrong height
        { station: 'base', altitude: 2050, depth: 15, name: 'Breuil' },
        { station: 'top', altitude: 3480, depth: 35, name: 'Plateau Rosa' },
        { station: 'cime', altitude: 2814, depth: 35, name: 'Cime Bianche Laghi' }]
    }));
    out.label = $('bar-snow-label').innerText;
    out.value = $('bar-snow').innerText;
    $('bar-snow-cell').click();
    await new Promise(res => setTimeout(res, 150));
    out.open = getComputedStyle($('snowModal')).display !== 'none';
    out.rows = [...$('snow-points-list').querySelectorAll('.snow-pt')].map(x => x.innerText.replace(/\s+/g, ' '));
    out.foot = $('snow-points-foot').innerText;
    closeM('snowModal');
    return out;
  });
  if (!/Plan Maison/.test(r.label) || /ס"מ/.test(r.label)) fail(T, `the label is "${r.label}" - it should name the station and not repeat the unit`); else ok();
  if (!/^20\s*ס"מ$/.test(r.value.trim())) fail(T, `the value reads "${r.value}"`); else ok();
  if (!r.open || r.rows.length !== 4 || !/פלטאו רוזה/.test(r.rows[0]) || !/הכפר/.test(r.rows[3]) || !/35/.test(r.rows[0]) || !/15/.test(r.rows[3]))
    fail(T, `the stations list: open ${r.open}, rows ${JSON.stringify(r.rows)}`); else ok();
  if (!/2,555/.test(r.rows.find(x => /פלאן מייזון/.test(x)) || '')) fail(T, 'Plan Maison is not shown at 2,555 m'); else ok();
  if (!/06\/11\/2026/.test(r.foot) || !/ולטורננש/.test(r.foot)) fail(T, `the foot lacks the last snowfall or the Valtournenche note: ${r.foot}`); else ok();
}

// ── no browser dialogs anywhere ──────────────────────────────────────
// Yossi, 11.11: deleting a review put up the browser's own box, headed
// "האתר cervinialive.co.il אומר". The site asks in its own card instead.
{
  const T = 'no browser dialogs anywhere';
  const SRC = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const code = [...SRC.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
  const natives = [...code.matchAll(/(^|[^\w.$])(alert|confirm|prompt)\s*\(/g)].map(m => m[2]);
  if (natives.length) fail(T, `the page still calls the browser's own ${[...new Set(natives)].join(', ')}()`); else ok();
  const r = await page.evaluate(async () => {
    const out = {};
    const press = sel => setTimeout(() => { const b = document.querySelector('#ui-dialog ' + sel); b && b.click(); }, 50);
    let p = uiConfirm('למחוק את הביקורת?', 'מחיקה', true); out.shown = !!document.getElementById('ui-dialog') && /למחוק את הביקורת/.test(document.getElementById('ui-dialog').innerText);
    press('.ui-dialog-ok'); out.yes = await p;
    p = uiConfirm('בטוח?'); press('.ui-dialog-cancel'); out.no = await p;
    p = uiConfirm('בטוח?'); setTimeout(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), 50);
    out.esc = await Promise.race([p, new Promise(res => setTimeout(() => res('no answer to Escape'), 800))]);
    { const d = document.getElementById('ui-dialog'); d && d.remove(); }
    p = uiAlert('הודעה'); out.alertOneBtn = document.querySelectorAll('#ui-dialog button').length === 1; press('.ui-dialog-ok'); await p;
    out.gone = !document.getElementById('ui-dialog');
    out.reviewUsesIt = !/confirm\(/.test(String(deleteReview) + String(confirmDelReview));
    return out;
  });
  if (!r.shown || r.yes !== true || r.no !== false || r.esc !== false || !r.alertOneBtn || !r.gone || !r.reviewUsesIt)
    fail(T, `the site's dialog: ${JSON.stringify(r)}`); else ok();
}

// ── the flight search, walked through as Yossi did (11.11, evening) ──
{
  const T = 'the flight search, walked through as Yossi did';
  const r = await page.evaluate(async () => {
    const $ = id => document.getElementById(id), out = {};
    const wait = ms => new Promise(res => setTimeout(res, ms));
    openM('hotelModal'); await wait(150);
    if (typeof planGo === 'function') planGo('flight'); else switchTripTab('flight');
    await wait(150);
    // the blue box does not point at results that are not there yet
    out.noPhantom = !/החיפוש למטה חי/.test(document.body.innerHTML);
    // an example, then "מלא בשבילי"
    const ex = [...$('trip-free-ex').querySelectorAll('.ftx')].find(e => /חנוכה/.test(e.textContent)) || $('trip-free-ex').querySelector('.ftx');
    ex && ex.click(); await wait(80);
    out.filled = $('trip-free').value.length > 3;
    await applyTripText(); await wait(400);
    const said = $('trip-free-said');
    out.said = /הבנתי/.test(said.innerText);
    const bd = said.querySelector('bdi[dir="ltr"]');
    out.chipDir = !!bd && /^\d{1,2}\.\d{1,2}–\d{1,2}\.\d{1,2}$/.test(bd.textContent);
    // "נקה" clears the sentence, the dates and what it said it understood
    resetTripDates(); await wait(80);
    out.cleared = !$('trip-free').value && !said.innerText.trim() && !$('trip-dates').value;
    closeM('hotelModal');
    return out;
  });
  if (!r.noPhantom) fail(T, 'the price box still speaks of a search "below" before there is one'); else ok();
  if (!r.filled || !r.said) fail(T, `the example and "מלא בשבילי": filled ${r.filled}, understood ${r.said}`); else ok();
  if (!r.chipDir) fail(T, 'the dates chip is not set left-to-right'); else ok();
  if (!r.cleared) fail(T, '"נקה" leaves the sentence, the dates or the "הבנתי" box behind'); else ok();
}

// ── a review is deleted the way a forum post is ──────────────────────
{
  const T = 'a review is deleted the way a forum post is';
  const r = await page.evaluate(async () => {
    const out = {};
    const keepU = user, keepR = _reviews;
    user = { sbId: 'me', isAdmin: false, name: 'בודק' };
    _reviews = [{ id: 'r1', authorId: 'me', user: 'בודק', cat: 'כללי', rating: 5, text: 'טוב', timestamp: Date.now() }].concat(_reviews);
    _revCatFilter = 'all';
    renderReviews();
    deleteReview('r1');
    const bar = document.querySelector('.rev-del-confirm');
    out.inline = !!bar && /למחוק את הביקורת/.test(bar.innerText) && !document.getElementById('ui-dialog');
    deleteReview(null);
    out.closes = !document.querySelector('.rev-del-confirm');
    user = keepU; _reviews = keepR; renderReviews();
    out.candles = /ico-candle/.test(document.getElementById('kosher-modal-title').innerHTML);
    return out;
  });
  if (!r.inline || !r.closes) fail(T, `inline confirm: shown ${r.inline}, put away ${r.closes}`); else ok();
  if (!r.candles) fail(T, 'the kosher title has lost its two drawn candles'); else ok();
}

// ── videos worth watching ────────────────────────────────────────────
// Yossi, 11.11: useful videos - tutorials in the lessons panel, the Ventina
// filmed, the official ones. Every one is a checked address.
{
  const T = 'videos worth watching';
  const VER = JSON.parse(fs.readFileSync(new URL('./verified_urls.json', import.meta.url), 'utf8'));
  const r = await page.evaluate(async () => {
    const $ = id => document.getElementById(id), out = {};
    openM('lessonsModal');
    const box = $('les-videos');
    const lv = box ? [...box.querySelectorAll('a.les-video')] : [];
    out.lessons = lv.map(a => a.href);
    out.levels = !!box && /מתחילים/.test(box.innerText) && /מתקדמים/.test(box.innerText);
    out.visible = !!box && box.offsetParent !== null;
    closeM('lessonsModal');
    _mapCurrentType = _texts.pistes.route_map.map;
    mapShowRoute('ventina');
    const a = $('map-route-video').querySelector('a');
    out.ventina = a ? a.href : '';
    mapShowRoute('grand_tour');
    out.noVideoElsewhere = !$('map-route-video').querySelector('a');
    mapShowRoute('grand_tour');
    out.why = [...document.querySelectorAll('#whyModal a[href*="youtube.com"]')].map(x => x.href);
    out.valt = [...$('lodging-body').querySelectorAll('a[href*="youtube.com"]')].map(x => x.href);
    return out;
  });
  const ok2 = u => VER.exact.includes(u) || VER.exact.includes(u.replace(/\/$/, ''));
  const all = [...r.lessons, r.ventina, ...r.why, ...r.valt].filter(Boolean);
  if (r.lessons.length < 4 || !r.levels || !r.visible) fail(T, `the lessons panel has ${r.lessons.length} tutorials (levels ${r.levels}, shown ${r.visible})`); else ok();
  if (!/R4QD6aEve0g/.test(r.ventina) || !r.noVideoElsewhere) fail(T, `the Ventina route does not offer its video, or another route does (${r.ventina})`); else ok();
  if (r.why.length < 3 || !r.valt.some(u => /5GPIabg51_A/.test(u))) fail(T, `the official videos are missing (why ${r.why.length}, Valtournenche ${r.valt.length})`); else ok();
  const unchecked = all.filter(u => !ok2(u));
  if (unchecked.length) fail(T, `videos linked without a check on record: ${unchecked.join(' ')}`); else ok();
}

// ── where to sleep ───────────────────────────────────────────────────
// Yossi, 11.11: a section on lodging in the village - the three areas of
// his map, outside the village, the kinds of lodging, what to ask, parking.
{
  const T = 'where to sleep in the village';
  const r = await page.evaluate(async () => {
    const $ = id => document.getElementById(id);
    const out = {};
    const card = $('svc-lodging');
    out.card = !!card && card.closest('.services-grid') !== null && !!card.querySelector('use[href="#ico-house"]');
    card && card.click();
    await new Promise(res => setTimeout(res, 150));
    out.open = getComputedStyle($('lodgingModal')).display !== 'none';
    const txt = $('lodging-body').innerText;
    out.areas = ['מרכז הכפר', 'Giomein', 'Cielo Alto', 'Plan Maison', 'Valtournenche'].filter(w => !txt.includes(w));
    out.yossi = [/20 דקות הליכה בעלייה תלולה/, /Ski in\/Ski out/, /רק לשני מסלולים שחורים/, /Zona a Traffico Limitato/, /אינה מופיעה במפות/, /בחצי עמידה/, /רכבל הכיסא הראשון/, /Hotel Lo Stambecco/, /אין אליו כביש/, /בדקו מראש היכן חונים/, /רק בתנאי שלג מתאימים/, /פריקה וטעינה/, /צמודה לתקרה/, /מרווחות יותר באותו מחיר/, /פינוי שלג/, /ZTL/, /Genzianella/].filter(re => !re.test(txt)).map(String);
    out.chips = $('lodgingModal').querySelectorAll('.panel-toc button').length;
    out.piste = /פיסטה|מוסך/.test(txt);
    out.stambecco = !!$('lodging-body').querySelector('a[href*="hotel-lo-stambecco"]') && !!$('lodging-body').querySelector('[onclick*="kosherModal"]');
    out.mapLink = !!$('lodging-body').querySelector('a[onclick*="loadMap(\'mymap\')"]');
    // the map button lands on Yossi's map, and closing it returns to the guide
    const mapBtn = [...$('lodging-body').querySelectorAll('button')].find(b => /נקודות הציון/.test(b.textContent));
    mapBtn && mapBtn.click();
    await new Promise(res => setTimeout(res, 200));
    out.mapOpen = getComputedStyle($('mapModal')).display !== 'none' && getComputedStyle($('lodgingModal')).display === 'none';
    closeM('mapModal');
    await new Promise(res => setTimeout(res, 120));
    out.backToGuide = getComputedStyle($('lodgingModal')).display !== 'none';
    closeM('lodgingModal');
    // from the lodging search screen
    openM('hotelModal'); planGo('hotel');
    const g = $('hotel-guide-link');
    out.fromSearch = !!g && g.offsetParent !== null;
    closeM('hotelModal');
    out.search = SEARCH_INDEX.some(e => /lodgingModal/.test(e.action));
    out.hash = typeof _panelHashOf === 'function' && _panelHashOf('lodgingModal') === 'lodging';
    return out;
  });
  if (!r.card) fail(T, 'no "where to sleep" card with its house icon on the home page'); else ok();
  if (!r.open) fail(T, 'the card does not open the lodging guide'); else ok();
  if (r.areas.length) fail(T, `the guide does not name: ${r.areas.join(', ')}`); else ok();
  if (r.yossi.length) fail(T, `Yossi's points are missing: ${r.yossi.join(' ')}`); else ok();
  if (!r.stambecco) fail(T, 'the Plan Maison hotel has no link to its page or to the kosher holiday'); else ok();
  if (r.piste) fail(T, 'the guide says פיסטה or מוסך - the words people use are מסלול and חניה'); else ok();
  if (r.chips < 5) fail(T, `the guide has ${r.chips} chips, not one per section`); else ok();
  if (!r.mapLink) fail(T, 'the words "מפת נקודות הציון" are not a link to the map'); else ok();
  if (!r.mapOpen || !r.backToGuide) fail(T, `the map button: opens ${r.mapOpen}, returns ${r.backToGuide}`); else ok();
  if (!r.fromSearch) fail(T, 'the lodging search screen has no way to the guide'); else ok();
  if (!r.search || !r.hash) fail(T, `the guide is not in the site search (${r.search}) or has no address (${r.hash})`); else ok();
}

// ── the phone's back button closes, it does not leave ───────────────
// Yossi, 11.11: back on a phone left the site whatever was open. Now back
// closes the top layer; with nothing open it says how to leave, and only a
// second back leaves. Its own page, because the last step really leaves.
{
  const T = 'the back button closes, it does not leave';
  const pb = await browser.newPage({ viewport: { width: 390, height: 800 } });
  await pb.goto('about:blank');
  await pb.goto('file://' + PAGE);
  await pb.waitForTimeout(900);
  // a back that leaves the site takes the page with it: that is a finding, not a crash
  const st = () => pb.evaluate(() => ({
    url: location.href,
    open: [...document.querySelectorAll('.modal')].filter(m => m.style.display && m.style.display !== 'none').map(m => m.id),
    side: typeof _sideMenuOpen === 'function' ? _sideMenuOpen() : null,
    toast: (() => { const t = document.getElementById('back-toast'); return t && t.style.display !== 'none' ? t.textContent : ''; })()
  })).catch(() => ({ url: pb.url(), open: [], side: null, toast: '' }));
  // two panels deep: back closes the top one, then the next
  await pb.evaluate(() => { openM('pisteModal'); if (typeof openSources === 'function') openSources('pistes'); }).catch(() => {});
  await pb.waitForTimeout(150);
  const before = await st();
  await pb.goBack(); await pb.waitForTimeout(250);
  const one = await st();
  await pb.goBack(); await pb.waitForTimeout(250);
  const two = await st();
  // the side menu
  await pb.evaluate(() => openSideMenu()).catch(() => {}); await pb.waitForTimeout(300);
  await pb.goBack(); await pb.waitForTimeout(300);
  const side = await st();
  // nothing open: a word, not an exit
  await pb.waitForTimeout(3200);           // let any earlier arming lapse
  await pb.goBack(); await pb.waitForTimeout(250);
  const warn = await st();
  // and a second back leaves
  await pb.goBack(); await pb.waitForTimeout(600);
  const gone = pb.url();
  await pb.close();

  if (before.open.length < 2) fail(T, `could not open two panels (${before.open})`);
  else if (one.open.length !== before.open.length - 1 || !/file:/.test(one.url)) fail(T,
    `back did not close just the top panel: ${before.open} → ${one.open} (${one.url})`); else ok();
  if (two.open.length !== 0 || !/file:/.test(two.url)) fail(T,
    `a second back did not close the last panel: ${two.open}`); else ok();
  if (side.side || !/file:/.test(side.url)) fail(T, 'back does not close the side menu'); else ok();
  if (!/file:/.test(warn.url) || !/לחצו שוב/.test(warn.toast)) fail(T,
    `with nothing open, back left or said nothing ("${warn.toast}", ${warn.url})`); else ok();
  if (/file:/.test(gone)) fail(T, `a second back right after the warning did not leave (${gone})`); else ok();
}

// ── L() is the language switch, and a local may not take its name ──────────
// A function-scoped "var L" hides the global for the whole function, hoisted,
// so every L('…', '…') inside it calls a number and throws - only on the
// pages that reach that function. Three such locals had to be renamed when
// the English site began; this keeps a fourth from arriving.
{
  const T0 = 'no local variable is called L';
  const src = fs.readFileSync(PAGE, 'utf8');
  const bad = [];
  src.split('\n').forEach((ln, i) => {
    if (/(?:^|[^\w$.])(?:var|let|const)\s+L\s*[=,;]/.test(ln) || /function\s*\w*\s*\([^)]*\bL\b[^)]*\)/.test(ln))
      bad.push((i + 1) + ': ' + ln.trim().slice(0, 80));
  });
  if (bad.length) fail(T0, bad.join(' | ')); else ok(T0);
}

// ── the English flight search asks where you fly from ─────────────────────
// The Hebrew site is for travellers from Israel and always searches from
// Tel Aviv. The English one must not: with no origin it searches nothing,
// and with one every engine gets it.
{
  const T0 = 'the English flight search starts from the origin the reader gave';
  const pg = await browser.newPage({ viewport: { width: 430, height: 900 } });
  await pg.goto('file://' + PAGE + '?lang=en');
  await pg.waitForTimeout(1500);
  const r = await pg.evaluate(() => {
    openM('hotelModal'); planGo('flight');
    try { localStorage.removeItem('cl_origin'); } catch (e) {}
    document.getElementById('fl-origin').value = '';
    var none = flOrigin();
    document.getElementById('fl-origin').value = 'Vienna';
    var byName = flOrigin();
    document.getElementById('fl-origin').value = 'London Heathrow (LHR)';
    var byCode = flOrigin();
    stripSetDates(new Date(2027, 0, 10), new Date(2027, 0, 17));
    searchFlight();
    var links = [].map.call(document.querySelectorAll('#flight-results a'), function (a) { return a.href; });
    return { none: none, byName: byName, byCode: byCode, links: links };
  });
  const tlv = r.links.filter(h => /tlv/i.test(h));
  if (r.none !== null) fail(T0, 'an empty field gave ' + r.none);
  else if (r.byName !== 'VIE' || r.byCode !== 'LHR') fail(T0, 'Vienna -> ' + r.byName + ', LHR -> ' + r.byCode);
  else if (!r.links.length || tlv.length) fail(T0, tlv.length ? 'Tel Aviv in ' + tlv[0] : 'no links');
  else ok(T0);
  await pg.close();
}

await browser.close();

// ── report ────────────────────────────────────────────────────────────────
const line = '─'.repeat(64);
console.log(line);
console.log(`עברו ${passed} · נכשלו ${fails.length} · אזהרות ${warns.length}`);
console.log(line);
for (const f of fails) console.log(`✗ ${f.test}\n   ${f.detail}`);
for (const w of warns) console.log(`⚠ ${w.test}\n   ${w.detail}`);
if (!fails.length && !warns.length) console.log('הכול תקין.');
process.exit(fails.length ? 1 : 0);

