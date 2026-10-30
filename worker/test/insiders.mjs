// Insider buys (SEC Form 4) in /api/ask: routing, the insiders agent, the pi-disclosures route, and a full case.
// Loaded by test/test.mjs, which owns the global fetch mock. This file sets globalThis.__insiders for insiders.json
// and swaps in its own Groq mock while it runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {memClear} from '../src/lib/http.js';
import {runCase, parseInput} from '../src/agents/supervisor.js';
import {rulesIntent, normalizeIntent} from '../src/agents/intent.js';
import {plan} from '../src/agents/registry.js';
import {windowOf, run as insidersRun} from '../src/agents/data/insiders.js';
import {validateFinal} from '../src/agents/validator.js';

const DAY = 86400000;
const iso = t => new Date(t).toISOString().slice(0, 10);
const NOW = Date.now();
const FIX = {updated: new Date(NOW).toISOString(), seen: {'edgar/data/1/x.txt': '2026-10-22'}, buys: [
  {ticker: 'SAMG', company: 'Silvercrest Asset Management Group Inc.', owner: 'Equinox Partners', role: '10% owner', date: iso(NOW - DAY), filed: iso(NOW - DAY), shares: 33398, price: 10.44, value: 348694},
  {ticker: 'BIGC', company: 'Big Co', owner: 'Jane Roe', role: 'CEO', date: iso(NOW - 2 * DAY), filed: iso(NOW - 2 * DAY), shares: 100000, price: 25, value: 2500000},
  {ticker: 'SMLL', company: 'Small Co', owner: 'John Doe', role: 'Director', date: iso(NOW - 3 * DAY), filed: iso(NOW - 3 * DAY), shares: 1000, price: 10, value: 10000},
  {ticker: 'OLDX', company: 'Old Co', owner: 'Old Owner', role: 'CFO', date: iso(NOW - 20 * DAY), filed: iso(NOW - 20 * DAY), shares: 5000, price: 100, value: 9000000},
  {ticker: 'bad ticker!', company: 'x', owner: 'y', role: 'z', filed: iso(NOW), value: 1},
]};
const ok = b => new Response(JSON.stringify(b), {status: 200, headers: {'Content-Type': 'application/json'}});

