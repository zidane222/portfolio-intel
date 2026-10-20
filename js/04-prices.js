// ─────────────────────────────────────────────
//  DATA: PRICES
// ─────────────────────────────────────────────
function allTickers() {
  const set = new Set(['VOO', ...BANNER_EXTRA]);
  stocks().forEach(h => set.add(h.ticker));
  watchlist.forEach(t => set.add(t));
  REF.pelosi.forEach(h => set.add(h.ticker));
  REF.trump.forEach(h => set.add(h.ticker));
  return [...set].slice(0, 40);
}
async function loadPrices() {
  try {
    const d = await getJSON(BACKEND_URL + '/api/prices/' + allTickers().join(','));
    prices = {...prices, ...(d.prices || {})};
    sizeRef();
    $('live-dot').classList.add('ok');
    $('live-text').textContent = 'Live prices · updated ' + new Date().toLocaleTimeString('en-US', {hour:'numeric', minute:'2-digit'});
  } catch (e) {
    $('live-dot').classList.remove('ok');
    $('live-text').textContent = Object.keys(prices).length ? 'Prices may be stale. Retrying…' : 'Market data is waking up. Retrying…';
  }
  renderHero(); renderHoldings(); renderCompareSubs(); renderSignals(); renderTicker(); renderMix();
  if (feedFilter === 'trump') renderFeed();
}
