// Case state for /api/ask. Only the supervisor creates and changes it (applyPatch).
// Agents return patches. A patch may only touch the agent's own keys.

export const CASE_SCHEMA_ID = 'pi/case-state/v1';
export const INTENT_TYPES = ['holdings', 'ticker', 'disclosures', 'rates', 'private', 'news_read', 'insights', 'general', 'out_of_scope'];
export const EVIDENCE_STATUS = ['ok', 'empty', 'error', 'timeout'];
export const FACT_STATUS = ['verified', 'unknown', 'conflicting'];
export const UNITS = ['usd', 'pct', 'count', 'shares', 'date', 'text'];
export const MAX_GROQ_CALLS = 3;
export const DEADLINE_MS = 25000;

// Keys each agent may write. Data agents append to evidence.
export const OWN_KEYS = {
  intent: ['intent'],
  data: ['evidence'],
  factcheck: ['facts'],
  builder: ['draft'],
  validator: ['validation'],
  render: ['result'],
  // Phase 3 news read roles (agents/newsread/*). Each may write only its own ext.news.* path.
  newspack: ['ext.news.pack', 'ext.news.mode'],
  bull: ['ext.news.bull'],
  bear: ['ext.news.bear'],
  joint: ['ext.news.joint'],
  judge: ['ext.news.judge'],
  newsvalidator: ['ext.news.validation'],
  newsread: ['ext.news.read'],
  // Phase 4 insights: the selected findings and runs the supervisor may record for the case.
  insights: ['ext.insights.items'],
};
const EXT_INSIGHTS = new Set(['ext.insights.items']);
const EXT_NEWS = new Set(['ext.news.pack', 'ext.news.mode', 'ext.news.bull', 'ext.news.bear', 'ext.news.joint', 'ext.news.judge', 'ext.news.validation', 'ext.news.read']);

export function createCase(input, now = Date.now()) {
  return {
    id: crypto.randomUUID(),
    created: new Date(now).toISOString(),
    input: {
      question: input.question,
      history: input.history || [],
      portfolio: input.portfolio || null,
      client_asof: input.client_asof || '',
    },
    intent: null,
    evidence: [],
    facts: [],
    draft: null,
    validation: null,
    result: null,
    trace: [],
    budget: {groq_calls: 0, deadline: now + DEADLINE_MS},
    ext: {},
  };
}

// Notes must never hold user text. Callers pass fixed strings or counts only.
export function trace(c, agent, ms, ok, note = '') {
  c.trace.push({agent, ms: Math.max(0, Math.round(ms)), ok: !!ok, note: String(note).slice(0, 80)});
}

// Merge an agent's patch. Returns false (and traces) when the patch touches other keys.
export function applyPatch(c, role, agent, patch) {
  const allowed = OWN_KEYS[role] || [];
  const keys = Object.keys(patch || {});
  if (keys.some(k => !allowed.includes(k))) { trace(c, agent, 0, false, 'patch rejected: foreign key'); return false; }
  for (const k of keys) {
    if (k === 'evidence') c.evidence.push(...(Array.isArray(patch.evidence) ? patch.evidence : []));
    else if (k.startsWith('ext.')) {
      if (EXT_INSIGHTS.has(k)) { c.ext = c.ext || {}; c.ext.insights = c.ext.insights || {}; c.ext.insights.items = patch[k]; continue; }
      if (!EXT_NEWS.has(k)) { trace(c, agent, 0, false, 'patch rejected: unknown ext path'); return false; }
      c.ext = c.ext || {};
      c.ext.news = c.ext.news || {};
      c.ext.news[k.slice('ext.news.'.length)] = patch[k];
    }
    else c[k] = patch[k];
  }
  return true;
}

export const remaining = c => c.budget.deadline - Date.now();

// Resolve within ms or reject with Error('timeout'). Never leaves the timer running.
export function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), Math.max(0, ms)); }),
  ]).finally(() => clearTimeout(t));
}

// GET JSON from a private service binding with a fixed path. Throws on error or non-2xx.
export async function bindingJSON(deps, name, path, ms = 6000) {
  const svc = deps.bindings && deps.bindings[name];
  if (!svc) throw new Error('not linked');
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  if (deps.signal) deps.signal.addEventListener('abort', stop);
  try {
    const req = new Request('https://internal' + path, {headers: deps.headers || {}, signal: ctl.signal});
    const r = await withTimeout(svc.fetch(req), ms);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    ctl.abort();
    if (deps.signal) deps.signal.removeEventListener('abort', stop);
  }
}

// Evidence row helper.
export const evidence = (agent, source, {url = null, asof = null, status = 'ok', items = [], ...rest} = {}) =>
  ({agent, source, url, asof, status: items.length || status !== 'ok' ? status : 'empty', items, ...rest});

// Text from public sources: capped and stripped of characters that could break prompt tags.
export const cleanText = (s, n = 160) => String(s == null ? '' : s).replace(/[<>`]/g, '').replace(/\[\[|\]\]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
export const TICKER_RE = /^[A-Z.\-]{1,6}$/;
