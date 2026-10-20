// ─────────────────────────────────────────────
//  RISK
// ─────────────────────────────────────────────
const LEVELS = [[1, 'Very low', '#1A7F37', '#E3F5E8'], [8, 'Low', '#2F6F3E', '#E8F3E2'], [20, 'Moderate', '#8A6100', '#FFF4D6'], [35, 'High', '#B54708', '#FFE9D6'], [Infinity, 'Very high', '#B42318', '#FDE6E4']];
const levelOf = v => LEVELS.find(l => v < l[0]);
function riskStats(series, bench) {
  if (!series || series.length < 30) return null;
  const rets = [];
  for (let i = 1; i < series.length; i++) if (series[i - 1] && series[i]) rets.push(series[i] / series[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) * Math.sqrt(252) * 100;
  let peak = series[0], dd = 0;
  series.forEach(v => { if (v > peak) peak = v; dd = Math.min(dd, v / peak - 1); });
  let beta = null;
  if (bench && bench.length === series.length) {
    const br = []; for (let i = 1; i < bench.length; i++) br.push(bench[i] / bench[i - 1] - 1);
    const bm = br.reduce((a, b) => a + b, 0) / br.length;
    let cov = 0, varb = 0; for (let i = 0; i < Math.min(br.length, rets.length); i++) { cov += (rets[i] - mean) * (br[i] - bm); varb += (br[i] - bm) ** 2; }
    beta = varb ? cov / varb : null;
  }
  return {vol, dd: dd * 100, beta, ret: (series[series.length - 1] / series[0] - 1) * 100};
}
function closesOn(t, days) {
  const m = new Map((hist1y[t] || []).map(p => [dayOf(p[0]), p[1]]));
  let last = null;
  return days.map(d => (m.has(d) ? (last = m.get(d)) : last));
}
async function loadRisk() {
  const box = $('risk-list');
  const ladder = [['SGOV', 'T-bills (via SGOV)'], ['BND', 'Total bond market'], ['LQD', 'Corporate bonds'], ['HYG', 'High-yield bonds'], ['AOK', 'Conservative 30/70 portfolio'], ['AOR', 'Balanced 60/40 portfolio'], ['SCHD', 'Dividend stocks (SCHD)'], ['VOO', 'S&P 500'], ['QQQ', 'Nasdaq 100'], ['TLT', 'Long-term Treasuries']];
  const mine = stocks().map(h => h.ticker);
  try { await ensureHistory(['VOO', ...ladder.map(x => x[0]), ...mine]); }
  catch (e) { box.innerHTML = '<div class="empty">Price history is unavailable right now.</div>'; return; }
  const days = (hist1y.VOO || []).map(p => dayOf(p[0]));
  if (!days.length) { box.innerHTML = '<div class="empty">Price history is unavailable right now.</div>'; return; }
  const bench = closesOn('VOO', days);
  const rows = [{name: 'Cash, savings, money market', sub: 'Price never moves; interest only', stats: {vol: 0, dd: 0, beta: 0}}];
  ladder.forEach(([t, n]) => { const st = riskStats(closesOn(t, days), bench); if (st) rows.push({t, name: n, stats: st}); });
  const own = mine.map(t => ({t, name: t, stats: riskStats(closesOn(t, days), bench), you: true})).filter(x => x.stats);
  const all = [...rows, ...own].sort((a, b) => a.stats.vol - b.stats.vol);
  const maxVol = Math.max(40, ...all.map(x => x.stats.vol));
  box.innerHTML = all.map(x => { const [, lvl, fg, bg] = levelOf(x.stats.vol);
    return `<div class="risk-row"><div><div class="n" style="font-size:15px;font-weight:600">${x.t ? `<button type="button" class="tk-link" data-tk="${esc(x.t)}">${esc(x.t)}</button> ` : ''}${x.t && x.name !== x.t ? `<span style="font-weight:400">${esc(x.name)}</span>` : x.t ? '' : esc(x.name)}${x.you ? '<span class="tag you">You own</span>' : ''}<span class="lvl" style="background:${bg};color:${fg}">${lvl}</span></div>
      <div class="p" style="font-size:13px;color:var(--dark-3)">${x.sub || `Swings ${x.stats.vol.toFixed(1)}% a year · worst drop ${x.stats.dd.toFixed(1)}%${x.stats.beta !== null ? ` · moves ${x.stats.beta.toFixed(2)}x the market` : ''}`}</div></div>
      <div class="num" style="text-align:right;font-weight:600">${x.stats.vol.toFixed(1)}%</div>
      <div class="risk-bar"><span style="width:${Math.max(1.5, x.stats.vol / maxVol * 100)}%;background:${fg}"></span></div></div>`; }).join('');
  // Your portfolio as a whole
  const me = $('risk-me');
  const held = stocks().filter(h => hist1y[h.ticker] && hist1y[h.ticker].length);
  if (!held.length) { me.innerHTML = '<div class="fine" style="padding-bottom:12px">Add your portfolio to see its overall risk level.</div>'; return; }
  const cash = myPortfolio.filter(h => h.isCash).reduce((s, h) => s + (h.marketValue || 0), 0);
  const cl = held.map(h => closesOn(h.ticker, days));
  const series = days.map((_, i) => cash + held.reduce((s, h, j) => s + h.shares * (cl[j][i] || 0), 0));
  const start = series.findIndex((v, i) => cl.every(c => c[i]));
  const st = riskStats(series.slice(start), bench.slice(start));
  if (!st) { me.innerHTML = ''; return; }
  const [, lvl, fg, bg] = levelOf(st.vol);
  const total = series[series.length - 1];
  me.innerHTML = `<div class="risk-me">
      <div><div class="fine">Your portfolio</div><div class="big-l"><span class="lvl" style="background:${bg};color:${fg};font-size:15px;margin:0;padding:4px 12px">${lvl} risk</span></div></div>
      <div><div class="fine">Typical yearly swing</div><div class="big-l num">±${st.vol.toFixed(1)}%</div><div class="fine num">about ±${usd(total * st.vol / 100, 0)}</div></div>
      <div><div class="fine">Worst drop, past year</div><div class="big-l num down">${st.dd.toFixed(1)}%</div></div>
      <div><div class="fine">If the market fell 10%</div><div class="big-l num">${st.beta !== null ? `${(-10 * st.beta).toFixed(1)}%` : 'n/a'}</div><div class="fine num">${st.beta !== null ? `about ${usd(total * st.beta * 0.1, 0)}` : ''}</div></div>
    </div>`;
}
