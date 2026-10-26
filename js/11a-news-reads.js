// ─────────────────────────────────────────────
//  NEWS READS (plan phase3-news-agents, contracts 6.3 and 6.4)
// ─────────────────────────────────────────────
// A news read says what the last 7 days of headlines say about a ticker. It is not advice.
// All server text goes through esc(). Links are shown only for https URLs.
const READ_LABEL = 'News read, not a recommendation';
const READ_MAX_AGE_H = 36; // stale reads are hidden (plan section 15)
const READ_MSG = {
  thin: 'Not enough news in the last 7 days for a news read.',
  limited: 'You have used today\'s news reads. Cached reads still show.',
  busy: 'News reads are at today\'s limit. Try again tomorrow.',
  invalid: 'Unknown ticker',
  fallback: 'We could not write a checked read. Here are the headlines.',
  paused: 'News reads are paused.',
  rate: 'Too many requests. Wait a minute and try again.',
  error: 'News reads are unavailable right now. Try again later.',
};
const STANCES = ['positive', 'negative', 'mixed', 'unclear'];
const CONFS = ['low', 'medium', 'high'];
const NR = {by: {}, state: {}, loaded: {}, quotaLeft: null, busy: false, blocked: null};

const httpsUrl = u => typeof u === 'string' && /^https:\/\//i.test(u) ? u : null;
function readDate(d) {
  const x = new Date(d && d.length === 10 ? d + 'T12:00:00Z' : d);
  return isNaN(x) ? '' : x.toLocaleDateString('en-US', {year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC'});
}
function readFresh(r) {
  const t = new Date(r && (r.created || r.run_date));
  return !isNaN(t) && Date.now() - t < READ_MAX_AGE_H * 3600e3;
}
// Newest usable record for a ticker, or null
function readOf(t) { const r = NR.by[t]; return r && readFresh(r) ? r : null; }
function keepRead(r) {
  if (!r || typeof r !== 'object' || !NEWS_TK.test(String(r.ticker || ''))) return;
  const old = NR.by[r.ticker];
  if (!old || String(r.created || '') >= String(old.created || '')) NR.by[r.ticker] = r;
}

async function newsdeskPost(path, body) {
  // The Worker only: the Render fallback has no newsdesk routes.
  return fetchJSON(BACKEND_URL + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), timeout: 30000});
}
// 7-day view for a list of tickers. 0 Groq calls. Once per session per list.
async function loadReads(tickers) {
  const list = [...new Set((tickers || []).map(t => String(t).toUpperCase()).filter(t => NEWS_TK.test(t)))].slice(0, NEWSLIST_MAX);
  if (!list.length) return NR.by;
  const key = list.slice().sort().join(',');
  if (!NR.loaded[key]) {
    NR.loaded[key] = newsdeskPost('/api/newsdesk/reads', {tickers: list}).then(d => {
      const reads = d && d.reads && typeof d.reads === 'object' ? d.reads : {};
      list.forEach(t => { const rows = Array.isArray(reads[t]) ? reads[t] : []; rows.forEach(keepRead); });
    }).catch(e => { delete NR.loaded[key]; throw e; });
  }
  await NR.loaded[key];
  return NR.by;
}
// On-demand read for one ticker. Returns {status, message}. One request at a time.
async function requestRead(t) {
  t = String(t || '').toUpperCase().trim();
  if (!NEWS_TK.test(t)) return {status: 'invalid', message: READ_MSG.invalid};
  if (NR.busy) return {status: 'wait', message: ''};
  NR.busy = true;
  try {
    const d = await newsdeskPost('/api/newsdesk/read', {ticker: t});
    if (d && typeof d.quota_left === 'number') NR.quotaLeft = Math.max(0, d.quota_left);
    const st = d && d.status;
    if (d && d.read && (st === 'ok' || st === 'fallback')) keepRead(d.read);
    if (st === 'ok') { NR.state[t] = 'ok'; return {status: 'ok', message: ''}; }
    if (st === 'fallback') { NR.state[t] = 'fallback'; return {status: 'fallback', message: READ_MSG.fallback}; }
    if (st === 'thin') { NR.state[t] = 'thin'; return {status: 'thin', message: READ_MSG.thin}; }
    if (st === 'limited' || st === 'busy') { NR.blocked = st; return {status: st, message: READ_MSG[st]}; }
    return {status: 'error', message: READ_MSG.error};
  } catch (e) {
    if (e.status === 400) { NR.state[t] = 'invalid'; return {status: 'invalid', message: READ_MSG.invalid}; }
    if (e.status === 429) return {status: 'rate', message: READ_MSG.rate};
    if (e.status === 503) { NR.blocked = 'paused'; return {status: 'paused', message: READ_MSG.paused}; }
    return {status: 'error', message: READ_MSG.error};
  } finally { NR.busy = false; }
}
function quotaText() {
  if (NR.quotaLeft == null) return '';
  return `${NR.quotaLeft} new read${NR.quotaLeft === 1 ? '' : 's'} left today.`;
}

