// Phase 5 tests: Gemini as a second news provider (docs/plans/phase5-news-dual-provider.md). QA extends this file.
// Loaded by test/test.mjs. Swaps globalThis.fetch per test and restores it.
import assert from 'node:assert/strict';
import {memClear} from '../src/lib/http.js';
import {geminiChat} from '../src/lib/gemini.js';
import {providerConfig, chat} from '../src/lib/llm.js';
import * as nd from '../src/modules/newsdesk.js';

const SB = 'https://abcdefgh.supabase.co';
const GEM = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const BASE = {SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: 'sk-test', GROQ_API_KEY: 'gk', GROQ_MODEL: 'openai/gpt-oss-120b',
  NEWS_CALLS_DAY: '90', NEWS_TOKENS_DAY: '180000', NEWS_BATCH_CALLS: '50', NEWS_BATCH_ENABLED: '1', NEWS_ONDEMAND_ENABLED: '1'};
const GEMINI = {...BASE, GEMINI_API_KEY: 'gem-key', GEMINI_MODEL: 'gem-test', GEMINI_CALLS_DAY: '90', GEMINI_TOKENS_DAY: '180000', GEMINI_BATCH_CALLS: '60',
  NEWS_PROVIDER: 'groq', NEWS_FALLBACK: 'gemini', NEWS_SHADOW: 'gemini', NEWS_SHADOW_UNTIL: '2026-11-10'};
const NOW = new Date('2026-11-02T04:03:00Z');

const AGENTS = {
  buildPack: (ticker, heads) => ({ticker, items: heads.map((h, i) => ({id: 'e' + (i + 1), title: h.title, source: h.source}))}),
  chooseMode: pack => ({mode: pack.items.length < 3 ? 'thin' : 'collaborate'}),
  async runNewsRead(kase, deps) {
    const {pack, mode} = kase.ext.news;
    const base = {mode: mode.mode, mode_basis: {}, evidence: pack.items, flags: [], prompt_version: 'newsread-1'};
    if (!await deps.take(1, 2000)) return {...base, status: 'fallback', stance: null, groq_calls: 0, tokens: 0};
    try {
      const r = await deps.groq('judge', 'NEWS: sys', '<headlines>' + pack.items.map(i => i.title).join('|') + '</headlines>', 450);
      return {...base, status: 'PASS', stance: 'mixed', confidence: 'low', summary: 'ok', groq_calls: 1, tokens: r.tokens};
    } catch { return {...base, status: 'fallback', stance: null, groq_calls: 0, tokens: 0}; }
  },
};

