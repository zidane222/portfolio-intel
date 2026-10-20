// ─────────────────────────────────────────────
//  SMART MONEY: insider buys + famous investors (SEC filings)
// ─────────────────────────────────────────────
let smTab = 'insiders', smInv = null, smFilter = 'all';
function renderSmart() {
  const tabs = [['insiders', 'Insider buys'], ['investors', 'Famous investors']];
  $('sm-tabs').innerHTML = tabs.map(([k, l]) => `<button type="button" aria-pressed="${k === smTab}" data-k="${k}">${l}</button>`).join('');
  $('sm-tabs').querySelectorAll('button').forEach(b => b.onclick = () => { smTab = b.dataset.k; renderSmart(); });
  const box = $('sm-body');
  const fmtD = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', {month: 'short', day: 'numeric'}) : '';
  if (smTab === 'insiders') {
    if (!insiderBuys.length) { box.innerHTML = '<div class="chart-msg" style="position:static;padding:28px">Insider filings appear after the next daily update.</div>'; return; }
    const f = followed();
    const filters = [['all', 'All'], ['big', '$1M+'], ['ceo', 'CEOs & CFOs'], ['mine', 'My stocks']];
    let list = insiderBuys;
    if (smFilter === 'big') list = list.filter(b => b.value >= 1e6);
    if (smFilter === 'ceo') list = list.filter(b => /chief executive|ceo|chief financial|cfo|president/i.test(b.role));
    if (smFilter === 'mine') list = list.filter(b => f.has(b.ticker));
    const month = insiderBuys.filter(b => b.filed >= new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10));
    const total = month.reduce((s, b) => s + b.value, 0);
    box.innerHTML = `<div class="sm-head"><div><div class="muted-d" style="font-size:13px">Open-market purchases, last 30 days</div><div class="sm-big num">${compact(total)} by ${new Set(month.map(b => b.owner)).size} insiders</div></div>
      <div class="seg seg-scroll" id="sm-filter">${filters.map(([k, l]) => `<button type="button" aria-pressed="${k === smFilter}" data-f="${k}">${l}</button>`).join('')}</div></div>
      <div class="lb-note muted-d">Executives and directors buying their own company's stock with their own money. Filed within 2 business days.</div>`
      + (list.slice(0, 25).map(b => `<div class="trade">
          <div><div class="who">${esc(b.owner)} · ${esc(b.role)}</div><div class="what"><button type="button" class="tk-link" data-tk="${esc(b.ticker)}">${esc(b.ticker)}</button><span class="pill buy">Bought</span>${f.has(b.ticker) ? '<span class="pill mine">You own</span>' : ''}</div><div class="who" style="margin-top:2px">${esc(b.company)}</div></div>
          <div><div class="amt num">${compact(b.value)}</div><div class="when">${b.shares.toLocaleString('en-US')} sh @ ${usd(b.price)}</div><div class="when">Traded ${esc(fmtD(b.date))} · filed ${esc(fmtD(b.filed))}</div></div>
        </div>`).join('') || '<div class="chart-msg" style="position:static;padding:28px">No purchases match this filter.</div>');
    box.querySelectorAll('#sm-filter button').forEach(b => b.onclick = () => { smFilter = b.dataset.f; renderSmart(); });
    return;
  }
  const invs = smart.investors.filter(x => x.quarters && x.quarters.length);
  if (!invs.length) { box.innerHTML = '<div class="chart-msg" style="position:static;padding:28px">Investor holdings appear after the next daily update.</div>'; return; }
  smInv = smInv || invs[0].id;
  const inv = invs.find(x => x.id === smInv) || invs[0];
  const [q, prev] = inv.quarters;
  const prevMap = new Map((prev ? prev.holdings : []).map(h => [h.cusip, h]));
  const curSet = new Set(q.holdings.map(h => h.cusip));
  const sold = prev ? prev.holdings.filter(h => !curSet.has(h.cusip) && h.pct >= 0.5) : [];
  box.innerHTML = `<div class="sm-head" style="margin-bottom:12px"><label class="sr" for="sm-inv">Investor</label><select id="sm-inv" class="picker">${invs.map(x => `<option value="${esc(x.id)}"${x.id === inv.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      <button class="btn glass small" type="button" id="sm-copy">Copy test</button></div>
    <div class="muted-d" style="font-size:13px">${esc(inv.firm)} · holdings as of ${esc(new Date(q.period + 'T12:00:00').toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'}))} · filed ${esc(fmtD(q.filed))}</div>
    <div class="sm-big num" style="margin:4px 0 10px">${compact(q.total)} across ${q.positions} positions</div>`
    + q.holdings.slice(0, 15).map(h => {
      const p = prevMap.get(h.cusip);
      const chg = !prev ? '' : !p ? '<span class="chg new">New</span>' : h.shares > p.shares * 1.05 ? `<span class="chg add">Added ${Math.round((h.shares / p.shares - 1) * 100)}%</span>` : h.shares < p.shares * 0.95 ? `<span class="chg cut">Trimmed ${Math.round((1 - h.shares / p.shares) * 100)}%</span>` : '';
      return `<div class="hold"><div><div class="what" style="font-size:15px">${h.ticker ? `<button type="button" class="tk-link" data-tk="${esc(h.ticker)}">${esc(h.ticker)}</button>` : ''} <span class="who" style="font-weight:400">${esc(h.name)}</span>${chg}</div></div>
        <div class="num" style="text-align:right;font-weight:600">${h.pct.toFixed(1)}%<div class="when">${compact(h.value)}</div></div>
        <div class="bar"><span style="width:${Math.min(100, h.pct / q.holdings[0].pct * 100)}%"></span></div></div>`;
    }).join('')
    + (sold.length ? `<div class="soldout">Sold out since last quarter: ${sold.slice(0, 10).map(h => esc(h.ticker || h.name)).join(', ')}</div>` : '')
    + '<div class="lb-note muted-d" style="margin-top:12px">13F filings are due 45 days after each quarter ends, so these holdings can be up to 4.5 months old. Long US stock positions only.</div>';
  $('sm-inv').onchange = e => { smInv = e.target.value; renderSmart(); };
  $('sm-copy').onclick = () => { runCopyTest('inv:' + inv.id); $('copy').scrollIntoView({behavior: reduced ? 'auto' : 'smooth'}); };
}
