// Supervisor for POST /api/ask. Owns the case state, runs the agents in order, enforces the
// Groq call cap and the 25 s deadline, and falls back to a code-only answer.
// The gateway (index.js) has already checked the origin and the ask rate limit.
// Logging: one line per case with ids, intent, counts, rule IDs and timings. Never user text.
import {json, readCapped} from '../lib/http.js';
import {createCase, applyPatch, trace, remaining, withTimeout, MAX_GROQ_CALLS, TICKER_RE} from './case.js';
import * as intentAgent from './intent.js';
import * as builder from './builder.js';
import {run as factcheckRun} from './factcheck.js';
import {validate, validateFinal, lineSafe} from './validator.js';
import {renderText, safeAnswer, outOfScopeAnswer, sourcesFor, insidersAnswer, disclosuresAnswer} from './render.js';
import {AGENTS, plan} from './registry.js';
import {validateRenderedRead} from './validator.js';
import {renderRead, NEWS_LABEL, MESSAGES} from './newsread/render.js';
import {DISCLAIMER} from './render.js';

export const MAX_BODY = 32 * 1024;
const AGENT_MS = 6000, DATA_STEP_MS = 7000, BUILD_MS = 8000, REPAIR_MS = 6000;

class BadInput extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const fin = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const cleanTicker = t => String(t == null ? '' : t).toUpperCase().replace(/[^A-Z0-9 .\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
const cleanLabel = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9 &/.\-]/g, '').trim().slice(0, 30);

// Section 5.1 validation. Throws BadInput(400|413).
export function parseInput(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_BODY) throw new BadInput(413, 'Request too large');
  let b;
  try { b = JSON.parse(text); } catch (e) { throw new BadInput(400, 'Bad request'); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new BadInput(400, 'Bad request');
  const question = typeof b.question === 'string' ? b.question.trim() : '';
  if (!question || question.length > 1000) throw new BadInput(400, 'Bad request');
  if (b.history != null && !Array.isArray(b.history)) throw new BadInput(400, 'Bad request');
  const history = (b.history || []).slice(-6).filter(h => h && typeof h.text === 'string')
    .map(h => ({role: h.role === 'assistant' ? 'assistant' : 'user', text: h.text.slice(0, 600)}));
  let portfolio = null;
  if (b.portfolio != null) {
    const p = b.portfolio;
    if (typeof p !== 'object' || Array.isArray(p)) throw new BadInput(400, 'Bad request');
    if (p.holdings != null && !Array.isArray(p.holdings)) throw new BadInput(400, 'Bad request');
    if ((p.holdings || []).length > 60) throw new BadInput(400, 'Too many holdings');
    const holdings = (p.holdings || []).filter(h => h && typeof h === 'object').map(h => ({
      ticker: cleanTicker(h.ticker), shares: fin(h.shares), value: fin(h.value), avgCost: fin(h.avgCost),
      isCash: h.isCash === true, apy: fin(h.apy), class: cleanLabel(h.class) || null,
    })).filter(h => h.ticker);
    const allocation = {};
    if (p.allocation && typeof p.allocation === 'object') {
      for (const [k, v] of Object.entries(p.allocation).slice(0, 20)) { const kk = cleanLabel(k); if (kk && fin(v) !== null) allocation[kk] = v; }
    }
    const asof = typeof p.asof === 'string' && !isNaN(Date.parse(p.asof)) ? new Date(p.asof).toISOString() : null;
    portfolio = {asof, total: fin(p.total), holdings, allocation, income_annual: fin(p.income_annual)};
  }
  const client_asof = typeof b.client_asof === 'string' ? b.client_asof.slice(0, 40) : '';
  return {question, history, portfolio, client_asof};
}

// Calls pi-ai over AI_SVC. Counts every attempt and refuses a 4th.
function makeAI(c, env, signal) {
  return async (path, body, ms) => {
    if (c.budget.groq_calls >= MAX_GROQ_CALLS) throw new Error('groq budget');
    if (!env.AI_SVC) throw new Error('ai not linked');
    const left = Math.min(ms, remaining(c));
    if (left <= 0) throw new Error('deadline');
    c.budget.groq_calls++;
    const r = await withTimeout(env.AI_SVC.fetch(new Request('https://internal' + path, {
      method: 'POST', signal,
      headers: {'Content-Type': 'application/json', 'X-PI-Internal': '1'},
      body: JSON.stringify(body),
    })), left + 250);
    if (!r.ok) throw new Error('ai HTTP ' + r.status);
    return await r.json();
  };
}

async function timed(c, name, fn) {
  const t0 = Date.now();
  try { const out = await fn(); trace(c, name, Date.now() - t0, true); return out; } catch (e) {
    trace(c, name, Date.now() - t0, false, e && e.message === 'timeout' ? 'timeout' : 'error');
    throw e;
  }
}

