// Rates agent: cached top savings rates only (?cached=1), so it never causes a Groq call.
import {bindingJSON, evidence, cleanText} from '../case.js';

export const SOURCE = 'The Motley Fool';

export async function run(c, deps) {
  const d = await bindingJSON(deps, 'RATES', '/api/top-rates?cached=1');
  if (!d || d.cached === false || !Array.isArray(d.rates)) {
    // Cold cache. The holdings agent already supplies the cash options the device sent.
    return {evidence: [evidence('rates', SOURCE, {status: 'empty', note: 'cold cache'})]};
  }
  const url = /^https:\/\/www\.fool\.com\//.test(d.url || '') ? d.url : null;
  const asof = d.date || null;
  const items = [];
  for (const r of d.rates.slice(0, 8)) {
    const inst = cleanText(r.institution, 60);
    if (!inst) continue;
    items.push({key: `rate:${inst}:apy`, label: `${inst} APY`, value: r.apy, unit: 'pct', asof});
    if (typeof r.min_deposit === 'number') items.push({key: `rate:${inst}:min`, label: `${inst} minimum deposit`, value: r.min_deposit, unit: 'usd', asof});
  }
  return {evidence: [evidence('rates', SOURCE, {url, asof, items})]};
}
