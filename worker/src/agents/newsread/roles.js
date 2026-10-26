// News read role agents: (case, deps, opts) => patch over case.ext.news. They never call each
// other and never see another role's raw model output: the judge gets only the validated sides
// that the supervisor stored on the case. Before every Groq call a role reserves global budget with
// deps.take(calls, tokens) (contract 6.2); a refusal throws BudgetError and no call is made.
// deps.groq(role, system, user, maxTokens) -> {text, tokens} (the supervisor wraps it with the
// per-ticker call cap and the deadline).
import {SYSTEM, MAX_TOKENS, userMessage} from './prompts.js';

const ID = /^e\d{1,2}$/;

// Model output to JSON. Accepts a fenced block; throws on anything that is not an object.
export function parseJSON(text) {
  let s = String(text || '').trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1];
  const o = JSON.parse(s);
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('bad json');
  return o;
}

// Shape only (types and caps on size); content rules are the validator's job, so invalid cites
// are kept and caught by V14 rather than silently dropped.
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const normPoints = (a, max) => (Array.isArray(a) ? a.slice(0, max + 1) : []).filter(p => p && typeof p === 'object')
  .map(p => ({text: str(p.text, 600), cites: (Array.isArray(p.cites) ? p.cites : []).slice(0, 6).map(x => String(x).slice(0, 8))}));
const pick = (v, allowed) => (typeof v === 'string' ? v.trim().toLowerCase().slice(0, 12) : v === undefined ? null : String(v).slice(0, 12));

const pack = c => c.ext.news.pack;
export class BudgetError extends Error { constructor() { super('budget'); this.budget = true; } }
// Rough input estimate (about 4 characters a token) plus the output cap.
export const estimateTokens = (system, user, maxTokens) => Math.ceil((system.length + user.length) / 4) + maxTokens;

async function ask(role, c, deps, opts) {
  const user = userMessage(role, pack(c), {bull: c.ext.news.bull, bear: c.ext.news.bear, flags: opts && opts.flags});
  if (!(await deps.take(1, estimateTokens(SYSTEM[role], user, MAX_TOKENS[role])))) throw new BudgetError();
  const r = await deps.groq(role, SYSTEM[role], user, MAX_TOKENS[role]);
  return parseJSON(r && typeof r === 'object' ? r.text : r);
}

function side(role) {
  return async (c, deps, opts = {}) => {
    const o = await ask(role, c, deps, opts);
    const points = normPoints(o.points, 3);
    return {[`ext.news.${role}`]: {points, status: points.length ? 'ok' : 'none'}};
  };
}

export const bull = side('bull');
export const bear = side('bear');

export async function joint(c, deps, opts = {}) {
  const o = await ask('joint', c, deps, opts);
  return {'ext.news.joint': {summary: str(o.summary, 800), points: normPoints(o.points, 4), stance: pick(o.stance), confidence: pick(o.confidence), status: 'ok'}};
}

export async function judge(c, deps, opts = {}) {
  const o = await ask('judge', c, deps, opts);
  const weighed = (Array.isArray(o.weighed) ? o.weighed : []).slice(0, 8).map(x => String(x).slice(0, 8));
  return {'ext.news.judge': {summary: str(o.summary, 900), stance: pick(o.stance), confidence: pick(o.confidence), weighed, status: 'ok'}};
}

export const isId = x => ID.test(x);