// Fake Supabase, Google News, Groq and Gemini. Budgets are kept per provider.
function world({groq = 'ok', gemini = 'ok', caps = {}} = {}) {
  const w = {sbCalls: [], gemBodies: [], groq: 0, gem: 0, news: 0, verdicts: [], jobs: new Map(), seeded: false, spent: {},
    mode: {groq, gemini}, caps};
  w.fetch = async (u, init = {}) => {
    u = String(u);
    const ok = b => new Response(typeof b === 'string' ? b : JSON.stringify(b), {status: 200});
    if (u.startsWith(SB + '/rest/v1/')) {
      const path = u.slice((SB + '/rest/v1/').length);
      const body = init.body ? JSON.parse(init.body) : null;
      w.sbCalls.push({method: init.method, path, body});
      if (path === 'rpc/news_seed') { if (w.seeded) return ok(0); w.seeded = true; for (const t of body.fixed) w.jobs.set(t, {ticker: t, status: 'pending', attempts: 0}); return ok(body.fixed.length); }
      if (path === 'rpc/news_claim') {
        const got = [...w.jobs.values()].filter(j => j.status === 'pending').slice(0, body.k);
        for (const j of got) { j.status = 'running'; j.attempts++; }
        return ok(got.map(j => ({ticker: j.ticker, attempts: j.attempts})));
      }
      if (path === 'rpc/news_take') {
        const s = w.spent[body.p] || (w.spent[body.p] = {calls: 0, tokens: 0});
        const cap = w.caps[body.p] ?? body.cap_calls;
        if (s.calls + body.calls > cap || s.tokens + body.tokens > body.cap_tokens) return ok(false);
        s.calls += body.calls; s.tokens += body.tokens; return ok(true);
      }
      if (path.startsWith('news_verdicts?on_conflict=')) { w.verdicts.push(...body); return new Response(null, {status: 201}); }
      if (path.startsWith('news_jobs?') && init.method === 'PATCH') { w.jobs.get(decodeURIComponent(path.match(/ticker=eq\.([^&]+)/)[1])).status = body.status; return new Response(null, {status: 204}); }
      return new Response('{}', {status: 404});
    }
    if (u.startsWith('https://news.google.com/')) {
      w.news++;
      const items = Array.from({length: 8}, (_, i) => `<item><title>Story ${i} - Pub${i % 3}</title><link>https://n.example/${i}</link><pubDate>Sun, 01 Nov 2026 10:00:00 GMT</pubDate><source url="s">Pub${i % 3}</source></item>`).join('');
      return ok(`<rss><channel>${items}</channel></rss>`);
    }
    const reply = (mode, text) => mode === '429' ? new Response(JSON.stringify({error: {code: 'rate_limit', message: 'SECRET PROMPT TEXT'}}), {status: 429})
      : mode === '500' ? new Response('SECRET PROMPT TEXT', {status: 500}) : ok({choices: [{message: {content: mode === 'empty' ? ' ' : text}}]});
    if (u.startsWith('https://api.groq.com/')) { w.groq++; return reply(w.mode.groq, '{"summary":"ok"}'); }
    if (u === GEM) { w.gem++; w.gemBodies.push({init, body: JSON.parse(init.body)}); return reply(w.mode.gemini, '{"summary":"ok"}'); }
    return new Response('no', {status: 404});
  };
  return w;
}
async function withFetch(w, fn) { const real = globalThis.fetch, log = console.log; globalThis.fetch = w.fetch; console.log = () => {}; memClear(); try { return await fn(); } finally { globalThis.fetch = real; console.log = log; memClear(); } }
const memCache = () => { const m = new Map(); return {get: async k => m.has(k) ? m.get(k) : null, put: async (k, v) => { m.set(k, v); }}; };
const deps = env => nd.makeDeps(env, AGENTS, {now: () => NOW, cache: memCache(), kv: null});

