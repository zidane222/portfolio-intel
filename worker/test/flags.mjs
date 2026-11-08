// Feature flags: registry, gateway checks, pi-flags admin (Access JWT, CSRF, versions, audit). Run: node test/flags.mjs
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import gateway from '../src/index.js';
import flagsSvc, {cleanReason, auditKey} from '../src/services/flags.js';
import * as F from '../src/lib/flags.js';
import {_resetJwks} from '../src/lib/access.js';
import {tick} from '../src/modules/newsdesk.js';

let n = 0; const t = async (name, fn) => { F._reset(); await fn(); n++; console.log('ok', name); };
const O = 'https://portfolio-intel-279.pages.dev';

function kv(init = {}, {fail = false} = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, {v: typeof v === 'string' ? v : JSON.stringify(v), meta: null}]));
  return {
    m, fail,
    async get(k, type) { if (this.fail) throw new Error('down'); const e = m.get(k); if (!e) return null; return type === 'json' ? JSON.parse(e.v) : e.v; },
    async put(k, v, o = {}) { m.set(k, {v, meta: o.metadata || null}); },
    lists: 0,
    async list({prefix, limit = 1000}) { this.lists++; const all = [...m.keys()].filter(k => k.startsWith(prefix)).sort(); return {keys: all.slice(0, limit).map(k => ({name: k, metadata: m.get(k).meta})), list_complete: all.length <= limit, cursor: all.length > limit ? 'c' : undefined}; },
  };
}
const doc = flags => ({v: 3, updated: '2026-11-01T00:00:00.000Z', flags: Object.fromEntries(Object.entries(flags).map(([k, on]) => [k, {on, by: 'x', at: 'y', reason: 'zzz'}]))});
const okSvc = {fetch: async () => new Response(JSON.stringify({ok: 1}), {status: 200, headers: {'Content-Type': 'application/json'}})};
const genv = extra => ({ALLOWED_ORIGINS: O, MARKET: okSvc, NEWS: okSvc, RATES: okSvc, AI_SVC: okSvc, BROKER: okSvc, DISCLOSURES: okSvc, PRIVATE: okSvc, INSIGHTS: okSvc, NEWSDESK: okSvc, ...extra});
let ip = 0;
const gcall = (path, e, init = {}) => gateway.fetch(new Request('https://w.dev' + path, {...init, headers: {Origin: O, 'CF-Connecting-IP': '9.9.' + (ip++ % 250) + '.1', ...(init.headers || {})}}), e);

await t('registry matches scripts/flags_registry.json', async () => {
  const py = JSON.parse(readFileSync(new URL('../../scripts/flags_registry.json', import.meta.url), 'utf8'));
  const js = Object.fromEntries(Object.entries(F.REGISTRY).map(([k, r]) => [k, {default: r.default, fail: r.fail, kind: r.kind}]));
  assert.deepEqual(py, js);
  assert.deepEqual(F.NAMES, ['maintenance', 'broker', 'sync_writes', 'ai', 'news', 'disclosures', 'market', 'house_scrape', 'senate_scrape', 'fmp_fill', 'recon_v2']);
});

await t('no binding: defaults, routes work', async () => {
  const p = await F.publicFlags({});
  assert.equal(p.flags.broker, true); assert.equal(p.flags.maintenance, false); assert.equal(p.flags.recon_v2, false);
  assert.equal((await gcall('/api/plaid/status', genv({}))).status, 200);
});

await t('flag off gives the disabled answer', async () => {
  const e = genv({FLAGS: kv({'flags:v1': doc({broker: false})})});
  const r = await gcall('/api/plaid/status', e);
  assert.equal(r.status, 503); assert.equal(r.headers.get('Retry-After'), '60'); assert.equal(r.headers.get('X-PI-Flag'), 'off');
  assert.deepEqual(await r.json(), {error: 'This feature is turned off for now. Try again later.', disabled: true, flag: 'broker'});
  assert.equal((await gcall('/api/prices/AAPL', e)).status, 200);
});

