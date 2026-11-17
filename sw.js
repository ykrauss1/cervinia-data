/* CerviniaLive service worker
 *
 *  1. Receive push messages and show them, even when the site is closed.
 *  2. Keep the site working with no signal on the mountain.
 *
 * Five kinds of request, five rules:
 *
 *  - The page itself (navigations): network first, the cached copy only as a
 *    parachute. index.html changes on most deploys; cache-first would keep
 *    serving yesterday's app.
 *  - The texts (texts.json, texts.en.json, manifest.json): network first too,
 *    for the same reason - but without them the page is an empty shell, so
 *    they are precached and answered from the cache when the network fails
 *    or is too slow. A weak signal that never answers is the usual case on a
 *    lift, so the network gets SLOW_MS before the cached copy is used.
 *  - Pictures, maps and PDFs of the site, and the libraries from the CDNs
 *    (flatpickr, supabase-js, pdf.js): cache first, with a fresh copy fetched
 *    quietly for next time. Their names change when their content does.
 *  - The latest lift reading and the weather forecast: network first, and
 *    the last good answer only when there is no network at all. The page
 *    already prints the time of the reading, and shows a bar saying there is
 *    no connection, so an old answer is never mistaken for a new one.
 *  - Everything else - sign-in, the forum, anything that writes - is left
 *    alone, never cached.
 */

const CACHE = 'cervinia-v4';
const FALLBACK = './index.html';
const SLOW_MS = 4000;

// Precached at install, so all of it is there even for somebody who never
// opened the panel in question while they still had a signal - which is most
// people. The big PDFs of the piste maps are NOT here (11 MB): a button in
// the maps panel saves them on request, and opening one saves it too.
const STATIC = ['./index.html', './manifest.json', './icon-192.png',
                './texts.json', './texts.en.json',
                './img/piste-map.jpg', './img/logo.png', './img/montblanc.webp',
                './hero-cervino.jpg', './mymap.jpg', './town-map.jpg',
                './maps/route-grand_tour.jpg', './maps/route-ventina.jpg', './maps/route-warmup.jpg',
                './files/packing-list.pdf',
                'https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/dist/flatpickr.min.js',
                'https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/dist/flatpickr.min.css',
                'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
                'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
                'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'];

// Libraries are pinned to a version in their address, so a cached copy is
// the same file the network would send.
const CDN = /^https:\/\/(cdn\.jsdelivr\.net\/npm\/(flatpickr|@supabase\/supabase-js|@emailjs\/browser)|cdnjs\.cloudflare\.com\/ajax\/libs\/(pdf\.js|cropperjs))\//;
// The two live answers worth keeping for a day without signal.
const LIVE = /^https:\/\/(api\.open-meteo\.com\/v1\/forecast|[a-z0-9]+\.supabase\.co\/rest\/v1\/ski_status_history\?)/;

self.addEventListener('install', function (e) {
  // take over as soon as possible - an old worker serving a stale fallback is
  // exactly the confusion we are trying to avoid
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // One addAll fails as a whole if any single file 404s, and then nothing
      // at all is precached. Each on its own, so one missing picture cannot
      // cost us the rest.
      return Promise.all(STATIC.map(function (u) {
        return c.add(u).catch(function () {});
      }));
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
});

// Cache first, refreshed in the background.
function cacheFirst(req, key) {
  return caches.open(CACHE).then(function (c) {
    return c.match(key || req, { ignoreVary: true }).then(function (hit) {
      const net = fetch(req).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) { c.put(key || req, res.clone()).catch(function () {}); }
        return res;
      }).catch(function () { return hit || Response.error(); });
      return hit || net;
    });
  });
}

