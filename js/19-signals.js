// ─────────────────────────────────────────────
//  SIGNALS (computed, not hardcoded)
// ─────────────────────────────────────────────
function renderSignals() {
  const out = [];
  const share = (list, sector) => {
    const tot = list.reduce((s, h) => s + h.shares * priceOf(h.ticker, h.cost), 0);
    const part = list.filter(h => h.sector === sector).reduce((s, h) => s + h.shares * priceOf(h.ticker, h.cost), 0);
    return tot ? part / tot * 100 : 0;
  };
  if (Object.keys(prices).length) {
    out.push({h: `Pelosi is ${share(REF.pelosi, 'Technology').toFixed(0)}% tech`, p: `Her recent buys lean on ${REF.pelosi.filter(h => h.sector === 'Technology').map(h => h.ticker).slice(0, 4).join(', ')}.`});
    if (prices.DJT) out.push({h: `Trump's DJT stake: ${compact(REF.trump[0].shares * prices.DJT.price)}`, p: `His only disclosed public stock, ${pct(prices.DJT.change_pct, 2)} today. His other assets are private.`});
  }
  if (trades.length) {
    const cut = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const counts = {};
    const who = {};
    trades.filter(t => t.ticker && (t.filed || t.date) >= cut && /purchase/i.test(t.type || '')).forEach(t => { counts[t.ticker] = (counts[t.ticker] || 0) + 1; (who[t.ticker] = who[t.ticker] || new Set()).add(t.representative); });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (top) out.push({h: `Most bought this month: ${top[0]}`, p: `${top[1]} purchases filed in the last 30 days by ${who[top[0]].size} member${who[top[0]].size === 1 ? '' : 's'} of Congress.`});
    const ib = insiderBuys.filter(b => b.filed >= cut).sort((a, b) => b.value - a.value)[0];
    if (ib) out.push({h: `Biggest insider buy: ${ib.ticker}`, p: `${ib.owner} (${ib.role}) bought ${compact(ib.value)} of ${ib.company} stock, filed ${ib.filed}.`});
  }
  const mine = stocks();
  if (mine.length && trades.length) {
    const hit = mine.filter(h => tradersOf(h.ticker) > 0);
    out.push({h: `${hit.length} of your ${mine.length} stocks`, p: hit.length ? `Members of Congress filed trades in ${hit.slice(0, 5).map(h => h.ticker).join(', ')}.` : 'None of your stocks appear in recent filings.'});
  }
  if (lastReturns.me !== undefined && lastReturns.voo !== undefined && mine.length) {
    const d = lastReturns.me - lastReturns.voo;
    out.push({h: d >= 0 ? `Beating the S&P by ${d.toFixed(1)} pts` : `Trailing the S&P by ${Math.abs(d).toFixed(1)} pts`, p: `Over the selected period, compared with VOO.`});
  }
  $('signal-list').innerHTML = out.length
    ? out.slice(0, 6).map(s => `<article class="signal"><h3>${esc(s.h)}</h3><p>${esc(s.p)}</p></article>`).join('')
    : '<article class="signal"><h3>Gathering data</h3><p>Signals appear once prices and filings load.</p></article>';
}
