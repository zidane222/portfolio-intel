// pi-newsdesk handlers: daily batch tick (Cron Trigger), on-demand read, 7-day reads.
// Plan: docs/plans/phase3-news-agents.md sections 3.1 to 3.3, contracts 6.3 and 6.4.
//
// Everything with a network side effect comes in through `deps` (see makeDeps), so tests can
// stub Supabase, KV, the Cache API, headlines and Groq. The pure news-read agents
// (buildPack, chooseMode, runNewsRead) are injected as deps.agents by services/newsdesk.js.
import {json, readCapped} from '../lib/http.js';
import {groqChat, groqModels} from '../lib/groq.js';
import {makeSupabase} from '../lib/supabase.js';
import {fetchTickerHeadlines} from './news.js';

export const FIXED = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'GLD'];
export const CHUNK = 2;              // tickers per cron tick (plan D5; set to 1 to roll back)
export const HEADLINES = 8;          // headlines per pack
export const TICK_DEADLINE_MS = 25000;
export const READ_DEADLINE_MS = 20000;
export const KV_TTL = 36 * 3600;
export const CACHE_READ_TTL = 3600;  // per-ticker 7-day view
export const CACHE_SHORT_TTL = 6 * 3600; // thin and fallback results
export const MAX_READS = 40;
export const SCHEMA = 'pi/news-verdict/v1';
const TICKER_RE = /^[A-Z.-]{1,6}$/;

export const MESSAGES = {
  thin: 'Not enough news in the last 7 days for a news read.',
  limited: 'You have used today\'s news reads. Cached reads still show.',
  busy: 'News reads are at today\'s limit. Try again tomorrow.',
  fallback: 'We could not write a checked read. Here are the headlines.',
};

export const day = d => new Date(d).toISOString().slice(0, 10);

// Last weekday on or before the date (market holidays are not modeled; the Learning agent
// joins hist_prices with "on or before", so a holiday resolves to the previous close).
export function priceRefDate(runDate) {
  const d = new Date(runDate + 'T00:00:00Z');
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return day(d);
}

// Stable id per (ticker, run_date, origin) so re-runs update the same row and the BigQuery
// MERGE on id never duplicates a ticker-day. UUID-shaped SHA-256 prefix.
export async function verdictId(ticker, runDate, origin) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${SCHEMA}|${ticker}|${runDate}|${origin}`)));
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = [...h.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };
export function caps(env) {
  return {calls: num(env.NEWS_CALLS_DAY, 90), tokens: num(env.NEWS_TOKENS_DAY, 180000), batch: num(env.NEWS_BATCH_CALLS, 50)};
}

// ── deps ────────────────────────────────────────────────
function cacheStore() {
  const c = typeof caches !== 'undefined' && caches.default;
  const req = key => new Request('https://pi-newsdesk.internal/' + key);
  return {
    async get(key) {
      if (!c) return null;
      try { const r = await c.match(req(key)); return r ? await r.json() : null; } catch { return null; }
    },
    async put(key, value, ttl) {
      if (!c) return;
      try { await c.put(req(key), new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}`}})); } catch { /* ignore */ }
    },
  };
}

export function makeDeps(env, agents, extra = {}) {
  let sb = null;
  return {
    agents,
    now: () => new Date(),
    cache: cacheStore(),
    kv: env.NEWSREADS || null,
    get sb() { return sb || (sb = makeSupabase(env)); },
    headlines: (t, n) => fetchTickerHeadlines(t, n, env),
    groqChat: (system, user, maxTokens, opts) => groqChat(env, system, user, maxTokens, true, opts),
    model: groqModels(env, false)[0],
    ...extra,
  };
}

// deps.take / deps.groq for runNewsRead, with a flag when the global cap said no.
function budgetFor(env, deps, runDate, batch, signal, perCallMs) {
  const c = caps(env);
  const state = {denied: false, calls: 0, tokens: 0};
  const take = async (calls, tokens) => {
    if (state.denied) return false;
    let ok = false;
    try {
      ok = await deps.sb.rpc('news_take', {d: runDate, calls, tokens, batch, cap_calls: c.calls, cap_tokens: c.tokens, cap_batch: c.batch}) === true;
    } catch (e) { console.log('newsdesk take failed', String(e.message || e)); ok = false; }
    if (!ok) state.denied = true;
    return ok;
  };
  const groq = async (role, system, user, maxTokens) => {
    const text = await deps.groqChat(system, user, maxTokens, {fallback: batch, timeoutMs: perCallMs, signal});
    const tokens = Math.ceil((String(system).length + String(user).length + String(text).length) / 4);
    state.calls++; state.tokens += tokens;
    return {text, tokens};
  };
  return {take, groq, state};
}

