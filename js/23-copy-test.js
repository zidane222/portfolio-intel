// ─────────────────────────────────────────────
//  COPY TEST: what if you'd followed Pelosi's filings
// ─────────────────────────────────────────────
// Shared one-year daily price history, fetched in batches and reused
const hist1y = {};
async function ensureHistory(tickers) {
  const need = [...new Set(tickers)].filter(t => !(t in hist1y));
  for (let i = 0; i < need.length; i += 40) {
    const batch = need.slice(i, i + 40);
    const d = await getJSON(`${BACKEND_URL}/api/history/${batch.join(',')}?range=1y`);
    batch.forEach(t => { hist1y[t] = (d.series || {})[t] || []; });
  }
}
const dayOf = ts => new Date(ts * 1000).toISOString().slice(0, 10);
const nameOf = rep => {
  if (!rep) return 'Unknown';
  const [last, first = ''] = rep.split(/,(.*)/s);
  const words = first.split(/\s+/).filter(w => w && !/^(dr|hon|mr|mrs|ms|the)\.?$/i.test(w));
  const isSuffix = w => /^(jr|sr|ii|iii|iv)\.?$/i.test(w);
  const suffix = words.filter(isSuffix).map(w => w.replace(/\.$/, '').replace(/^(jr|sr)$/i, m => m[0].toUpperCase() + m.slice(1).toLowerCase() + '.'));
  return [...words.filter(w => !isSuffix(w)), last.trim(), ...suffix].join(' ').replace(/\s+/g, ' ').trim();
};
const lagOf = t => t.date && t.filed ? Math.round((new Date(t.filed) - new Date(t.date)) / 864e5) : null;
const LATE_DAYS = 45;
function memberTrades(rep) {
  const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  return trades.filter(t => t.representative === rep && t.ticker && t.filed && t.filed >= yearAgo && /purchase|sale/i.test(t.type || ''));
}
// Follow one member's filings with $10,000, acting on each filing date
// A copy plan: which tickers, and what to do on each filing date
function planFor(key) {
  if (key.startsWith('inv:')) {
    const inv = smart.investors.find(x => 'inv:' + x.id === key);
    if (!inv) return null;
    const yearAgo = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
    const qs = inv.quarters.filter(q => q.filed >= yearAgo).slice().reverse();
    const steps = qs.map(q => ({date: q.filed, weights: Object.fromEntries(q.holdings.filter(h => h.ticker).slice(0, 25).map(h => [h.ticker, h.pct]))}));
    return {steps, tickers: [...new Set(steps.flatMap(s => Object.keys(s.weights)))]};
  }
  const mine = memberTrades(key);
  return {steps: mine.map(t => ({date: t.filed, buy: /purchase/i.test(t.type) ? t.ticker : null, sell: /purchase/i.test(t.type) ? null : t.ticker})), tickers: [...new Set(mine.map(t => t.ticker))]};
}
function simulate(key) {
  const plan = planFor(key);
  const voo = hist1y.VOO || [];
  if (!plan || !plan.steps.length || !voo.length) return null;
  const tickers = plan.tickers;
  const days = voo.map(p => dayOf(p[0]));
  const close = {};
  for (const t of ['VOO', ...tickers]) {
    const m = new Map((hist1y[t] || []).map(p => [dayOf(p[0]), p[1]]));
    let last = null;
    close[t] = days.map(d => (m.has(d) ? (last = m.get(d)) : last));
  }
  const events = new Map();
  for (const st of plan.steps) {
    const i = days.findIndex(d => d >= st.date);
    if (i < 0) continue;
    const e = events.get(i) || {buy: new Set(), sell: new Set(), weights: null};
    if (st.weights) e.weights = st.weights;
    if (st.buy) e.buy.add(st.buy);
    if (st.sell) e.sell.add(st.sell);
    events.set(i, e);
  }
  if (!events.size) return null;
  const startIdx = Math.min(...events.keys());
  let cash = 10000, held = {}, followed = 0;
  const skipped = new Set(), copySeries = [], vooSeries = [];
  const vooShares = 10000 / close.VOO[startIdx];
  for (let i = startIdx; i < days.length; i++) {
    const value = () => cash + Object.entries(held).reduce((s, [t, sh]) => s + sh * (close[t][i] || 0), 0);
    const e = events.get(i);
    if (e && e.weights) {
      // Investor filing: match their portfolio weights
      const total = value();
      const avail = Object.entries(e.weights).filter(([t]) => { const ok = close[t] && close[t][i]; if (!ok) skipped.add(t); return ok; });
      const sum = avail.reduce((s, [, w]) => s + w, 0);
      held = {}; cash = total; followed += avail.length;
      if (sum > 0) { avail.forEach(([t, w]) => { held[t] = total * (w / sum) / close[t][i]; }); cash = 0; }
    } else if (e) {
      const keep = new Set(Object.keys(held));
      e.sell.forEach(t => keep.delete(t));
      e.buy.forEach(t => { if (close[t] && close[t][i]) keep.add(t); else skipped.add(t); });
      followed += e.buy.size + e.sell.size;
      const total = value();
      held = {}; cash = total;
      if (keep.size) { const each = total / keep.size; keep.forEach(t => { held[t] = each / close[t][i]; }); cash = 0; }
    }
    copySeries.push({time: voo[i][0], value: value()});
    vooSeries.push({time: voo[i][0], value: vooShares * close.VOO[i]});
  }
  const end = copySeries[copySeries.length - 1].value, vooEnd = vooSeries[vooSeries.length - 1].value;
  return {copySeries, vooSeries, end, vooEnd, r: (end / 10000 - 1) * 100, vr: (vooEnd / 10000 - 1) * 100,
          followed, filings: events.size, held: Object.keys(held), skipped: [...skipped], start: days[startIdx]};
}

