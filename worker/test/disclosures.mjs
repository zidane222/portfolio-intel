// Ask: Congress trade questions. Run: node test/disclosures.mjs
import assert from 'node:assert/strict';
import {runCase} from '../src/agents/supervisor.js';
import {rulesIntent} from '../src/agents/intent.js';

const now = Date.UTC(2026, 9, 31, 15);
const trades = [
  {representative: 'McCormick, David H', ticker: 'GS', type: 'Purchase', amount: '$250,001 - $500,000', filed: '2026-10-29'},
  {representative: 'Taylor, David J.', ticker: 'LRCX', type: 'Purchase', amount: '$1,001 - $15,000', filed: '2026-10-29'},
  {representative: 'Taylor, David J.', ticker: 'V', type: 'Sale', amount: '$1,001 - $15,000', filed: '2026-10-29'},
  {representative: 'Doe, Jane', ticker: 'AAPL', type: 'Purchase', amount: '$15,001 - $50,000', filed: '2026-10-12'},
  {representative: 'Roe, Rick', ticker: 'NVDA', type: 'Purchase', amount: '$1,001 - $15,000', filed: '2026-09-20'},
];
const res = b => ({ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b), headers: new Headers()});
let groq = 0;
const env = {
  DISCLOSURES: {fetch: async () => res({trades, updated: new Date(now - 3600e3).toISOString()})},
  AI_SVC: {fetch: async () => { groq++; return res({intent: {type: 'holdings'}}); }},
};
const ask = (question, portfolio = null) => runCase({question, history: [], portfolio, client_asof: ''}, env, {bindings: env});
const realNow = Date.now; Date.now = () => now;
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };

await t('presets route to disclosures by rules, no Groq call', async () => {
  for (const q of ['What is Congress buying this month?', 'Which of my stocks is Congress trading?', 'Which of my stocks is Congress buying?', 'What sectors is Congress buying this month?'])
    assert.equal(rulesIntent(q, ['AAPL']).type, 'disclosures', q);
});

await t('this month: PASS, buys only, window applied', async () => {
  groq = 0;
  const r = await ask('What is Congress buying this month?');
  assert.equal(r.check.status, 'PASS'); assert.equal(groq, 0);
  assert.match(r.answer, /Congress buys filed this month/);
  assert.match(r.answer, /GS/); assert.match(r.answer, /AAPL/);
  assert.doesNotMatch(r.answer, /NVDA/); assert.doesNotMatch(r.answer, /SELL V/);
  assert.doesNotMatch(r.answer, /[–—]/);
});

await t('my stocks: filtered to holdings, not "no congressional data"', async () => {
  const r = await ask('Which of my stocks is Congress trading?', {holdings: [{ticker: 'AAPL', value: 1000}, {ticker: 'V', value: 500}, {ticker: 'SPAXX', isCash: true, value: 50}]});
  assert.equal(r.intent, 'disclosures'); assert.equal(r.check.status, 'PASS');
  assert.match(r.answer, /AAPL/); assert.match(r.answer, /SELL V/); assert.doesNotMatch(r.answer, /GS|LRCX/);
  assert.match(r.answer, /stocks you hold/);
});

await t('my stocks with no overlap says so', async () => {
  const r = await ask('Which of my stocks is Congress trading?', {holdings: [{ticker: 'TSLA', value: 1}]});
  assert.equal(r.check.status, 'PASS'); assert.match(r.answer, /No Congress trades were found in the stocks you hold/);
});

await t('empty window falls back to newest and says so', async () => {
  const r = await ask('What did Congress buy today?');
  assert.equal(r.check.status, 'PASS'); assert.match(r.answer, /showing the newest filed instead/);
});
Date.now = realNow;
console.log(`${n} passed`);
