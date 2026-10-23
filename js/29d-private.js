// ─────────────────────────────────────────────
//  PRIVATE MARKETS (SEC Form D and Form C)
// ─────────────────────────────────────────────
// Startups raising private rounds (Form D, mostly accredited investors only) and crowdfunding
// raises anyone can join (Form C). Collected daily by scripts/private_markets.py.
let pmData = null, pmTab = 'D', pmShow = 40;
const PM_STATES = {TX: 'Texas', CA: 'California', NY: 'New York', FL: 'Florida', MA: 'Massachusetts', WA: 'Washington', CO: 'Colorado', IL: 'Illinois', DE: 'Delaware'};
// Exemption codes as filed: 06b and 06c are Rule 506(b) and 506(c)
const PM_EX = {'06b': '506(b): accredited investors, no public ads', '06c': '506(c): accredited investors, can advertise', '04': '4(a)(2)', '04a5': '4(a)(5)', '3C': 'Investment company exemption 3(c)', '3C.1': '3(c)(1)', '3C.7': '3(c)(7)'};
const pmMoney = v => v == null ? '' : v >= 1e9 ? '$' + (v / 1e9).toFixed(1) + 'B' : v >= 1e6 ? '$' + (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M' : '$' + Math.round(v / 1e3) + 'K';
const pmTitle = s => { s = String(s || ''); return s !== s.toUpperCase() ? s : s.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/\b(Llc|Inc|Lp|Llp|Ltd|Pbc|Ai|Us|Usa)\b/g, m => m.toUpperCase()); };

async function loadPrivate() {
  try { pmData = await getJSON('./private_markets.json?v=' + Math.floor(Date.now() / 3.6e6)); } catch (e) { pmData = null; }
  renderPrivate();
}

function pmFiltered() {
  const st = $('pm-state').value, stage = $('pm-stage').value, ind = $('pm-ind').value, q = $('pm-q').value.trim().toLowerCase();
  const austin = st === 'AUSTIN';
  return (pmData.raises || []).filter(r => r.f === pmTab
    && (!st || (austin ? r.st === 'TX' && /austin/i.test(r.city || '') : r.st === st))
    && (!stage || r.stage === stage)
    && (!ind || r.ind === ind)
    && (!q || (r.n || '').toLowerCase().includes(q) || (r.city || '').toLowerCase().includes(q) || (r.portal || '').toLowerCase().includes(q)));
}

