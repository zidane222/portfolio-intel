// ─────────────────────────────────────────────
//  CHART (TradingView Lightweight Charts)
// ─────────────────────────────────────────────
function buildChart() {
  const legend = $('legend');
  legend.innerHTML = SERIES.map(s => `<button class="chip" type="button" aria-pressed="true" data-k="${s.key}"><span class="sw" style="background:${s.color}"></span>${s.label} <span class="v num" id="lv-${s.key}"></span></button>`).join('');
  legend.querySelectorAll('.chip').forEach(b => b.onclick = () => {
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', on);
    lines[b.dataset.k] && lines[b.dataset.k].applyOptions({visible: on});
  });
  $('ranges').innerHTML = RANGES.map(([l, r]) => `<button type="button" aria-pressed="${r === range}" data-r="${r}">${l}</button>`).join('');
  $('ranges').querySelectorAll('button').forEach(b => b.onclick = () => {
    range = b.dataset.r;
    $('ranges').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
    loadHistory();
  });

  if (!window.LightweightCharts) { $('chart-msg').textContent = 'Chart library failed to load.'; return; }
  chart = LightweightCharts.createChart($('chart'), {
    autoSize: true,
    layout: {background: {type: 'solid', color: 'transparent'}, textColor: '#9FB1CE', fontFamily: getComputedStyle(document.body).fontFamily, fontSize: 12},
    grid: {vertLines: {visible: false}, horzLines: {color: 'rgba(255,255,255,0.06)'}},
    rightPriceScale: {borderVisible: false, scaleMargins: {top: 0.1, bottom: 0.08}},
    timeScale: {borderVisible: false, timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true},
    crosshair: {mode: 0, vertLine: {color: 'rgba(255,255,255,0.35)', width: 1, style: 0, labelBackgroundColor: '#12306A'}, horzLine: {visible: false, labelVisible: false}},
    localization: {locale: 'en-US', priceFormatter: v => pct(v)},
    handleScroll: false, handleScale: false,
  });
  for (const s of SERIES) {
    const opts = {color: s.color, lineColor: s.color, lineWidth: s.width, lineStyle: s.dashed ? 2 : 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerRadius: 4};
    lines[s.key] = s.area
      ? chart.addAreaSeries({...opts, topColor: 'rgba(10,132,255,0.28)', bottomColor: 'rgba(10,132,255,0)'})
      : chart.addLineSeries(opts);
  }
  chart.subscribeCrosshairMove(p => {
    if (!p || !p.time) { showLegendValues(lastReturns); $('chart-date').textContent = 'Return over period'; return; }
    const vals = {};
    for (const s of SERIES) { const d = p.seriesData.get(lines[s.key]); if (d) vals[s.key] = d.value; }
    showLegendValues(vals);
    const dt = new Date(p.time * 1000);
    $('chart-date').textContent = dt.toLocaleString('en-US', range === '1d' || range === '5d' ? {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'} : {month:'short', day:'numeric', year:'numeric'});
  });
}
function showLegendValues(vals) {
  for (const s of SERIES) { const el = $('lv-' + s.key); if (el) el.textContent = vals[s.key] !== undefined ? pct(vals[s.key]) : ''; }
}

// Value of a basket over time, normalized to % return from the first point where every ticker has a price
function basketSeries(holdings, hist) {
  const ok = holdings.filter(h => hist[h.ticker] && hist[h.ticker].length);
  if (!ok.length) return [];
  const times = [...new Set(ok.flatMap(h => hist[h.ticker].map(p => p[0])))].sort((a, b) => a - b);
  const idx = ok.map(() => 0), last = ok.map(() => null), out = [];
  for (const t of times) {
    let total = 0, complete = true;
    ok.forEach((h, i) => {
      const s = hist[h.ticker];
      while (idx[i] < s.length && s[idx[i]][0] <= t) { last[i] = s[idx[i]][1]; idx[i]++; }
      if (last[i] === null) complete = false; else total += h.shares * last[i];
    });
    if (complete) out.push({time: t, value: total});
  }
  if (!out.length) return [];
  const base = out[0].value;
  return out.map(p => ({time: p.time, value: (p.value / base - 1) * 100}));
}

let historyReq = 0;
async function loadHistory() {
  const req = ++historyReq;
  const msg = $('chart-msg');
  msg.style.display = 'flex'; msg.textContent = 'Loading price history…';
  try {
    const d = await getJSON(`${BACKEND_URL}/api/history/${allTickers().join(',')}?range=${range}`);
    if (req !== historyReq) return;
    const hist = d.series || {};
    const data = {
      me: basketSeries(stocks().map(h => ({ticker: h.ticker, shares: h.shares})), hist),
      pelosi: basketSeries(REF.pelosi, hist),
      trump: basketSeries(REF.trump, hist),
      voo: basketSeries([{ticker: 'VOO', shares: 1}], hist),
    };
    lastReturns = {};
    for (const s of SERIES) {
      lines[s.key] && lines[s.key].setData(data[s.key]);
      if (data[s.key].length) lastReturns[s.key] = data[s.key][data[s.key].length - 1].value;
    }
    if (!Object.keys(lastReturns).length) throw new Error('empty');
    msg.style.display = 'none';
    chart && chart.timeScale().fitContent();
    showLegendValues(lastReturns);
    setRet($('ret-me'), 'rme', myPortfolio.length ? lastReturns.me : null);
    if (!stocks().length) { $('ret-me').classList.remove('up','down'); $('ret-me').textContent = 'Not added'; }
    setRet($('ret-pelosi'), 'rpel', lastReturns.pelosi);
    setRet($('ret-trump'), 'rtr', lastReturns.trump);
    setRet($('ret-voo'), 'rvoo', lastReturns.voo);
    renderAnyMember();
    renderSignals();
  } catch (e) {
    if (req !== historyReq) return;
    msg.style.display = 'flex';
    msg.textContent = 'Price history is unavailable right now. It will retry shortly.';
    setTimeout(() => { if (req === historyReq) loadHistory(); }, 60000);
  }
}
let cmpMember = null;
async function renderAnyMember() {
  const sel = $('cmp-member');
  const cands = copyCandidates();
  if (!cands.length) return;
  cmpMember = cmpMember || cands.find(r => !/pelosi/i.test(r)) || cands[0];
  const invs = smart.investors.filter(x => x.quarters && x.quarters.length);
  sel.innerHTML = (invs.length ? `<optgroup label="Famous investors">${invs.map(x => `<option value="inv:${esc(x.id)}"${'inv:' + x.id === cmpMember ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>` : '')
    + `<optgroup label="Congress">${cands.slice(0, 60).sort((a, b) => nameOf(a).localeCompare(nameOf(b))).map(r => `<option value="${esc(r)}"${r === cmpMember ? ' selected' : ''}>${esc(nameOf(r))}</option>`).join('')}</optgroup>`;
  const el = $('ret-any'), sub = $('sub-any');
  try { await ensureHistory(['VOO', ...((planFor(cmpMember) || {}).tickers || [])]); } catch (e) { el.textContent = 'No data'; return; }
  const res = simulate(cmpMember);
  if (!res) { el.classList.remove('up', 'down'); el.textContent = 'No data'; sub.textContent = 'No stock filings in the past year'; return; }
  // Return over the same window as the chart above
  const days = {'1d': 1, '5d': 7, '1mo': 31, '6mo': 183, '1y': 366, '5y': 9999}[range];
  const startTs = range === 'ytd' ? Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000 : Date.now() / 1000 - (days || 183) * 86400;
  const i = Math.max(0, res.copySeries.findIndex(p => p.time >= startTs));
  const r = (res.copySeries[res.copySeries.length - 1].value / res.copySeries[i].value - 1) * 100;
  const vr = (res.vooSeries[res.vooSeries.length - 1].value / res.vooSeries[i].value - 1) * 100;
  setRet(el, 'rany', r);
  const since = res.copySeries[i].time > startTs + 5 * 86400 ? ` · since ${new Date(res.copySeries[i].time * 1000).toLocaleDateString('en-US', {month: 'short', day: 'numeric'})}` : '';
  sub.innerHTML = `${r - vr >= 0 ? 'Beat' : 'Trailed'} VOO by ${Math.abs(r - vr).toFixed(1)} pts${since}`;
}
function renderCompareSubs() {
  const val = list => list.reduce((s, h) => s + h.shares * priceOf(h.ticker, h.cost), 0);
  $('sub-pelosi').textContent = `${REF.pelosi.length} positions · ${compact(val(REF.pelosi))} from filings`;
  $('sub-trump').textContent = `DJT stake · ${compact(val(REF.trump))}`;
  if (myPortfolio.length) {
    const t = portfolioTotals();
    $('sub-me').textContent = `${stocks().length} positions · ${compact(t.total)}`;
  }
  if (prices.VOO) $('sub-voo').textContent = `VOO ${usd(prices.VOO.price)} · ${pct(prices.VOO.change_pct, 2)} today`;
}
