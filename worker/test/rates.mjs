// Ask: cash yield questions. Run: node test/rates.mjs
import assert from 'node:assert/strict';
import {runCase} from '../src/agents/supervisor.js';
import {rulesIntent} from '../src/agents/intent.js';

const now = Date.UTC(2026, 9, 31, 15);
const res = b => ({ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b), headers: new Headers()});
let groq = 0;
const env = {
  RATES: {fetch: async () => res({cached: true, date: '2026-10-30', url: 'https://www.fool.com/x', rates: [
    {institution: 'Axos Bank', apy: 5.0, min_deposit: 0}, {institution: 'Go2bank', apy: 4.5}, {institution: 'SoFi Bank, N.A.', apy: 4.4, min_deposit: 0}]})},
  AI_SVC: {fetch: async () => { groq++; return res({intent: {type: 'holdings'}}); }},
};
const ask = (question, portfolio = null) => runCase({question, history: [], portfolio, client_asof: ''}, env, {bindings: env});
const realNow = Date.now; Date.now = () => now;
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok', name); };

await t('routes to rates by rules', async () => {
  for (const q of ['How much more could my cash earn?', 'Where should my cash go for better APY?']) assert.equal(rulesIntent(q).type, 'rates', q);
});
await t('with cash: PASS and a computed gap', async () => {
  groq = 0;
  const r = await ask('How much more could my cash earn?', {asof: new Date(now).toISOString(), holdings: [
    {ticker: 'SPAXX', isCash: true, value: 10000, apy: 4.0}, {ticker: 'BANK', isCash: true, value: 2000, apy: 0.5}, {ticker: 'AAPL', value: 5000}]});
  assert.equal(r.check.status, 'PASS', JSON.stringify(r.check)); assert.equal(groq, 0);
  // SPAXX 10000*(5-4)%=100, BANK 2000*(5-0.5)%=90, total 190
  assert.match(r.answer, /\$190/); assert.match(r.answer, /SPAXX/); assert.match(r.answer, /Axos Bank/);
  assert.doesNotMatch(r.answer, /AAPL/); assert.doesNotMatch(r.answer, /[–—]/);
});
await t('no portfolio: PASS, says it cannot compute', async () => {
  const r = await ask('How much more could my cash earn?');
  assert.equal(r.check.status, 'PASS'); assert.match(r.answer, /can't be worked out/);
});
Date.now = realNow;
console.log(`${n} passed`);
