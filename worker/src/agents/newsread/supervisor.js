// runNewsRead(case, deps) -> pi/news-verdict/v1 record (contract 6.3).
// Owns sequencing, the one repair, fallback and the confidence cap. No network of its own:
// deps = {groq, take, now, deadline} (+ optional origin, model, run_date, price_ref_date; origin and
// run_date may also sit on the case, as pi-newsdesk passes them).
// case.ext.news.pack and .mode are set first (newsCase() builds them through applyPatch).
import {applyPatch, createCase, withTimeout} from '../case.js';
import {buildPack} from './pack.js';
import {chooseMode, confidenceCap} from './mode.js';
import {PROMPT_VERSION} from './prompts.js';
import * as roles from './roles.js';
import {validateRole, validateNewsRead, capConfidence} from '../validator.js';

export const MAX_NEWS_CALLS = 4;
export const NEWS_DEADLINE_MS = 20000;
export const SCHEMA = 'pi/news-verdict/v1';

// A case holding only the news extension (used by pi-newsdesk; Ask cases never run this).
export function newsCase(ticker, headlines, now = Date.now()) {
  const c = createCase({question: ''}, now);
  const pack = buildPack(ticker, headlines, now);
  applyPatch(c, 'newspack', 'newspack', {'ext.news.pack': pack, 'ext.news.mode': chooseMode(pack)});
  return c;
}

