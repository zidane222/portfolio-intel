// ─────────────────────────────────────────────
//  DIVIDENDS
// ─────────────────────────────────────────────
let divTab = 'stocks';
async function loadYieldData() {
  try { rates = await getJSON('./rates.json?v=' + Math.floor(Date.now() / 3.6e6)); } catch (e) {}
  try { yields = await getJSON('./yields.json?v=' + Math.floor(Date.now() / 3.6e6)); } catch (e) {}
  renderCash(); renderDividends();
  getJSON(BACKEND_URL + '/api/top-rates').then(d => { if (d && d.rates && d.rates.length) { topRates = d; renderCash(); } }).catch(() => {});
  if (!rates) return;
  const tks = [...rates.bond_etfs.map(b => b.ticker), ...rates.dividend_etfs, ...rates.dividend_stocks, ...rates.model_portfolios.map(m => m.ticker)];
  try {
    for (let i = 0; i < tks.length; i += 60) Object.assign(divData, (await getJSON(`${BACKEND_URL}/api/dividends/${tks.slice(i, i + 60).join(',')}`)).dividends || {});
  } catch (e) {}
  renderCash(); renderDividends(); loadRisk(); renderReviewSec();
}
function renderDividends() {
  const tabs = [['stocks', 'Top dividend stocks'], ['etfs', 'Dividend ETFs'], ['models', 'All-in-one portfolios']];
  $('div-tabs').innerHTML = tabs.map(([k, l]) => `<button type="button" aria-pressed="${k === divTab}" data-d="${k}">${l}</button>`).join('');
  $('div-tabs').querySelectorAll('button').forEach(b => b.onclick = () => { divTab = b.dataset.d; renderDividends(); });
  if (!rates) { $('div-list').innerHTML = '<div class="empty">Loading…</div>'; return; }
  const own = new Set(stocks().map(h => h.ticker));
  let list = divTab === 'stocks' ? rates.dividend_stocks.map(t => ({t})) : divTab === 'etfs' ? rates.dividend_etfs.map(t => ({t})) : rates.model_portfolios.map(m => ({t: m.ticker, mix: m.mix, full: m.name}));
  list = list.map(x => ({...x, d: divData[x.t]})).filter(x => x.d && x.d.price);
  if (!list.length) { $('div-list').innerHTML = '<div class="empty">Loading yields…</div>'; return; }
  if (divTab !== 'models') list.sort((a, b) => b.d.yield - a.d.yield);
  list = list.slice(0, divTab === 'stocks' ? 12 : 10);
  $('div-list').innerHTML = list.map(x => {
    const d = x.d, trap = d.yield >= 8 && divTab === 'stocks';
    return `<div class="rate"><div><div class="n"><button type="button" class="tk-link" data-tk="${esc(x.t)}">${esc(x.t)}</button> <span style="font-weight:400">${esc(x.full || d.name)}</span>${own.has(x.t) ? '<span class="tag you">You own</span>' : ''}${trap ? '<span class="tag warn">Very high, check if sustainable</span>' : ''}</div>
      <div class="p">${x.mix ? esc(x.mix) + ' · ' : ''}${usd(d.price)} · ${d.payments} payment${d.payments === 1 ? '' : 's'} in 12 months${d.return_1y !== null ? ` · price ${pct(d.return_1y)} over 1 year` : ''}</div></div>
      <div><div class="a">${d.yield.toFixed(2)}%</div><div class="x">${usd(10000 * d.yield / 100, 0)}/yr per $10K</div></div></div>`;
  }).join('');
  $('div-note').textContent = divTab === 'models'
    ? 'BlackRock iShares Core allocation ETFs hold a fixed stock and bond mix in one fund and rebalance for you. Yields shown are trailing 12-month payouts.'
    : 'Trailing 12-month dividends divided by today\'s price. Very high yields can mean the price fell or the payout may be cut.';
}
