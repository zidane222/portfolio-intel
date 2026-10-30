// ─────────────────────────────────────────────
//  DISCLOSURES FEED
// ─────────────────────────────────────────────
let senateNote = '';
async function loadTrades() {
  let d = null;
  try { d = await getJSON('./trades.json?v=' + Math.floor(Date.now() / 3.6e6)); }
  catch (e) { try { d = await getJSON(BACKEND_URL + '/api/all-trades'); } catch (e2) {} }
  if (d && Array.isArray(d.trades)) {
    trades = d.trades.filter(t => (t.ticker && t.ticker.length <= 6) || (t.private && t.description)).map(t => ({...t, amount: String(t.amount || '').replace(/\s+/g, ' ').replace(/\s*-\s*/, ' - ')})).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    tradesUpdated = d.updated ? new Date(d.updated) : null;
    const fmtDay = s => new Date(s + 'T12:00:00').toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
    const hc = d.fmp_house_check || {};
    senateNote = d.senate_stale && d.senate_as_of ? ` · Senate trades as of ${fmtDay(d.senate_as_of)} (Senate updates are delayed)`
      : d.senate_source === 'FMP' && d.senate_newest_filing ? ` · Senate data via FMP, newest filing ${fmtDay(d.senate_newest_filing)}${hc.checked ? `, ${Math.round(hc.rate * 100)}% match on the official House check` : ''}` : '';
  }
  buildPelosiRef();
  if (REF.pelosi.some(h => !prices[h.ticker])) loadPrices().then(loadHistory);
  try { const t = await getJSON('./trump_filings.json?v=' + Math.floor(Date.now() / 3.6e6)); trumpFilings = t.filings || []; } catch (e) {}
  try { smart = await getJSON('./smart_money.json?v=' + Math.floor(Date.now() / 3.6e6)); smart.investors = smart.investors || []; } catch (e) {}
  try { insiderBuys = (await getJSON('./insiders.json?v=' + Math.floor(Date.now() / 3.6e6))).buys || []; } catch (e) {}
  renderSmart();
  fillFeedFilters(); renderFeed(); renderHoldings(); renderSignals();
  bestCache = null; renderAnyMember();
  runCopyTest(); renderLeaderboard();
}
function renderFeed() {
  const filters = [['all','All'],['house','House'],['senate','Senate'],['pelosi','Pelosi'],['trump','Trump'],['large','Large trades'],['mine','My stocks + watchlist']];
  $('feed-filter').innerHTML = filters.map(([k, l]) => `<button type="button" aria-pressed="${k === feedFilter}" data-f="${k}">${l}</button>`).join('');
  $('feed-filter').querySelectorAll('button').forEach(b => b.onclick = () => { feedFilter = b.dataset.f; feedLimit = 12; trumpLimit = 6; renderFeed(); });

  const mine = new Set(stocks().map(h => h.ticker));
  let list = trades;
  if (feedFilter === 'pelosi') list = trades.filter(t => /pelosi/i.test(t.representative || ''));
  if (feedFilter === 'senate') list = trades.filter(t => t.source === 'senate');
  if (feedFilter === 'house') list = trades.filter(t => t.source !== 'senate');
  if (feedFilter === 'mine') { const f = followed(); list = trades.filter(t => f.has(t.ticker)); }
  if (feedFilter === 'large') list = trades.filter(t => lowerBound(t.amount) >= LARGE);
  // Advanced filters
  const fm = feedAdv.member.trim().toLowerCase();
  if (fm) list = list.filter(t => nameOf(t.representative).toLowerCase().includes(fm) || (t.representative || '').toLowerCase().includes(fm));
  if (feedAdv.sector) list = list.filter(t => (t.sector || sectorOf(t.ticker) || '') === feedAdv.sector);
  if (feedAdv.type) list = list.filter(t => feedAdv.type === 'buy' ? /purchase/i.test(t.type) : /sale/i.test(t.type));
  if (feedAdv.size) list = list.filter(t => lowerBound(t.amount) >= feedAdv.size);
  if (feedAdv.flagged) list = list.filter(t => flags[tradeKey(t)]);
  const advOn = fm || feedAdv.sector || feedAdv.type || feedAdv.size || feedAdv.flagged;
  const fresh = lastVisit ? trades.filter(t => (t.filed || '') > lastVisit).length : 0;
  $('feed-lede').innerHTML = (tradesUpdated ? `${trades.length} recent trades · filings checked ${esc(ago(tradesUpdated))}${esc(senateNote)}` : 'Congressional trades, as filed.') + (fresh ? `<span class="new-dot">${fresh} new since your last visit</span>` : '');

  const feed = $('feed');
  if (feedFilter === 'trump') { renderTrumpFeed(feed); return; }
  if (!trades.length) { feed.innerHTML = '<div class="chart-msg" style="position:static;padding:28px">Loading disclosures…</div>'; $('feed-more').style.display = 'none'; return; }
  if (!list.length) {
    const why = feedAdv.flagged && !Object.keys(flags).length ? 'Nothing flagged yet. Tap Flag on any trade to save it for review.' : feedFilter === 'mine' && !advOn ? (mine.size ? 'No recent filings touch your stocks.' : 'Add your portfolio to see trades in your stocks.') : 'No filings match these filters.';
    feed.innerHTML = `<div class="chart-msg" style="position:static;padding:28px">${why}</div>`; $('feed-more').style.display = 'none'; return;
  }
  if (advOn || feedFilter !== 'all') $('feed-lede').innerHTML += ` <span class="new-dot" style="background:rgba(255,255,255,.18)">${list.length} match</span>`;
  feed.innerHTML = list.slice(0, feedLimit).map(t => {
    const buy = /purchase|buy/i.test(t.type || '');
    const k = tradeKey(t), fl = flags[k], big = lowerBound(t.amount) >= LARGE;
    const name = nameOf(t.representative);
    const fmtD = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'}) : '';
    const traded = fmtD(t.date), filed = fmtD(t.filed);
    const lag = t.date && t.filed ? Math.round((new Date(t.filed) - new Date(t.date)) / 864e5) : null;
    const label = t.private ? `<span class="priv">${esc(t.description)}</span>` : `<button type="button" class="tk-link" data-tk="${esc(t.ticker)}">${esc(t.ticker)}</button>`;
    return `<div class="trade${fl ? ' flagged' : ''}">
      <div><div class="who">${t.source === 'senate' ? '<span class="pill chamber">Senate</span>' : ''}${esc(name)}${t.sector ? ' · ' + esc(t.sector) : ''}</div><div class="what">${label}<span class="pill ${buy ? 'buy' : 'sell'}">${buy ? 'Buy' : 'Sell'}</span>${big ? '<span class="pill big">Large</span>' : ''}${!t.private && (t.kind === 'Mutual fund' || t.kind === 'ETF') ? `<span class="pill priv-pill">${t.kind === 'ETF' ? 'ETF' : 'Fund'}</span>` : ''}${t.private ? `<span class="pill priv-pill">${esc(t.kind || 'Private investment')}</span>` : ''}${mine.has(t.ticker) ? '<span class="pill mine">You own</span>' : ''}${lag !== null && lag > LATE_DAYS ? `<span class="pill late">Filed late</span>` : ''}${t.committees && t.committees.length ? `<span class="pill cmte" title="${esc('Sits on ' + t.committees.join(', '))}">Committee overlap</span>` : ''}</div>${t.committees && t.committees.length ? `<div class="who" style="margin-top:2px">Sits on ${esc(t.committees.join(', '))}</div>` : ''}</div>
      <div><div class="amt num">${esc(t.amount || '')}</div><div class="when">Traded ${esc(traded)}</div>${filed ? `<div class="when">Filed ${esc(filed)}${lag !== null && lag >= 0 ? ` · ${lag}d later` : ''}</div>` : ''}
        <div class="row-acts">${t.ticker ? `<button type="button" class="mini" data-track="${esc(t.ticker)}" aria-label="Track ${esc(t.ticker)} in your portfolio">+ Track</button>` : ''}<button type="button" class="mini" data-flag="${esc(k)}" aria-pressed="${!!fl}" aria-label="${fl ? 'Unflag' : 'Flag for review'}">${fl ? 'Flagged' : 'Flag'}</button></div></div>
      ${fl ? `<div style="grid-column:1 / -1"><label class="sr" for="n-${esc(btoa(unescape(encodeURIComponent(k))).slice(0, 16))}">Review note</label><input class="flag-note" id="n-${esc(btoa(unescape(encodeURIComponent(k))).slice(0, 16))}" data-note="${esc(k)}" placeholder="Add a review note" value="${esc(fl.note || '')}"></div>` : ''}
    </div>`;
  }).join('');
  $('feed-more').style.display = list.length > feedLimit ? 'inline-flex' : 'none';
  feed.querySelectorAll('[data-flag]').forEach(b => b.onclick = () => {
    const key = b.dataset.flag;
    if (flags[key]) delete flags[key]; else flags[key] = {at: new Date().toISOString().slice(0, 10), note: ''};
    saveFlags(); renderFeed();
  });
  feed.querySelectorAll('[data-note]').forEach(i => i.onchange = () => { if (flags[i.dataset.note]) { flags[i.dataset.note].note = i.value.slice(0, 200); saveFlags(); } });
  feed.querySelectorAll('[data-track]').forEach(b => b.onclick = () => openTicker(b.dataset.track, true));
  $('f-flagged').textContent = `Flagged${Object.keys(flags).length ? ' (' + Object.keys(flags).length + ')' : ''}`;
}

