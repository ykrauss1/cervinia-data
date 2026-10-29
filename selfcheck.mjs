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
    const read = () => document.getElementById('zermatt-status').textContent.trim();
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
  // and the one that has to travel two levels down really gets there
  const deep = await page.evaluate(async () => {
    openWhenToGo();
    await new Promise(r => setTimeout(r, 400));
    const d = document.querySelector('#season-box details');
    const open = !!(d && d.open);
    closeM('hotelModal');
    return open;
  });
  if (!deep) fail('the search bar finds the newer sections',
    '"when to go" opened the panel but left the card collapsed');
  else ok();
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
  if (!/הזמינו מראש/.test(r.booking_warning || '')) fail('the rental prices come from a published list',
    'nothing on the page warns about turning up without a booking'); else ok();
  const shown = await page.evaluate(() => {
    openM('rentalModal');
    const w = document.getElementById('rental-booking-warning');
    return !!(w && w.textContent.trim().length > 60);
  });
  if (!shown) fail('the rental prices come from a published list',
    'the booking warning is in the content file but never drawn'); else ok();

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

  // the midday closure is the detail that sends people to a locked door
  if (!(r.tips || []).some(t => /12:30/.test(t))) fail('every rental shop is listed under its own name',
    'the page does not say the village shops close at midday'); else ok();

  // Renting up at Plan Maison costs you two things, and the page used to
  // name neither properly: on a windy day the gear is out of reach even if
  // another sector is open, and every day has to end at the gondola, before
  // it stops - no last run down to the village, no run after an apres-ski.
  const pm = await page.evaluate(() => {
    const card = [...document.querySelectorAll('#rentalModal div')]
      .find(d => /Adriano Sport/.test(d.textContent) && d.textContent.length < 900);
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
    await new Promise(res => setTimeout(res, 300));
    const menu = document.getElementById('side-menu');
    out.onScreen = menu.getBoundingClientRect().right > 0
                && menu.getBoundingClientRect().left < window.innerWidth
                && menu.classList.contains('on');
    out.items = [...document.querySelectorAll('#side-menu-links button')].map(b => b.textContent.trim());

    // the drawer has to get out of the way before what it opens appears
    smGo('help');
    await new Promise(res => setTimeout(res, 400));
    out.closedAfterGo = !menu.classList.contains('on');
    out.helpOpen = document.getElementById('helpModal').style.display === 'flex';
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
  if (r.items.length !== 4) fail('the standing links are reachable without scrolling',
    `the menu holds ${r.items.length} items: ${JSON.stringify(r.items)}`); else ok();
  if (!r.closedAfterGo || !r.helpOpen) fail('the standing links are reachable without scrolling',
    `choosing an item left the drawer open (${!r.closedAfterGo}) or opened nothing (${!r.helpOpen})`); else ok();
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
