// ─────────────────────────────────────────────
//  TICKER PAGE (tap any ticker)
// ─────────────────────────────────────────────
let sheetChart = null, sheetLine = null, sheetTicker = null;
async function openTicker(tk, focusTrack) {
  tk = String(tk || '').toUpperCase(); if (!tk) return;
  sheetTicker = tk;
  const dlg = $('tk-sheet'), box = $('tk-body');
  const pos = myPortfolio.find(h => h.ticker === tk && !h.isCash);
  const tr = trades.filter(t => t.ticker === tk);
  const co = (pos && pos.company) || (tr[0] && tr[0].description) || '';
  const sector = sectorOf(tk) || (tr.find(t => t.sector) || {}).sector || '';
  const pel = REF.pelosi.find(h => h.ticker === tk), trm = REF.trump.find(h => h.ticker === tk);
  const p = prices[tk];
  const members = [...new Set(tr.map(t => t.representative))];
  const lags = tr.map(lagOf).filter(x => x !== null && x >= 0);
  box.innerHTML = `
    <div class="sheet-head">
      <div><div class="sheet-tk">${esc(tk)}</div><div class="sheet-co">${esc(co)}${sector ? ' · ' + esc(sector) : ''}</div>
        <div class="sheet-px num" id="tk-px">${p ? `${usd(p.price)} <span class="${p.change_pct >= 0 ? 'up' : 'down'}" style="font-size:16px">${pct(p.change_pct, 2)} today</span>` : '<span class="sk">$000.00</span>'}</div></div>
      <div class="sheet-btns">
        <button class="icon-d" type="button" id="tk-star" aria-pressed="${watchlist.includes(tk)}" aria-label="Watch ${esc(tk)}"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="${watchlist.includes(tk) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.3 12 2"/></svg></button>
        <button class="icon-d" type="button" id="tk-close" aria-label="Close"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>
      </div>
    </div>
    <div id="tk-chart" style="height:180px;margin-top:14px;position:relative"><div class="chart-msg" id="tk-chart-msg">Loading chart…</div></div>
    <div class="facts" style="margin-top:14px">
      ${pos ? `<div class="fact">Your position<b class="num">${pos.shares.toLocaleString('en-US', {maximumFractionDigits: 4})} sh${p ? ' · ' + usd(pos.shares * p.price) : ''}</b></div>` : ''}
      ${pel ? `<div class="fact">Pelosi<b>Holds (est.)</b></div>` : ''}
      ${trm ? `<div class="fact">Trump<b>Holds (est.)</b></div>` : ''}
      <div class="fact">In Congress<b class="num">${members.length} member${members.length === 1 ? '' : 's'} · ${tr.length} trade${tr.length === 1 ? '' : 's'}</b></div>
      ${(() => { const ib = insiderBuys.filter(b => b.ticker === tk); return ib.length ? `<div class="fact">Insiders bought (90d)<b class="num">${compact(ib.reduce((s, b) => s + b.value, 0))} · ${ib.length} buy${ib.length === 1 ? '' : 's'}</b></div>` : ''; })()}
      ${(() => { const who = smart.investors.filter(x => x.quarters && x.quarters[0] && x.quarters[0].holdings.some(h => h.ticker === tk)).map(x => x.name.split(' ').slice(-1)[0]); return who.length ? `<div class="fact">Held by<b>${esc(who.join(', '))}</b></div>` : ''; })()}
      ${lags.length ? `<div class="fact">Avg filing delay<b class="num">${Math.round(lags.reduce((a, b) => a + b, 0) / lags.length)} days</b></div>` : ''}
    </div>
    <h3>${pos ? 'Update your position' : 'Track in your portfolio'}</h3>
    <form class="track-form" id="track-form"><label class="sr" for="track-sh">Shares</label><input id="track-sh" inputmode="decimal" placeholder="Shares" value="${pos ? pos.shares : ''}"><label class="sr" for="track-cost">Cost per share</label><input id="track-cost" inputmode="decimal" placeholder="Cost/share (opt.)" value="${pos && pos.avgCost ? pos.avgCost : ''}"><button class="btn small" type="submit">${pos ? 'Save' : 'Add'}</button><span class="track-ok" id="track-ok" aria-live="polite"></span></form>
    <h3>Congress trades</h3>
    <div>${tr.length ? tr.slice(0, 12).map(t => { const buy = /purchase/i.test(t.type); const lag = lagOf(t);
      return `<div class="trade"><div><div class="who">${esc(nameOf(t.representative))}</div><div class="what" style="font-size:15px">${buy ? 'Bought' : 'Sold'}<span class="pill ${buy ? 'buy' : 'sell'}">${esc(t.amount)}</span>${lag !== null && lag > LATE_DAYS ? '<span class="pill late">Filed late</span>' : ''}${t.committees && t.committees.length ? '<span class="pill cmte">Committee overlap</span>' : ''}</div></div><div><div class="when">Traded ${esc(t.date)}</div><div class="when">Filed ${esc(t.filed || '')}</div></div></div>`; }).join('')
      : '<div class="muted-d" style="font-size:14px;padding:8px 0">No congressional trades in this stock this year.</div>'}</div>
    <h3>News read</h3>
    <div id="tk-read" aria-live="polite"><div class="muted-d" style="font-size:14px;padding:8px 0">Loading news read…</div></div>
    <h3>News</h3>
    <div id="tk-news"><div class="muted-d" style="font-size:14px;padding:8px 0">Loading headlines…</div></div>`;
  $('tk-close').onclick = () => dlg.close();
  $('track-form').onsubmit = e => {
    e.preventDefault();
    const sh = parseFloat($('track-sh').value.replace(/,/g, '')), cost = parseFloat($('track-cost').value.replace(/[$,]/g, ''));
    if (!(sh > 0)) { $('track-ok').textContent = 'Enter a number of shares.'; $('track-ok').style.color = '#FF8A80'; return; }
    const i = myPortfolio.findIndex(h => h.ticker === tk && !h.isCash);
    const row = {ticker: tk, shares: sh, avgCost: isFinite(cost) && cost > 0 ? cost : (prices[tk] ? prices[tk].price : 0), company: co, isCash: false};
    if (i >= 0) myPortfolio[i] = {...myPortfolio[i], ...row}; else myPortfolio.push(row);
    savePortfolio(); refreshAll(); renderFeed();
    $('track-ok').style.color = ''; $('track-ok').textContent = i >= 0 ? 'Updated.' : 'Added to your portfolio.';
  };
  if (focusTrack) setTimeout(() => $('track-sh') && $('track-sh').focus(), 300);
  $('tk-star').onclick = () => { toggleWatch(tk); const on = watchlist.includes(tk); $('tk-star').setAttribute('aria-pressed', on); $('tk-star').querySelector('svg').setAttribute('fill', on ? 'currentColor' : 'none'); };
  if (!dlg.open) { dlg.showModal(); }
  sheetChart && sheetChart.remove(); sheetChart = null;
  tickerRead(tk);
  // chart
  try {
    const d = await getJSON(`${BACKEND_URL}/api/history/${tk}?range=6mo`);
    if (sheetTicker !== tk) return;
    const pts = ((d.series || {})[tk] || []).map(([time, value]) => ({time, value}));
    if (!pts.length) throw new Error('none');
    $('tk-chart-msg').style.display = 'none';
    const up = pts[pts.length - 1].value >= pts[0].value, col = up ? '#30D158' : '#FF453A';
    sheetChart = LightweightCharts.createChart($('tk-chart'), {autoSize: true, layout: {background: {type: 'solid', color: 'transparent'}, textColor: '#9FB1CE', fontSize: 11},
      grid: {vertLines: {visible: false}, horzLines: {color: 'rgba(255,255,255,0.05)'}}, rightPriceScale: {borderVisible: false}, timeScale: {borderVisible: false, fixLeftEdge: true, fixRightEdge: true},
      crosshair: {mode: 0, horzLine: {visible: false, labelVisible: false}}, localization: {locale: 'en-US', priceFormatter: v => usd(v)}, handleScroll: false, handleScale: false});
    sheetChart.addAreaSeries({lineColor: col, topColor: up ? 'rgba(48,209,88,.25)' : 'rgba(255,69,58,.25)', bottomColor: 'rgba(0,0,0,0)', lineWidth: 2, priceLineVisible: false, lastValueVisible: false}).setData(pts);
    sheetChart.timeScale().fitContent();
  } catch (e) { if (sheetTicker === tk) $('tk-chart-msg').textContent = 'Chart unavailable right now.'; }
  // news
  try {
    const d = await getJSON(`${BACKEND_URL}/api/news/tickers/${tk}?per=5`);
    if (sheetTicker !== tk) return;
    const items = (d.articles || []).slice(0, 5);
    $('tk-news').innerHTML = items.length ? items.map(newsItem).join('') : '<div class="muted-d" style="font-size:14px;padding:8px 0">No recent headlines.</div>';
  } catch (e) { if (sheetTicker === tk) $('tk-news').innerHTML = '<div class="muted-d" style="font-size:14px;padding:8px 0">Headlines unavailable right now.</div>'; }
}
// News read section: stored read if any (0 Groq calls), else an on-demand button
async function tickerRead(tk) {
  const box = () => sheetTicker === tk ? $('tk-read') : null;
  const show = (msg) => {
    const b = box(); if (!b) return;
    const r = readOf(tk);
    if (r) { b.innerHTML = readCard(r, {dark: true}); return; }
    const note = NR.state[tk] === 'thin' ? READ_MSG.thin : NR.state[tk] === 'invalid' ? READ_MSG.invalid : '';
    const off = NR.blocked || NR.busy || NR.quotaLeft === 0;
    b.innerHTML = `<p class="muted-d tk-read-msg">${esc(msg || note || 'No news read for ' + tk + ' yet.')}${quotaText() ? ' ' + esc(quotaText()) : ''}</p>`
      + (note ? '' : `<button type="button" class="btn small" id="tk-read-get"${off ? ' disabled' : ''}>Get a news read</button>`);
    const g = $('tk-read-get');
    if (g) g.onclick = async () => {
      g.disabled = true; g.textContent = 'Getting a news read…';
      const res = await requestRead(tk);
      show(res.status === 'ok' ? '' : res.message);
      if (newsTab === 'reads') renderMyReads();
    };
  };
  if (!NEWS_TK.test(tk)) { const b = box(); if (b) b.innerHTML = `<p class="muted-d tk-read-msg">${esc(READ_MSG.invalid)}</p>`; return; }
  try { await loadReads([tk]); show(); } catch (e) { show(readOf(tk) ? '' : READ_MSG.error); }
}
function wireTickerLinks() {
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-tk]');
    if (!el || el.closest('[data-unwatch]')) return;
    e.preventDefault(); openTicker(el.dataset.tk);
  });
  const dlg = $('tk-sheet');
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => { sheetTicker = null; sheetChart && sheetChart.remove(); sheetChart = null; });
}
