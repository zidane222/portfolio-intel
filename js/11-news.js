// ─────────────────────────────────────────────
//  NEWS
// ─────────────────────────────────────────────
let newsTab = null, newsCache = {};
// Group headlines about the same story so each story shows once
const STOP = new Set('the a an and or of to in on for with at by from as is are was were be its it this that after over into amid says said new will could may than more how why what who stock stocks shares market markets s'.split(' '));
function words(t) { return new Set(String(t).toLowerCase().replace(/[^a-z0-9$% ]+/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w))); }
function clusterNews(items) {
  const sorted = items.slice().sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0));
  const groups = [];
  for (const a of sorted) {
    const w = words(a.title);
    let best = null, bestScore = 0;
    for (const g of groups) {
      let shared = 0; w.forEach(x => { if (g.words.has(x)) shared++; });
      const score = shared / Math.max(1, Math.min(w.size, g.words.size));
      if (score > bestScore) { bestScore = score; best = g; }
    }
    if (best && bestScore >= 0.6 && w.size >= 3) { best.more.push(a); w.forEach(x => best.words.add(x)); }
    else groups.push({...a, words: w, more: []});
  }
  // Stories covered by more sources rank a little higher
  return groups.sort((a, b) => (b.more.length - a.more.length) * 6 * 3600e3 + (new Date(b.published || 0) - new Date(a.published || 0)));
}
function newsItem(a) {
  const href = /^https?:\/\//.test(a.link || '') ? a.link : '#';
  const when = a.published ? ago(new Date(a.published)) : '';
  const tag = a.ticker ? `<button type="button" class="news-tag tk-link" data-tk="${esc(a.ticker)}" style="text-decoration:none">${esc(a.ticker)}</button>${a.why ? `<span class="news-tag" style="background:rgba(90,107,133,.12);color:#3A4A63">${esc(a.why)}</span>` : ''}` : '';
  const others = (a.more || []).filter(o => o.source !== a.source || o.link !== a.link);
  const srcs = new Set([a.source, ...others.map(o => o.source)]);
  const more = others.length ? `<details class="news-more"><summary>Also covered by ${esc([...srcs].filter(x => x !== a.source).slice(0, 3).join(', ') || others.length + ' more')}</summary>${others.slice(0, 6).map(o => `<a href="${esc(/^https?:\/\//.test(o.link || '') ? o.link : '#')}" target="_blank" rel="noopener">${esc(o.source)}: ${esc(o.title)}</a>`).join('')}</details>` : '';
  return `<div class="news-item"><a href="${esc(href)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none"><div class="t">${esc(a.title)}</div></a><div class="m">${tag}${esc(a.source)}${a.source && when ? ' · ' : ''}${esc(when)}${srcs.size > 1 ? `<span class="src-count">${srcs.size} sources</span>` : ''}</div>${more}</div>`;
}
function newsTabs() {
  const f = [...followed()];
  const pel = [...new Set([...trades.filter(t => /pelosi/i.test(t.representative) && t.ticker).map(t => t.ticker), ...REF.pelosi.map(h => h.ticker)])].slice(0, 8);
  const cut = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const counts = {}; trades.filter(t => t.ticker && (t.filed || t.date) >= cut).forEach(t => counts[t.ticker] = (counts[t.ticker] || 0) + 1);
  const hot = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(x => x[0]);
  return [
    ['mine', 'Your stocks', f.slice(0, 12)],
    ['market', 'Top stories', null],
    ['social', 'Reddit', null],
    ['pelosi', 'Pelosi', pel],
    ['trump', 'Trump', REF.trump.map(h => h.ticker)],
    ['congress', 'Most traded', hot],
  ];
}
function whyTag(tk) {
  const f = followed(), own = stocks().some(h => h.ticker === tk);
  if (own) return 'You own';
  if (f.has(tk)) return 'Watching';
  if (REF.pelosi.some(h => h.ticker === tk)) return 'Pelosi bought';
  if (REF.trump.some(h => h.ticker === tk)) return 'Trump holds';
  const n = new Set(trades.filter(t => t.ticker === tk).map(t => t.representative)).size;
  return n ? `${n} in Congress` : '';
}
async function loadNews() {
  const tabs = newsTabs();
  if (!newsTab) newsTab = tabs[0][2].length ? 'mine' : 'market';
  $('news-tabs').innerHTML = tabs.map(([k, l]) => `<button type="button" aria-pressed="${k === newsTab}" data-n="${k}">${l}</button>`).join('');
  $('news-tabs').querySelectorAll('button').forEach(b => b.onclick = () => { newsTab = b.dataset.n; loadNews(); });
  const el = $('news-list');
  const [, , tickers] = tabs.find(t => t[0] === newsTab);
  if (newsTab === 'mine' && !tickers.length) { el.innerHTML = '<div class="empty">Add your portfolio or a watchlist to see news about your stocks.</div>'; return; }
  if (newsCache[newsTab]) { el.innerHTML = newsCache[newsTab]; return; }
  el.innerHTML = '<div class="empty">Loading headlines…</div>';
  const tab = newsTab;
  try {
    let raw;
    if (tickers) raw = (await getJSON(`${BACKEND_URL}/api/news/tickers/${tickers.join(',')}?per=4`)).articles || [];
    else {
      try { raw = (await getJSON(BACKEND_URL + '/api/feeds')).articles || []; }
      catch (e) { raw = (await getJSON(BACKEND_URL + '/api/news')).articles || []; }
      raw = raw.filter(a => tab === 'social' ? a.social : !a.social);
    }
    const items = clusterNews(raw.map(a => ({...a, why: a.ticker ? whyTag(a.ticker) : ''}))).slice(0, 14);
    if (!items.length) throw new Error('none');
    newsCache[tab] = items.map(newsItem).join('');
  } catch (e) {
    newsCache[tab] = null;
    if (tab === newsTab) el.innerHTML = '<div class="empty">Headlines are unavailable right now.</div>';
    return;
  }
  if (tab === newsTab) el.innerHTML = newsCache[tab];
}