function fillFeedFilters() {
  const names = [...new Set(trades.map(t => nameOf(t.representative)))].sort();
  $('member-list').innerHTML = names.map(n => `<option value="${esc(n)}">`).join('');
  const secs = [...new Set(trades.map(t => t.sector).filter(Boolean))].sort();
  const cur = $('f-sector').value;
  $('f-sector').innerHTML = '<option value="">Any industry</option>' + secs.map(x => `<option${x === cur ? ' selected' : ''}>${esc(x)}</option>`).join('');
}
function wireFeedFilters() {
  const upd = () => { feedAdv = {member: $('f-member').value, sector: $('f-sector').value, type: $('f-type').value, size: +$('f-size').value, flagged: $('f-flagged').getAttribute('aria-pressed') === 'true'}; feedLimit = 12; renderFeed(); };
  $('f-member').addEventListener('input', () => { clearTimeout(wireFeedFilters.t); wireFeedFilters.t = setTimeout(upd, 250); });
  ['f-sector', 'f-type', 'f-size'].forEach(id => $(id).onchange = upd);
  $('f-flagged').onclick = () => { $('f-flagged').setAttribute('aria-pressed', $('f-flagged').getAttribute('aria-pressed') !== 'true'); upd(); };
  $('f-clear').onclick = () => { $('f-member').value = ''; $('f-sector').value = ''; $('f-type').value = ''; $('f-size').value = '0'; $('f-flagged').setAttribute('aria-pressed', 'false'); feedFilter = 'all'; upd(); };
  $('f-alert').onclick = () => {
    const a = {members: $('f-member').value.trim(), sectors: $('f-sector').value, type: $('f-type').value, min: +$('f-size').value || 0};
    if (feedFilter === 'pelosi' && !a.members) a.members = 'Pelosi';
    if (feedFilter === 'large' && !a.min) a.min = LARGE;
    try { localStorage.setItem('pi.alertrule', JSON.stringify(a)); } catch (e) {}
    renderAlerts(); $('alerts').scrollIntoView({behavior: reduced ? 'auto' : 'smooth'});
  };
}

