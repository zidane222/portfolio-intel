// groqChat fallback 'fast': second model after a quick failure, inside one time budget. Run: node test/groq-fast.mjs
import assert from 'node:assert/strict';
import {groqChat} from '../src/lib/groq.js';
const env = {GROQ_API_KEY: 'test'};
const orig = globalThis.fetch;
const reply = (status, body) => ({ok: status === 200, status, json: async () => body});
const seen = [];
globalThis.fetch = async (u, init) => { const m = JSON.parse(init.body).model; seen.push(m);
  return m.startsWith('openai/') ? reply(429, {error: {code: 'rate_limit_exceeded'}}) : reply(200, {choices: [{message: {content: '{"ok":1}'}}]}); };
assert.equal(await groqChat(env, 's', 'u', 10, true, {timeoutMs: 5000, fallback: 'fast'}), '{"ok":1}');
assert.deepEqual(seen, ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile']);
seen.length = 0;
await assert.rejects(groqChat(env, 's', 'u', 10, true, {timeoutMs: 5000, fallback: false}));
assert.deepEqual(seen, ['openai/gpt-oss-120b']);
// a slow first model uses the budget: no second call once under 1.5 s remain
seen.length = 0;
globalThis.fetch = async (u, init) => { seen.push(JSON.parse(init.body).model); await new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))); };
const keep = setTimeout(() => {}, 3000); // AbortSignal.timeout is unref'd in Node
await assert.rejects(groqChat(env, 's', 'u', 10, true, {timeoutMs: 1200, fallback: 'fast'})); clearTimeout(keep);
assert.deepEqual(seen, ['openai/gpt-oss-120b']);
globalThis.fetch = orig;
console.log('3 passed');