await t('ai covers /api/ask and /api/ai, news covers newsdesk', async () => {
  const e = genv({FLAGS: kv({'flags:v1': doc({ai: false, news: false})})});
  for (const p of ['/api/ask', '/api/ai']) assert.equal((await (await gcall(p, e, {method: 'POST', body: '{}'})).json()).flag, 'ai');
  for (const p of ['/api/news', '/api/feeds', '/api/newsdesk/read']) assert.equal((await (await gcall(p, e, {method: 'POST', body: '{}'})).json()).flag, 'news');
});

await t('maintenance turns every route off but not health or /api/flags', async () => {
  const e = genv({FLAGS: kv({'flags:v1': doc({maintenance: true})})});
  for (const p of ['/api/prices/AAPL', '/api/top-rates', '/api/private', '/api/insights', '/api/all-trades', '/api/plaid/status']) {
    const r = await gcall(p, e); assert.equal(r.status, 503, p); assert.equal((await r.json()).flag, 'maintenance');
  }
  assert.equal((await gcall('/health', e)).status, 200);
  const f = await gcall('/api/flags', e);
  assert.equal(f.status, 200); assert.equal(f.headers.get('Cache-Control'), 'public, max-age=15');
  const d = await f.json();
  assert.deepEqual(Object.keys(d).sort(), ['flags', 'updated', 'v']);
  assert.equal(d.flags.maintenance, true);
  assert.ok(Object.values(d.flags).every(v => typeof v === 'boolean'));
  assert.ok(!JSON.stringify(d).includes('reason'));
});

await t('/api/flags: GET only, bad origin 403, no origin ok, rate limited', async () => {
  const e = genv({FLAGS: kv()});
  assert.equal((await gcall('/api/flags', e, {method: 'POST'})).status, 404);
  assert.equal((await gcall('/api/flags', e, {headers: {Origin: 'https://evil.example'}})).status, 403);
  const noOrigin = () => gateway.fetch(new Request('https://w.dev/api/flags', {headers: {'CF-Connecting-IP': '7.7.7.7'}}), e);
  assert.equal((await noOrigin()).status, 200);
  let last; for (let i = 0; i < 31; i++) last = await noOrigin();
  assert.equal(last.status, 429);
});

await t('admin paths 404 through the gateway', async () => {
  const e = genv({FLAGS: kv()});
  for (const p of ['/admin', '/admin/flags', '/api/admin/flags', '/api/flags/admin']) assert.equal((await gcall(p, e)).status, 404, p);
});

await t('fail-safe: unreadable KV, no last known: closed off, others default', async () => {
  const st = await F.load({FLAGS: kv({}, {fail: true})});
  assert.equal(st.state, 'error');
  assert.equal(F.resolve('broker', st), false); assert.equal(F.resolve('sync_writes', st), false);
  assert.equal(F.resolve('market', st), true); assert.equal(F.resolve('maintenance', st), false);
});

await t('fail-safe: last known value wins when KV goes down', async () => {
  const store = kv({'flags:v1': doc({broker: true, market: false, maintenance: true})});
  await F.load({FLAGS: store}, 0);
  store.fail = true;
  const st = await F.load({FLAGS: store}, F.CACHE_MS + 1);
  assert.equal(st.state, 'error');
  assert.equal(F.resolve('broker', st), true); assert.equal(F.resolve('market', st), false); assert.equal(F.resolve('maintenance', st), true);
});

await t('10 s isolate cache', async () => {
  const store = kv({'flags:v1': doc({market: false})});
  let reads = 0; const g = store.get.bind(store); store.get = async (...a) => { reads++; return g(...a); };
  await F.load({FLAGS: store}, 1000); await F.load({FLAGS: store}, 1000 + F.CACHE_MS - 1);
  assert.equal(reads, 1);
  await F.load({FLAGS: store}, 1000 + F.CACHE_MS + 1); assert.equal(reads, 2);
});

await t('invalid stored doc is treated as unreadable', async () => {
  const st = await F.load({FLAGS: kv({'flags:v1': {v: 'x', flags: {broker: {on: 'yes'}}}})});
  assert.equal(st.state, 'error'); assert.equal(F.resolve('broker', st), false);
});

await t('pi-newsdesk cron skips when the news flag is off', async () => {
  const r = await tick({NEWS_BATCH_ENABLED: '1', FLAGS: kv({'flags:v1': doc({news: false})})}, {sb: null});
  assert.deepEqual(r, {skipped: 'flag'});
  const r2 = await tick({NEWS_BATCH_ENABLED: '0', FLAGS: kv()}, {sb: null});
  assert.deepEqual(r2, {skipped: 'disabled'});
});