async function runDataStep(c, deps) {
  const stepEnd = Date.now() + Math.min(DATA_STEP_MS, Math.max(0, remaining(c)));
  for (const names of plan(c)) {
    const results = await Promise.allSettled(names.map(name => {
      const mod = AGENTS[name];
      const ms = Math.min(AGENT_MS, Math.max(0, stepEnd - Date.now()));
      return timed(c, name, () => withTimeout(mod.run(c, deps), ms));
    }));
    results.forEach((r, i) => {
      const name = names[i];
      if (r.status === 'fulfilled') { applyPatch(c, 'data', name, r.value); return; }
      const status = r.reason && r.reason.message === 'timeout' ? 'timeout' : 'error';
      applyPatch(c, 'data', name, {evidence: [{agent: name, source: AGENTS[name].SOURCE, url: null, asof: null, status, items: []}]});
    });
  }
}

function finish(c, t0, {answer, ids, status, flags, attempts}) {
  const check = validateFinal(answer);
  if (check.status !== 'PASS') { // should never happen: the templates are built to pass
    const safe = safeAnswer([], lineSafe);
    answer = safe.text; ids = []; status = 'fallback';
  }
  c.result = {
    answer,
    sources: sourcesFor(c.facts, ids),
    check: {status, flags: [...new Set(flags.map(f => f.rule))], attempts},
    intent: c.intent?.type || 'general',
    case_id: c.id,
    ms: Date.now() - t0,
  };
  console.log(JSON.stringify({ask: 1, case_id: c.id, intent: c.result.intent, via: c.intent?.via || null, groq_calls: c.budget.groq_calls,
    status, flags: c.result.check.flags, attempts, ms: c.result.ms, trace: c.trace.map(x => `${x.agent}:${x.ok ? 'ok' : x.note}:${x.ms}`)}));
  return c.result;
}

function fallback(c, t0, flags, attempts) {
  const safe = safeAnswer(c.facts, lineSafe);
  return finish(c, t0, {answer: safe.text, ids: safe.shown, status: 'fallback', flags, attempts});
}

// news_read (plan 3.4): data agent newsread (pi-newsdesk /read, its own 20 s deadline inside
// Ask's 25 s), then code rendering, then V18 to V21 on the rendered text. No builder call: the
// read's Groq calls are counted by pi-newsdesk under the global cap, not in this case's budget.
async function newsReadAnswer(c, deps, t0) {
  const mod = AGENTS.newsread;
  try {
    applyPatch(c, 'data', 'newsread', await timed(c, 'newsread', () => withTimeout(mod.run(c, deps), Math.max(0, remaining(c) - 250))));
  } catch (e) {
    applyPatch(c, 'data', 'newsread', {evidence: [{agent: 'newsread', source: mod.SOURCE, url: null, asof: null, status: e && e.message === 'timeout' ? 'timeout' : 'error', items: [], newsdesk: {status: 'unavailable'}}]});
  }
  const ev = c.evidence.find(e => e.agent === 'newsread') || {};
  const nd = ev.newsdesk || {status: 'unavailable'};
  const read = ev.read || null;
  const status = read ? read.status : nd.status;
  let answer = renderRead(read, status === 'ok' ? 'unavailable' : status);
  let check = validateRenderedRead(answer, read ? {ticker: read.ticker, items: read.evidence} : null);
  trace(c, 'validator', 0, check.status === 'PASS', check.flags.map(f => f.rule).join(',') || 'PASS');
  // PASS for a checked read and for the fixed code messages (thin, limited, busy); fallback otherwise
  const outStatus = check.status === 'PASS' && (!read || read.status === 'PASS' || read.status === 'thin') && !['fallback', 'unavailable', 'error', 'skipped'].includes(status) ? 'PASS' : 'fallback';
  if (check.status !== 'PASS') answer = `${NEWS_LABEL}\n${read ? read.ticker + ': ' : ''}${MESSAGES.fallback}\n\n${DISCLAIMER}`;
  const result = finish(c, t0, {answer, ids: [], status: outStatus, flags: check.flags, attempts: 0});
  result.sources = (read ? read.evidence : []).map(e => ({fact: e.id, label: e.title, value: e.title, status: 'verified', source: e.source, asof: e.date, url: e.url}));
  result.read = check.status === 'PASS' ? read : (read ? {...read, status: 'fallback', stance: null, confidence: null, summary: null, bull: [], bear: [], joint: []} : null);
  result.news = {status: nd.status, cached: !!nd.cached, quota_left: nd.quota_left ?? null};
  return result;
}