// Trump files with the Office of Government Ethics, not the House, so his trades
// aren't in the House feed. Show his disclosed positions with live prices instead.
function renderTrumpFeed(feed) {
  const mine = new Set(stocks().map(h => h.ticker));
  const fmtD = d => new Date(d + 'T12:00:00').toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'});
  const head = t => `<div class="trade" style="display:block;padding-top:22px"><div class="what" style="font-size:13px;color:var(--ink-3);font-weight:600">${t}</div></div>`;
  const note = `<div class="trade" style="display:block;border-top:0"><div class="who" style="line-height:1.5">Trump files with the Office of Government Ethics, not the House. His reports are scanned documents, so they're listed here with links to the originals.</div></div>`;

  const filings = trumpFilings.slice(0, trumpLimit).map(f => {
    // The filename carries the date he signed it, e.g. "Donald-J-Trump.09.17.2026-278T.pdf"
    const m = decodeURIComponent(f.url || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    const signed = m ? fmtD(`${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`) : '';
    const kind = /annual/i.test(f.type) ? f.type.replace(/^Annual/i, 'Annual report') : /transaction/i.test(f.type) ? 'Transaction report' : f.type;
    const href = /^https:\/\/extapps2\.oge\.gov\//.test(f.url) ? f.url : '';
    return `<div class="trade">
      <div><div class="who">${signed ? 'Signed ' + esc(signed) : 'Office of Government Ethics'}</div><div class="what" style="font-size:15px">${esc(kind)}${f.amended ? '<span class="pill hold-pill">Amended</span>' : ''}</div></div>
      <div style="text-align:right"><div class="amt">${href ? `<a href="${esc(href)}" target="_blank" rel="noopener" style="color:#8EC5FF;text-decoration:none;font-weight:600">Open</a>` : ''}</div><div class="when">Posted ${esc(fmtD(f.date))}${f.pages ? ` · ${f.pages} pages` : ''}</div></div>
    </div>`;
  }).join('');
  const moreFilings = trumpFilings.length > trumpLimit ? `<div class="more"><button class="btn glass small" type="button" id="trump-more">Show more reports</button></div>` : '';

  const rows = REF.trump.map(h => ({...h, value: h.shares * priceOf(h.ticker, h.cost)})).sort((a, b) => b.value - a.value);
  const positions = rows.map(h => {
    const p = prices[h.ticker], chg = p ? p.change_pct : null;
    return `<div class="trade">
      <div><div class="who">${esc(h.sector)}</div><div class="what"><button type="button" class="tk-link" data-tk="${esc(h.ticker)}">${esc(h.ticker)}</button><span class="pill hold-pill">Holds</span>${mine.has(h.ticker) ? '<span class="pill mine">You own</span>' : ''}</div></div>
      <div><div class="amt num">${compact(h.value)}</div><div class="when">${p ? usd(p.price) : ''}${chg !== null ? ` · <span class="${chg >= 0 ? 'up' : 'down'}">${pct(chg, 2)}</span> today` : ''}</div></div>
    </div>`;
  }).join('');

  feed.innerHTML = note
    + (trumpFilings.length ? head('Latest filings') + filings + moreFilings : '')
    + head('Disclosed stock (SEC filings)') + positions;
  const btn = $('trump-more');
  if (btn) btn.onclick = () => { trumpLimit += 10; renderFeed(); };
  $('feed-more').style.display = 'none';
}