export default async function ({t, env, withServices}) {
  let data = FIX, fail = false, hits = 0;
  globalThis.__insiders = () => { hits++; return fail ? new Response('down', {status: 503}) : ok(data); };

  const G = {INTENT: [], BUILD: [], calls: []};
  const prevGroq = globalThis.__groq;
  globalThis.__groq = async init => {
    const p = JSON.parse(init.body);
    const sys = p.messages[0].content, user = p.messages[1].content;
    const kind = sys.startsWith('INTENT:') ? 'INTENT' : sys.startsWith('BUILD:') ? 'BUILD' : 'OTHER';
    G.calls.push({kind, user, sys});
    let next = G[kind] && G[kind].shift();
    if (next === undefined) return new Response(JSON.stringify({error: {message: 'no mock'}}), {status: 500});
    if (typeof next === 'function') next = next(user);
    return ok({choices: [{message: {content: JSON.stringify(next)}}]});
  };
  const factsIn = user => JSON.parse(user.match(/<facts>\n([\s\S]*?)\n<\/facts>/)[1]);
  const idOf = (user, label) => { const f = factsIn(user).find(x => x.label === label); assert.ok(f, 'fact missing: ' + label); return f.id; };

  try {
    await t('insiders: routing by rules, Congress questions stay on disclosures', async () => {
      for (const q of ['Any big insider buys this week?', 'Did the CEO of NVDA buy shares?', 'Form 4 filings for AAPL', 'What did directors purchase recently?', 'insider purchases'])
        assert.equal(rulesIntent(q).type, 'insiders', q);
      for (const q of ['Congress insider trading this week', 'Pelosi trades', 'What did senators buy?'])
        assert.equal(rulesIntent(q).type, 'disclosures', q);
      assert.deepEqual(rulesIntent('Did the CEO of NVDA buy shares?').tickers, ['NVDA']);
      // A model intent of "insiders" is accepted by the allowlist
      assert.equal(normalizeIntent({type: 'insiders', tickers: ['aapl']}, rulesIntent('x')).type, 'insiders');
      assert.deepEqual(plan({input: {portfolio: null}, intent: {type: 'insiders'}, evidence: []}), [['insiders']]);
    });

    await t('insiders: concept questions, selling and portfolio scope (review fixes)', async () => {
      for (const q of ['What is insider trading?', 'Is insider trading illegal?', 'What is Form 4?']) assert.notEqual(rulesIntent(q).type, 'insiders', q);
      assert.equal(rulesIntent('Is insider trading illegal?').type, 'general');
      for (const q of ['insider selling at AAPL', 'Are insiders dumping shares?', 'insider sales this week']) assert.notEqual(rulesIntent(q).type, 'insiders', q);
      assert.equal(rulesIntent('biggest buys by 10% owners').type, 'insiders');
      memClear(); data = FIX;
      const deps = {bindings: withServices(env), now: () => NOW};
      const port = {holdings: [{ticker: 'SAMG'}, {ticker: 'MSFT'}]};
      const {evidence: [ev]} = await insidersRun({input: {question: 'Insider buying in my portfolio', portfolio: port}, intent: {type: 'insiders', tickers: []}}, deps);
      assert.deepEqual(ev.items.filter(i => /^insider:\d+$/.test(i.key)).map(i => i.value.split(' ')[0]), ['SAMG']);
      assert.match(ev.items.find(i => i.key === 'insider:scope').value, /in the stocks you hold.*Sales are not included/);
      const all = await insidersRun({input: {question: 'insider buys'}, intent: {type: 'insiders', tickers: []}}, deps);
      assert.equal(all.evidence[0].items.find(i => i.key === 'insider:scope').value, 'Open-market purchases by company insiders from SEC filings. Sales are not included');
    });

    await t('insiders: signal and confidence wording is flagged as advice (V4)', async () => {
      const {validate} = await import('../src/agents/validator.js');
      for (const text of ['This is a bullish sign for the stock.', 'Insiders are confident in the company.', 'The buy signals the stock will rise.', 'Insiders know something.', 'A strong signal here.'])
        assert.ok(validate({draft: {text, used: []}, facts: []}).flags.some(f => f.rule === 'V4'), text);
      assert.equal(validate({draft: {text: 'Insiders reported purchases in SEC filings.', used: []}, facts: []}).status, 'PASS');
    });

    await t('insiders: oversized or redirected insiders.json is refused', async () => {
      const prev = globalThis.__insiders;
      const e = withServices(env);
      globalThis.__insiders = () => new Response('x'.repeat(10), {status: 200, headers: {'Content-Length': String(3 * 1024 * 1024)}});
      memClear(); assert.deepEqual(await (await e.DISCLOSURES.fetch(new Request('https://internal/api/insiders'))).json(), {buys: [], updated: null});
      globalThis.__insiders = () => new Response('', {status: 302, headers: {Location: 'https://evil.example/x'}});
      memClear(); assert.deepEqual(await (await e.DISCLOSURES.fetch(new Request('https://internal/api/insiders'))).json(), {buys: [], updated: null});
      globalThis.__insiders = prev; memClear();
    });

    await t('insiders: filing window from the question', async () => {
      const now = Date.UTC(2026, 9, 30);
      assert.deepEqual(windowOf('Any big insider buys this week?', now), {since: '2026-10-23', label: 'in the last 7 days'});
      assert.equal(windowOf('insider buys this month', now).since, '2026-10-01');
      assert.equal(windowOf('insider buys in the last 30 days', now).since, '2026-09-30');
      assert.equal(windowOf('insider buys today', now).since, '2026-10-30');
    });

    await t('insiders: pi-disclosures /api/insiders returns buys without the seen index', async () => {
      memClear(); data = FIX; fail = false;
      const e = withServices(env);
      const d = await (await e.DISCLOSURES.fetch(new Request('https://internal/api/insiders'))).json();
      assert.equal(d.buys.length, FIX.buys.length); assert.equal(d.updated, FIX.updated); assert.equal(d.seen, undefined);
      fail = true; memClear();
      const down = await (await e.DISCLOSURES.fetch(new Request('https://internal/api/insiders'))).json();
      assert.deepEqual(down, {buys: [], updated: null});
      fail = false;
    });

    await t('insiders: agent keeps the window, sorts by value, drops bad rows', async () => {
      memClear(); data = FIX;
      const deps = {bindings: withServices(env), now: () => NOW};
      const {evidence: [ev]} = await insidersRun({input: {question: 'Any big insider buys this week?'}, intent: {type: 'insiders', tickers: []}}, deps);
      assert.equal(ev.agent, 'insiders'); assert.equal(ev.source, 'SEC EDGAR Form 4');
      const texts = ev.items.filter(i => /^insider:\d+$/.test(i.key)).map(i => i.value);
      assert.deepEqual(texts.map(x => x.split(' ')[0]), ['BIGC', 'SAMG', 'SMLL']); // OLDX is outside the window, bad ticker dropped
      assert.equal(ev.items.find(i => i.key === 'count:insider_buys').value, 3);
      assert.equal(ev.items.find(i => i.key === 'insider:1:value').value, 2500000);
      assert.match(texts[0], /bought by Jane Roe, CEO, filed/);
      // Ticker filter
      const one = await insidersRun({input: {question: 'insider buys'}, intent: {type: 'insiders', tickers: ['SAMG']}}, deps);
      assert.deepEqual(one.evidence[0].items.filter(i => /^insider:\d+$/.test(i.key)).map(i => i.value.split(' ')[0]), ['SAMG']);
    });

    await t('insiders: implausible values held back, joint filers merged, entities decoded', async () => {
      memClear();
      const day = iso(NOW - DAY);
      data = {...FIX, buys: [
        {ticker: 'LONA', company: 'LeonaBio, Inc.', owner: 'Portman David J.', role: '10% owner', date: day, filed: day, shares: 3149470, price: 3149.47, value: 9919161281},
        {ticker: 'RENT', company: 'Rent the Runway, Inc.', owner: 'Nexus Capital Management LP', role: 'Director, 10% owner', date: day, filed: day, shares: 632922, price: 3.55, value: 2246873},
        {ticker: 'RENT', company: 'Rent the Runway, Inc.', owner: 'STORY3 Capital Partners, LLC', role: 'Director, 10% owner', date: day, filed: day, shares: 632922, price: 3.55, value: 2246873},
        {ticker: 'NPB', company: 'NORTHPOINTE BANCSHARES INC', owner: 'Williams Charles Alan', role: 'Director, CHAIRMAN &amp; CEO', date: day, filed: day, shares: 1000, price: 15, value: 15000}]};
      const {evidence: [ev]} = await insidersRun({input: {question: 'Any big insider buys this week?'}, intent: {type: 'insiders', tickers: []}}, {bindings: withServices(env), now: () => NOW});
      const texts = ev.items.filter(i => /^insider:\d+$/.test(i.key)).map(i => i.value);
      assert.deepEqual(texts.map(x => x.split(' ')[0]), ['RENT', 'NPB']);
      assert.match(texts[0], /bought by Nexus Capital Management LP and STORY3 Capital Partners, LLC, Director/);
      assert.match(texts[1], /CHAIRMAN & CEO/);
      assert.equal(ev.items.find(i => i.key === 'count:insider_buys').value, 2);
      assert.match(ev.items.find(i => i.key === 'insider:held_back').value, /one filing whose reported value looks like a data error/);
      data = FIX;
    });

    await t('insiders: empty window says so and shows the newest', async () => {
      memClear(); data = {...FIX, buys: [FIX.buys[3]]};
      const deps = {bindings: withServices(env), now: () => NOW};
      const {evidence: [ev]} = await insidersRun({input: {question: 'insider buys this week'}, intent: {type: 'insiders', tickers: []}}, deps);
      assert.match(ev.items.find(i => i.key === 'insider:window').value, /^No insider buys were filed in the last 7 days/);
      assert.equal(ev.items.find(i => i.key === 'insider:1').value.split(' ')[0], 'OLDX');
      assert.equal(ev.items.find(i => i.key === 'count:insider_buys'), undefined);
      data = FIX;
    });

    await t('ask: "Any big insider buys this week?" gives a checked answer from Form 4 data', async () => {
      memClear(); data = FIX; G.INTENT = []; G.BUILD = []; G.calls = [];
      G.BUILD.push(u => ({text: `The largest insider buy filed in the last week was [[${idOf(u, 'Insider buy BIGC')}]], worth [[${idOf(u, 'Value of BIGC insider buy')}]]. `
        + `Next was [[${idOf(u, 'Insider buy SAMG')}]] at [[${idOf(u, 'Value of SAMG insider buy')}]]. These come from SEC insider filings, not Congress.`, used: []}));
      const seen = new Set();
      const e = withServices(env);
      const spied = Object.fromEntries(['MARKET', 'NEWS', 'RATES', 'DISCLOSURES', 'PRIVATE', 'INSIGHTS'].map(n => [n, {fetch: r => { seen.add(n + ' ' + new URL(r.url).pathname); return e[n].fetch(r); }}]));
      const res = await runCase(parseInput(JSON.stringify({question: 'Any big insider buys this week?'})), {...e, ...spied});
      assert.equal(res.intent, 'insiders');
      assert.deepEqual([...seen], ['DISCLOSURES /api/insiders']);
      assert.deepEqual(G.calls.map(c => c.kind), ['BUILD']); // rules routed it: no model intent call
      assert.ok(G.calls[0].sys.includes('For intent insiders'));
      assert.equal(res.check.status, 'PASS', JSON.stringify(res.check));
      assert.match(res.answer, /BIGC \(Big Co\), bought by Jane Roe, CEO/);
      assert.match(res.answer, /worth \$2\.50M/);
      assert.ok(res.sources.length >= 4 && res.sources.every(s => s.source === 'SEC EDGAR Form 4'));
      assert.equal(validateFinal(res.answer).status, 'PASS');
    });

    await t('ask: typed form number in the draft is caught (V1) and repaired', async () => {
      memClear(); data = FIX; G.INTENT = []; G.BUILD = []; G.calls = [];
      G.BUILD.push({text: 'Insiders reported buys on Form 4 this week.', used: []});
      G.BUILD.push(u => ({text: `The largest was [[${idOf(u, 'Insider buy BIGC')}]].`, used: []}));
      const res = await runCase(parseInput(JSON.stringify({question: 'Any big insider buys this week?'})), withServices(env));
      assert.equal(res.check.status, 'PASS'); assert.equal(res.check.attempts, 2);
      assert.ok(G.calls[1].user.includes('V1'));
    });
    await t('insiders QA: Congress, ticker and general questions keep their routes', async () => {
      for (const q of ['insider trading by senators', 'Pelosi insider', 'Did Nancy Pelosi buy NVDA?', 'Which lawmakers bought?'])
        assert.equal(rulesIntent(q, ['NVDA']).type, 'disclosures', q);
      for (const q of ['who bought NVDA', 'Did the director of NVDA sell?']) assert.equal(rulesIntent(q, ['NVDA']).type, 'ticker', q);
      for (const q of ['CEO pay', 'director of the Fed', 'officer', 'Who is the CEO of Apple?', 'form 4 vs form d', 'board members buying shares'])
        assert.notEqual(rulesIntent(q).type, 'insiders', q);
      assert.ok(fs.readFileSync(new URL('../src/agents/case.js', import.meta.url), 'utf8').includes("'insiders'"));
    });

    await t('insiders QA: real insiders.json gives a checked answer with no typed digits flagged', async () => {
      const real = JSON.parse(fs.readFileSync(new URL('../../insiders.json', import.meta.url), 'utf8'));
      memClear(); data = real; G.INTENT = []; G.BUILD = []; G.calls = [];
      const now = Date.parse(real.updated);
      const {evidence: [ev]} = await insidersRun({input: {question: 'Any big insider buys this week?'}, intent: {type: 'insiders', tickers: []}}, {bindings: withServices(env), now: () => now});
      const vals = ev.items.filter(i => /^insider:\d+:value$/.test(i.key)).map(i => i.value);
      assert.ok(vals.length > 0 && vals.length <= 8 && vals.every(v => v > 0 && v <= 1e9), 'values in range');
      assert.deepEqual(vals, [...vals].sort((a, b) => b - a), 'largest first');
      const since = new Date(now - 7 * DAY).toISOString().slice(0, 10);
      assert.ok(ev.items.filter(i => /^insider:\d+$/.test(i.key)).every(i => i.value.match(/filed (\d{4}-\d{2}-\d{2})$/)[1] >= since), 'all in window');
      assert.ok(ev.items.every(i => !/&amp;|&lt;|&gt;|&#39;/.test(String(i.value))), 'entities decoded');
      G.BUILD.push(u => { const f = factsIn(u); const ins = f.filter(x => /^Insider buy /.test(x.label)).slice(0, 3);
        return {text: `From SEC insider filings ([[${idOf(u, 'Filing window')}]]): ` + ins.map(x => `[[${x.id}]], worth [[${idOf(u, 'Value of ' + x.label.split(' ')[2] + ' insider buy')}]].`).join(' ') + ' These are company insiders, not Congress.', used: []}; });
      // runCase uses the clock: refresh "updated" so the file's age (freshness, 3 days) cannot make this flaky.
      memClear(); data = {...real, updated: new Date().toISOString()};
      const res = await runCase(parseInput(JSON.stringify({question: 'Any big insider buys this week?'})), withServices(env));
      assert.equal(res.intent, 'insiders');
      assert.equal(res.check.status, 'PASS', JSON.stringify(res.check)); assert.equal(res.check.attempts, 1);
      assert.match(res.answer, /filed \d{4}-\d{2}-\d{2}, worth \$/);
      assert.equal(validateFinal(res.answer).status, 'PASS');
      data = FIX;
    });
  } finally {
    globalThis.__groq = prevGroq; globalThis.__insiders = undefined; data = FIX;
  }
}
