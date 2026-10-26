// News read data agent (intent news_read) plus the gateway helpers shared with index.js:
// the pi-market ticker check and the call to pi-newsdesk /read. Only the ticker and the quota
// flag cross to pi-newsdesk: no IP, no Origin, no user text.
import {evidence, withTimeout, TICKER_RE} from '../case.js';
import {peek, count} from '../../lib/ratelimit.js';

export const SOURCE = 'Google News via pi-newsdesk';
const MARKET_MS = 5000, READ_MS = 21000;

// true when pi-market has a usable quote; false when it has none; throws when pi-market fails.
export async function marketHasQuote(market, ticker, signal) {
  if (!market) throw new Error('market not linked');
  const r = await withTimeout(market.fetch(new Request('https://internal/api/prices/' + encodeURIComponent(ticker), {signal})), MARKET_MS);
  if (!r.ok) { if (r.status === 404 || r.status === 400) return false; throw new Error('market HTTP ' + r.status); }
  const d = await r.json();
  const q = d && d.prices && d.prices[ticker];
  return !!(q && typeof q.price === 'number' && Number.isFinite(q.price) && q.price > 0);
}

// POST pi-newsdesk /read. Returns the raw Response so the gateway can pass status codes through.
export function newsdeskRead(newsdesk, ticker, quota, signal) {
  return withTimeout(newsdesk.fetch(new Request('https://internal/read', {
    method: 'POST', signal,
    headers: {'Content-Type': 'application/json', 'X-PI-Internal': '1', 'X-PI-Quota': quota === 'over' ? 'over' : 'ok'},
    body: JSON.stringify({ticker}),
  })), READ_MS);
}

export async function run(c, deps) {
  const t = (c.intent?.tickers || []).find(x => TICKER_RE.test(x));
  if (!t) return {evidence: [evidence('newsread', SOURCE, {status: 'empty', newsdesk: {status: 'invalid'}})]};
  const b = deps.bindings || {};
  if (!b.NEWSDESK) throw new Error('not linked');
  if (!(await marketHasQuote(b.MARKET, t, deps.signal))) return {evidence: [evidence('newsread', SOURCE, {status: 'empty', ticker: t, newsdesk: {status: 'invalid'}})]};
  // Same per-visitor bucket as /api/newsdesk/read. The IP stays here, in gateway memory.
  const who = {headers: new Headers({'CF-Connecting-IP': (deps.headers && deps.headers['CF-Connecting-IP']) || 'unknown'})};
  const state = peek(who, 'newsread');
  const r = await newsdeskRead(b.NEWSDESK, t, state.over || state.minute ? 'over' : 'ok', deps.signal);
  if (!r.ok) throw new Error('newsdesk HTTP ' + r.status);
  const d = await r.json();
  let left = state.left;
  if (d && d.cached === false && Number(d.groq_calls) > 0) left = count(who, 'newsread').left;
  const read = d && d.read && d.read.schema === 'pi/news-verdict/v1' ? d.read : null;
  const items = (read ? read.evidence : []).map(e => ({key: `headline:${t}:${e.id}`, label: `${e.source} headline`, value: String(e.title || ''), unit: 'text',
    asof: e.date || null, url: e.url || null}));
  return {evidence: [evidence('newsread', SOURCE, {asof: read ? read.created : null, items, status: read ? 'ok' : 'empty', ticker: t, read,
    newsdesk: {status: String(d && d.status || 'unavailable').slice(0, 12), cached: !!(d && d.cached), groq_calls: Number(d && d.groq_calls) || 0, quota_left: left}})]};
}