// ---- pi-flags admin
const team = 'https://pitest.cloudflareaccess.com', aud = 'a'.repeat(64), admin = 'owner@example.com';
const pair = await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify']);
const other = await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify']);
const pub = {...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1'};
const b64u = b => Buffer.from(b).toString('base64url');
async function jwt(claims, key = pair.privateKey, head = {alg: 'RS256', kid: 'k1'}) {
  const s = b64u(JSON.stringify(head)) + '.' + b64u(JSON.stringify(claims));
  return s + '.' + b64u(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(s))));
}
const good = () => ({aud: [aud], iss: team, email: admin, exp: Math.floor(Date.now() / 1000) + 600, iat: Math.floor(Date.now() / 1000)});
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  if (String(u) === team + '/cdn-cgi/access/certs') return new Response(JSON.stringify({keys: [pub]}), {status: 200});
  if (String(u).includes('supabase.co')) { globalThis.__sb = {u: String(u), body: JSON.parse(init.body), auth: init.headers.Authorization}; return new Response('null', {status: 200}); }
  return realFetch(u, init);
};
const FURL = 'https://pi-flags.example.workers.dev';
const fenv = extra => ({ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ADMIN_EMAIL: admin, SUPABASE_URL: 'https://abc.supabase.co', FLAGS: kv(), ...extra});
const fcall = async (path, e, {token, method = 'GET', body, headers = {}} = {}) => flagsSvc.fetch(new Request(FURL + path, {method, body,
  headers: {...(token === undefined ? {'Cf-Access-Jwt-Assertion': await jwt(good())} : token ? {'Cf-Access-Jwt-Assertion': token} : {}), ...headers}}), e);
const post = (e, b, h = {'X-PI-Flags': '1', Origin: FURL}, token) => fcall('/admin/flags', e, {method: 'POST', body: JSON.stringify(b), headers: {'Content-Type': 'application/json', ...h}, token});

await t('pi-flags: fails closed without Access settings', async () => {
  _resetJwks();
  for (const miss of ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ADMIN_EMAIL']) {
    const e = fenv({[miss]: '__PLACEHOLDER__'});
    for (const p of ['/admin', '/admin/flags', '/admin/audit', '/admin/app.js']) assert.equal((await fcall(p, e)).status, 403, miss + p);
  }
});

await t('pi-flags: bad tokens are 403', async () => {
  _resetJwks();
  const e = fenv();
  const bad = [null, 'garbage', await jwt(good(), other.privateKey), await jwt({...good(), aud: ['b'.repeat(64)]}), await jwt({...good(), exp: 1}),
    await jwt({...good(), iss: 'https://evil.cloudflareaccess.com'}), await jwt({...good(), email: 'someone@example.com'}),
    await jwt(good(), pair.privateKey, {alg: 'none', kid: 'k1'}), await jwt(good(), pair.privateKey, {alg: 'RS256', kid: 'nope'})];
  for (const tok of bad) assert.equal((await fcall('/admin/flags', e, {token: tok || ''})).status, 403);
  assert.equal((await fcall('/admin/flags', e)).status, 200);
});

await t('pi-flags: page has strict CSP and no inline script', async () => {
  const r = await fcall('/admin', fenv());
  assert.equal(r.status, 200);
  const csp = r.headers.get('Content-Security-Policy');
  assert.ok(csp.includes("script-src 'self'") && csp.includes("default-src 'none'") && csp.includes("frame-ancestors 'none'"));
  const html = await r.text();
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html) && !/innerHTML/.test(html) && !/https?:\/\//.test(html));
  const js = await (await fcall('/admin/app.js', fenv())).text();
  assert.ok(!js.includes('innerHTML'));
});

await t('pi-flags: POST needs CSRF header and same Origin', async () => {
  const e = fenv();
  const b = {name: 'broker', on: false, reason: 'Plaid outage', v: 0};
  assert.equal((await post(e, b, {Origin: FURL})).status, 403);
  assert.equal((await post(e, b, {'X-PI-Flags': '1', Origin: 'https://evil.example'})).status, 403);
  assert.equal((await post(e, b, {'X-PI-Flags': '1'})).status, 403);
  assert.equal((await post(e, b)).status, 200);
});

