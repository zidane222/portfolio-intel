// Disclosures agent: pi-disclosures House and Senate periodic transaction reports.
import {bindingJSON, evidence, cleanText, TICKER_RE} from '../case.js';

export const SOURCE = 'House/Senate PTR';

export async function run(c, deps) {
  const d = await bindingJSON(deps, 'DISCLOSURES', '/api/all-trades');
  const tick = new Set(c.intent?.tickers || []);
  const people = (c.intent?.people || []).map(p => p.toLowerCase());
  let trades = (d.trades || []).filter(x => x && typeof x === 'object');
  if (tick.size) trades = trades.filter(x => tick.has(String(x.ticker || '').toUpperCase()));
  if (people.length) trades = trades.filter(x => people.some(p => String(x.representative || '').toLowerCase().includes(p)));
  trades = trades.sort((a, b) => String(b.filed || '').localeCompare(String(a.filed || ''))).slice(0, 15);
  const asof = d.updated || null;
  const items = trades.map((x, i) => {
    const side = /purchase|buy/i.test(x.type || '') ? 'BUY' : /sale|sell/i.test(x.type || '') ? 'SELL' : cleanText(x.type, 20);
    const what = cleanText(x.ticker, 8) || cleanText(x.description, 40);
    return {key: `trade:${i + 1}`, label: 'Disclosed trade', value: cleanText(`${x.representative}, ${side} ${what}, ${x.amount}, filed ${x.filed}`), unit: 'text', asof};
  });
  const buys = {}, freq = {};
  for (const x of trades) {
    const t = String(x.ticker || '').toUpperCase();
    if (!TICKER_RE.test(t)) continue;
    freq[t] = (freq[t] || 0) + 1;
    if (/purchase|buy/i.test(x.type || '')) buys[t] = (buys[t] || 0) + 1;
  }
  for (const [t, n] of Object.entries(buys)) items.push({key: `count:buys:${t}`, label: `Disclosed buys of ${t}`, value: n, unit: 'count', asof});
  const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, 5);
  return {evidence: [evidence('disclosures', SOURCE, {asof, items, tickers: top})]};
}