// ── Rendering ──
function stanceOf(r) { return STANCES.includes(r.stance) ? r.stance : 'unclear'; }
function confOf(r) { return CONFS.includes(r.confidence) ? r.confidence : null; }
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
function evidenceMap(r) { const m = {}; (Array.isArray(r.evidence) ? r.evidence : []).forEach(e => { if (e && e.id) m[e.id] = e; }); return m; }
function headlineHTML(e) {
  const url = httpsUrl(e.url);
  const title = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(e.title)}</a>` : `<span>${esc(e.title)}</span>`;
  const meta = [esc(e.source || ''), esc(readDate(e.date))].filter(Boolean).join(', ');
  return `<li>${title}${meta ? `<span class="rc-src">${meta}</span>` : ''}</li>`;
}
function pointsHTML(points, ev) {
  if (!Array.isArray(points) || !points.length) return '<p class="rc-none">No points were made from these headlines.</p>';
  return '<ul class="rc-points">' + points.slice(0, 4).map(p => {
    const cites = (Array.isArray(p.cites) ? p.cites : []).map(id => ev[id]).filter(Boolean);
    return `<li><p>${esc(p.text)}</p>${cites.length ? `<ul class="rc-cites" aria-label="Cited headlines">${cites.map(headlineHTML).join('')}</ul>` : ''}</li>`;
  }).join('') + '</ul>';
}
// Small tone chip, used in lists
function readChip(t) {
  const r = readOf(t);
  if (!r) return '';
  const s = stanceOf(r);
  return `<span class="stance stance-${s}">Tone: ${cap(s)}</span>`;
}
// Full card for a read record. opts.title adds the ticker as a heading.
function readCard(r, opts) {
  if (!r || typeof r !== 'object') return '';
  opts = opts || {};
  const ev = evidenceMap(r), evList = Object.values(ev);
  const s = stanceOf(r), c = confOf(r);
  const debate = r.mode === 'debate', collab = r.mode === 'collaborate';
  const fallback = r.status === 'fallback' || r.status === 'error' || r.status === 'skipped';
  const thin = r.mode === 'thin' || r.status === 'thin';
  const when = readDate(r.created || r.run_date);
  const how = debate ? 'Two analysts argued from the same headlines and a judge weighed both.' : collab ? 'The headlines agreed, so one joint brief was written.' : '';
  let body = '';
  if (thin) body = `<p class="rc-msg">${esc(READ_MSG.thin)}</p>`;
  else if (fallback) body = `<p class="rc-msg">${esc(READ_MSG.fallback)}</p>`;
  else {
    if (r.summary) body += `<div class="rc-sec"><h4>${debate ? 'Judge\'s verdict' : 'Joint brief'}</h4><p class="rc-sum">${esc(r.summary)}</p></div>`;
    if (debate) body += `<div class="rc-sides"><div class="rc-sec"><h4>Case for</h4>${pointsHTML(r.bull, ev)}</div><div class="rc-sec"><h4>Case against</h4>${pointsHTML(r.bear, ev)}</div></div>`;
    else if (collab) body += `<div class="rc-sec"><h4>Points from the brief</h4>${pointsHTML(r.joint, ev)}</div>`;
  }
  const heads = evList.length ? `<details class="rc-heads"${fallback ? ' open' : ''}><summary>Headlines weighed (${evList.length})</summary><ul class="rc-cites">${evList.slice(0, 8).map(headlineHTML).join('')}</ul></details>` : '';
  const tags = thin || fallback ? '' : `<span class="stance stance-${s}">Tone: ${cap(s)}</span>${c ? `<span class="conf">Confidence: ${cap(c)}</span>` : ''}`;
  return `<article class="read-card${opts.dark ? ' dark' : ''}" aria-label="News read for ${esc(r.ticker)}">
    <div class="rc-head">${opts.title ? `<button type="button" class="rc-tk" data-tk="${esc(r.ticker)}">${esc(r.ticker)}</button>` : ''}<span class="rc-label">${esc(READ_LABEL)}</span></div>
    ${tags ? `<div class="rc-tags">${tags}</div>` : ''}
    ${body}${heads}
    <p class="rc-meta">${how ? esc(how) + ' ' : ''}Read on ${esc(when)}, from 7 days of news.</p>
  </article>`;
}
