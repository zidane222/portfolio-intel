// Offline support: the app shell loads from cache instantly and refreshes in the background;
// data files and API calls go to the network first and fall back to the last saved copy.
const CACHE = 'pi-v26';
const SHELL = ['./', './index.html', './js/01-config.js?v=10', './js/02-state.js?v=11', './js/03-helpers.js?v=10', './js/04-prices.js?v=10', './js/05-hero.js?v=10', './js/06-chart.js?v=10', './js/07-disclosures.js?v=13', './js/08-holdings.js?v=10', './js/09-import.js?v=10', './js/10-plaid.js?v=10', './js/11-news.js?v=11', './js/11a-news-reads.js?v=1', './js/12-watchlist.js?v=10', './js/13-ticker-page.js?v=11', './js/14-alerts.js?v=10', './js/15-share-card.js?v=10', './js/16-lock.js?v=11', './js/17-ask.js?v=15', './js/18-assistant.js?v=14', './js/19-signals.js?v=10', './js/20-ticker-banner.js?v=10', './js/21-industry-mix.js?v=10', './js/22-motion.js?v=10', './js/23-copy-test.js?v=10', './js/24-smart-money.js?v=10', './js/25-cash.js?v=10', './js/26-dividends.js?v=10', './js/27-risk.js?v=10', './js/28-review.js?v=10', './js/29-leaderboard.js?v=10', './js/29a-account.js?v=13', './js/29c-passkey.js?v=11', './js/29d-private.js?v=2', './js/29e-insights.js?v=1', './js/29b-pages.js?v=13', './js/30-init.js?v=13', './manifest.webmanifest', './icons/icon-192.png', './icons/apple-touch-icon.png'];

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
  // The page itself and app code: network first, so a new release shows on the next open
  if (req.mode === 'navigate' || (url.origin === location.origin && /\.(html|js|css)$/.test(url.pathname)) || url.pathname.endsWith('/')) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html'))));
    return;
  }
  // Stale while revalidate for icons and libraries
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
