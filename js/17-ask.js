// ─────────────────────────────────────────────
//  ASK
// ─────────────────────────────────────────────
const PRESETS = ['Should I follow Pelosi\'s trades?', 'Which of my stocks is Congress buying?', 'Compare my risk to Trump\'s portfolio', 'What sectors is Congress buying this month?'];
// Everything the assistant knows: the same live data shown on the page
function buildContext() {
  const L = [];
  L.push(`Today: ${new Date().toISOString().slice(0, 10)}.`);
  const priceCtx = Object.entries(prices).slice(0, 45).map(([t, p]) => `${t} $${p.price} (${pct(p.change_pct, 2)})`).join(', ');
  if (priceCtx) L.push(`Live prices (change is the latest session): ${priceCtx}`);
  if (myPortfolio.length) {
    const tot = myPortfolio.reduce((s, h) => s + valueOf(h), 0);
    L.push(`USER PORTFOLIO, total ${usd(tot)}:`);
    myPortfolio.forEach(h => {
      if (h.isCash) L.push(`- ${h.ticker} (cash/money market): ${usd(h.marketValue || 0)}${h.apy ? ` earning ${h.apy}% APY (${usd(incomeOf(h), 0)}/yr)` : ', yield unknown'}`);
      else { const p = priceOf(h.ticker, 0); L.push(`- ${h.ticker}: ${h.shares} sh, value ${usd(valueOf(h))}${h.avgCost ? `, cost ${usd(h.avgCost)}/sh, gain ${pct((p - h.avgCost) / h.avgCost * 100)}` : ''}${divData[h.ticker] ? `, dividend yield ${divData[h.ticker].yield}%` : ''}, ${classOf(h)}`); }
    });
    const inc = myPortfolio.reduce((s, h) => s + incomeOf(h), 0);
    const cls = {}; myPortfolio.forEach(h => cls[classOf(h)] = (cls[classOf(h)] || 0) + valueOf(h));
    L.push(`Allocation: ${Object.entries(cls).map(([k, v]) => `${k} ${(v / tot * 100).toFixed(1)}%`).join(', ')}. Estimated annual income ${usd(inc, 0)}.`);
    const snapStmt = snapshots.filter(x => x.src === 'statement').pop();
    if (snapStmt) L.push(`Last uploaded statement: ${usd(snapStmt.v)} on ${snapStmt.d}.`);
  } else L.push('User has not added a portfolio yet.');
  if (watchlist.length) L.push(`Watchlist: ${watchlist.join(', ')}`);
  if (Object.keys(lastReturns).length) L.push(`Chart returns over ${range}: ` + Object.entries(lastReturns).map(([k, v]) => `${k} ${pct(v)}`).join(', '));
  if (yields && yields.curve) L.push(`Treasury yields ${yields.date}: ` + Object.entries(yields.curve).map(([k, v]) => `${k} ${v}%`).join(', '));
  try {
    const opts = cashOptions().filter(o => !o.promo).sort((x, y) => y.apy - x.apy).slice(0, 8);
    if (opts.length) L.push('Cash options: ' + opts.map(o => `${o.name.split(' · ')[0]} ${o.apy}%${o.min ? ` (min ${usd(o.min, 0)})` : ''}${o.cap ? ` (only first ${usd(o.cap, 0)})` : ''} [${o.catName}]`).join('; '));
  } catch (e) {}
  L.push(`Pelosi basket (stocks bought in her filings and not sold since; not her full portfolio): ${REF.pelosi.map(h => h.ticker).join(', ')}. Trump disclosed public stock (SEC filings; other assets private): ${REF.trump.map(h => h.ticker).join(', ')}.`);
  const tr = trades.slice(0, 50).map(t => `${t.filed || t.date} ${nameOf(t.representative)} ${/purchase/i.test(t.type) ? 'BUY' : 'SELL'} ${t.ticker || t.description + ' (private)'} ${t.amount}${t.committees && t.committees.length ? ' [committee overlap]' : ''}`);
  if (tr.length) L.push('Recent congressional filings (newest first):\n' + tr.join('\n'));
  if (insiderBuys.length) L.push('Recent insider purchases: ' + insiderBuys.slice(0, 12).map(b => `${b.ticker} ${compact(b.value)} by ${b.role} (${b.filed})`).join('; '));
  const invs = (smart.investors || []).filter(x => x.quarters && x.quarters[0]);
  if (invs.length) L.push('Famous investors top holdings: ' + invs.map(x => `${x.name}: ${x.quarters[0].holdings.slice(0, 5).map(h => h.ticker || h.name).join(', ')}`).join('; '));
  return L.join('\n').slice(0, 14000);
}
// The assistant's instructions live on the server (backend/main.py, AI_MODES).
async function askAI(question, history) {
  const convo = (history || []).slice(-8).map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n');
  const d = await getJSON(BACKEND_URL + '/api/ai', {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({mode: 'assistant', context: buildContext(), question: (convo ? 'Conversation so far:\n' + convo + '\n\nNew question: ' : '') + question})});
  if (d.error) throw new Error(d.error);
  return (d.answer || 'No answer came back. Try rephrasing.').replace(/\*\*|__|^#+\s/gm, '').trim();
}
// Structured portfolio summary built on the device for /api/ask (plan 5.1).
// User-supplied context for this one request only: the server never stores it.
function buildPortfolio() {
  if (!myPortfolio.length) return undefined;
  const list = myPortfolio.slice(0, 60);
  const tot = myPortfolio.reduce((s, h) => s + valueOf(h), 0);
  const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const cls = {}; myPortfolio.forEach(h => cls[classOf(h)] = (cls[classOf(h)] || 0) + valueOf(h));
  const allocation = {}; Object.entries(cls).forEach(([k, v]) => allocation[k] = tot ? Math.round(v / tot * 1000) / 10 : 0);
  return {
    asof: new Date().toISOString(),
    total: r2(tot),
    holdings: list.map(h => ({ticker: String(h.ticker || '').slice(0, 20), shares: h.isCash ? null : (Number(h.shares) || 0), value: r2(valueOf(h)),
      avgCost: h.avgCost ? r2(h.avgCost) : null, isCash: !!h.isCash, apy: h.apy != null && h.apy !== '' ? Number(h.apy) : null, class: classOf(h)})),
    allocation,
    income_annual: r2(myPortfolio.reduce((s, h) => s + incomeOf(h), 0))
  };
}
// Calls the supervisor. Returns {text, sources, check, mode}: mode is 'checked', 'fallback' or 'plain' (old /api/ai path).
// The server adds this to every checked answer (validator V7). The app shows it once, at the top of the chat
// and under Ask, so it is not repeated on each message. Simulated labels stay on the answers they belong to.
const ASK_DISCLAIMER = 'This is general information from the sources listed, not personalized investment advice. Simulated or past results do not predict future returns.';
const stripDisclaimer = s => String(s || '').split(ASK_DISCLAIMER).join('').replace(/\n{3,}/g, '\n\n').trim();
async function askChecked(question, history) {
  try {
    const hist = (history || []).filter(m => m && m.text).slice(-6).map(m => ({role: m.role === 'user' ? 'user' : 'assistant', text: String(m.text).slice(0, 600)}));
    const body = {question: question.slice(0, 1000), client_asof: new Date().toISOString()};
    if (hist.length) body.history = hist;
    const pf = buildPortfolio(); if (pf) body.portfolio = pf;
    const d = await getJSON(BACKEND_URL + '/api/ask', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    if (!d || d.error || typeof d.answer !== 'string') throw new Error((d && d.error) || 'Bad response');
    const status = d.check && d.check.status;
    const sources = Array.isArray(d.sources) ? d.sources : [];
    // intent news_read: the gateway adds the read record (contract 6.4); it is rendered by readCard()
    const read = d.intent === 'news_read' && d.read && typeof d.read === 'object' ? d.read : null;
    if (read) keepRead(read);
    if (status === 'PASS') return {text: stripDisclaimer(d.answer), sources, check: 'PASS', mode: 'checked', read};
    return {text: '', sources, check: status || 'fallback', mode: 'fallback', read};
  } catch (e) {
    return {text: await askAI(question, history), sources: [], check: null, mode: 'plain', read: null};
  }
}
const FALLBACK_NOTE = 'Shown from sources only, the written answer did not pass our checks.';
const PLAIN_NOTE = 'Sources unavailable right now.';
function fmtAsof(a) {
  if (!a) return 'date unknown';
  const d = new Date(a);
  return isNaN(d) ? 'date unknown' : 'as of ' + d.toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: 'numeric'});
}
// Sources list HTML. Every server value goes through esc(). Links only for http(s) URLs.
function sourcesItems(sources) {
  return sources.map(s => {
    const st = String(s.status || '').toLowerCase();
    const tag = st === 'unknown' ? '<span class="src-tag unknown">Unknown</span>' : st === 'conflicting' ? '<span class="src-tag conflict">Conflicting</span>' : '';
    const url = typeof s.url === 'string' && /^https:\/\//i.test(s.url) ? s.url : null;
    const src = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(s.source || 'Source')}</a>` : esc(s.source || 'Source');
    return `<li><span class="src-l">${esc(s.label || s.fact || 'Fact')}</span>${s.value != null && s.value !== '' ? `: <b>${esc(s.value)}</b>` : ''} ${tag}<span class="src-m">${src}, ${esc(fmtAsof(s.asof))}</span></li>`;
  }).join('');
}
function sourcesBlock(sources, open) {
  if (!sources || !sources.length) return '';
  return `<details class="sources"${open ? ' open' : ''}><summary>Sources (${sources.length})</summary><ul>${sourcesItems(sources)}</ul></details>`;
}
function checkHTML(r) {
  if (r.mode === 'checked') return '<span class="check-badge" title="Every number was checked against its source">Checked</span>';
  if (r.mode === 'fallback') return `<span class="check-note">${esc(FALLBACK_NOTE)}</span>`;
  return `<span class="check-note">${esc(PLAIN_NOTE)}</span>`;
}
async function ask(q) {
  q = (q || '').trim(); if (!q) return;
  const btn = $('ask-go'), out = $('answer'), chk = $('answer-check'), src = $('answer-sources');
  btn.disabled = true; btn.textContent = 'Thinking…'; out.textContent = ''; chk.innerHTML = ''; src.hidden = true; src.open = false; $('answer-read').innerHTML = '';
  $('answer-status').textContent = 'Thinking';
  try {
    const r = await askChecked(q);
    out.textContent = r.text; out.hidden = !r.text;
    chk.innerHTML = checkHTML(r);
    if (r.read) $('answer-read').innerHTML = readCard(r.read, {title: true});
    if (r.sources.length) {
      $('answer-sources-n').textContent = `Sources (${r.sources.length})`;
      $('answer-sources-list').innerHTML = sourcesItems(r.sources);
      src.hidden = false; src.open = r.mode === 'fallback';
    }
    $('answer-status').textContent = r.mode === 'checked' ? 'Answer ready, checked' : r.mode === 'fallback' ? 'Showing sources only' : 'Answer ready';
  } catch (e) {
    out.hidden = false; out.textContent = 'The assistant is unavailable right now. Try again in a minute.';
    $('answer-status').textContent = 'Assistant unavailable';
  }
  btn.disabled = false; btn.textContent = 'Ask';
}
