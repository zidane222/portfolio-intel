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
    ['reads', 'My reads', getNewsList()],
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
  if (newsTab === 'reads') { renderMyReads(); return; }
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
  if (['pelosi', 'trump', 'congress'].includes(tab) && tickers && tickers.length) universeReads(tab, tickers);
}
// Read cards above the headlines for tickers that have a stored read (public universe)
async function universeReads(tab, tickers) {
  try { await loadReads(tickers); } catch (e) { return; }
  const cards = tickers.map(readOf).filter(Boolean).slice(0, 4);
  if (tab !== newsTab || !cards.length || $('news-list').querySelector('.nr-uni')) return;
  $('news-list').insertAdjacentHTML('afterbegin', `<div class="nr-uni"><h3 class="nr-h">News reads</h3>${cards.map(r => readCard(r, {title: true})).join('')}</div>`);
}

// ── My reads tab: editable list on this device ──
let nrMsg = '';
function renderMyReads() {
  const el = $('news-list');
  const list = getNewsList();
  // keep what the user is typing across re-renders
  const prev = $('nr-in'), typed = prev ? prev.value : '', hadFocus = prev && document.activeElement === prev;
  const chips = list.length ? list.map(t => `<span class="chip-l nr-chip"><button type="button" class="nr-tkb" data-tk="${esc(t)}">${esc(t)}</button><button type="button" class="nr-x" aria-label="Remove ${esc(t)} from my reads" data-nr-rm="${esc(t)}"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button></span>`).join('')
    : '<span class="fine">No tickers yet. Add one below.</span>';
  const rows = list.map(t => {
    const r = readOf(t), st = NR.state[t];
    if (r) return readCard(r, {title: true});
    const note = st === 'thin' ? READ_MSG.thin : st === 'invalid' ? READ_MSG.invalid : '';
    const off = NR.blocked || NR.busy || NR.quotaLeft === 0;
    return `<div class="nr-row"><button type="button" class="nr-tk" data-tk="${esc(t)}">${esc(t)}</button>${note ? `<span class="nr-note">${esc(note)}</span>` : `<button type="button" class="btn small nr-get" data-nr-get="${esc(t)}"${off ? ' disabled' : ''}>Get a news read</button>`}</div>`;
  }).join('');
  el.innerHTML = `<div class="nr-edit">
      <p class="fine">Your watchlist and portfolio tickers by default. This list stays on this device. Each read says what the news says, not what to do.</p>
      <div class="chips" id="nr-chips">${chips}</div>
      <form class="watch-form nr-form" id="nr-form"><label class="sr" for="nr-in">Add a ticker to my reads</label><input id="nr-in" placeholder="Add ticker, e.g. PLTR" autocapitalize="characters" autocomplete="off" maxlength="6"><button class="btn small" type="submit">Add</button></form>
      ${newsListIsDefault() ? '' : '<button type="button" class="btn small ghost nr-reset" id="nr-reset">Reset to watchlist and portfolio</button>'}
      <p class="nr-status" id="nr-status" role="status" aria-live="polite">${esc([nrMsg, quotaText()].filter(Boolean).join(' '))}</p>
    </div><div id="nr-rows">${rows || ''}</div>`;
  if (typed) $('nr-in').value = typed;
  if (hadFocus) $('nr-in').focus();
  el.querySelectorAll('[data-nr-rm]').forEach(b => b.onclick = () => { const t = b.dataset.nrRm; saveNewsList(getNewsList().filter(x => x !== t)); nrMsg = `Removed ${t}.`; renderMyReads(); });
  el.querySelectorAll('[data-nr-get]').forEach(b => b.onclick = () => getReadFor(b.dataset.nrGet));
  $('nr-form').onsubmit = e => {
    e.preventDefault();
    const t = $('nr-in').value.toUpperCase().trim();
    if (!NEWS_TK.test(t)) { nrMsg = 'Enter a ticker of 1 to 6 letters, like NVDA.'; renderMyReads(); $('nr-in').focus(); return; }
    const cur = getNewsList();
    if (cur.includes(t)) nrMsg = `${t} is already in your list.`;
    else if (cur.length >= NEWSLIST_MAX) nrMsg = `Your list can hold ${NEWSLIST_MAX} tickers.`;
    else { saveNewsList([...cur, t]); nrMsg = `Added ${t}.`; }
    $('nr-in').value = ''; renderMyReads(); $('nr-in').focus();
    loadReads(getNewsList()).then(() => newsTab === 'reads' && renderMyReads()).catch(() => {});
  };
  if ($('nr-reset')) $('nr-reset').onclick = () => { saveNewsList(null); nrMsg = 'List reset to your watchlist and portfolio.'; renderMyReads(); loadReads(getNewsList()).then(() => newsTab === 'reads' && renderMyReads()).catch(() => {}); };
  if (list.length && !renderMyReads.asked) {
    renderMyReads.asked = true;
    loadReads(list).then(() => { if (newsTab === 'reads') renderMyReads(); }).catch(() => { nrMsg = READ_MSG.error; if (newsTab === 'reads') renderMyReads(); });
  }
}
async function getReadFor(t) {
  nrMsg = `Getting a news read for ${t}.`; NR.busy = true; renderMyReads(); NR.busy = false;
  const r = await requestRead(t);
  nrMsg = r.status === 'ok' ? `News read for ${t} is ready.` : r.message;
  if (newsTab === 'reads') renderMyReads();
}
