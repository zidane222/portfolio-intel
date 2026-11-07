// ─────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────
// ── Feature flags ──
// GET /api/flags at boot and every 60 s. Closed flags (broker, sync_writes) read off until the
// gateway or the Render fallback has answered once; the rest use their defaults.
const FLAG_DEFAULTS = {maintenance: false, broker: true, sync_writes: true, ai: true, news: true, disclosures: true, market: true};
const FLAG_CLOSED = ['broker', 'sync_writes'];
const FLAG_TEXT = {maintenance: 'Portfolio Intel is in maintenance. Live data is paused; your saved data is safe on this device.',
  broker: 'Brokerage linking is turned off for now.', sync_writes: 'Cloud sync uploads are paused. Changes stay on this device and upload later.',
  ai: 'The assistant is turned off for now.', news: 'News is turned off for now.', disclosures: 'Congressional trades are turned off for now.',
  market: 'Live prices are turned off for now.'};
let FLAGS = null;
function flagOn(name) {
  if (FLAGS && typeof FLAGS[name] === 'boolean') return FLAGS[name];
  if (!FLAGS && FLAG_CLOSED.includes(name)) return false;
  return name in FLAG_DEFAULTS ? FLAG_DEFAULTS[name] : true;
}
function renderFlagNotice() {
  const el = $('flag-notice'); if (!el) return;
  const off = flagOn('maintenance') ? ['maintenance'] : Object.keys(FLAG_TEXT).filter(n => n !== 'maintenance' && FLAGS && !flagOn(n));
  el.textContent = off.map(n => FLAG_TEXT[n]).join(' ');
  el.hidden = !off.length;
}
async function loadFlags() {
  const wasHeld = !flagOn('sync_writes');
  try {
    const d = await getJSON(BACKEND_URL + '/api/flags', {timeout: 8000});
    if (d && d.flags && typeof d.flags === 'object') {
      const next = {};
      for (const [k, v] of Object.entries(d.flags)) if (typeof v === 'boolean') next[k] = v;
      FLAGS = next;
    }
  } catch (e) { /* keep the last known values */ }
  renderFlagNotice();
  if (wasHeld && flagOn('sync_writes') && typeof syncHeld !== 'undefined' && syncHeld && typeof syncSoon === 'function') syncSoon();
}
const flagsReady = loadFlags();
setInterval(() => { if (!document.hidden) loadFlags(); }, 60 * 1000);

function refreshAll() {
  renderReviewSec();
  renderCash(); renderDividends(); loadRisk();
  renderAlerts();
  newsCache = {}; loadNews();
  renderHero(); renderHoldings(); renderFeed(); renderCompareSubs(); renderSignals(); renderTicker(); renderMix();
  loadPrices(); loadHistory(); loadSectors();
}
function init() {
  wireReveal(); wirePages(); wireImport(); wireAsk(); buildChart();
  $('feed-more').onclick = () => { feedLimit += 12; renderFeed(); };
  $('copy-member').onchange = e => runCopyTest(e.target.value);
  wireLock(); wireAssist(); wirePlaid(); wireAccount(); if (typeof wirePrivate === 'function') wirePrivate(); if (typeof wireInsights === 'function') wireInsights();
  wireTickerLinks(); renderWatch(); renderAlerts(); wireCopyButtons(); wireCash(); loadYieldData(); wireFeedFilters();
  $('cmp-member').onchange = e => { cmpMember = e.target.value; renderAnyMember(); };
  $('share-copy').onclick = shareCopy;
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    // When a new release takes over, reload once so the new code is used right away
    const hadController = !!navigator.serviceWorker.controller; let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
    navigator.serviceWorker.register('sw.js').then(r => r.update()).catch(() => {});
  }
  $('watch-form').onsubmit = e => { e.preventDefault(); toggleWatch($('watch-in').value, true); $('watch-in').value = ''; };
  renderHero(); renderHoldings(); renderFeed(); renderSignals(); renderTicker(); renderMix();
  loadPrices(); loadHistory(); loadTrades(); loadNews(); loadSectors();
  setInterval(() => { if (!document.hidden) loadPrices(); }, 60 * 1000);
  setInterval(loadHistory, 10 * 60 * 1000);
  setInterval(loadNews, 15 * 60 * 1000);
  setInterval(loadTrades, 60 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadPrices(); });
}
sbTakeRedirect();
openVault().then(() => { myPortfolio = loadPortfolio(); snapshots = loadSnaps(); init(); });