function renderPrivate() {
  const box = $('pm-list'); if (!box) return;
  const tabs = [['D', 'Startup raises'], ['C', 'Open to anyone']];
  $('pm-tabs').innerHTML = tabs.map(([k, l]) => `<button type="button" aria-pressed="${k === pmTab}" data-f="${k}">${l}</button>`).join('');
  $('pm-tabs').querySelectorAll('button').forEach(b => b.onclick = () => { pmTab = b.dataset.f; pmShow = 40; renderPrivate(); });
  if (!pmData || !pmData.raises) { box.innerHTML = '<div class="empty">Private market data isn\'t available yet. It updates daily from SEC filings.</div>'; $('pm-note').textContent = ''; return; }
  // Industry options come from the data
  const indSel = $('pm-ind'), cur = indSel.value;
  const inds = [...new Set(pmData.raises.filter(r => r.f === 'D' && r.ind).map(r => r.ind))].sort();
  indSel.innerHTML = '<option value="">All industries</option>' + inds.map(i => `<option${i === cur ? ' selected' : ''}>${esc(i)}</option>`).join('');
  indSel.disabled = pmTab === 'C';
  const list = pmFiltered();
  const sort = $('pm-sort').value;
  if (sort === 'big') list.sort((a, b) => (b.amt || 0) - (a.amt || 0));
  else if (sort === 'small') list.sort((a, b) => (a.amt ?? 9e15) - (b.amt ?? 9e15));
  const total = list.reduce((s, r) => s + (r.amt || 0), 0);
  $('pm-count').textContent = `${list.length.toLocaleString()} ${pmTab === 'D' ? (list.length === 1 ? 'raise' : 'raises') : (list.length === 1 ? 'crowdfunding offer' : 'crowdfunding offers')}${total ? ' · ' + pmMoney(total) + ' sought' : ''}`;
  if (!list.length) { box.innerHTML = '<div class="empty">No matches. Try a wider filter.</div>'; }
  else box.innerHTML = list.slice(0, pmShow).map(r => {
    const where = [r.city && pmTitle(r.city), r.st].filter(Boolean).join(', ');
    const tags = r.f === 'D'
      ? `<span class="tag">${esc(r.stage)}</span>${(r.ex || []).some(x => /^06/.test(x)) ? '<span class="tag warn">Accredited investors only</span>' : ''}${r.y && +r.y >= new Date().getFullYear() - 2 ? '<span class="tag you">New company</span>' : ''}`
      : `<span class="tag you">Open to anyone</span>${r.dl ? `<span class="tag">Closes ${esc(r.dl)}</span>` : ''}`;
    const p = r.f === 'D'
      ? [r.ind, where, r.y && 'founded ' + r.y, r.sold != null && r.amt ? `${pmMoney(r.sold)} raised so far` : r.sold ? `${pmMoney(r.sold)} raised` : '', r.inv ? `${r.inv} investor${r.inv === 1 ? '' : 's'}` : '', r.min ? `min ${pmMoney(r.min)}` : '', (r.sec || []).join(', ')]
      : [where, r.portal && 'via ' + r.portal, r.type, r.price ? 'price ' + usd(r.price) : '', r.emp != null ? `${r.emp} employees` : '', r.rev != null ? `revenue ${pmMoney(r.rev)}` : ''];
    const amount = r.f === 'C' ? (r.max ? `${pmMoney(r.amt)} to ${pmMoney(r.max)}` : pmMoney(r.amt)) : r.indef ? 'Open-ended' : r.amt != null ? pmMoney(r.amt) : 'Undisclosed';
    return `<div class="rate"><div><div class="n">${esc(pmTitle(r.n))} ${tags}</div>
      <div class="p">${esc(p.filter(Boolean).join(' · '))}</div>
      <div class="p">Filed ${esc(r.d)} · <a href="${esc(r.u)}" target="_blank" rel="noopener noreferrer">SEC filing</a>${r.web ? ` · <a href="${esc(/^https?:/i.test(r.web) ? r.web : 'https://' + r.web)}" target="_blank" rel="noopener noreferrer">Website</a>` : ''}</div></div>
      <div><div class="a">${esc(amount)}</div><div class="x">${r.f === 'D' ? 'offering size' : 'target to max'}</div></div></div>`;
  }).join('') + (list.length > pmShow ? `<button class="btn ghost small" type="button" id="pm-more" style="margin-top:12px">Show more (${(list.length - pmShow).toLocaleString()} left)</button>` : '');
  const more = $('pm-more'); if (more) more.onclick = () => { pmShow += 40; renderPrivate(); };
  const upd = pmData.updated ? new Date(pmData.updated).toLocaleDateString('en-US', {month: 'short', day: 'numeric'}) : '';
  $('pm-note').textContent = (pmTab === 'D'
    ? 'Form D: companies must file within 15 days of their first sale. Most of these rounds are only open to accredited investors (about $200K+ income, or $1M+ net worth not counting your home). Stage is estimated from the raise size. Investment funds are left out.'
    : 'Form C: crowdfunding offers anyone can invest in through the listed platform, with yearly limits based on income and net worth. Startups are high risk and hard to sell.')
    + ` Last ${pmData.window_days || 60} days of SEC filings${upd ? ', updated ' + upd : ''}. Information only, not investment advice.`;
}

function wirePrivate() {
  if (!$('pm-list')) return;
  $('pm-state').innerHTML = '<option value="">All states</option><option value="AUSTIN">Austin, TX</option>'
    + Object.entries(PM_STATES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('pm-stage').innerHTML = '<option value="">Any size</option>' + ['Pre-seed / seed', 'Seed / Series A', 'Growth', 'Late stage', 'Undisclosed'].map(s => `<option>${s}</option>`).join('');
  $('pm-sort').innerHTML = '<option value="new">Newest</option><option value="big">Largest</option><option value="small">Smallest</option>';
  ['pm-state', 'pm-stage', 'pm-ind', 'pm-sort'].forEach(id => $(id).onchange = () => { pmShow = 40; renderPrivate(); });
  let t; $('pm-q').oninput = () => { clearTimeout(t); t = setTimeout(() => { pmShow = 40; renderPrivate(); }, 200); };
  loadPrivate();
}
