// ─────────────────────────────────────────────
//  INDUSTRY MIX (donut)
// ─────────────────────────────────────────────
function sectorOf(t) { return (sectorCache[t] && sectorCache[t].sector) || SECTOR_OF[t] || null; }
async function loadSectors() {
  const need = stocks().map(h => h.ticker).filter(t => !sectorOf(t));
  if (!need.length) return;
  try {
    const d = await getJSON(BACKEND_URL + '/api/sectors/' + need.join(','));
    Object.assign(sectorCache, d.sectors || {});
    try { localStorage.setItem(SECTOR_KEY, JSON.stringify(sectorCache)); } catch (e) {}
  } catch (e) {}
  renderMix();
}
function mixData(who) {
  const list = who === 'pelosi' ? REF.pelosi.map(h => ({ticker: h.ticker, value: h.shares * priceOf(h.ticker, h.cost), sector: h.sector}))
    : who === 'trump' ? REF.trump.map(h => ({ticker: h.ticker, value: h.shares * priceOf(h.ticker, h.cost), sector: h.sector}))
    : myPortfolio.map(h => h.isCash
        ? {ticker: h.ticker, value: h.marketValue || 0, sector: 'Money market'}
        : {ticker: h.ticker, value: h.shares * priceOf(h.ticker, h.currentPrice || h.avgCost || 0), sector: sectorOf(h.ticker) || 'Other'});
  const groups = {};
  list.filter(x => x.value > 0).forEach(x => { (groups[x.sector] = groups[x.sector] || {sector: x.sector, value: 0, tickers: []}); groups[x.sector].value += x.value; groups[x.sector].tickers.push(x); });
  let arr = Object.values(groups).sort((a, b) => b.value - a.value);
  // Keep at most 7 named slices; fold the rest into Other. Money market and Other always sit last in gray tones.
  const tail = arr.filter(g => g.sector === 'Money market' || g.sector === 'Other');
  let named = arr.filter(g => g.sector !== 'Money market' && g.sector !== 'Other');
  if (named.length > 7) {
    const extra = named.slice(7); named = named.slice(0, 7);
    const other = tail.find(g => g.sector === 'Other') || (tail.push({sector: 'Other', value: 0, tickers: []}), tail[tail.length - 1]);
    extra.forEach(g => { other.value += g.value; other.tickers.push(...g.tickers); });
  }
  arr = [...named.map((g, i) => ({...g, color: MIX_COLORS[i]})), ...tail.sort((a, b) => a.sector === 'Money market' ? 1 : -1).map(g => ({...g, color: g.sector === 'Money market' ? '#C7D2E3' : '#6E7F9C'}))];
  const total = arr.reduce((s, g) => s + g.value, 0);
  return {groups: arr.map(g => ({...g, pct: total ? g.value / total * 100 : 0, tickers: g.tickers.sort((a, b) => b.value - a.value).map(x => x.ticker)})), total};
}
function renderMix() {
  const who = [['me', 'You'], ['pelosi', 'Pelosi'], ['trump', 'Trump']];
  $('mix-who').innerHTML = who.map(([k, l]) => `<button type="button" aria-pressed="${k === mixWho}" data-w="${k}">${l}</button>`).join('');
  $('mix-who').querySelectorAll('button').forEach(b => b.onclick = () => { mixWho = b.dataset.w; mixHot = null; renderMix(); });

  const svg = $('donut'), legend = $('mix-legend'), center = $('donut-center');
  if (mixWho === 'me' && !myPortfolio.length) {
    svg.innerHTML = '<circle cx="100" cy="100" r="70" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="34"/>';
    center.innerHTML = '<div class="small">No holdings yet</div>';
    legend.innerHTML = '<div class="muted-d" style="font-size:15px;line-height:1.5;padding:8px">Add your portfolio to see how it splits across industries. <a href="#import" style="color:#8EC5FF">Add portfolio</a></div>';
    return;
  }
  const {groups, total} = mixData(mixWho);
  if (!total) {
    svg.innerHTML = '<circle cx="100" cy="100" r="70" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="34"/>';
    center.innerHTML = '<div class="small">Waiting for prices</div>'; legend.innerHTML = ''; return;
  }
  const R = 70, C = 2 * Math.PI * R, gap = groups.length > 1 ? 1.2 : 0;
  let off = 0;
  svg.innerHTML = groups.map((g, i) => {
    const len = Math.max(0, g.pct / 100 * C - gap);
    const el = `<circle class="seg${mixHot === null ? '' : mixHot === i ? ' hot' : ' dim'}" data-i="${i}" cx="100" cy="100" r="${R}" stroke="${g.color}" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}"><title>${esc(g.sector)} ${g.pct.toFixed(1)}%</title></circle>`;
    off += g.pct / 100 * C;
    return el;
  }).join('');
  const h = mixHot !== null ? groups[mixHot] : null;
  center.innerHTML = h
    ? `<div class="big num">${h.pct.toFixed(1)}%</div><div class="small">${esc(h.sector)}</div>`
    : `<div class="big num">${compact(total)}</div><div class="small">${groups.length} ${groups.length === 1 ? 'industry' : 'industries'}</div>`;
  legend.innerHTML = groups.map((g, i) => `<button type="button" class="mix-row${mixHot === i ? ' hot' : ''}" data-i="${i}">
      <span class="sw" style="background:${g.color}"></span><span>${esc(g.sector)}</span><span class="pc">${g.pct.toFixed(1)}%</span><span class="dl">${compact(g.value)}</span>
      <span class="tks">${esc(g.tickers.slice(0, 6).join(', '))}${g.tickers.length > 6 ? ` +${g.tickers.length - 6}` : ''}</span>
    </button>`).join('');
  const pick = i => { mixHot = mixHot === i ? null : i; renderMix(); };
  svg.querySelectorAll('.seg').forEach(c => { c.onclick = () => pick(+c.dataset.i); c.onmouseenter = () => { if (mixHot !== +c.dataset.i) { mixHot = +c.dataset.i; renderMix(); } }; });
  svg.onmouseleave = () => { if (mixHot !== null) { mixHot = null; renderMix(); } };
  legend.querySelectorAll('.mix-row').forEach(b => b.onclick = () => pick(+b.dataset.i));
  $('mix-desc').textContent = 'Industry breakdown: ' + groups.map(g => `${g.sector} ${g.pct.toFixed(0)}%`).join(', ');
}