let copyChart = null, copyLines = [], copyMember = null, lastCopy = null;
const keyName = k => k.startsWith('inv:') ? ((smart.investors.find(x => 'inv:' + x.id === k) || {}).name || 'Investor') : nameOf(k);
const keyShort = k => k.startsWith('inv:') ? keyName(k).split(' ').slice(-1)[0] : k.split(',')[0].trim();
function copyCandidates() {
  const counts = {};
  trades.forEach(t => { if (t.ticker && t.filed) counts[t.representative] = (counts[t.representative] || 0) + 1; });
  return Object.entries(counts).filter(([rep]) => memberTrades(rep).length).sort((a, b) => b[1] - a[1]).map(([rep]) => rep);
}
async function runCopyTest(rep) {
  const msg = $('copy-msg');
  const cands = copyCandidates();
  if (!cands.length) { msg.textContent = trades.length ? 'No stock filings in the past year.' : 'Waiting for disclosures…'; return; }
  copyMember = rep || copyMember || cands.find(r => /pelosi/i.test(r)) || cands[0];
  const sel = $('copy-member');
  const list = [...new Set([...(copyMember.startsWith('inv:') ? [] : [copyMember]), ...cands.slice(0, 40)])].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const invs = smart.investors.filter(x => x.quarters && x.quarters.length);
  sel.innerHTML = (invs.length ? `<optgroup label="Famous investors">${invs.map(x => `<option value="inv:${esc(x.id)}"${'inv:' + x.id === copyMember ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>` : '')
    + `<optgroup label="Congress">${list.map(r => `<option value="${esc(r)}"${r === copyMember ? ' selected' : ''}>${esc(nameOf(r))}</option>`).join('')}</optgroup>`;
  const who = keyName(copyMember);
  $('copy-title').textContent = `What if you copied ${keyShort(copyMember)}?`;
  $('copy-name').textContent = `Copying ${who}`;
  msg.style.display = 'flex'; msg.textContent = 'Running the numbers…';
  try { await ensureHistory(['VOO', ...((planFor(copyMember) || {}).tickers || [])]); }
  catch (e) { msg.textContent = 'Price history is unavailable right now. It will retry shortly.'; setTimeout(() => runCopyTest(), 60000); return; }
  const res = simulate(copyMember);
  if (!res) { msg.textContent = 'No filings fall inside the price history yet.'; return; }
  lastCopy = {...res, who};
  animateTo($('copy-val'), 'copy', res.end, x => usd(x, 0));
  animateTo($('copy-voo'), 'copyvoo', res.vooEnd, x => usd(x, 0));
  $('copy-ret').innerHTML = `<span class="${res.r >= 0 ? 'up' : 'down'}">${pct(res.r)}</span> <span class="muted-d">${res.r - res.vr >= 0 ? 'ahead of' : 'behind'} VOO by ${Math.abs(res.r - res.vr).toFixed(1)} pts</span>`;
  $('copy-voo-ret').innerHTML = `<span class="${res.vr >= 0 ? 'up' : 'down'}">${pct(res.vr)}</span>`;
  const startDay = new Date(res.start + 'T12:00:00').toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'});
  $('copy-foot').textContent = `Since ${startDay} · ${copyMember.startsWith('inv:') ? `rebalanced to their 13F weights at ${res.filings} quarterly filings` : `${res.followed} trades followed across ${res.filings} filings`} · now holding ${res.held.length ? res.held.slice(0, 8).join(', ') + (res.held.length > 8 ? ` and ${res.held.length - 8} more` : '') : 'cash'}${res.skipped.length ? ` · skipped ${res.skipped.join(', ')} (no price data)` : ''}`;
  if (!window.LightweightCharts) { msg.textContent = 'Chart library failed to load.'; return; }
  msg.style.display = 'none';
  if (!copyChart) {
    copyChart = LightweightCharts.createChart($('copy-chart'), {
      autoSize: true,
      layout: {background: {type: 'solid', color: 'transparent'}, textColor: '#9FB1CE', fontFamily: getComputedStyle(document.body).fontFamily, fontSize: 12},
      grid: {vertLines: {visible: false}, horzLines: {color: 'rgba(255,255,255,0.06)'}},
      rightPriceScale: {borderVisible: false}, timeScale: {borderVisible: false, fixLeftEdge: true, fixRightEdge: true},
      crosshair: {mode: 0, horzLine: {visible: false, labelVisible: false}, vertLine: {color: 'rgba(255,255,255,0.35)', labelBackgroundColor: '#12306A'}},
      localization: {locale: 'en-US', priceFormatter: v => usd(v, 0)}, handleScroll: false, handleScale: false,
    });
    copyLines = [
      copyChart.addAreaSeries({lineColor: '#0A84FF', topColor: 'rgba(10,132,255,0.28)', bottomColor: 'rgba(10,132,255,0)', lineWidth: 2.5, priceLineVisible: false, lastValueVisible: false}),
      copyChart.addLineSeries({color: '#8E9BB3', lineWidth: 2, lineStyle: 2, priceLineVisible: false, lastValueVisible: false}),
    ];
  }
  copyLines[0].setData(res.copySeries); copyLines[1].setData(res.vooSeries);
  copyChart.timeScale().fitContent();
}