// Network first; the cached copy when the network fails, or - if wait is
// given - when it has not answered within wait ms.
function networkFirst(req, key, wait) {
  return caches.open(CACHE).then(function (c) {
    const net = fetch(req).then(function (res) {
      if (res && res.ok) { c.put(key, res.clone()).catch(function () {}); }
      return res;
    });
    const fromCache = function () {
      return c.match(key, { ignoreVary: true }).then(function (hit) { return hit || net; });
    };
    if (!wait) return net.catch(fromCache);
    return new Promise(function (resolve) {
      let done = false;
      const t = setTimeout(function () {
        c.match(key, { ignoreVary: true }).then(function (hit) {
          if (hit && !done) { done = true; resolve(hit); }
        });
      }, wait);
      net.then(function (res) { if (!done) { done = true; clearTimeout(t); resolve(res); } })
         .catch(function () { if (!done) { done = true; clearTimeout(t); resolve(fromCache()); } });
    });
  });
}

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url = null;
  try { url = new URL(req.url); } catch (err) { return; }
  const same = url.origin === self.location.origin;
  const scopePath = new URL(self.registration.scope).pathname;
  const rel = same ? url.pathname.slice(scopePath.length) : '';

  // ── the texts: network first, the saved copy when slow or offline ─────
  if (same && /^(texts\.json|texts\.en\.json|manifest\.json)$/.test(rel)) {
    // one key per file, whatever ?query the page added
    e.respondWith(networkFirst(req, './' + rel, SLOW_MS));
    return;
  }

  // ── pictures, maps, PDFs: cache first ─────────────────────────────────
  // (img/ and files/ and maps/, and the pictures and PDFs at the top level)
  if (same && (/^(img|files|maps)\//.test(rel) || /^[^/]+\.(jpg|jpeg|png|webp|pdf|ico)$/.test(rel))) {
    e.respondWith(cacheFirst(req, './' + rel));
    return;
  }

  // ── libraries from the CDNs: cache first ──────────────────────────────
  if (CDN.test(req.url)) {
    e.respondWith(cacheFirst(req));
    return;
  }

  // ── the latest reading and the forecast: last good answer if offline ──
  if (LIVE.test(req.url)) {
    e.respondWith(networkFirst(req, req.url, 0));
    return;
  }

  // Only page navigations get the parachute. Everything else is left alone, so
  // other live data is never served from a cache.
  if (req.mode !== 'navigate') return;
  // Only the site itself may become the parachute. Every navigation used to
  // be stored under index.html - the privacy page, the /en/ hand-over page,
  // a 404 - so whoever opened one of those last and then lost the signal was
  // handed that page in place of the site.
  const isHome = same && (url.pathname === scopePath || url.pathname === scopePath + 'index.html');
  e.respondWith(
    fetch(req)
      .then(function (res) {
        if (isHome && res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(FALLBACK, copy); }).catch(function () {});
        }
        return res;
      })
      .catch(function () {
        return caches.match(FALLBACK).then(function (hit) {
          return hit || new Response('<h1 dir="rtl">אין חיבור</h1>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        });
      })
  );
});

// The page asks for the big piste-map PDFs to be saved for a day without
// signal; the answer says how many made it.
self.addEventListener('message', function (e) {
  const d = e.data || {};
  if (d.type !== 'save-offline' || !Array.isArray(d.urls)) return;
  const port = e.ports && e.ports[0];
  e.waitUntil(caches.open(CACHE).then(function (c) {
    let ok = 0;
    return Promise.all(d.urls.map(function (u) {
      return c.match(u).then(function (hit) {
        if (hit) { ok++; if (port) port.postMessage({ type: 'progress', ok: ok, total: d.urls.length }); return; }
        return c.add(u).then(function () {
          ok++; if (port) port.postMessage({ type: 'progress', ok: ok, total: d.urls.length });
        }).catch(function () {});
      });
    })).then(function () { if (port) port.postMessage({ type: 'done', ok: ok, total: d.urls.length }); });
  }));
});

/* ---------------------------------------------------------------- push ---- */

self.addEventListener('push', function (e) {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }

  const title = d.title || 'צ\'רוויניה לייב';
  const opts = {
    body: d.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    lang: 'he',
    dir: 'rtl',
    // A tag means a second alert REPLACES the first instead of stacking five
    // notifications on the lock screen. Alerts and notices get their own tag so
    // one kind never silences the other.
    tag: d.tag || 'cervinia-alert',
    renotify: true,
    requireInteraction: d.severity === 'danger',
    vibrate: d.severity === 'danger' ? [200, 100, 200] : [100],
    data: { url: d.url || './index.html?open=alerts' }
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || './index.html';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      // already open somewhere? focus that tab rather than opening a second one
      for (const c of list) {
        if (c.url.indexOf(self.registration.scope) === 0 && 'focus' in c) {
          c.postMessage({ type: 'open-alerts' });
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
