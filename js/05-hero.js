// ─────────────────────────────────────────────
//  HERO
// ─────────────────────────────────────────────
function portfolioTotals() {
  let total = 0, prev = 0, cost = 0, stockVal = 0;
  for (const h of myPortfolio) {
    if (h.isCash) { total += h.marketValue || 0; prev += h.marketValue || 0; continue; }
    const p = prices[h.ticker];
    const now = p ? p.price : (h.currentPrice || h.avgCost || 0);
    const pc = p ? (p.prev_close || p.price) : now;
    total += h.shares * now; prev += h.shares * pc; stockVal += h.shares * now;
    cost += h.shares * (h.avgCost || now);
  }
  return {total, day: total - prev, dayPct: prev ? (total - prev) / prev * 100 : 0, gain: stockVal - cost, gainPct: cost ? (stockVal - cost) / cost * 100 : 0};
}
function renderHero() {
  const v = $('hero-value'), c = $('hero-change');
  if (!myPortfolio.length) {
    $('hero-label').textContent = 'Portfolio Intel';
    v.textContent = 'Track the trades.';
    c.innerHTML = '<span style="color:var(--ink-2)">Compare your portfolio with what Congress is buying.</span>';
    $('hero-cta').style.display = 'block';
    return;
  }
  $('hero-label').textContent = 'Total portfolio value';
  $('hero-cta').style.display = 'none';
  if (!Object.keys(prices).length && !myPortfolio.some(h => h.currentPrice || h.isCash)) { v.innerHTML = '<span class="sk">$000,000</span>'; return; }
  const t = portfolioTotals();
  animateTo(v, 'hero', t.total, x => usd(x));
  c.className = 'hero-change num ' + (t.day >= 0 ? 'up' : 'down');
  c.textContent = `${t.day >= 0 ? '+' : '-'}${usd(Math.abs(t.day))} · ${pct(t.dayPct, 2)} today`;
}
