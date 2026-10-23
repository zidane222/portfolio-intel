// News agent: pi-news ticker headlines. Titles are data only, capped and cleaned.
import {bindingJSON, evidence, cleanText, TICKER_RE} from '../case.js';

export const SOURCE = 'Google News via pi-news';

export async function run(c, deps) {
  const list = (c.intent?.tickers || []).filter(t => TICKER_RE.test(t)).slice(0, 3);
  if (!list.length) return {evidence: [evidence('news', SOURCE, {status: 'empty'})]};
  const d = await bindingJSON(deps, 'NEWS', `/api/news/tickers/${list.join(',')}?per=3`);
  const count = {};
  const items = [];
  for (const a of d.articles || []) {
    const t = String(a.ticker || '').toUpperCase();
    if (!list.includes(t)) continue;
    count[t] = (count[t] || 0) + 1;
    if (count[t] > 3) continue;
    const url = /^https:\/\//.test(a.link || '') ? String(a.link).slice(0, 500) : null;
    const pub = a.published ? new Date(a.published) : null;
    items.push({key: `headline:${t}:${count[t]}`, label: `${t} headline`, value: cleanText(a.title, 160), unit: 'text',
      asof: pub && !isNaN(pub) ? pub.toISOString() : (d.updated || null), url});
  }
  return {evidence: [evidence('news', SOURCE, {asof: d.updated || null, items})]};
}
