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
    const card = document.getElementById('svc-webcam');
    const out = {};
    // a picture that loads
    const good = 'data:image/svg+xml;base64,' + btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="24">'
      + '<rect width="40" height="24" fill="#9fd0f5"/></svg>');
    SVC_CAM_URL = good;
    refreshServiceCam();
    await wait(500);
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
    SVC_CAM_URL = 'https://example.invalid/none.jpg';
    refreshServiceCam();
    await wait(700);
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
      inJson: (t.kosher.cervinia_products || []).length,
      items: li ? li.children.length : 0,
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
      leftATag: /<(p|b|img|script)[ >]/i.test(box.innerHTML),
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

    // saved searches
    try { localStorage.removeItem('cl_saved_trips'); } catch (e) {}
    const dt2 = document.getElementById('trip-dates');
    if (dt2) { dt2.setAttribute('data-ci', '2027-01-10'); dt2.setAttribute('data-co', '2027-01-17'); }
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
    await populateAdminStats();
    await new Promise(r2 => setTimeout(r2, 120));
    const txt = id => (document.getElementById(id) || {}).textContent || '';
    const out = { posts: txt('stat-posts'), today: txt('stat-today-posts'),
                  reactions: txt('stat-reactions'), users: txt('stat-users'),
                  usesWindow: /window\.allPosts\s*\|\|/.test(populateAdminStats.toString()) };
    // and the close control must be visible against its own header
    // the user count, with the query answering and then refusing
    const realFetch = window.sbFetch;
    window.sbFetch = async () => new Array(7).fill(0).map((_, i) => ({ id: i }));
    await _admCountUsers(); await new Promise(r2 => setTimeout(r2, 40));
    out.usersOk = txt('stat-users');
    window.sbFetch = async () => null;
    await _admCountUsers(); await new Promise(r2 => setTimeout(r2, 40));
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
    const out = { placeholder: inp.getAttribute('placeholder') || '' };
    const say = (v) => { inp.value = v; checkPassValidity(); return msg.textContent || ''; };
    out.short  = say('abc');
    out.hebrew = say('סיסמא123');
    out.digits = say('123456');       // digits only - allowed, and must be ACCEPTED
    out.weak   = say('abcdef');
    out.strong = say('Abcdef!');
    inp.value = ''; checkPassValidity();
    return out;
  });

  const T = 'the password rule says what it actually enforces';
  if (r.missing) warn(T, 'the registration password field is not on the page');
  else {
    if (/באנגלית/.test(r.placeholder)) fail(T,
      `the field still says "${r.placeholder}" - digits and symbols are accepted too`); else ok();
    if (!/6/.test(r.placeholder)) fail(T,
      'the field no longer states the one rule there is'); else ok();
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
    out.viewCount  = /profiles_public\?select=id/.test(src);
    out.loginRpc   = /rpc\('cl_login_email'/.test(src) &&
                     !/from\('profiles'\)\.select\('internal_email'\)/.test(src);
    out.takenRpc   = /rpc\('cl_username_taken'/.test(src);
    out.resetRpc   = /rpc\('cl_reset_email'/.test(src);
    out.regRpc     = /rpc\('cl_register_profile'/.test(src) &&
                     !/upsert\(\{[\s\S]{0,120}internal_email/.test(src);
    out.stub = /יצטרך Supabase/.test(document.documentElement.innerHTML);
    return out;
  });

  const T = 'the users tab lists the users';
  if (r.unreachable) warn(T, '_admRenderUsers is not reachable from the page scope');
  else if (r.noHost) fail(T, 'there is no #admin-users-list to fill');
  else {
    if (r.stub) fail(T,
      'the placeholder text is still in the page - the tab was not rebuilt'); else ok();
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
    if (!r.takenRpc || !r.resetRpc) fail(T,
      'the name-taken check or the reset lookup still reads the table'); else ok();
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

// ── the search box is not a login field ─────────────────────────────────
// Chrome kept offering a saved credential over it - not autocomplete and
// not form restoration, but the PASSWORD MANAGER, which is why type=search,
// a name of its own and autocomplete=off all failed: those are hints. It
// offers nothing on a readonly field, and the attribute comes off the
// moment the reader touches it.
{
  const r = await page.evaluate(() => {
    const el = document.getElementById('global-search-input');
    if (!el) return { missing: true };
    const before = el.hasAttribute('readonly');
    el.dispatchEvent(new Event('focus'));
    const afterFocus = el.hasAttribute('readonly');
    el.dispatchEvent(new Event('blur'));
    const afterBlur = el.hasAttribute('readonly');
    return { before, afterFocus, afterBlur,
             type: el.getAttribute('type'),
             ignores: !!el.getAttribute('data-lpignore') && el.hasAttribute('data-1p-ignore') };
  });

  const T = 'the search box is not a login field';
  if (r.missing) { fail(T, 'there is no search field'); }
  else {
    if (!r.before) fail(T,
      'the field is writable before it is touched, so the password manager can offer on it'); else ok();
    if (r.afterFocus) fail(T,
      'the field stayed readonly after focus - nobody can type in it'); else ok();
    if (!r.afterBlur) fail(T,
      'the guard is not restored on blur, so it protects only the first visit'); else ok();
    if (r.type !== 'search') fail(T, `type is "${r.type}"`); else ok();
    if (!r.ignores) fail(T, 'the password-manager opt-outs are missing'); else ok();
  }
}

// ── every card's picture is drawn, not typed ─────────────────────────────
// An emoji character is a request, not a picture: the reader sees whatever
// their system font draws. U+1F3BF is "skis and ski boot" in Unicode and
// Windows renders it as something closer to a snowboard, which is a picture
// arguing with its own label. These are Google's drawings of the same
// characters, defined once as symbols and referenced by every card.
{
  const r = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.services-grid .service-btn')];
    const out = { cards: cards.length, noIcon: [], stillEmoji: [], broken: [], sizes: [] };
    for (const c of cards) {
      const ico = c.querySelector('.svc-ico');
      if (!ico) { out.noIcon.push(c.id); continue; }
      const use = ico.querySelector('svg use');
      if (!use) {
        // anything that is not a <use> reference is a bare character
        if (ico.textContent.trim()) out.stillEmoji.push(c.id + ':' + ico.textContent.trim());
        else out.noIcon.push(c.id);
        continue;
      }
      const id = (use.getAttribute('href') || use.getAttribute('xlink:href') || '').replace('#', '');
      if (!id || !document.getElementById(id)) { out.broken.push(c.id + '->' + id); continue; }
      const box = ico.querySelector('svg').getBoundingClientRect();
      out.sizes.push(Math.round(box.width));
    }
    // the sprite itself must take no space in the layout
    const sprite = document.querySelector('svg[aria-hidden="true"][style*="width:0"]');
    out.spriteHidden = !!sprite && Math.round(sprite.getBoundingClientRect().height) === 0;
    out.symbols = sprite ? sprite.querySelectorAll('symbol').length : 0;
    return out;
  });

  const T = "every card's picture is drawn, not typed";
  if (r.cards < 8) fail(T, `only ${r.cards} cards`); else ok();
  if (r.noIcon.length) fail(T, `cards with no icon at all: ${r.noIcon.join(', ')}`); else ok();
  if (r.stillEmoji.length) fail(T,
    `still drawing with a font character: ${r.stillEmoji.join(', ')}`); else ok();
  if (r.broken.length) fail(T,
    `a card points at a symbol that is not there: ${r.broken.join(', ')}`); else ok();
  if (r.symbols < r.cards) fail(T,
    `${r.symbols} symbols defined for ${r.cards} cards`); else ok();
  if (!r.spriteHidden) fail(T,
    'the sprite is taking up space in the page instead of hiding'); else ok();
  if (r.sizes.some(w => w < 14 || w > 40)) fail(T,
    `an icon rendered at ${Math.min(...r.sizes)}-${Math.max(...r.sizes)}px`); else ok();
}

// ── the cards promise what the panels hold ───────────────────────────────
// The subtitles live in texts.json, and the markup carries a copy as the
// fallback for when that file cannot be fetched. The two drifted: the piste
// card still said "איפה אוכלים על ההר" in the markup weeks after the line
// was taken out of the content file, and anyone whose texts.json failed to
// load saw the old wording. Whatever the reason for a mismatch, it means one
// of the two is wrong.
{
  // BOTH sides come off disk, and that is the whole point. The first version
  // of this check read the live DOM - but _applyTexts runs near the top of
  // this suite and rewrites every card from texts.json, so by the time the
  // check ran it was comparing the content file against itself and passed
  // whatever the markup said. It sat there green while index.html still
  // carried "בשאלה אחת" and texts.json said "בשאילתא אחת".
  const buttons = (JSON.parse(fs.readFileSync(TEXTS, 'utf8')).services || {}).buttons || [];
  const pageSrc = fs.readFileSync(PAGE, 'utf8');
  const r = (() => {
    const out = { missing: [], drift: [], iconDrift: [], count: buttons.length };
    for (const b of buttons) {
      const re = new RegExp(
        '<div id="' + b.id + '" class="service-btn[^"]*"[^>]*>\\s*' +
        '(?:<!--[\\s\\S]*?-->\\s*)?<span class="svc-ico">([\\s\\S]*?)</span>[\\s\\S]*?' +
        '<span class="svc-txt"><b>([\\s\\S]*?)</b>\\s*<small>([\\s\\S]*?)</small>');
      const m = re.exec(pageSrc);
      if (!m) { out.missing.push(b.id); continue; }
      const norm = (x) => x.replace(/\s+/g, ' ').trim();
      const I = norm(m[1]), L = norm(m[2]), S = norm(m[3]);
      if (L !== String(b.label || '').trim() || S !== String(b.sub || '').trim()) {
        out.drift.push({ id: b.id, markup: S, json: String(b.sub || '').trim() });
      }
      // The icon drifts the same way and is harder to notice: _applyTexts
      // overwrites it from texts.json the moment the content file loads, so
      // a stale emoji in the markup is invisible until the day that fetch
      // fails - and then the card shows a different picture than everyone
      // else sees.
      if (I !== norm(String(b.icon || ''))) {
        out.iconDrift.push({ id: b.id,
          markup: I.slice(0, 40), json: norm(String(b.icon || '')).slice(0, 40) });
      }
    }
    return out;
  })();
  const _unused = async (btns) => {
    const out = { missing: [], drift: [], count: btns.length };
    for (const b of btns) {
      const el = document.getElementById(b.id);
      if (!el) { out.missing.push(b.id); continue; }
      const lab = el.querySelector('.svc-txt b');
      const sub = el.querySelector('.svc-txt small');
      const L = lab ? lab.textContent.trim() : '';
      const S = sub ? sub.textContent.trim() : '';
      if (L !== (b.label || '').trim() || S !== (b.sub || '').trim()) {
        out.drift.push({ id: b.id, markup: S, json: (b.sub || '').trim() });
      }
    }
    return out;
  };

  const T = 'the cards promise what the panels hold';
  if (r.count < 8) fail(T, `only ${r.count} service buttons in texts.json`); else ok();
  if (r.missing.length) fail(T,
    `texts.json names cards the page does not have: ${r.missing.join(', ')}`); else ok();
  if (r.drift.length) fail(T,
    'markup and texts.json disagree: ' + r.drift.map(d =>
      `${d.id} markup="${d.markup}" json="${d.json}"`).join(' ; ')); else ok();
  if (r.iconDrift.length) fail(T,
    'the icons disagree: ' + r.iconDrift.map(d =>
      `${d.id} markup="${d.markup}" json="${d.json}"`).join(' ; ')); else ok();
}

// ── the search box in the header is a search box ─────────────────────────
// It had no name and no type beyond "text", which is exactly the shape
// Chrome decides is a "your name" field: it filled it with the saved name
// and painted its own opaque background over a field that sits in a dark
// header. autocomplete="off" does not stop that on its own.
{
  const r = await page.evaluate(() => {
    const el = document.getElementById('global-search-input');
    if (!el) return { missing: true };
    // The raw stylesheet text, not the parsed rules: a browser that does not
    // understand :-webkit-autofill drops the rule from cssRules entirely, and
    // the guard would look missing when it is right there in the file.
    const css = [...document.querySelectorAll('style')].map(n => n.textContent).join('\n');
    return {
      type: el.getAttribute('type'),
      name: el.getAttribute('name') || '',
      auto: el.getAttribute('autocomplete'),
      label: el.getAttribute('aria-label') || '',
      hasAutofillGuard: /#global-search-input:-webkit-autofill/.test(css)
                        && /-webkit-box-shadow[^;]*inset/.test(css)
    };
  });

  const T = 'the search box in the header is a search box';
  if (r.missing) { fail(T, 'there is no #global-search-input at all'); }
  else {
    if (r.type !== 'search') fail(T, `type is "${r.type}", not search`); else ok();
    if (!r.name) fail(T, 'the field still has no name, so the browser guesses'); else ok();
    if (r.auto !== 'off') fail(T, `autocomplete is "${r.auto}"`); else ok();
    if (!r.label) fail(T, 'the field has no accessible label'); else ok();
    if (!r.hasAutofillGuard) fail(T,
      'nothing covers the colour a browser paints when it autofills anyway'); else ok();
  }
}

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
    await new Promise(res => setTimeout(res, 300));
    const menu = document.getElementById('side-menu');
    out.onScreen = menu.getBoundingClientRect().right > 0
                && menu.getBoundingClientRect().left < window.innerWidth
                && menu.classList.contains('on');
    out.items = [...document.querySelectorAll('#side-menu-links button')].map(b => b.textContent.trim());

    // the drawer has to get out of the way before what it opens appears
    smGo('install');
    await new Promise(res => setTimeout(res, 500));
    out.closedAfterGo = !menu.classList.contains('on');
    out.helpOpen = document.getElementById('helpModal').style.display === 'flex';
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
  if (!/מדידה אוטומטית/.test(r.sysCard))
    fail(T, 'the system card does not say it is a measurement'); else ok();
  if (!/👤/.test(r.humanCard))
    fail(T, "a person's card lost its person icon"); else ok();
  if (/מדידה אוטומטית/.test(r.humanCard))
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
    const tagAt  = html.indexOf('מדידה אוטומטית');
    const textAt = html.indexOf('רוח חזקה בהר');
    out.chipBeforeText = tagAt >= 0 && textAt >= 0 && tagAt < textAt;
    out.humanCardClean = _alertCardHtml(_alerts[1]).indexOf('מדידה אוטומטית') < 0;
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
