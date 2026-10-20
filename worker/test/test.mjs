// Offline tests with mocked outside services. Run: node test/test.mjs
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {fernetKey, fernetEncrypt, fernetDecrypt} from '../src/lib/fernet.js';
import {parseFeed} from '../src/modules/news.js';
import {mapHoldings} from '../src/modules/broker.js';
import {previousClose} from '../src/modules/market.js';

const env = {ALLOWED_ORIGINS: 'https://portfolio-intel-279.pages.dev', PLAID_SECRET: 'testsecret', PLAID_CLIENT_ID: 'cid', PLAID_ENV: 'sandbox', GROQ_API_KEY: 'k'};
const O = 'https://portfolio-intel-279.pages.dev';
const call = (path, init = {}) => worker.fetch(new Request('https://w.dev' + path, {...init, headers: {Origin: O, 'CF-Connecting-IP': '1.2.3.4', ...(init.headers || {})}}), env);

const chart = (price, closes) => ({chart: {result: [{meta: {regularMarketPrice: price, regularMarketTime: 1760400000, gmtoffset: -14400, currency: 'USD', longName: 'Test Co'},
  timestamp: [1760054400, 1760140800, 1760313600, 1760400000], indicators: {quote: [{close: closes}]}, events: {dividends: {a: {date: Math.floor(Date.now()/1000) - 86400*30, amount: 0.5}}}}]}});
globalThis.fetch = async (u, init) => {
  u = String(u);
  const ok = b => new Response(typeof b === 'string' ? b : JSON.stringify(b), {status: 200});
  if (u.includes('/v8/finance/chart/')) return ok(chart(110, [100, 102, 104, 110]));
  if (u.includes('/v1/finance/search')) return ok({quotes: [{symbol: 'AAPL', quoteType: 'EQUITY', sectorDisp: 'Technology', industryDisp: 'Consumer Electronics'}]});
  if (u.includes('news.google.com')) return ok('<rss><channel><item><title>Apple rises - Reuters</title><link>https://x.com/a</link><pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate><source url="r">Reuters</source></item></channel></rss>');
  if (u.includes('raw.githubusercontent.com')) return ok({trades: [{ticker: 'NVDA'}], house_count: 1, updated: 'x'});
  if (u.includes('api.groq.com')) return ok({choices: [{message: {content: '{"holdings":[]}'}}]});
  if (u.includes('plaid.com/link/token/create')) return ok({link_token: 'link-sandbox-1'});
  if (u.includes('plaid.com/item/public_token/exchange')) return ok({access_token: 'access-sandbox-xyz'});
  if (u.includes('plaid.com/investments/holdings/get')) { assert.equal(JSON.parse(init.body).access_token, 'access-sandbox-123'); return ok({accounts: [{name: 'CMA', type: 'investment'}], securities: [{security_id: 'a', ticker_symbol: 'NVDA', name: 'NVIDIA'}], holdings: [{security_id: 'a', quantity: 2, cost_basis: 200, institution_value: 300}]}); }
  return new Response('no', {status: 404});
};

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };

