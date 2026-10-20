// ─────────────────────────────────────────────
//  WATCHLIST
// ─────────────────────────────────────────────
function renderWatch() {
  $('watch-chips').innerHTML = watchlist.length
    ? watchlist.map(t => `<span class="chip-l"><button type="button" class="tk-link" data-tk="${esc(t)}" style="width:auto;height:auto;color:inherit;text-decoration:none">${esc(t)}</button><button type="button" aria-label="Remove ${esc(t)}" data-unwatch="${esc(t)}"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button></span>`).join('')
    : '<span class="fine">Nothing yet. Add a ticker, or tap the star on any stock.</span>';
  $('watch-chips').querySelectorAll('[data-unwatch]').forEach(b => b.onclick = () => toggleWatch(b.dataset.unwatch));
}
function toggleWatch(t, on) {
  setTimeout(renderAlerts, 0);
  t = String(t || '').toUpperCase().trim();
  if (!/^[A-Z][A-Z0-9.\-]{0,7}$/.test(t)) return;
  const has = watchlist.includes(t);
  if (on === undefined) on = !has;
  watchlist = on ? (has ? watchlist : [...watchlist, t]) : watchlist.filter(x => x !== t);
  saveWatch(); renderWatch(); renderTicker(); renderFeed(); newsCache = {};
  if (newsTab === 'mine') loadNews();
  if (on && !prices[t]) loadPrices();
}
