// Private markets agent: pi-private SEC Form D and C filings, list and stats.
// When the filters match nothing, it relaxes them one step at a time (topic, then industry and
// name search, then stage) and says so in a fact, so the answer never claims nothing exists
// when nearby filings do.
import {bindingJSON, evidence, cleanText} from '../case.js';

export const SOURCE = 'SEC EDGAR Form D/C';
const DAY = 86400000;
// Topics with an SEC industry group to fall back on when no company name matches.
const TOPIC_INDUSTRY = {ai: 'other technology', fintech: 'other technology', crypto: 'other technology'};
const TOPIC_LABEL = {ai: 'AI', fintech: 'fintech', biotech: 'biotech', health: 'health', energy: 'energy', crypto: 'crypto'};

// Filed-date window start (YYYY-MM-DD) for a period key.
export function sinceOf(period, now = Date.now()) {
  const d = new Date(now);
  if (period === 'this_month') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
  if (period === '30d') return new Date(now - 30 * DAY).toISOString().slice(0, 10);
  if (period === '90d') return new Date(now - 90 * DAY).toISOString().slice(0, 10);
  if (period === 'this_year') return `${d.getUTCFullYear()}-01-01`;
  return null;
}

export function query(f = {}, now = Date.now()) {
  const p = new URLSearchParams();
  for (const k of ['state', 'city', 'stage', 'industry', 'form', 'q', 'topic']) if (f[k]) p.set(k, String(f[k]));
  const since = f.since || sinceOf(f.period, now);
  if (since) p.set('since', since);
  return p.toString();
}

// The filter sets to try, strictest first, each with a note of what was relaxed.
// Location, form and the date window are never relaxed.
export function relaxSteps(f) {
  const steps = [{f: {...f}, note: null}];
  const cur = {...f};
  const dropped = [];
  if (cur.topic) {
    const label = TOPIC_LABEL[cur.topic] || cur.topic;
    const ind = TOPIC_INDUSTRY[cur.topic];
    if (ind && !cur.industry) steps.push({f: {...cur, topic: null, industry: ind}, note: `uses the closest SEC industry group (Other Technology) because no company names matched ${label}`});
    cur.topic = null; dropped.push(`topic (${label})`);
  }
  if (cur.industry || cur.q) { cur.industry = null; cur.q = null; dropped.push('industry and name search'); }
  if (dropped.length) steps.push({f: {...cur}, note: `drops the ${dropped.join(' and ')} filter`});
  if (cur.stage) {
    dropped.push(`stage (${cur.stage})`); cur.stage = null;
    steps.push({f: {...cur}, note: `drops the ${dropped.join(' and ')} filter`});
  }
  return steps;
}

const money = n => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`);

export function describe(f, now = Date.now()) {
  const parts = [];
  if (f.city) parts.push(`city ${String(f.city).replace(/\b\w/g, ch => ch.toUpperCase())}`);
  if (f.state) parts.push(`state ${f.state}`);
  if (f.topic) parts.push(`topic ${TOPIC_LABEL[f.topic] || f.topic} (company name)`);
  if (f.industry) parts.push(`industry ${f.industry}`);
  if (f.q) parts.push(`name contains ${f.q}`);
  if (f.stage) parts.push(`stage ${f.stage}`);
  if (f.form) parts.push(`Form ${f.form}`);
  const since = f.since || sinceOf(f.period, now);
  if (since) parts.push(`filed on or after ${since}`);
  return parts.length ? parts.join(', ') : 'none';
}

export async function run(c, deps) {
  const now = deps && deps.now ? deps.now() : Date.now();
  const base = {...(c.intent?.private_filters || {})};
  let used = null, stats = null, qs = '';
  for (const step of relaxSteps(base)) {
    qs = query(step.f, now);
    stats = await bindingJSON(deps, 'PRIVATE', `/api/private/stats${qs ? '?' + qs : ''}`);
    used = step;
    if (!(typeof stats.count === 'number' && stats.count === 0)) break;
  }
  const list = await bindingJSON(deps, 'PRIVATE', `/api/private?${qs ? qs + '&' : ''}limit=10`);
  const asof = stats.updated || list.updated || null;
  const items = [{key: 'filters:applied', label: 'Filters applied', value: cleanText(describe(used.f, now), 200), unit: 'text', asof}];
  if (used.note) items.push({key: 'filters:relaxed', label: 'Filters relaxed', unit: 'text', asof,
    value: cleanText(`No filings matched every filter asked for (${describe(base, now)}), so this answer ${used.note}.`, 300)});
  items.push(...(list.raises || []).slice(0, 10).map((r, i) => ({
    key: `raise:${i + 1}`, label: 'Private raise', unit: 'text', asof,
    value: cleanText(`${r.n}, ${r.city || ''} ${r.st || ''}, ${r.stage || 'Undisclosed'}, ${typeof r.amt === 'number' ? money(r.amt) : 'amount not given'}, Form ${r.f}, filed ${r.d}`),
    url: /^https:\/\/www\.sec\.gov\//.test(r.u || '') ? r.u : null,
  })));
  if (typeof stats.count === 'number') items.push({key: 'stats:count', label: 'Matching filings', value: stats.count, unit: 'count', asof});
  if (typeof stats.total_amt === 'number') items.push({key: 'stats:total_amt', label: 'Total amount raised', value: stats.total_amt, unit: 'usd', asof});
  for (const [k, v] of Object.entries(stats.by_stage || {})) {
    if (typeof v === 'number') items.push({key: `stats:by_stage:${cleanText(k, 30)}`, label: `Filings at ${cleanText(k, 30)}`, value: v, unit: 'count', asof});
  }
  return {evidence: [evidence('private', SOURCE, {asof, items})]};
}