await t('pi-flags: input checks', async () => {
  const e = fenv();
  for (const b of [{name: 'nope', on: true, reason: 'abc', v: 0}, {name: 'ai', on: 'yes', reason: 'abc', v: 0}, {name: 'ai', on: true, reason: 'ab', v: 0},
    {name: 'ai', on: true, reason: 'x'.repeat(201), v: 0}, {name: 'ai', on: true, reason: 'abc'}, {name: 'ai', on: true, reason: 7, v: 0}]) {
    assert.equal((await post(e, b)).status, 400, JSON.stringify(b).slice(0, 60));
  }
  assert.equal(cleanReason('  a\u0000b\nc  '), 'a b c');
  assert.equal(cleanReason('<b>hi</b>'), '<b>hi</b>'); // stored as text, rendered with textContent
});

await t('pi-flags: version check, write, audit in KV and Supabase', async () => {
  globalThis.__sb = null;
  const e = fenv({SUPABASE_FLAGS_KEY: 'test-flags-key'});
  const r1 = await post(e, {name: 'ai', on: false, reason: 'Groq bill spike', v: 0});
  assert.equal(r1.status, 200);
  const d1 = await r1.json();
  assert.equal(d1.v, 1); assert.equal(d1.flags.ai.on, false); assert.equal(d1.flags.ai.by, admin); assert.equal(d1.flags.ai.reason, 'Groq bill spike');
  const stale = await post(e, {name: 'ai', on: true, reason: 'back on', v: 0});
  assert.equal(stale.status, 409); assert.equal((await stale.json()).v, 1);
  assert.equal((await post(e, {name: 'ai', on: true, reason: 'back on', v: 1})).status, 200);
  const keys = [...e.FLAGS.m.keys()].filter(k => k.startsWith('audit:'));
  assert.equal(keys.length, 2); assert.ok(keys.every(k => /^audit:r:\d{13}:[0-9a-f]{12}$/.test(k)));
  const a = await (await fcall('/admin/audit', e)).json();
  assert.equal(a.audit.length, 2); assert.equal(a.audit[0].on, true); assert.equal(a.audit[0].by, admin);
  assert.ok(globalThis.__sb.u.endsWith('/rest/v1/rpc/flag_audit_add'));
  assert.equal(globalThis.__sb.auth, 'Bearer test-flags-key');
  assert.deepEqual(Object.keys(globalThis.__sb.body).sort(), ['p_actor', 'p_at', 'p_flag', 'p_id', 'p_on', 'p_reason', 'p_v']);
  assert.equal((await fcall('/admin/audit?since=bad', e)).status, 400);
  // gateway sees the new value
  F._reset();
  assert.equal((await F.publicFlags({FLAGS: e.FLAGS})).flags.ai, true);
});

await t('pi-flags: missing Supabase key keeps KV audit', async () => {
  globalThis.__sb = null;
  const e = fenv();
  assert.equal((await post(e, {name: 'market', on: false, reason: 'Yahoo down', v: 0})).status, 200);
  assert.equal(globalThis.__sb, null);
  assert.equal([...e.FLAGS.m.keys()].filter(k => k.startsWith('audit:')).length, 1);
});


await t('pi-flags: failed audit write leaves the flag unchanged', async () => {
  const e = fenv();
  const put = e.FLAGS.put.bind(e.FLAGS);
  e.FLAGS.put = async (k, v, o) => { if (k.startsWith('audit:')) throw new Error('kv down'); return put(k, v, o); };
  const r = await post(e, {name: 'ai', on: false, reason: 'test outage', v: 0});
  assert.equal(r.status, 503);
  assert.equal(e.FLAGS.m.has(F.KEY), false);
  assert.equal([...e.FLAGS.m.keys()].filter(k => k.startsWith('audit:')).length, 0);
});

await t('pi-flags: audit is written before the flag', async () => {
  const e = fenv(); const order = [];
  const put = e.FLAGS.put.bind(e.FLAGS);
  e.FLAGS.put = async (k, v, o) => { order.push(k.startsWith('audit:') ? 'audit' : k); return put(k, v, o); };
  assert.equal((await post(e, {name: 'ai', on: false, reason: 'order check', v: 0})).status, 200);
  assert.deepEqual(order, ['audit', F.KEY]);
});

