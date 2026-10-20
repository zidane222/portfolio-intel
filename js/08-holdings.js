// ─────────────────────────────────────────────
//  HOLDINGS TABLE
// ─────────────────────────────────────────────
function tradersOf(ticker) {
  const names = new Set();
  trades.forEach(t => { if (t.ticker === ticker) names.add(t.representative); });
  return names.size;
}
function renderHoldings() {
  const tb = $('my-tbl');
  if (!myPortfolio.length) { tb.innerHTML = ''; $('my-empty').style.display = 'block'; $('my-actions').style.display = 'none'; return; }
  $('my-empty').style.display = 'none'; $('my-actions').style.display = 'flex';
  const pel = new Set(REF.pelosi.map(h => h.ticker)), tr = new Set(REF.trump.map(h => h.ticker));
  const rows = [...myPortfolio].sort((a, b) => (a.isCash - b.isCash) || ((b.shares * priceOf(b.ticker, b.currentPrice || 0)) - (a.shares * priceOf(a.ticker, a.currentPrice || 0))));
  tb.innerHTML = rows.map(h => {
    if (h.isCash) return `<tr><td><strong>${esc(h.ticker)}</strong><div class="co">${esc(h.company && h.company !== h.ticker ? h.company : 'Money market')}</div></td><td>–</td><td>$1.00</td><td>${usd(h.marketValue || 0)}</td><td>${usd(h.marketValue || 0)}</td><td class="muted-l">–</td><td>${h.apy ? usd(incomeOf(h), 0) : '<span class="muted-l">–</span>'}</td><td>${h.apy ? h.apy.toFixed(2) + '%' : '<span class="muted-l">Add APY</span>'}</td><td></td></tr>`;
    const p = priceOf(h.ticker, h.currentPrice || 0);
    const r = h.avgCost > 0 && p > 0 ? (p - h.avgCost) / h.avgCost * 100 : null;
    const n = tradersOf(h.ticker);
    const badges = (pel.has(h.ticker) ? '<span class="badge b-pelosi">Pelosi</span>' : '') + (tr.has(h.ticker) ? '<span class="badge b-trump">Trump</span>' : '') + (n ? `<span class="badge b-cong">${n} in Congress</span>` : '');
    return `<tr>
      <td><strong><button type="button" class="tk-link" data-tk="${esc(h.ticker)}">${esc(h.ticker)}</button></strong>${h.company && h.company !== h.ticker ? `<div class="co">${esc(h.company)}</div>` : ''}</td>
      <td>${h.shares.toLocaleString('en-US', {maximumFractionDigits: 4})}</td>
      <td>${p ? usd(p) : '<span class="sk">$000</span>'}</td>
      <td>${p ? usd(h.shares * p) : '–'}</td>
      <td>${h.avgCost > 0 ? usd(h.shares * h.avgCost) : '<span class="muted-l">–</span>'}</td>
      <td class="${r === null ? 'muted-l' : r >= 0 ? 'up' : 'down'}">${r === null ? '–' : `${(p - h.avgCost) * h.shares >= 0 ? '+' : '-'}${usd(Math.abs((p - h.avgCost) * h.shares))}<div class="co" style="color:inherit">${pct(r)}</div>`}</td>
      <td>${divData[h.ticker] ? usd(incomeOf(h), 0) : '<span class="muted-l">–</span>'}</td>
      <td>${divData[h.ticker] ? (divData[h.ticker].yield || 0).toFixed(2) + '%' : '<span class="muted-l">–</span>'}</td>
      <td>${badges || '<span class="muted-l">–</span>'}</td>
    </tr>`;
  }).join('');
}
