// ─────────────────────────────────────────────
//  LEADERBOARD
// ─────────────────────────────────────────────
let lbTab = 'active', bestCache = null;
const LB_TABS = [['active', 'Most active'], ['buyers', 'Biggest buyers'], ['best', 'Best to copy'], ['late', 'Slowest filers'], ['committee', 'Committee overlaps']];
const lowerBound = a => { const m = String(a || '').match(/\$([\d,]+)/); return m ? +m[1].replace(/,/g, '') : 0; };
function lbRow(i, rep, main, sub, right, rightSub, click) {
  return `<button type="button" class="lb-row" data-rep="${esc(rep)}"${click ? '' : ' data-noclick="1"'}>
    <span class="lb-rank num">${i + 1}</span>
    <span class="lb-main"><span class="lb-name">${esc(main)}</span><span class="lb-sub">${sub}</span></span>
    <span class="lb-right"><span class="lb-val num">${right}</span><span class="lb-sub">${rightSub}</span></span>
  </button>`;
}
function groupBy(list) { const g = {}; list.forEach(t => (g[t.representative] = g[t.representative] || []).push(t)); return g; }
async function renderLeaderboard() {
  $('lb-tabs').innerHTML = LB_TABS.map(([k, l]) => `<button type="button" aria-pressed="${k === lbTab}" data-k="${k}">${l}</button>`).join('');
  $('lb-tabs').querySelectorAll('button').forEach(b => b.onclick = () => { lbTab = b.dataset.k; renderLeaderboard(); });
  const box = $('lb-list'), note = $('lb-note');
  if (!trades.length) { box.innerHTML = '<div class="chart-msg" style="position:static;padding:28px">Loading disclosures…</div>'; return; }
  const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const recent = trades.filter(t => (t.filed || t.date) >= yearAgo);
  const g = groupBy(recent);
  let html = '';
  if (lbTab === 'active') {
    note.textContent = 'Trades filed in the past 12 months.';
    html = Object.entries(g).sort((a, b) => b[1].length - a[1].length).slice(0, 10).map(([rep, ts], i) => {
      const buys = ts.filter(t => /purchase/i.test(t.type)).length;
      return lbRow(i, rep, nameOf(rep), `${buys} buys · ${ts.length - buys} sells`, ts.length, 'trades', true);
    }).join('');
  } else if (lbTab === 'buyers') {
    note.textContent = 'Sum of the low end of each purchase range, past 12 months. Disclosures only give ranges.';
    html = Object.entries(g).map(([rep, ts]) => [rep, ts.filter(t => /purchase/i.test(t.type)).reduce((s, t) => s + lowerBound(t.amount), 0), ts]).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([rep, v, ts], i) => { const top = Object.entries(ts.filter(t => /purchase/i.test(t.type) && t.ticker).reduce((m, t) => (m[t.ticker] = (m[t.ticker] || 0) + lowerBound(t.amount), m), {})).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]).join(', ');
        return lbRow(i, rep, nameOf(rep), top ? 'Top buys: ' + esc(top) : 'Mostly bonds or private assets', compact(v) + '+', 'bought', true); }).join('');
  } else if (lbTab === 'late') {
    note.textContent = `The STOCK Act gives members ${LATE_DAYS} days to file. Average delay and late filings, past 12 months.`;
    html = Object.entries(g).map(([rep, ts]) => { const lags = ts.map(lagOf).filter(x => x !== null && x >= 0); return [rep, lags.length ? lags.reduce((a, b) => a + b, 0) / lags.length : 0, lags.filter(x => x > LATE_DAYS).length, Math.max(0, ...lags)]; })
      .filter(x => x[1] > 0).sort((a, b) => b[2] - a[2] || b[1] - a[1]).slice(0, 10)
      .map(([rep, avg, late, max], i) => lbRow(i, rep, nameOf(rep), late ? `<span class="late-txt">${late} late filing${late > 1 ? 's' : ''}</span> · longest ${max} days` : `Longest ${max} days`, Math.round(avg) + 'd', 'avg delay', true)).join('');
  } else if (lbTab === 'committee') {
    note.textContent = 'Trades in industries overseen by a committee the member sits on. Overlap is not wrongdoing, it is context.';
    html = Object.entries(g).map(([rep, ts]) => [rep, ts.filter(t => t.committees && t.committees.length)]).filter(x => x[1].length).sort((a, b) => b[1].length - a[1].length).slice(0, 10)
      .map(([rep, ts], i) => { const cs = [...new Set(ts.flatMap(t => t.committees))].slice(0, 2).join(', '); const tk = [...new Set(ts.map(t => t.ticker))].slice(0, 4).join(', ');
        return lbRow(i, rep, nameOf(rep), esc(cs) + ' · ' + esc(tk), ts.length, 'overlaps', true); }).join('')
      || '<div class="chart-msg" style="position:static;padding:28px">Committee data appears after the next daily update.</div>';
  } else if (lbTab === 'best') {
    note.textContent = '$10,000 following the 12 most active members and 6 famous investors, from their first filing in the past year. Return vs buying VOO on the same day.';
    if (!bestCache) {
      box.innerHTML = '<div class="chart-msg" style="position:static;padding:28px">Testing the 12 most active members…</div>';
      try {
        const cands = [...copyCandidates().slice(0, 12), ...smart.investors.map(x => 'inv:' + x.id)];
        await ensureHistory(['VOO', ...cands.flatMap(r => (planFor(r) || {}).tickers || [])]);
        bestCache = cands.map(r => [r, simulate(r)]).filter(x => x[1]).sort((a, b) => (b[1].r - b[1].vr) - (a[1].r - a[1].vr));
      } catch (e) { box.innerHTML = '<div class="chart-msg" style="position:static;padding:28px">Price history is unavailable right now. Try again in a minute.</div>'; return; }
      if (lbTab !== 'best') return;
    }
    html = bestCache.map(([rep, res], i) => lbRow(i, rep, keyName(rep) + (rep.startsWith('inv:') ? ' · investor' : ''), `${res.filings} filings · vs VOO <span class="${res.r - res.vr >= 0 ? 'up' : 'down'}">${res.r - res.vr >= 0 ? '+' : ''}${(res.r - res.vr).toFixed(1)} pts</span>`, `<span class="${res.r >= 0 ? 'up' : 'down'}">${pct(res.r)}</span>`, usd(res.end, 0), true)).join('');
  }
  box.innerHTML = html || '<div class="chart-msg" style="position:static;padding:28px">Nothing to show yet.</div>';
  box.querySelectorAll('.lb-row:not([data-noclick])').forEach(b => b.onclick = () => { runCopyTest(b.dataset.rep); $('copy').scrollIntoView({behavior: reduced ? 'auto' : 'smooth'}); });
}

function wireNavHighlight() {
  const links = [...document.querySelectorAll('.navlinks a')];
  const map = new Map(links.map(a => [a.getAttribute('href').slice(1), a]));
  if (!('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver(entries => entries.forEach(en => {
    if (!en.isIntersecting) return;
    const a = map.get(en.target.id); if (!a) return;
    links.forEach(l => l.classList.toggle('active', l === a));
    const row = a.parentElement;
    if (row.scrollWidth > row.clientWidth) row.scrollTo({left: a.offsetLeft - 14, behavior: reduced ? 'auto' : 'smooth'});
  }), {rootMargin: '-45% 0px -50% 0px'});
  map.forEach((a, id) => { const sec = document.getElementById(id); if (sec) io.observe(sec); });
}
function wireReveal() {
  const els = document.querySelectorAll('.reveal');
  if (reduced || !('IntersectionObserver' in window)) { els.forEach(e => e.classList.add('in')); return; }
  const io = new IntersectionObserver(entries => entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), {rootMargin: '0px 0px -8% 0px'});
  els.forEach(e => io.observe(e));
}