// Runs one case end to end. Exposed for tests: deps.bindings defaults to env.
export async function runCase(input, env, opts = {}) {
  const t0 = Date.now();
  const c = createCase(input, t0);
  if (opts.deadlineMs) c.budget.deadline = t0 + opts.deadlineMs;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(0, c.budget.deadline - t0));
  const deps = {env, bindings: opts.bindings || env, signal: ctl.signal, now: () => Date.now(), headers: opts.headers || {}};
  deps.ai = makeAI(c, env, ctl.signal);
  let flags = [], attempts = 0;
  try {
    // 1 intent (skipped for very clear out of scope)
    const held = (c.input.portfolio?.holdings || []).map(h => h.ticker).filter(t => TICKER_RE.test(t));
    if (intentAgent.clearlyOutOfScope(c.input.question)) applyPatch(c, 'intent', 'intent', {intent: intentAgent.rulesIntent(c.input.question, held)});
    else applyPatch(c, 'intent', 'intent', await timed(c, 'intent', () => intentAgent.run(c, deps)));

    if (c.intent.type === 'out_of_scope') {
      return finish(c, t0, {answer: outOfScopeAnswer(), ids: [], status: 'PASS', flags: [], attempts: 0});
    }
    if (c.intent.type === 'news_read') return await newsReadAnswer(c, deps, t0);
    // 2 data agents, 3 fact checker
    await runDataStep(c, deps);
    applyPatch(c, 'factcheck', 'factcheck', await timed(c, 'factcheck', () => factcheckRun(c, deps)));
    // Insider buys: a code-built list from checked facts, no builder call (the builder handles stale data)
    if (c.intent.type === 'insiders') {
      const r = insidersAnswer(c.facts, lineSafe);
      if (r) return finish(c, t0, {answer: r.text, ids: r.ids, status: 'PASS', flags: [], attempts: 0});
    }
    // Congress trades: same code-built list. The builder kept failing V1/V1b on dollar ranges and dates.
    if (c.intent.type === 'disclosures') {
      const r = disclosuresAnswer(c.facts, lineSafe);
      if (r) return finish(c, t0, {answer: r.text, ids: r.ids, status: 'PASS', flags: [], attempts: 0});
    }

    // 4 builder, 5 validator, repair once
    while (true) {
      const isRepair = attempts > 0;
      if (isRepair && (c.budget.groq_calls >= MAX_GROQ_CALLS || remaining(c) < REPAIR_MS)) break;
      if (!isRepair && remaining(c) <= 0) break;
      attempts++;
      let patch;
      try {
        patch = await timed(c, 'builder', () => builder.run(c, deps, {attempt: attempts, flags, timeoutMs: isRepair ? REPAIR_MS : BUILD_MS}));
      } catch (e) { break; }
      applyPatch(c, 'builder', 'builder', patch);
      const rendered = renderText(c.draft.text, c.facts);
      const v = validate({draft: c.draft, facts: c.facts, question: c.input.question, rendered});
      applyPatch(c, 'validator', 'validator', {validation: {status: v.status, flags: v.flags}});
      trace(c, 'validator', 0, v.status === 'PASS', v.flags.map(f => f.rule).join(',') || 'PASS');
      flags = v.flags;
      if (v.status === 'PASS') {
        const used = new Set(c.draft.used.filter(id => c.draft.text.includes(`[[${id}]]`)));
        for (const m of c.draft.text.matchAll(/\[\[(f\d+)\]\]/g)) used.add(m[1]);
        return finish(c, t0, {answer: rendered, ids: [...used], status: 'PASS', flags: [], attempts});
      }
      if (attempts >= 2) break;
    }
    return fallback(c, t0, flags, attempts);
  } catch (e) {
    trace(c, 'supervisor', Date.now() - t0, false, 'error');
    return fallback(c, t0, flags, attempts);
  } finally {
    clearTimeout(timer);
    ctl.abort(); // cancel any binding or Groq request still in flight once the case is done
  }
}

// Gateway handler. Body checks here (400, 413). Origin and rate limit are checked before this.
export async function handleAsk(req, env) {
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) return json({error: 'Request too large'}, 413);
  let input;
  try {
    const text = await readCapped(req.body, MAX_BODY);
    if (text === null) return json({error: 'Request too large'}, 413);
    input = parseInput(text);
  } catch (e) {
    if (e instanceof BadInput) return json({error: e.message}, e.status);
    return json({error: 'Bad request'}, 400);
  }
  const headers = {};
  for (const h of ['Origin', 'CF-Connecting-IP']) { const v = req.headers.get(h); if (v) headers[h] = v; }
  try {
    return json(await runCase(input, env, {headers}));
  } catch (e) {
    console.log('ask error', String(e && e.name || 'Error'));
    return json({error: 'The assistant is unavailable right now.'}, 502);
  }
}
