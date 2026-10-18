/* CerviniaLive service worker
 *
 * Two jobs, and deliberately not a third.
 *
 *  1. Receive push messages and show them, even when the site is closed.
 *  2. Give the app something to open when there is no signal on the mountain.
 *
 * What it does NOT do is cache index.html aggressively. That file is ~1.8MB and
 * changes on most deploys; a cache-first worker would keep serving yesterday's
 * app and no amount of Ctrl+F5 would obviously fix it. So: network first,
 * always, and the cached copy is only a parachute.
 */

const CACHE = 'cervinia-v1';
const FALLBACK = './index.html';

self.addEventListener('install', function (e) {
  // take over as soon as possible - an old worker serving a stale fallback is
  // exactly the confusion we are trying to avoid
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(['./manifest.json', './icon-192.png']).catch(function () {});
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

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  // Only page navigations get the parachute. Everything else is left alone, so
  // live data (Supabase, the scraper's data.json) is never served from a cache.
  if (req.mode !== 'navigate') return;
  e.respondWith(
    fetch(req)
      .then(function (res) {
        const copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(FALLBACK, copy); }).catch(function () {});
        return res;
      })
      .catch(function () {
        return caches.match(FALLBACK).then(function (hit) {
          return hit || new Response('<h1 dir="rtl">אין חיבור</h1>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        });
      })
  );
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
