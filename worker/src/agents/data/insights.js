// Insights agent: reads the weekly analysis (pi-insights, binding INSIGHTS) and turns the findings
// and simulated backtests that match the question into evidence items. Selection is in code by id
// and keyword, never by a model. Numbers become facts; text from the files is cleaned and capped.
// Insight facts carry rules ['historical']; strategy facts carry ['simulated'] (checked by V13, V22).
import {bindingJSON, evidence, cleanText} from '../case.js';

export const SOURCE = 'Portfolio Intel weekly analysis (BigQuery)';
const ID_RE = /^[a-z0-9-]{1,60}$/;
const DAY = 86400000;
export const MAX_FINDINGS = 3;
export const MAX_RUNS = 4;
const MAX_CAVEATS = 4;

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const day = s => { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

const SECTORS = ['technology', 'healthcare', 'energy', 'financial', 'utilities', 'industrials', 'consumer', 'materials', 'real estate', 'communication'];

// Which findings the question is about. Falls back to the first few (the file orders them by id).
export function pickFindings(findings, q) {
  const s = String(q || '').toLowerCase();
  const list = (findings || []).filter(f => f && ID_RE.test(String(f.id)));
  const by = fn => list.filter(fn);
  let sel = [];
  if (/\bsenat/.test(s)) sel = by(f => f.subject && f.subject.chamber === 'senate');
  else if (/\bhouse\b|representative/.test(s)) sel = by(f => f.subject && f.subject.chamber === 'house');
  if (!sel.length && /\bsales?\b|\bsell|\bsold\b/.test(s)) sel = by(f => f.analysis === 'A2');
  if (!sel.length && /\bdelay|\bfiling|\bslow|\bfast/.test(s)) sel = by(f => f.analysis === 'A3');
  if (!sel.length && /\bsize\b|\bamount|\blarge|\bbig\b/.test(s)) sel = by(f => f.analysis === 'A6');
  if (!sel.length) {
    const w = SECTORS.find(k => s.includes(k));
    if (w) sel = by(f => f.analysis === 'A5' && String(f.subject && f.subject.sector || '').toLowerCase().includes(w));
  }
  if (!sel.length) sel = list;
  return sel.slice(0, MAX_FINDINGS);
}

// Which simulated runs the question is about. Strategy words pick by name; otherwise the copy runs lead.
export function pickRuns(runs, q) {
  const s = String(q || '').toLowerCase();
  const list = (runs || []).filter(r => r && ID_RE.test(String(r.id)));
  const ids = f => list.filter(r => f(r.id));
  let sel = [];
  const id = s.match(/\b(copy-senate-buys|copy-house-buys|copy-top-members|momentum-sectors|dividend-basket|tbill-proxy|balanced-(?:annual|never|band))\b/);
  if (id) sel = ids(x => x === id[1]);
  else if (/\bmomentum|\bsector etf/.test(s)) sel = ids(x => x === 'momentum-sectors');
  else if (/\bdividend/.test(s)) sel = ids(x => x === 'dividend-basket');
  else if (/\bt-?bill|\btreasur/.test(s)) sel = ids(x => x === 'tbill-proxy');
  else if (/\b60\/40|\bbalanced|\brebalanc/.test(s)) sel = ids(x => x.startsWith('balanced-'));
  else if (/\bsenat/.test(s)) sel = ids(x => x === 'copy-senate-buys');
  else if (/\bhouse\b|representative/.test(s)) sel = ids(x => x === 'copy-house-buys');
  else if (/\bmember|\bpelosi|\bpolitician|\blawmaker/.test(s)) sel = ids(x => x.startsWith('copy-'));
  if (!sel.length) sel = ids(x => x.startsWith('copy-'));
  return sel.slice(0, MAX_RUNS);
}

const stale = (generated, now) => {
  const t = Date.parse(generated);
  return !Number.isFinite(t) || now - t > 10 * DAY;
};

export function insightItems(d, q) {
  const asof = day(d.generated);
  const items = [], wanted = [], used = new Set();
  const add = (key, label, value, unit, rules = ['historical']) => {
    if (unit === 'text' ? value == null : num(value) === null) return;
    items.push({key, label: cleanText(label, 100), value, unit, asof, rules});
  };
  const tr = d.tests_run || {};
  add('insights:tests_run', 'Tests run this week', (num(tr.confirmatory) || 0) + (num(tr.exploratory) || 0), 'count');
  add('insights:findings_count', 'Results that passed all tests', Array.isArray(d.findings) ? d.findings.length : 0, 'count');
  add('insights:label', 'How to read these results', cleanText(d.label, 200), 'text');
  for (const f of pickFindings(d.findings, q)) {
    const k = `insight:${f.id}`;
    const t = cleanText(f.title, 80);
    add(`${k}:mean_excess_pct`, `${t}, average vs SPY`, num(f.mean_excess_pct), 'pct');
    add(`${k}:ci_low`, `${t}, interval low end`, num(f.ci95_pct && f.ci95_pct[0]), 'pct');
    add(`${k}:ci_high`, `${t}, interval high end`, num(f.ci95_pct && f.ci95_pct[1]), 'pct');
    add(`${k}:n_events`, `${t}, trades counted`, num(f.n_events), 'count');
    add(`${k}:holdout_mean`, `${t}, average in the hold-out period`, num(f.holdout && f.holdout.mean_excess_pct), 'pct');
    wanted.push(`${k}:mean_excess_pct`);
    for (const c of f.caveats || []) used.add(c);
  }
  const cav = new Map((d.caveats || []).filter(c => c && ID_RE.test(String(c.id).replace(/_/g, '-'))).map(c => [c.id, c.text]));
  return {asof, items, wanted, used, cav};
}

export function strategyItems(d, q) {
  const asof = day(d.generated);
  const items = [], wanted = [], used = new Set();
  const R = ['simulated'];
  const add = (key, label, value, unit) => {
    if (unit === 'text' ? value == null : num(value) === null) return;
    items.push({key, label: cleanText(label, 100), value, unit, asof, rules: R});
  };
  add('strategy:label', 'How to read these simulations', cleanText(d.label, 260), 'text');
  for (const r of pickRuns(d.runs, q)) {
    const k = `strategy:${r.id}`;
    const n = cleanText(r.name, 70);
    const m = (r.metrics && r.metrics.full) || {};
    add(`${k}:cagr`, `${n}, yearly return`, num(m.cagr_pct), 'pct');
    add(`${k}:vol`, `${n}, volatility`, num(m.vol_pct), 'pct');
    add(`${k}:max_dd`, `${n}, largest drop`, num(m.max_dd_pct), 'pct');
    add(`${k}:sharpe`, `${n}, Sharpe ratio`, num(m.sharpe) === null ? null : num(m.sharpe).toFixed(2), 'text');
    add(`${k}:benchmark_cagr`, `SPY over the same dates as ${n}, yearly return`, num(r.benchmark_metrics && r.benchmark_metrics.full && r.benchmark_metrics.full.cagr_pct), 'pct');
    add(`${k}:excess_cagr`, `${n}, yearly return minus SPY`, num(r.relative && r.relative.excess_cagr_pct), 'pct');
    const words = {ahead: 'ahead of SPY, and the hold-out agrees', behind: 'behind SPY, and the hold-out agrees', not_distinguishable: 'not statistically distinguishable from SPY'};
    if (words[r.evidence]) add(`${k}:evidence`, `${n}, result against SPY`, words[r.evidence], 'text');
    if (r.period) add(`${k}:period`, `${n}, simulated period`, `${cleanText(r.period.start, 10)} to ${cleanText(r.period.end, 10)}`, 'text');
    wanted.push(`${k}:cagr`);
    for (const c of r.caveats || []) used.add(c);
  }
  const cav = new Map((d.caveats || []).filter(c => c && c.id).map(c => [c.id, c.text]));
  return {asof, items, wanted, used, cav};
}

export async function run(c, deps) {
  const d2 = {...deps, headers: {...(deps.headers || {}), 'X-PI-Internal': '1'}}; // pi-insights answers only internal callers
  const [a, b] = await Promise.allSettled([
    bindingJSON(d2, 'INSIGHTS', '/api/insights'),
    bindingJSON(d2, 'INSIGHTS', '/api/insights/strategies'),
  ]);
  const ins = a.status === 'fulfilled' && a.value && a.value.schema === 'pi/insights/v1' ? a.value : null;
  const st = b.status === 'fulfilled' && b.value && b.value.schema === 'pi/strategies/v1' ? b.value : null;
  if (!ins && !st) throw new Error('insights unavailable');
  const q = c.input.question;
  const items = [], wanted = [];
  const used = new Map(); // caveat id -> rules of the numbers that depend on it
  const cav = new Map();
  let asof = null;
  for (const [doc, fn, rule] of [[ins, insightItems, 'historical'], [st, strategyItems, 'simulated']]) {
    if (!doc) continue;
    const r = fn(doc, q);
    items.push(...r.items); wanted.push(...r.wanted);
    r.used.forEach(x => used.set(x, [...new Set([...(used.get(x) || []), rule])]));
    r.cav.forEach((v, k) => cav.set(k, v));
    if (!asof || (r.asof && r.asof < asof)) asof = r.asof;
  }
  // caveats the shown numbers depend on, as text facts (a few, capped)
  let n = 0;
  for (const [id, rules] of used) {
    if (n >= MAX_CAVEATS || !cav.has(id) || !/^[a-z_]{1,30}$/.test(id)) continue;
    items.push({key: `caveat:${id}`, label: `Caveat, ${id.replace(/_/g, ' ')}`, value: cleanText(cav.get(id), 240), unit: 'text', asof: items[0] ? items[0].asof : asof,
      rules});
    n++;
  }
  const flagged = (a.status === 'fulfilled' && a.value && a.value.stale === true) || (b.status === 'fulfilled' && b.value && b.value.stale === true) || stale(asof, deps.now ? deps.now() : Date.now());
  return {evidence: [evidence('insights', SOURCE, {asof, items, wanted, stale: !!flagged, partial: !(ins && st)})]};
}