// One ticker end to end: headlines, pack, mode, agents. Returns {record, denied}.
async function produce(env, deps, ticker, runDate, origin, deadlineMs) {
  const now = deps.now();
  const deadline = now.getTime() + deadlineMs;
  const signal = AbortSignal.timeout(deadlineMs);
  const heads = await deps.headlines(ticker, HEADLINES);
  const a = deps.agents;
  let kase;
  if (typeof a.newsCase === 'function') kase = a.newsCase(ticker, heads || [], now.getTime());
  else { const pack = a.buildPack(ticker, heads || [], now); kase = {ext: {news: {pack, mode: a.chooseMode(pack)}}}; }
  kase.ticker = ticker; kase.origin = origin; kase.run_date = runDate;
  const b = budgetFor(env, deps, runDate, origin === 'batch', signal, Math.min(15000, deadlineMs));
  const out = await a.runNewsRead(kase, {groq: b.groq, take: b.take, now: () => deps.now(), deadline, signal,
    origin, run_date: runDate, model: deps.model, price_ref_date: priceRefDate(runDate)});
  const record = {
    schema: SCHEMA, ...out,
    id: await verdictId(ticker, runDate, origin), run_date: runDate, created: now.toISOString(), ticker, origin,
    price_ref_date: priceRefDate(runDate),
    model: (out && out.model) || deps.model,
  };
  if (b.state.denied && record.status !== 'PASS' && record.status !== 'thin') record.status = origin === 'batch' ? 'skipped' : 'fallback';
  if (!Number.isFinite(record.groq_calls)) record.groq_calls = b.state.calls;
  if (!Number.isFinite(record.tokens)) record.tokens = b.state.tokens;
  delete record.user; delete record.ip; // never store a user field, even if an agent added one
  return {record, denied: b.state.denied};
}

export const verdictRow = r => ({
  id: r.id, run_date: r.run_date, created: r.created, ticker: r.ticker, origin: r.origin, mode: r.mode || null,
  stance: r.stance || null, confidence: r.confidence || null, status: r.status, groq_calls: r.groq_calls | 0,
  tokens: r.tokens | 0, model: r.model || null, prompt_version: r.prompt_version || null, price_ref_date: r.price_ref_date, record: r,
});

const JOB_STATUS = {PASS: 'ok', thin: 'thin', fallback: 'fallback', skipped: 'skipped', error: 'error'};

// ── batch tick ──────────────────────────────────────────
export async function tick(env, deps, scheduledTime = Date.now()) {
  if (String(env.NEWS_BATCH_ENABLED) !== '1') return {skipped: 'disabled'};
  const runDate = day(scheduledTime);
  const sb = deps.sb;
  const seeded = await sb.rpc('news_seed', {d: runDate, fixed: FIXED}); // no-op after the first tick of the day
  const claimed = (await sb.rpc('news_claim', {d: runDate, k: CHUNK})) || [];
  const jobs = claimed.slice(0, CHUNK).filter(j => j && TICKER_RE.test(j.ticker));
  const results = await Promise.all(jobs.map(async job => {
    const where = `run_date=eq.${runDate}&ticker=eq.${encodeURIComponent(job.ticker)}`;
    try {
      const {record} = await produce(env, deps, job.ticker, runDate, 'batch', TICK_DEADLINE_MS);
      if (record.status !== 'skipped' && record.status !== 'error') await sb.upsert('news_verdicts', [verdictRow(record)], 'ticker,run_date,origin');
      const status = JOB_STATUS[record.status] || 'error';
      await sb.patch('news_jobs', where, {status});
      return {ticker: job.ticker, status, groq_calls: record.groq_calls};
    } catch (e) {
      console.log('newsdesk batch error', job.ticker, String(e && e.message || e).slice(0, 120));
      // Retry on a later tick until the third attempt (news_claim also reclaims stale 'running').
      const status = (job.attempts | 0) >= 3 ? 'error' : 'pending';
      try { await sb.patch('news_jobs', where, {status}); } catch { /* reclaimed after 10 minutes */ }
      return {ticker: job.ticker, status, groq_calls: 0};
    }
  }));
  return {run_date: runDate, seeded: seeded | 0, results};
}

// ── on-demand read ──────────────────────────────────────
async function bodyJson(req, max) {
  const text = await readCapped(req.body, max);
  if (text === null) return {tooLarge: true};
  try { return {data: JSON.parse(text || '{}')}; } catch { return {data: null}; }
}
const internal = req => req.headers.get('X-PI-Internal') === '1';
const answer = (status, cached, read, groqCalls = 0) => json({status, cached, groq_calls: groqCalls, read: read || null, message: MESSAGES[status] || null});
const statusOf = r => r.status === 'PASS' ? 'ok' : r.status === 'thin' ? 'thin' : 'fallback';

