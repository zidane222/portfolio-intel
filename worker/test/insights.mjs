// pi-insights tests: gateway routes, header guard, schema checks, redirects, stale copy, caps.
import assert from 'node:assert/strict';
import {memClear} from '../src/lib/http.js';
import {checkDoc, decorate} from '../src/modules/insights.js';

const BASE = 'https://portfolio-intel-279.pages.dev';
const iso = ms => new Date(ms).toISOString();
const ins = (generated = iso(Date.now() - 86400000), over = {}) => ({schema: 'pi/insights/v1', generated, label: 'Historical analysis of public disclosures. Not investment advice.', findings: [], caveats: [], extra_key: 'x', ...over});
const st = (generated = iso(Date.now() - 86400000), over = {}) => ({schema: 'pi/strategies/v1', generated, label: 'SIMULATED. Not investment advice.', runs: [], caveats: [], ...over});
const J = (b, status = 200, ct = 'application/json') => new Response(typeof b === 'string' ? b : JSON.stringify(b), {status, headers: {'Content-Type': ct}});

export default async function ({t, worker, env, O}) {
  const insEnv = {...env, INSIGHTS_DATA_URL: BASE + '/insights.json'};
  const realFetch = globalThis.fetch, seen = [];
  const serve = (handler) => { memClear(); seen.length = 0; globalThis.fetch = async (u, init) => { u = String(u); if (new URL(u).origin === BASE) { seen.push({u, init}); return handler(u); } return realFetch(u, init); }; };
  const restore = () => { globalThis.fetch = realFetch; memClear(); };
  const hdr = {Origin: O, 'CF-Connecting-IP': '7.7.7.7'};
  const get = (path, h = hdr) => worker.fetch(new Request('https://w.dev' + path, {headers: h}), insEnv);
  const ok = u => u.endsWith('/insights.json') ? J(ins()) : J(st());

  await t('insights: gateway serves both files with served_asof and stale false, unknown keys dropped', async () => {
    serve(ok);
    try {
      const a = await get('/api/insights');
      assert.equal(a.status, 200);
      const d = await a.json();
      assert.equal(d.schema, 'pi/insights/v1'); assert.equal(d.stale, false); assert.ok(d.served_asof); assert.equal(d.extra_key, undefined);
      const s = await (await get('/api/insights/strategies')).json();
      assert.equal(s.schema, 'pi/strategies/v1'); assert.equal(s.stale, false);
      assert.deepEqual(seen.map(x => x.u).sort(), [BASE + '/insights.json', BASE + '/strategies.json']);
      assert.equal(seen[0].init.redirect, 'manual');
    } finally { restore(); }
  });
  await t('insights: stale true when older than 10 days', async () => {
    serve(u => u.endsWith('/insights.json') ? J(ins(iso(Date.now() - 11 * 86400000))) : J(st()));
    try { assert.equal((await (await get('/api/insights')).json()).stale, true); } finally { restore(); }
    assert.equal(decorate({generated: 'nope'}).stale, true);
  });
  await t('insights: service answers 404 without X-PI-Internal and with POST', async () => {
    serve(ok);
    try {
      const svc = (await import('../src/services/insights.js')).default;
      assert.equal((await svc.fetch(new Request('https://i/api/insights'), insEnv)).status, 404);
      assert.equal((await svc.fetch(new Request('https://i/api/insights/strategies', {headers: {'X-PI-Internal': '0'}}), insEnv)).status, 404);
      assert.equal((await svc.fetch(new Request('https://i/api/insights', {headers: {'X-PI-Internal': '1'}}), insEnv)).status, 200);
      assert.equal((await svc.fetch(new Request('https://i/api/insights', {method: 'POST', headers: {'X-PI-Internal': '1'}}), insEnv)).status, 404);
      assert.equal((await svc.fetch(new Request('https://i/health'), insEnv)).status, 200);
    } finally { restore(); }
  });
  await t('insights: a client X-PI-Internal header is stripped, route still works via gateway', async () => {
    serve(ok);
    try { assert.equal((await get('/api/insights', {...hdr, 'X-PI-Internal': '1'})).status, 200); } finally { restore(); }
  });
  await t('insights: other origin gets no CORS header, query and path tricks do not change the fetched URL', async () => {
    serve(ok);
    try {
      assert.equal((await get('/api/insights', {Origin: 'https://evil.com', 'CF-Connecting-IP': '8.8.8.8'})).headers.get('Access-Control-Allow-Origin'), null);
      await get('/api/insights?url=https://evil.com/x.json');
      assert.ok(seen.every(x => x.u.startsWith(BASE + '/') && !x.u.includes('evil')));
      assert.equal((await get('/api/insights/other')).status, 404);
    } finally { restore(); }
  });
  await t('insights: redirects are refused (3xx and opaque redirect) with 502', async () => {
    serve(() => new Response(null, {status: 302, headers: {Location: 'https://evil.com/insights.json'}}));
    try { assert.equal((await get('/api/insights')).status, 502); } finally { restore(); }
    serve(() => { const r = J(ins()); Object.defineProperty(r, 'type', {value: 'opaqueredirect'}); return r; });
    try { assert.equal((await get('/api/insights')).status, 502); } finally { restore(); }
  });
  await t('insights: wrong schema, wrong content type, missing label, bad list give 502', async () => {
    for (const bad of [J(ins(undefined, {schema: 'other'})), J(ins(), 200, 'text/html'), J(ins(undefined, {label: ''})), J(ins(undefined, {findings: 'x'})), J(ins('not a date')), J('not json')]) {
      serve(() => bad.clone());
      try { assert.equal((await get('/api/insights')).status, 502); } finally { restore(); }
    }
    assert.throws(() => checkDoc('strategies', ins()));
  });
  await t('insights: oversize body (declared or streamed) gives 502', async () => {
    serve(() => J(ins(undefined, {pad: 'x'.repeat(5 * 1024 * 1024 + 10)})));
    try { assert.equal((await get('/api/insights')).status, 502); } finally { restore(); }
    serve(() => new Response(JSON.stringify(ins()), {status: 200, headers: {'Content-Type': 'application/json', 'Content-Length': String(6 * 1024 * 1024)}}));
    try { assert.equal((await get('/api/insights')).status, 502); } finally { restore(); }
  });
  await t('insights: last good copy served when Pages fails, 502 when none, bad INSIGHTS_DATA_URL gives 502', async () => {
    let fail = false;
    serve(u => fail ? new Response('no', {status: 500}) : ok(u));
    try {
      assert.equal((await get('/api/insights')).status, 200);
      fail = true;
      const {memSet} = await import('../src/lib/http.js');
      memSet('insights:insights', null, 0); // expire the fresh copy, keep the last good one
      assert.equal((await get('/api/insights')).status, 200);
      memClear();
      assert.equal((await get('/api/insights')).status, 502);
      fail = false;
      const r = await worker.fetch(new Request('https://w.dev/api/insights', {headers: {Origin: O, 'CF-Connecting-IP': '6.6.6.6'}}), {...env, INSIGHTS_DATA_URL: 'https://evil.com/insights.json'});
      assert.equal(r.status, 502);
    } finally { restore(); }
  });
  await t('insights: empty findings pass through', async () => {
    serve(ok);
    try { const d = await (await get('/api/insights')).json(); assert.deepEqual(d.findings, []); } finally { restore(); }
  });
}
