// Offline support: the app shell loads from cache instantly and refreshes in the background;
// data files and API calls go to the network first and fall back to the last saved copy.
const CACHE = 'pi-v3';
const SHELL = ['./', './index.html', './app.js?v=2', './manifest.webmanifest', './icons/icon-192.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isData = url.pathname.endsWith('.json') || url.pathname.includes('/api/');
  const isAI = url.pathname.includes('/api/ai');
  if (isAI) return;
  if (isData) {
    // Network first, cached copy if offline
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, {ignoreSearch: url.origin === location.origin}).then(r => r || Response.error())));
    return;
  }
  // Stale while revalidate for the page, icons and libraries
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
