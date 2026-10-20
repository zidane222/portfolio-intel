// ─────────────────────────────────────────────
//  TICKER BANNER
// ─────────────────────────────────────────────
const ARROW_UP = '<svg aria-hidden="true" width="9" height="9" viewBox="0 0 10 10"><path d="M5 1 9 8H1z" fill="currentColor"/></svg>';
const ARROW_DN = '<svg aria-hidden="true" width="9" height="9" viewBox="0 0 10 10"><path d="M5 9 1 2h8z" fill="currentColor"/></svg>';
function renderTicker() {
  const order = [...new Set(['SPY', 'QQQ', 'DIA', 'VOO', ...stocks().map(h => h.ticker), ...watchlist, ...REF.pelosi.map(h => h.ticker), ...REF.trump.map(h => h.ticker)])];
  const items = order.filter(t => prices[t]).map(t => {
    const p = prices[t], up = p.change_pct >= 0;
    return `<span class="tk" data-tk="${esc(t)}"><b>${esc(t)}</b>${usd(p.price)}<span class="${up ? 'up' : 'down'}">${up ? ARROW_UP : ARROW_DN} ${Math.abs(p.change_pct).toFixed(2)}%</span></span>`;
  }).join('');
  const track = $('ticker-track');
  if (!items) { track.innerHTML = '<span class="tk">Loading prices…</span>'; track.style.animation = 'none'; return; }
  // Two copies side by side so the loop is seamless; speed scales with length
  track.innerHTML = items + items.replace(/class="tk"/g, 'class="tk" aria-hidden="true"');
  track.style.animation = '';
  track.style.setProperty('--dur', Math.max(30, order.length * 3.2) + 's');
  if (reduced) { track.style.animation = 'none'; $('ticker').style.overflowX = 'auto'; }
}