// Last trading day on or before d (weekends only; holidays are left to the Learning agent's join).
export function priceRefDate(d) {
  const t = new Date(d + 'T12:00:00Z');
  while (t.getUTCDay() === 0 || t.getUTCDay() === 6) t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

const uuid = () => crypto.randomUUID();

function baseRecord(c, deps, nowMs) {
  const {pack, mode} = c.ext.news;
  const runDate = deps.run_date || c.run_date || new Date(nowMs).toISOString().slice(0, 10);
  return {
    schema: SCHEMA, id: uuid(), run_date: runDate, created: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ticker: pack.ticker, origin: (deps.origin || c.origin) === 'batch' ? 'batch' : 'on_demand', mode: mode.mode,
    mode_basis: {P: mode.P, N: mode.N, n: mode.n, pubs_pos: mode.pubs_pos, pubs_neg: mode.pubs_neg},
    stance: null, confidence: null, confidence_cap: confidenceCap(pack, mode), summary: null,
    bull: [], bear: [], joint: [],
    evidence: pack.items.map(i => ({id: i.id, title: i.title, source: i.source, date: i.date, url: i.url, tone: i.tone})),
    price_ref_date: deps.price_ref_date || priceRefDate(runDate),
    status: 'thin', flags: [], groq_calls: 0, tokens: 0, model: deps.model || null, prompt_version: PROMPT_VERSION,
  };
}

const clean = pts => (pts || []).map(p => ({text: p.text, cites: [...p.cites]}));

export async function runNewsRead(c, deps) {
  const clock = () => Number(deps.now ? deps.now() : Date.now()); // deps.now may return a Date or ms
  const nowMs = clock();
  const deadline = Number(deps.deadline) || nowMs + NEWS_DEADLINE_MS;
  const rec = baseRecord(c, deps, nowMs);
  const {pack, mode} = c.ext.news;
  const flags = new Set();
  const warn = new Set();
  let calls = 0, tokens = 0, repairs = 0, budgetHit = false;
  const done = status => {
    rec.status = status; rec.groq_calls = calls; rec.tokens = tokens;
    rec.flags = [...flags, ...warn].filter((x, i, a) => a.indexOf(x) === i);
    if (status !== 'PASS') { rec.stance = null; rec.confidence = null; rec.summary = null; rec.bull = []; rec.bear = []; rec.joint = []; }
    applyPatch(c, 'newsvalidator', 'newsvalidator', {'ext.news.validation': {status: status === 'PASS' ? 'PASS' : status === 'thin' ? 'PASS' : 'fallback', flags: rec.flags, attempts: 1 + repairs}});
    applyPatch(c, 'newsread', 'newsread', {'ext.news.read': rec});
    return rec;
  };
  if (mode.mode === 'thin') return done('thin');

  // Counted Groq wrapper: per-ticker cap of 4 calls, deadline, token tally. take stays the role's.
  const roleDeps = {
    take: async (n, t) => { const ok = await deps.take(n, t); if (!ok) budgetHit = true; return ok; },
    groq: async (role, system, user, maxTokens) => {
      if (calls >= MAX_NEWS_CALLS) throw new Error('call cap');
      const left = Number(deadline) - clock();
      if (left <= 0) throw new Error('timeout');
      calls++;
      const r = await withTimeout(Promise.resolve(deps.groq(role, system, user, maxTokens)), left);
      tokens += Math.max(0, Number(r && r.tokens) || 0);
      return r;
    },
  };
  const canCall = () => calls < MAX_NEWS_CALLS && !budgetHit;

  // Run one role, validate it, repair once if the shared repair is still free.
  async function runRole(role, ctx) {
    let attemptFlags = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt === 1 && (repairs >= 1 || !canCall())) break;
      if (!canCall()) break;
      if (attempt === 1) repairs++;
      let patch;
      try { patch = await roles[role](c, roleDeps, {flags: attemptFlags}); } catch (e) {
        if (e && e.budget) { flags.add('budget'); return null; }
        flags.add(e && e.message === 'timeout' ? 'timeout' : 'groq_error');
        attemptFlags = null;
        continue;
      }
      const out = patch[`ext.news.${role}`];
      const v = validateRole(role, out, pack, {mode: mode.mode, ...ctx});
      for (const w of v.warnings) warn.add(w.rule);
      if (v.status === 'PASS') return out;
      for (const f of v.flags) flags.add(f.rule);
      attemptFlags = v.flags;
    }
    return null;
  }

  if (mode.mode === 'collaborate') {
    const j = await runRole('joint', {});
    if (!j) return done(budgetHit && rec.origin === 'batch' ? 'skipped' : 'fallback');
    applyPatch(c, 'joint', 'joint', {'ext.news.joint': j});
    const [conf] = capConfidence(j.confidence, pack, mode);
    Object.assign(rec, {stance: j.stance, confidence: conf, summary: j.summary, joint: clean(j.points)});
  } else {
    // bull and bear in parallel on the same frozen pack
    for (const it of pack.items) Object.freeze(it);
    Object.freeze(pack.items);
    const [b, r] = await Promise.all([runRole('bull', {}), runRole('bear', {})]);
    const sideOf = v => (v ? v : {points: [], status: 'error'});
    applyPatch(c, 'bull', 'bull', {'ext.news.bull': sideOf(b)});
    applyPatch(c, 'bear', 'bear', {'ext.news.bear': sideOf(r)});
    const okB = b && b.status === 'ok', okR = r && r.status === 'ok';
    if (b && r && !okB && !okR) { flags.add('V15'); return done('fallback'); } // both empty: should have been thin
    if (!okB && !okR) return done(budgetHit && rec.origin === 'batch' ? 'skipped' : 'fallback');
    const j = await runRole('judge', {bull: c.ext.news.bull, bear: c.ext.news.bear});
    if (!j) return done(budgetHit && rec.origin === 'batch' ? 'skipped' : 'fallback');
    applyPatch(c, 'judge', 'judge', {'ext.news.judge': j});
    const [conf] = capConfidence(j.confidence, pack, mode);
    Object.assign(rec, {stance: j.stance, confidence: conf, summary: j.summary,
      bull: okB ? clean(b.points) : [], bear: okR ? clean(r.points) : []});
  }
  rec.status = 'PASS'; // candidate; the whole-record check decides
  const final = validateNewsRead(rec, pack);
  if (final.status !== 'PASS') { for (const f of final.flags) flags.add(f.rule); return done('fallback'); }
  return done('PASS');
}
