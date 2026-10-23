// Private markets agent: pi-private SEC Form D and C filings, list and stats.
import {bindingJSON, evidence, cleanText} from '../case.js';

export const SOURCE = 'SEC EDGAR Form D/C';

export function query(f = {}) {
  const p = new URLSearchParams();
  for (const k of ['state', 'city', 'stage', 'industry', 'form', 'q']) if (f[k]) p.set(k, String(f[k]));
  return p.toString();
}

const money = n => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`);

export async function run(c, deps) {
  const qs = query(c.intent?.private_filters || {});
  const [list, stats] = await Promise.all([
    bindingJSON(deps, 'PRIVATE', `/api/private?${qs ? qs + '&' : ''}limit=10`),
    bindingJSON(deps, 'PRIVATE', `/api/private/stats${qs ? '?' + qs : ''}`),
  ]);
  const asof = stats.updated || list.updated || null;
  const items = (list.raises || []).slice(0, 10).map((r, i) => ({
    key: `raise:${i + 1}`, label: 'Private raise', unit: 'text', asof,
    value: cleanText(`${r.n}, ${r.city || ''} ${r.st || ''}, ${r.stage || 'Undisclosed'}, ${typeof r.amt === 'number' ? money(r.amt) : 'amount not given'}, Form ${r.f}, filed ${r.d}`),
    url: /^https:\/\/www\.sec\.gov\//.test(r.u || '') ? r.u : null,
  }));
  if (typeof stats.count === 'number') items.push({key: 'stats:count', label: 'Matching filings', value: stats.count, unit: 'count', asof});
  if (typeof stats.total_amt === 'number') items.push({key: 'stats:total_amt', label: 'Total amount raised', value: stats.total_amt, unit: 'usd', asof});
  for (const [k, v] of Object.entries(stats.by_stage || {})) {
    if (typeof v === 'number') items.push({key: `stats:by_stage:${cleanText(k, 30)}`, label: `Filings at ${cleanText(k, 30)}`, value: v, unit: 'count', asof});
  }
  return {evidence: [evidence('private', SOURCE, {asof, items})]};
}
