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

const LAUNCH = fs.existsSync('/opt/pw-browsers/chromium')
  ? { executablePath: '/opt/pw-browsers/chromium' } : {};
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