export default async function ({t}) {
  await t('gemini request shape: endpoint, bearer, model, json mode, no reasoning_effort', async () => {
    const w = world();
    const out = await withFetch(w, () => geminiChat(GEMINI, 'sys', 'usr', 300, true, {timeoutMs: 5000}));
    assert.equal(out, '{"summary":"ok"}');
    const {init, body} = w.gemBodies[0];
    assert.equal(init.headers.Authorization, 'Bearer gem-key');
    assert.equal(body.model, 'gem-test'); assert.equal(body.max_tokens, 300);
    assert.deepEqual(body.response_format, {type: 'json_object'});
    assert.equal('reasoning_effort' in body, false);
    assert.deepEqual(body.messages.map(m => m.role), ['system', 'user']);
    const w2 = world();
    await withFetch(w2, () => geminiChat(GEMINI, 's', 'u', 10, false));
    assert.equal('response_format' in w2.gemBodies[0].body, false);
  });

  await t('gemini needs key and model', async () => {
    await assert.rejects(geminiChat({...GEMINI, GEMINI_API_KEY: ''}, 's', 'u', 1), /AI not configured/);
    await assert.rejects(geminiChat({...GEMINI, GEMINI_MODEL: ''}, 's', 'u', 1), /AI not configured/);
  });

  await t('gemini errors carry status and code only, never body text', async () => {
    for (const mode of ['429', '500', 'empty']) {
      const w = world({gemini: mode});
      let err;
      await withFetch(w, async () => { try { await geminiChat(GEMINI, 's', 'u', 10, true); } catch (e) { err = e; } });
      assert.ok(err, mode); assert.ok(!/SECRET/.test(err.message), err.message);
      assert.match(err.message, mode === 'empty' ? /^empty answer/ : mode === '429' ? /^429 rate_limit/ : /^500/);
    }
  });

  await t('gemini timeout is reported as timeout', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason)));
    const keep = setInterval(() => {}, 100); // AbortSignal.timeout timers do not keep Node alive
    try { await assert.rejects(geminiChat(GEMINI, 's', 'u', 1, true, {timeoutMs: 30}), /timeout/); } finally { globalThis.fetch = real; clearInterval(keep); }
  });

  await t('providerConfig validates and disables unusable slots', async () => {
    assert.deepEqual(providerConfig(GEMINI), {primary: 'groq', fallback: 'gemini', shadow: 'gemini', shadowUntil: '2026-11-10'});
    const noKey = providerConfig({...GEMINI, GEMINI_API_KEY: undefined});
    assert.equal(noKey.fallback, ''); assert.equal(noKey.shadow, ''); assert.equal(noKey.primary, 'groq');
    assert.equal(providerConfig({...GEMINI, GEMINI_MODEL: ''}).shadow, '');
    assert.equal(providerConfig({...GEMINI, NEWS_PROVIDER: 'gemini', GEMINI_API_KEY: ''}).primary, 'groq');
    assert.equal(providerConfig({...GEMINI, NEWS_FALLBACK: 'bogus', NEWS_SHADOW: 'x'}).fallback, '');
    assert.equal(providerConfig({...GEMINI, NEWS_SHADOW_UNTIL: 'soon'}).shadowUntil, '');
    assert.equal(providerConfig(BASE).primary, 'groq');
    await assert.rejects(async () => chat('nope', BASE, 's', 'u', 1), /AI not configured/);
  });

  await t('failover: primary 429 retries once on the other provider and records it', async () => {
    const w = world({groq: '429'});
    const r = await withFetch(w, () => nd.tick({...GEMINI, NEWS_SHADOW: ''}, deps({...GEMINI, NEWS_SHADOW: ''}), NOW.getTime()));
    assert.equal(r.results.length, 2); assert.ok(r.results.every(x => x.status === 'ok'));
    assert.ok(w.groq >= 2 && w.gem === 2, `groq ${w.groq} gem ${w.gem}`);
    const v = w.verdicts[0];
    assert.equal(v.origin, 'batch'); assert.equal(v.provider, 'groq');
    assert.deepEqual(v.record.providers, {judge: 'gemini'});
  });

  await t('failover: both providers denied gives a fallback, not a crash', async () => {
    const w = world({groq: '429', caps: {gemini: 0}});
    const r = await withFetch(w, () => nd.tick({...GEMINI, NEWS_SHADOW: ''}, deps({...GEMINI, NEWS_SHADOW: ''}), NOW.getTime()));
    assert.ok(r.results.every(x => x.status === 'fallback'));
    assert.equal(w.gem, 0, 'no Gemini call when its budget says no');
  });

  await t('failover does not fire on a non-retryable error', async () => {
    const w = world();
    const d = deps({...GEMINI, NEWS_SHADOW: ''}); d.chat = async () => { throw new Error('400 invalid_request'); };
    await withFetch(w, () => nd.tick({...GEMINI, NEWS_SHADOW: ''}, d, NOW.getTime()));
    assert.equal(w.gem, 0);
  });

  await t('budgets are separate per provider', async () => {
    const w = world();
    await withFetch(w, () => nd.tick(GEMINI, deps(GEMINI), NOW.getTime()));
    const takes = w.sbCalls.filter(c => c.path === 'rpc/news_take').map(c => c.body);
    assert.ok(takes.some(b => b.p === 'groq' && b.cap_batch === 50 && b.cap_calls === 90));
    assert.ok(takes.some(b => b.p === 'gemini' && b.cap_batch === 60 && b.cap_calls === 90));
    assert.equal(w.spent.groq.calls, 2); assert.equal(w.spent.gemini.calls, 2);
    assert.deepEqual(nd.caps({GEMINI_CALLS_DAY: '5', GEMINI_TOKENS_DAY: '6', GEMINI_BATCH_CALLS: '7'}, 'gemini'), {calls: 5, tokens: 6, batch: 7});
    assert.deepEqual(nd.caps({NEWS_CALLS_DAY: '1', NEWS_TOKENS_DAY: '2', NEWS_BATCH_CALLS: '3'}), {calls: 1, tokens: 2, batch: 3});
  });

  await t('shadow rows: origin shadow, one headline fetch per ticker, same input, job status from primary only', async () => {
    const w = world();
    const r = await withFetch(w, () => nd.tick(GEMINI, deps(GEMINI), NOW.getTime()));
    assert.equal(w.news, 2, 'one headline fetch per ticker');
    assert.equal(w.verdicts.length, 4);
    const sh = w.verdicts.filter(v => v.origin === 'shadow'), ba = w.verdicts.filter(v => v.origin === 'batch');
    assert.equal(sh.length, 2); assert.ok(sh.every(v => v.provider === 'gemini' && v.model === 'gem-test'));
    assert.ok(ba.every(v => v.provider === 'groq'));
    assert.ok(w.sbCalls.some(c => c.path === 'news_verdicts?on_conflict=ticker%2Crun_date%2Corigin'));
    const same = (x, y) => JSON.stringify(x.record.evidence) === JSON.stringify(y.record.evidence);
    assert.ok(ba.every(b => same(b, sh.find(s => s.ticker === b.ticker))));
    assert.notEqual(sh[0].id, ba[0].id);
    assert.ok(r.results.every(x => x.status === 'ok' && x.shadow === 'PASS'));
  });

  await t('shadow failure never changes the job status', async () => {
    const w = world({gemini: '500'});
    const r = await withFetch(w, () => nd.tick({...GEMINI, NEWS_FALLBACK: ''}, deps({...GEMINI, NEWS_FALLBACK: ''}), NOW.getTime()));
    assert.ok(r.results.every(x => x.status === 'ok'));
    assert.ok([...w.jobs.values()].filter(j => j.status !== 'pending').every(j => j.status === 'ok'));
    const w2 = world();
    const d = deps(GEMINI); const real = d.chat;
    d.chat = (p, ...a) => { if (p === 'gemini') throw new Error('boom'); return real(p, ...a); };
    const r2 = await withFetch(w2, () => nd.tick(GEMINI, d, NOW.getTime()));
    assert.ok(r2.results.every(x => x.status === 'ok'));
    assert.ok(w2.verdicts.filter(v => v.origin === 'batch').length === 2);
  });

  await t('no shadow after NEWS_SHADOW_UNTIL, and none on demand', async () => {
    const env = {...GEMINI, NEWS_SHADOW_UNTIL: '2026-11-01'};
    const w = world();
    await withFetch(w, () => nd.tick(env, deps(env), NOW.getTime()));
    assert.equal(w.gem, 0); assert.ok(w.verdicts.every(v => v.origin === 'batch'));
    const w2 = world();
    const res = await withFetch(w2, () => nd.read(new Request('https://x/read', {method: 'POST', body: '{"ticker":"AAPL"}', headers: {'X-PI-Internal': '1', 'X-PI-Quota': 'ok'}}), GEMINI, deps(GEMINI)));
    assert.equal((await res.json()).status, 'ok');
    assert.equal(w2.gem, 0, 'on-demand has no shadow'); assert.equal(w2.news, 1);
  });

  await t('no GEMINI_API_KEY behaves like Groq alone', async () => {
    const env = {...GEMINI, GEMINI_API_KEY: undefined};
    const w = world({groq: '429'});
    const r = await withFetch(w, () => nd.tick(env, deps(env), NOW.getTime()));
    assert.equal(w.gem, 0); assert.ok(r.results.every(x => x.status === 'fallback' && x.shadow === null));
    assert.ok(!w.sbCalls.some(c => c.body && c.body.p === 'gemini'));
    const w2 = world();
    const r2 = await withFetch(w2, () => nd.tick(BASE, deps(BASE), NOW.getTime()));
    assert.equal(w2.gem, 0); assert.ok(r2.results.every(x => x.status === 'ok'));
    assert.ok(w2.verdicts.every(v => v.origin === 'batch' && v.provider === 'groq'));
  });

  await t('privacy: the payload sent to Gemini has no user, ip, holdings or watchlist field', async () => {
    const w = world();
    await withFetch(w, () => nd.tick(GEMINI, deps(GEMINI), NOW.getTime()));
    assert.ok(w.gemBodies.length >= 2);
    for (const {init, body} of w.gemBodies) {
      assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'response_format']);
      const text = JSON.stringify(body).toLowerCase();
      for (const bad of ['"user":', '"ip"', 'holdings', 'watchlist', 'portfolio', 'x-forwarded', 'cf-connecting']) assert.ok(!text.includes(bad), bad);
      assert.deepEqual(Object.keys(init.headers).sort(), ['Authorization', 'Content-Type']);
    }
  });
}
