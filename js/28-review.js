// ─────────────────────────────────────────────
//  PORTFOLIO REVIEW (what a brokerage statement shows, but live)
// ─────────────────────────────────────────────
const GOLD = new Set(['GLD', 'IAU', 'SLV', 'GLDM', 'SGOL', 'PPLT', 'BAR', 'AAAU', 'PHYS']);
const BONDS = new Set(['BND', 'AGG', 'TLT', 'SHY', 'IEF', 'VGIT', 'VGSH', 'VCIT', 'VCSH', 'LQD', 'HYG', 'JNK', 'MUB', 'SGOV', 'BIL', 'TIP', 'SCHZ', 'BNDX', 'GOVT', 'USFR', 'TFLO', 'VTEB']);
const CLASS_COLORS = {'Cash & money market': '#9DBBE0', 'Equities': '#0A84FF', 'Fixed income': '#30A46C', 'Alternatives': '#E8A33D'};
const SNAP_KEY = 'pi.snapshots.v1';
function loadSnaps() { try { return JSON.parse(vget(SNAP_KEY)) || []; } catch (e) { return []; } }
let snapshots = loadSnaps();
function saveSnap(d, v, src) {
  if (!(v > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
  // A statement value for a date beats a live reading for the same date
  const old = snapshots.find(x => x.d === d);
  if (old && old.src === 'statement' && src === 'live') return;
  snapshots = snapshots.filter(x => x.d !== d);
  snapshots.push({d, v: Math.round(v * 100) / 100, src});
  snapshots.sort((a, b) => a.d.localeCompare(b.d));
  snapshots = snapshots.slice(-400);
  vset(SNAP_KEY, JSON.stringify(snapshots));
}
function classOf(h) {
  if (h.isCash) return 'Cash & money market';
  if (GOLD.has(h.ticker)) return 'Alternatives';
  if (BONDS.has(h.ticker) || (rates && rates.bond_etfs.some(b => b.ticker === h.ticker))) return 'Fixed income';
  return 'Equities';
}
function valueOf(h) { return h.isCash ? (h.marketValue || 0) : h.shares * priceOf(h.ticker, h.currentPrice || h.avgCost || 0); }
function incomeOf(h) {
  if (h.isCash) return h.apy ? (h.marketValue || 0) * h.apy / 100 : 0;
  const d = divData[h.ticker];
  return d ? h.shares * (d.ttm_dividend || 0) : 0;
}
async function ensureDivs(tks) {
  const need = tks.filter(t => !divData[t] || !divData[t].history);
  if (!need.length) return;
  try { Object.assign(divData, (await getJSON(`${BACKEND_URL}/api/dividends/${need.join(',')}`)).dividends || {}); } catch (e) {}
}
let prChart = null, prRun = 0;
async function renderReviewSec() {
  const run = ++prRun;
  const has = myPortfolio.length > 0;
  $('pr-empty').style.display = has ? 'none' : 'block';
  $('pr-body').style.display = has ? 'block' : 'none';
  if (!has) return;
  const st = stocks();
  await ensureDivs(st.map(h => h.ticker));
  if (run !== prRun) return;
  const rows = myPortfolio.map(h => ({h, v: valueOf(h), inc: incomeOf(h), cls: classOf(h)}));
  const total = rows.reduce((s, r) => s + r.v, 0);
  if (!total) return;
  const income = rows.reduce((s, r) => s + r.inc, 0);
  const withCost = st.filter(h => h.avgCost > 0);
  const cost = withCost.reduce((s, h) => s + h.shares * h.avgCost, 0);
  const gain = cost ? withCost.reduce((s, h) => s + valueOf(h), 0) - cost : null;
  const today = new Date().toISOString().slice(0, 10);
  if (Object.keys(prices).length) saveSnap(today, total, 'live');

  // Price history for "today's holdings over the past year"
  let series = null;
  try { await ensureHistory(['VOO', ...st.map(h => h.ticker)]); } catch (e) {}
  if (run !== prRun) return;
  const days = (hist1y.VOO || []).map(p => dayOf(p[0]));
  const cashTotal = rows.filter(r => r.h.isCash).reduce((s, r) => s + r.v, 0);
  if (days.length) {
    const cl = st.map(h => closesOn(h.ticker, days));
    series = days.map((d, i) => ({time: hist1y.VOO[i][0], d, value: cashTotal + st.reduce((s, h, j) => s + h.shares * (cl[j][i] || priceOf(h.ticker, h.avgCost || 0)), 0)}));
  }

  // Month comparison: a saved value from 20 to 45 days ago, else today's holdings priced a month ago
  const iso = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const monthAgo = iso(30);
  // Prefer your latest uploaded statement (at least a week old), then a saved value from 20 to 45 days ago
  const snap = snapshots.filter(x => x.src === 'statement' && x.d <= iso(7) && x.d >= iso(70)).pop() || snapshots.filter(x => x.d <= iso(20) && x.d >= iso(45)).pop();
  const ref = snap ? {d: snap.d, v: snap.v, est: false, stmt: snap.src === 'statement'}
    : (series ? (() => { const p = series.filter(x => x.d <= monthAgo).pop() || series[0]; return {d: p.d, v: p.value, est: true}; })() : null);
  // Income over the same period: dividends actually paid on today's shares, plus cash interest for those days
  const since = ref ? ref.d : monthAgo;
  const periodDays = Math.max(1, Math.round((Date.now() - new Date(since + 'T12:00:00')) / 864e5));
  const cashAnnual = rows.filter(r => r.h.isCash).reduce((s, r) => s + r.inc, 0);
  const cashMonth = cashAnnual / 12;
  const divPeriod = st.reduce((s, h) => s + ((divData[h.ticker] || {}).history || []).filter(([d]) => d > since).reduce((a, [, amt]) => a + amt * h.shares, 0), 0);
  const incMonth = divPeriod + cashAnnual * periodDays / 365;
  const chg = ref ? total - ref.v : null;
  // The estimate holds cash flat and ignores dividends, so its change is market movement only
  const market = chg === null ? null : ref.est ? chg : chg - incMonth;
  const earned = chg === null ? null : ref.est ? chg + incMonth : chg;
  const fmtD = d => new Date(d + 'T12:00:00').toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
  const sign = v => (v >= 0 ? '+' : '-') + usd(Math.abs(v));
  $('pr-sum').innerHTML = `
    <div><div class="pr-k">Net portfolio value</div><div class="pr-v">${usd(total)}</div><div class="pr-s">${rows.length} position${rows.length === 1 ? '' : 's'}</div></div>
    <div><div class="pr-k">Change since ${ref ? fmtD(ref.d) : 'last month'}</div><div class="pr-v ${chg === null ? '' : chg >= 0 ? 'up' : 'down'}">${chg === null ? '–' : sign(chg)}</div><div class="pr-s">${ref ? pct(chg / ref.v * 100, 2) + (ref.est ? ' · estimated from today\'s holdings' : ref.stmt ? ' · vs your statement' : ' · vs your saved value') : ''}</div></div>
    <div><div class="pr-k">Estimated annual income</div><div class="pr-v">${usd(income, 0)}</div><div class="pr-s">${(income / total * 100).toFixed(2)}% yield on the whole portfolio</div></div>
    <div><div class="pr-k">Unrealized gain / loss</div><div class="pr-v ${gain === null ? '' : gain >= 0 ? 'up' : 'down'}">${gain === null ? '–' : sign(gain)}</div><div class="pr-s">${gain === null ? 'Add cost basis to see this' : pct(gain / cost * 100, 2) + ' on invested positions'}</div></div>`;
  $('pr-earn').innerHTML = chg === null ? '' : `<span>Earnings since ${ref ? fmtD(ref.d) : 'last month'}</span><span>Income <b>${usd(incMonth)}</b></span><span>Market gains <b class="${market >= 0 ? 'up' : 'down'}">${sign(market)}</b></span><span>Total <b class="${earned >= 0 ? 'up' : 'down'}">${sign(earned)}</b></span>`;

  // Allocation by asset class
  const cls = {};
  rows.forEach(r => { cls[r.cls] = (cls[r.cls] || 0) + r.v; });
  const parts = Object.entries(cls).sort((a, b) => b[1] - a[1]);
  const R = 70, C = 2 * Math.PI * R;
  let off = 0;
  $('pr-donut').innerHTML = parts.map(([k, v]) => {
    const len = v / total * C;
    const el = `<circle cx="100" cy="100" r="${R}" fill="none" stroke="${CLASS_COLORS[k]}" stroke-width="34" stroke-dasharray="${Math.max(0, len - (parts.length > 1 ? 1.2 : 0))} ${C}" stroke-dashoffset="${-off}"><title>${esc(k)} ${(v / total * 100).toFixed(1)}%</title></circle>`;
    off += len;
    return el;
  }).join('');
  $('pr-alloc-legend').innerHTML = parts.map(([k, v]) => `<div class="pr-leg"><span class="sw" style="background:${CLASS_COLORS[k]}"></span><span>${esc(k)}</span><span class="muted-l">${compact(v)}</span><b>${(v / total * 100).toFixed(2)}%</b></div>`).join('');

  // Income by month over the last 12 months, if you had held today's positions
  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 15); months.push(d.toISOString().slice(0, 7)); }
  const divByM = Object.fromEntries(months.map(m => [m, 0]));
  st.forEach(h => ((divData[h.ticker] || {}).history || []).forEach(([d, amt]) => { const m = d.slice(0, 7); if (m in divByM) divByM[m] += amt * h.shares; }));
  const max = Math.max(1, ...months.map(m => divByM[m] + cashMonth));
  const ytd = months.filter(m => m.startsWith(String(now.getFullYear()))).reduce((s, m) => s + divByM[m] + cashMonth, 0);
  const missingApy = rows.filter(r => r.h.isCash && !r.h.apy).length;
  $('pr-income').innerHTML = `<div class="pr-bars" role="img" aria-label="Estimated income by month">${months.map(m => { const dv = divByM[m]; return `<div class="pr-bar" title="${m}: ${usd(dv + cashMonth)}"><span class="top" style="height:${dv / max * 100}%"></span><span class="cash${dv ? '' : ' top'}" style="height:${cashMonth / max * 100}%"></span></div>`; }).join('')}</div>
    <div class="pr-ml">${months.map(m => `<span>${new Date(m + '-15T12:00:00').toLocaleDateString('en-US', {month: 'narrow'})}</span>`).join('')}</div>
    <div class="pr-earn" style="margin-top:12px"><span>This year <b>${usd(ytd)}</b></span><span>Est. annual <b>${usd(income)}</b></span><span><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--accent)"></span> Dividends <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:#9DBBE0;margin-left:8px"></span> Cash interest</span></div>
    <p class="fine" style="margin-top:8px">Dividends actually paid per share over the past year, times the shares you hold today. Cash interest uses each cash position's yield${missingApy ? `. <b>${missingApy} cash position${missingApy > 1 ? 's have' : ' has'} no yield yet:</b> add it under Edit holdings` : ''}.</p>`;

  // Value over the past year
  const msg = $('pr-chart-msg');
  if (series && window.LightweightCharts) {
    msg.style.display = 'none';
    if (!prChart) {
      prChart = LightweightCharts.createChart($('pr-chart'), {autoSize: true, layout: {background: {type: 'solid', color: 'transparent'}, textColor: '#5A6B85', fontSize: 11},
        grid: {vertLines: {visible: false}, horzLines: {color: '#E3EAF3'}}, rightPriceScale: {borderVisible: false}, timeScale: {borderVisible: false, fixLeftEdge: true, fixRightEdge: true},
        crosshair: {mode: 0, horzLine: {visible: false, labelVisible: false}}, localization: {locale: 'en-US', priceFormatter: v => compact(v)}, handleScroll: false, handleScale: false});
      prChart.line = prChart.addAreaSeries({lineColor: '#0A84FF', topColor: 'rgba(10,132,255,.22)', bottomColor: 'rgba(10,132,255,0)', lineWidth: 2, priceLineVisible: false, lastValueVisible: false});
      prChart.snaps = prChart.addLineSeries({color: '#0B1A33', lineWidth: 1, lineStyle: 2, pointMarkersVisible: true, priceLineVisible: false, lastValueVisible: false});
    }
    prChart.line.setData(series.map(({time, value}) => ({time, value})));
    const pts = snapshots.filter(x => x.src === 'statement').map(x => ({time: Math.floor(new Date(x.d + 'T20:00:00Z').getTime() / 1000), value: x.v})).filter(x => x.time >= series[0].time);
    if (pts.length) pts.push({time: series[series.length - 1].time, value: total});
    prChart.snaps.setData(pts.length > 1 ? pts : []);
    prChart.timeScale().fitContent();
    const n = snapshots.filter(x => x.src === 'statement').length;
    $('pr-chart-note').textContent = `Blue: today's holdings priced over the past year, with cash held constant. ${n ? `Dashed: your actual values from ${n} uploaded statement${n > 1 ? 's' : ''}.` : 'Upload monthly statements to plot your actual values too.'}`;
  } else msg.textContent = 'Price history is unavailable right now.';

  // Top five holdings
  $('pr-top').innerHTML = rows.slice().sort((a, b) => b.v - a.v).slice(0, 5).map(r => `<div class="pr-top"><div><b>${r.h.isCash ? esc(r.h.ticker) : `<button type="button" class="tk-link" data-tk="${esc(r.h.ticker)}">${esc(r.h.ticker)}</button>`}</b> <span class="muted-l">${esc((r.h.company || '').slice(0, 32))}</span></div><span>${usd(r.v, 0)}</span><b>${(r.v / total * 100).toFixed(2)}%</b></div>`).join('');
  renderIndicators();
}
async function renderIndicators() {
  const body = $('pr-ind');
  const out = [];
  try { await ensureHistory(['^GSPC', '^IXIC']); } catch (e) {}
  const yEnd = `${new Date().getFullYear() - 1}-12-31`;
  const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  [['S&P 500', '^GSPC'], ['Nasdaq', '^IXIC']].forEach(([n, t]) => {
    const h = (hist1y[t] || []).map(p => [dayOf(p[0]), p[1]]);
    if (!h.length) return;
    const at = d => (h.filter(x => x[0] <= d).pop() || [])[1];
    const f = v => v ? v.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '–';
    out.push([n, f(h[h.length - 1][1]), f(at(monthAgo)), f(at(yEnd))]);
  });
  if (yields && yields.curve) {
    const y = k => [yields.curve[k], yields.month_ago && yields.month_ago.curve[k], yields.year_end && yields.year_end.curve[k]].map(v => v !== undefined && v !== null ? v.toFixed(2) + '%' : '–');
    out.push(['3-month Treasury bills', ...y('3 Mo')], ['10-year Treasury', ...y('10 Yr')], ['30-year Treasury bonds', ...y('30 Yr')]);
    if (yields.sofr && yields.sofr.now) out.push(['SOFR (overnight)', ...[yields.sofr.now, yields.sofr.month_ago, yields.sofr.year_end].map(x => x ? x.rate.toFixed(2) + '%' : '–')]);
  }
  body.innerHTML = out.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="4" class="muted-l">Loading…</td></tr>';
  $('pr-ind-note').textContent = yields ? `Treasury yields as of ${yields.date}. Indexes at the latest close.` : '';
}