export async function read(req, env, deps) {
  if (!internal(req)) return json({error: 'Not found'}, 404);
  if (String(env.NEWS_ONDEMAND_ENABLED) !== '1') return json({error: 'News reads are paused.'}, 503);
  const {tooLarge, data} = await bodyJson(req, 1024);
  if (tooLarge) return json({error: 'Request too large'}, 413);
  const ticker = String(data && data.ticker || '').trim().toUpperCase();
  if (!TICKER_RE.test(ticker)) return json({error: 'Unknown ticker'}, 400);
  const today = day(deps.now());
  const ckey = `read/${ticker}/${today}`, kkey = `r:${ticker}:${today}`;

  const c = await deps.cache.get(ckey);
  if (c) return answer(statusOf(c), true, c);
  if (deps.kv) {
    try { const k = await deps.kv.get(kkey, 'json'); if (k) { await deps.cache.put(ckey, k, CACHE_READ_TTL); return answer('ok', true, k); } } catch { /* fall through */ }
  }
  try {
    const rows = await deps.sb.select('news_verdicts', `select=record&ticker=eq.${ticker}&run_date=eq.${today}&origin=eq.batch&limit=1`);
    const b = rows && rows[0] && rows[0].record;
    if (b) { await deps.cache.put(ckey, b, CACHE_READ_TTL); return answer(statusOf(b), true, b); }
  } catch (e) { console.log('newsdesk batch lookup failed', String(e.message || e)); }

  if (req.headers.get('X-PI-Quota') !== 'ok') return answer('limited', true, null);

  const {record, denied} = await produce(env, deps, ticker, today, 'on_demand', READ_DEADLINE_MS);
  if (record.status === 'thin') { await deps.cache.put(ckey, record, CACHE_SHORT_TTL); return answer('thin', false, record, 0); }
  if (record.status === 'PASS') {
    if (deps.kv) { try { await deps.kv.put(kkey, JSON.stringify(record), {expirationTtl: KV_TTL}); } catch (e) { console.log('newsdesk kv put failed'); } }
    await deps.cache.put(ckey, record, CACHE_READ_TTL);
    return answer('ok', false, record, record.groq_calls);
  }
  if (denied && !(record.groq_calls > 0)) return answer('busy', false, null, 0);
  // Fallback: Cache API only, never KV (plan D9). Not cached when the cap stopped it, so it can retry.
  if (!denied) await deps.cache.put(ckey, record, CACHE_SHORT_TTL);
  return answer(denied ? 'busy' : 'fallback', false, record, record.groq_calls);
}

// ── 7-day reads for a ticker list ───────────────────────
export async function reads(req, env, deps) {
  if (!internal(req)) return json({error: 'Not found'}, 404);
  const {tooLarge, data} = await bodyJson(req, 2048);
  if (tooLarge) return json({error: 'Request too large'}, 413);
  const raw = data && Array.isArray(data.tickers) ? data.tickers : null;
  if (!raw || !raw.length || raw.length > MAX_READS) return json({error: 'Send 1 to 40 tickers'}, 400);
  const list = [...new Set(raw.map(t => String(t || '').trim().toUpperCase()))];
  if (list.some(t => !TICKER_RE.test(t))) return json({error: 'Unknown ticker'}, 400);
  const now = deps.now(), today = day(now);
  const out = {};
  const miss = [];
  await Promise.all(list.map(async t => { const c = await deps.cache.get(`reads/${t}/${today}`); if (c) out[t] = c; else miss.push(t); }));
  if (miss.length) {
    for (const t of miss) out[t] = [];
    try {
      const rows = await deps.sb.select('news_reads_7d', `select=ticker,record&ticker=in.(${miss.map(encodeURIComponent).join(',')})&order=run_date.desc`);
      for (const r of rows || []) if (r && out[r.ticker] && r.record) out[r.ticker].push(r.record);
    } catch (e) { console.log('newsdesk reads lookup failed', String(e.message || e)); }
    if (deps.kv) {
      await Promise.all(miss.map(async t => {
        if (out[t].some(r => r.run_date === today)) return; // today's batch verdict wins
        try { const k = await deps.kv.get(`r:${t}:${today}`, 'json'); if (k) out[t].unshift(k); } catch { /* ignore */ }
      }));
    }
    await Promise.all(miss.map(t => deps.cache.put(`reads/${t}/${today}`, out[t], CACHE_READ_TTL)));
  }
  for (const t of list) out[t].sort((a, b) => String(b.run_date).localeCompare(String(a.run_date)) || String(b.created).localeCompare(String(a.created)));
  return json({updated: now.toISOString(), window_days: 7, reads: out});
}
