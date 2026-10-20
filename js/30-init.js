// ─────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────
function refreshAll() {
  renderReviewSec();
  renderCash(); renderDividends(); loadRisk();
  renderAlerts();
  newsCache = {}; loadNews();
  renderHero(); renderHoldings(); renderFeed(); renderCompareSubs(); renderSignals(); renderTicker(); renderMix();
  loadPrices(); loadHistory(); loadSectors();
}
function init() {
  wireReveal(); wireNavHighlight(); wireImport(); wireAsk(); buildChart();
  $('feed-more').onclick = () => { feedLimit += 12; renderFeed(); };
  $('copy-member').onchange = e => runCopyTest(e.target.value);
  wireLock(); wireAssist(); wirePlaid();
  wireTickerLinks(); renderWatch(); renderAlerts(); wireCopyButtons(); wireCash(); loadYieldData(); wireFeedFilters();
  $('cmp-member').onchange = e => { cmpMember = e.target.value; renderAnyMember(); };
  $('share-copy').onclick = shareCopy;
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
  $('watch-form').onsubmit = e => { e.preventDefault(); toggleWatch($('watch-in').value, true); $('watch-in').value = ''; };
  renderHero(); renderHoldings(); renderFeed(); renderSignals(); renderTicker(); renderMix();
  loadPrices(); loadHistory(); loadTrades(); loadNews(); loadSectors();
  setInterval(() => { if (!document.hidden) loadPrices(); }, 60 * 1000);
  setInterval(loadHistory, 10 * 60 * 1000);
  setInterval(loadNews, 15 * 60 * 1000);
  setInterval(loadTrades, 60 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadPrices(); });
}
openVault().then(() => { myPortfolio = loadPortfolio(); snapshots = loadSnaps(); init(); });