await t('pi-flags: audit list reads one page, newest first, since filter', async () => {
  const e = fenv();
  const base = Date.parse('2026-11-01T00:00:00.000Z');
  for (let i = 0; i < 45; i++) {
    const at = new Date(base + i * 60000).toISOString();
    const rec = {id: 'id' + i, at, name: 'ai', on: i % 2 === 0, by: admin, reason: 'r' + i, v: i + 1};
    await e.FLAGS.put(auditKey(at), JSON.stringify(rec), {metadata: rec});
  }
  e.FLAGS.lists = 0;
  const a = (await (await fcall('/admin/audit', e)).json()).audit;
  assert.equal(e.FLAGS.lists, 1); assert.equal(a.length, 20);
  assert.equal(a[0].id, 'id44'); assert.equal(a[19].id, 'id25');
  const s = (await (await fcall('/admin/audit?since=' + new Date(base + 41 * 60000).toISOString(), e)).json()).audit;
  assert.deepEqual(s.map(x => x.id), ['id44', 'id43', 'id42']);
});

// ---- QA additions (feat/feature-flags)
await t('qa: registry JSON and JS identical, labels present', async () => {
  const py = JSON.parse(readFileSync(new URL('../../scripts/flags_registry.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(py), F.NAMES);
  for (const nm of F.NAMES) {
    assert.deepEqual(Object.keys(py[nm]).sort(), ['default', 'fail', 'kind'], nm);
    for (const k of ['default', 'fail', 'kind']) assert.equal(py[nm][k], F.REGISTRY[nm][k], nm + '.' + k);
    assert.ok(['closed', 'last', 'open'].includes(F.REGISTRY[nm].fail));
  }
});

await t('qa: every flag fail mode with KV throwing and no last known', async () => {
  const st = await F.load({FLAGS: kv({}, {fail: true})});
  for (const nm of F.NAMES) {
    const r = F.REGISTRY[nm], want = r.fail === 'closed' ? false : r.default;
    assert.equal(F.resolve(nm, st), want, nm);
  }
  const p = await F.publicFlags({FLAGS: kv({}, {fail: true})});
  assert.equal(p.v, 0); assert.equal(p.flags.broker, false); assert.equal(p.flags.sync_writes, false);
  // gateway: broker closed, market open, unflagged rates up, flags route still answers
  const e = genv({FLAGS: kv({}, {fail: true})});
  assert.equal((await (await gcall('/api/plaid/status', e)).json()).flag, 'broker');
  assert.equal((await gcall('/api/prices/AAPL', e)).status, 200);
  assert.equal((await gcall('/api/top-rates', e)).status, 200);
  assert.equal((await gcall('/api/flags', e)).status, 200);
});

await t('qa: maintenance turns off every OWNERS route, not /api/flags, /health or admin', async () => {
  const {OWNERS} = await import('../src/routes.js');
  const e = genv({FLAGS: kv({'flags:v1': doc({maintenance: true})})});
  const paths = ['/api/prices/X', '/api/history/X', '/api/sectors', '/api/dividends/X', '/api/news', '/api/feeds', '/api/top-rates', '/api/ai',
    '/api/plaid/link', '/api/all-trades', '/api/private', '/api/private/stats', '/api/insights', '/api/insights/strategies',
    '/api/newsdesk/read', '/api/newsdesk/reads', '/api/ask', '/api/unknown-route'];
  for (const [re] of OWNERS) assert.ok(paths.some(p => re.test(p)), 'route not covered ' + re);
  for (const p of paths) for (const method of ['GET', 'POST']) {
    const r = await gcall(p, e, method === 'POST' ? {method, body: '{}'} : {});
    assert.equal(r.status, 503, method + ' ' + p); assert.equal((await r.json()).flag, 'maintenance');
  }
  assert.equal((await gcall('/health', e)).status, 200);
  assert.equal((await gcall('/', e)).status, 200);
  assert.equal((await gcall('/api/flags', e)).status, 200);
  for (const p of ['/admin', '/admin/', '/admin/flags', '/admin/audit', '/admin/app.js']) assert.equal((await gcall(p, e)).status, 404, p);
});

await t('qa: admin paths 404 through gateway for every method', async () => {
  const e = genv({FLAGS: kv()});
  for (const p of ['/admin', '/admin/', '/admin/flags', '/admin/audit', '/admin/app.js', '/admin/app.css'])
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      const r = await gcall(p, e, method === 'GET' ? {} : {method, body: method === 'DELETE' ? undefined : '{}'});
      assert.equal(r.status, 404, method + ' ' + p);
    }
  assert.ok(!e.FLAGS.m.has('flags:v1'));
});

await t('qa: JWT missing, bad sig, wrong aud, expired, future nbf, other email are 403 on every route', async () => {
  _resetJwks();
  const e = fenv();
  const now = Math.floor(Date.now() / 1000);
  const bad = {missing: '', badsig: await jwt(good(), other.privateKey), aud: await jwt({...good(), aud: 'c'.repeat(64)}),
    expired: await jwt({...good(), exp: now - 1}), noexp: await jwt({...good(), exp: undefined}), nbf: await jwt({...good(), nbf: now + 3600}),
    email: await jwt({...good(), email: 'Owner@Example.com.evil.com'}), noemail: await jwt({...good(), email: undefined}),
    tampered: (await jwt(good())).replace(/\.[^.]+\./, '.' + b64u(JSON.stringify({...good(), email: 'x@y.z'})) + '.')};
  for (const [k, tok] of Object.entries(bad)) for (const [p, m] of [['/admin', 'GET'], ['/admin/flags', 'GET'], ['/admin/audit', 'GET'], ['/admin/flags', 'POST']]) {
    const r = m === 'POST' ? await post(e, {name: 'ai', on: false, reason: 'test', v: 0}, undefined, tok || null) : await fcall(p, e, {token: tok || null});
    assert.equal(r.status, 403, k + ' ' + m + ' ' + p);
  }
  assert.ok(!e.FLAGS.m.has('flags:v1'));
  // ADMIN_EMAIL with two entries fails closed
  assert.equal((await fcall('/admin/flags', fenv({ADMIN_EMAIL: admin + ',b@example.com'}))).status, 403);
});

await t('qa: actor never taken from body', async () => {
  const e = fenv();
  const r = await post(e, {name: 'news', on: false, reason: 'test run', v: 0, by: 'evil@example.com', actor: 'evil@example.com', email: 'evil@example.com'});
  assert.equal(r.status, 200);
  const d = await r.json(); assert.equal(d.flags.news.by, admin);
  const stored = JSON.parse(e.FLAGS.m.get('flags:v1').v); assert.equal(stored.flags.news.by, admin);
  assert.ok(![...e.FLAGS.m.values()].some(x => x.v.includes('evil@')));
});

await t('qa: stale v gives 409 and does not write', async () => {
  const e = fenv({FLAGS: kv({'flags:v1': doc({ai: true})})});
  for (const v of [0, 2, 4, -1]) {
    const r = await post(e, {name: 'ai', on: false, reason: 'stale', v});
    assert.equal(r.status, 409, String(v)); assert.equal((await r.json()).v, 3);
  }
  assert.equal(JSON.parse(e.FLAGS.m.get('flags:v1').v).v, 3);
  assert.equal([...e.FLAGS.m.keys()].filter(k => k.startsWith('audit:')).length, 0);
  assert.equal((await post(e, {name: 'ai', on: false, reason: 'fresh', v: 3})).status, 200);
});

await t('qa: reason length boundaries and escaping', async () => {
  assert.equal(cleanReason('abc'), 'abc'); assert.equal(cleanReason('x'.repeat(200)).length, 200);
  assert.equal(cleanReason('   ab   '), null); assert.equal(cleanReason('x'.repeat(201)), null);
  assert.equal(cleanReason('a b\u0085c'), 'a b c');
  const e = fenv();
  assert.equal((await post(e, {name: 'ai', on: false, reason: 'x'.repeat(200), v: 0})).status, 200);
  const xss = '<img src=x onerror=alert(1)>"\'&';
  const r = await post(e, {name: 'ai', on: true, reason: xss, v: 1});
  assert.equal(r.status, 200); assert.equal(r.headers.get('Content-Type').split(';')[0], 'application/json');
  assert.equal((await r.json()).flags.ai.reason, xss);
  assert.equal((await post(e, {name: 'ai', on: true, reason: 'y'.repeat(3000), v: 2})).status, 413);
  const js = await (await fcall('/admin/app.js', fenv())).text();
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(js));
});

await t('qa: CSRF and Origin on POST, GET has no side effect', async () => {
  const e = fenv();
  const b = {name: 'broker', on: false, reason: 'csrf test', v: 0};
  for (const h of [{}, {'X-PI-Flags': '0', Origin: FURL}, {'X-PI-Flags': '1', Origin: 'null'}, {'X-PI-Flags': '1', Origin: FURL + '.evil.com'},
    {'X-PI-Flags': '1', Origin: 'http://pi-flags.example.workers.dev'}]) assert.equal((await post(e, b, h)).status, 403, JSON.stringify(h));
  assert.ok(!e.FLAGS.m.has('flags:v1'));
  assert.equal((await fcall('/admin/flags?name=broker&on=false', e)).status, 200);
  assert.ok(!e.FLAGS.m.has('flags:v1'));
  for (const m of ['PUT', 'DELETE', 'PATCH']) assert.equal((await fcall('/admin/flags', e, {method: m, headers: {'X-PI-Flags': '1', Origin: FURL}})).status, 404, m);
});

// ---- removed or renamed flags left in KV
const stale = () => { const d = doc({broker: true, sync_writes: true}); d.flags.old_flag = {on: false, by: 'x', at: 'y', reason: 'gone'}; return d; };
await t('gateway read ignores a flag name no longer in the registry', async () => {
  F._reset();
  const st = await F.load({FLAGS: kv({'flags:v1': stale()})});
  assert.equal(st.state, 'ok'); assert.ok(!('old_flag' in st.doc.flags));
  assert.equal(F.resolve('broker', st), true); assert.equal(F.resolve('sync_writes', st), true);
  F._reset();
  const e = genv({FLAGS: kv({'flags:v1': stale()})});
  assert.equal((await gcall('/api/plaid/status', e)).status, 200);
  F._reset();
  const bad = stale(); bad.flags.broker = {on: 'yes'}; // known names are still validated
  assert.equal((await F.load({FLAGS: kv({'flags:v1': bad})})).state, 'error');
  F._reset();
});

await t('admin GET and POST work with a stale flag name in KV', async () => {
  globalThis.__sb = null;
  const e = fenv({FLAGS: kv({'flags:v1': stale()})});
  const g = await fcall('/admin/flags', e);
  assert.equal(g.status, 200);
  const gd = await g.json();
  assert.equal(gd.v, 3); assert.ok(!('old_flag' in gd.flags)); assert.equal(gd.flags.broker.on, true);
  const r = await post(e, {name: 'ai', on: false, reason: 'clean up stale flag', v: 3});
  assert.equal(r.status, 200);
  const stored = await e.FLAGS.get('flags:v1', 'json');
  assert.equal(stored.v, 4); assert.equal(stored.flags.ai.on, false); assert.ok(!('old_flag' in stored.flags));
  assert.equal((await fcall('/admin/flags', e)).status, 200);
});

const EM = String.fromCharCode(0x2014);
await t('qa: no em dash in any user-facing message', async () => {
  const files = ['../src/lib/flags.js', '../src/services/flags.js', '../src/services/flags-page.js', '../src/lib/access.js', '../src/index.js',
    '../../js/03-helpers.js', '../../js/29a-account.js', '../../js/30-init.js', '../../backend/main.py', '../../scripts/flags.py'];
  for (const f of files) { // comments are not user-facing; every other line is checked
    const code = readFileSync(new URL(f, import.meta.url), 'utf8').split('\n').filter(l => !/^\s*(#|\/\/|\*)/.test(l)).join('\n');
    assert.ok(!code.includes(EM), f);
  }
  assert.ok(!F.DISABLED_MSG.includes(EM));
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const m = html.match(/id="flag-notice"[^>]*>[^<]*/); if (m) assert.ok(!m[0].includes(EM));
});

// ---- appsec fixes: JWKS refetch on unknown kid, audit metadata size
import {verifyAccess} from '../src/lib/access.js';
import {auditMeta} from '../src/services/flags.js';
await t('access: unknown kid refetches JWKS once, at most once a minute, still fails closed', async () => {
  _resetJwks();
  let calls = 0, set = [pub];
  const fetcher = async () => { calls++; return new Response(JSON.stringify({keys: set}), {status: 200}); };
  const e = {ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ADMIN_EMAIL: admin};
  const req = tok => new Request(FURL + '/admin', {headers: {'Cf-Access-Jwt-Assertion': tok}});
  const t0 = Date.now();
  assert.ok(await verifyAccess(req(await jwt(good())), e, {fetcher, now: t0}));
  assert.equal(calls, 1);
  const pub2 = {...(await crypto.subtle.exportKey('jwk', other.publicKey)), kid: 'k2'};
  set = [pub, pub2]; // Access rotated in a new key
  const tok2 = await jwt(good(), other.privateKey, {alg: 'RS256', kid: 'k2'});
  assert.ok(await verifyAccess(req(tok2), e, {fetcher, now: t0 + 1000}));
  assert.equal(calls, 2);
  const tokX = await jwt(good(), other.privateKey, {alg: 'RS256', kid: 'kX'});
  assert.equal(await verifyAccess(req(tokX), e, {fetcher, now: t0 + 2000}), null);
  assert.equal(calls, 2, 'no second forced refetch inside a minute');
  assert.equal(await verifyAccess(req(tokX), e, {fetcher, now: t0 + 3000}), null);
  assert.equal(calls, 2);
  assert.equal(await verifyAccess(req(tokX), e, {fetcher, now: t0 + 62000}), null);
  assert.equal(calls, 3, 'one forced refetch after a minute');
  const down = async () => { calls++; return new Response('x', {status: 500}); };
  assert.equal(await verifyAccess(req(tokX), e, {fetcher: down, now: t0 + 130000}), null);
  _resetJwks();
});

await t('audit: long non-ASCII reason plus long email fits KV metadata, value keeps the full record', async () => {
  const u8 = s => new TextEncoder().encode(s).length;
  const rec = {id: crypto.randomUUID(), at: new Date().toISOString(), name: 'ai', on: true, by: 'a'.repeat(64) + '@' + 'b'.repeat(330) + '.com',
    reason: '\u4e2d'.repeat(150) + '\u{1F600}'.repeat(25), v: 7}; // 200 UTF-16 units, 550 bytes
  const m = auditMeta(rec);
  assert.ok(u8(JSON.stringify(m)) <= 1024 && m.rt === true && rec.reason.startsWith(m.reason));
  assert.ok(!/[\uD800-\uDBFF]$/.test(m.reason), 'no split surrogate');
  assert.deepEqual(auditMeta({...rec, reason: 'short', by: 'o@x.io'}), {...rec, reason: 'short', by: 'o@x.io'});
  const huge = auditMeta({...rec, by: 'c'.repeat(2000)});
  assert.ok(u8(JSON.stringify(huge)) <= 1024);
  // end to end: KV that enforces the 1024 byte metadata cap
  const longAdmin = 'o'.repeat(64) + '@' + 'x'.repeat(330) + '.com';
  _resetJwks();
  const e = fenv({ADMIN_EMAIL: longAdmin});
  const put = e.FLAGS.put.bind(e.FLAGS);
  e.FLAGS.put = async (k, v, o = {}) => { if (o.metadata && u8(JSON.stringify(o.metadata)) > 1024) throw new Error('metadata too large'); return put(k, v, o); };
  const reason = '\u4e2d'.repeat(150) + '\u{1F600}'.repeat(25);
  const r = await post(e, {name: 'ai', on: false, reason, v: 0}, undefined, await jwt({...good(), email: longAdmin}));
  assert.equal(r.status, 200);
  const k = [...e.FLAGS.m.keys()].find(x => x.startsWith('audit:r:'));
  const stored = JSON.parse(e.FLAGS.m.get(k).v);
  assert.equal(stored.reason, reason); assert.equal(stored.by, longAdmin);
  assert.equal(e.FLAGS.m.get(k).meta.rt, true);
  assert.ok(u8(JSON.stringify(e.FLAGS.m.get(k).meta)) <= 1024);
});

console.log(`${n} flag tests passed`);