await t('health', async () => { const r = await call('/health'); assert.equal((await r.json()).status, 'ok'); });
await t('CORS allowed origin', async () => { const r = await call('/api/prices/AAPL'); assert.equal(r.headers.get('Access-Control-Allow-Origin'), O); });
await t('CORS other origin gets no header', async () => { const r = await call('/api/prices/AAPL', {headers: {Origin: 'https://evil.com'}}); assert.equal(r.headers.get('Access-Control-Allow-Origin'), null); });
await t('preflight', async () => { const r = await call('/api/ai', {method: 'OPTIONS'}); assert.equal(r.status, 204); });
await t('prices + previous close', async () => { const d = await (await call('/api/prices/AAPL,MSFT')).json(); assert.equal(d.prices.AAPL.price, 110); assert.equal(d.prices.AAPL.prev_close, 104); assert.equal(d.prices.AAPL.change_pct, 5.77); });
await t('history', async () => { const d = await (await call('/api/history/AAPL?range=1y')).json(); assert.equal(d.series.AAPL.length, 4); });
await t('sectors', async () => { const d = await (await call('/api/sectors/AAPL')).json(); assert.equal(d.sectors.AAPL.sector, 'Technology'); });
await t('dividends', async () => { const d = await (await call('/api/dividends/AAPL')).json(); assert.equal(d.dividends.AAPL.ttm_dividend, 0.5); assert.equal(d.dividends.AAPL.name, 'Test Co'); });
await t('ticker news strips source', async () => { const d = await (await call('/api/news/tickers/AAPL?per=3')).json(); assert.equal(d.articles[0].title, 'Apple rises'); assert.equal(d.articles[0].ticker, 'AAPL'); });
await t('all trades', async () => { const d = await (await call('/api/all-trades')).json(); assert.equal(d.trades[0].ticker, 'NVDA'); });
await t('ai blocked from other origin', async () => { const r = await call('/api/ai', {method: 'POST', headers: {Origin: 'https://evil.com'}, body: '{}'}); assert.equal(r.status, 403); });
await t('ai extract', async () => { const r = await call('/api/ai', {method: 'POST', body: JSON.stringify({mode: 'extract', question: 'AAPL 10'})}); assert.equal((await r.json()).answer, '{"holdings":[]}'); });
await t('ai bad mode', async () => { const r = await call('/api/ai', {method: 'POST', body: JSON.stringify({mode: 'x', question: 'q'})}); assert.equal(r.status, 400); });
await t('fernet round trip', async () => { const k = await fernetKey(env); assert.equal(await fernetDecrypt(k, await fernetEncrypt(k, 'hello')), 'hello'); });
await t('fernet reads Python token', async () => { const tok = process.argv[2]; assert.equal(await fernetDecrypt(await fernetKey(env), tok), 'access-sandbox-123'); });
await t('plaid holdings with Python token', async () => { const d = await (await call('/api/plaid/holdings', {method: 'POST', body: JSON.stringify({token: process.argv[2]})})).json(); assert.equal(d.holdings[0].avgCost, 100); assert.equal(d.accounts, 'CMA'); });
await t('plaid bad token', async () => { const d = await (await call('/api/plaid/holdings', {method: 'POST', body: JSON.stringify({token: 'junk'})})).json(); assert.match(d.error, /no longer valid/); });
await t('plaid link + exchange', async () => { assert.equal((await (await call('/api/plaid/link-token', {method: 'POST'})).json()).link_token, 'link-sandbox-1'); const tok = (await (await call('/api/plaid/exchange', {method: 'POST', body: '{"public_token":"p"}'})).json()).token; assert.equal(await fernetDecrypt(await fernetKey(env), tok), 'access-sandbox-xyz'); });
await t('feed parser rss + atom', async () => { const a = parseFeed('X', '<rss><item><title><![CDATA[A &amp; B]]></title><link>https://a.com</link><pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate></item></rss>'); assert.equal(a[0].title, 'A & B'); const b = parseFeed('r/stocks', '<feed><entry><title>T</title><link href="https://r.com/x"/><updated>2026-10-19T10:00:00Z</updated></entry></feed>'); assert.equal(b[0].link, 'https://r.com/x'); assert.equal(b[0].social, true); });
await t('404', async () => { assert.equal((await call('/api/nope')).status, 404); });
await t('rate limit', async () => { let last; for (let i = 0; i < 125; i++) last = await worker.fetch(new Request('https://w.dev/api/news', {headers: {Origin: O, 'CF-Connecting-IP': '9.9.9.9'}}), env); assert.equal(last.status, 429); });
console.log(`\n${n} tests passed`);
// Secrets Store bindings are objects with get()
{
  const {resolveSecrets} = await import('../src/lib/secrets.js');
  const e = await resolveSecrets({GROQ_API_KEY: {get: async () => 'from-store'}, PLAID_SECRET: 'plain', PLAID_ENV: 'sandbox'});
  assert.equal(e.GROQ_API_KEY, 'from-store'); assert.equal(e.PLAID_SECRET, 'plain'); assert.equal(e.PLAID_ENV, 'sandbox');
  const r = await worker.fetch(new Request('https://w.dev/api/plaid/status', {headers: {Origin: O}}), {...env, PLAID_CLIENT_ID: {get: async () => 'x'.repeat(24)}, PLAID_SECRET: {get: async () => 'y'.repeat(30)}});
  const d = await r.json(); assert.equal(d.client_id_length, 24); assert.equal(d.secret_length, 30);
  console.log('ok secrets store bindings');
}
