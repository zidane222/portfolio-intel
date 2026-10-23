// Market agent: pi-market prices and, if a range is set, history.
import {bindingJSON, evidence, TICKER_RE} from '../case.js';

export const SOURCE = 'Yahoo Finance via pi-market';
const RANGE = {'1mo': ['1mo', 0], '3mo': ['6mo', 92], '1y': ['1y', 0]}; // pi-market has no 3mo, so cut 6mo to 92 days

export function marketTickers(c) {
  const type = c.intent?.type;
  if (c.intent?.tickers?.length) return c.intent.tickers.slice(0, 5);
  if (type === 'disclosures') {
    const ev = c.evidence.find(e => e.agent === 'disclosures');
    return (ev?.tickers || []).slice(0, 5);
  }
  return (c.input.portfolio?.holdings || []).filter(h => !h.isCash && TICKER_RE.test(h.ticker))
    .sort((a, b) => (b.value || 0) - (a.value || 0)).map(h => h.ticker).slice(0, 10);
}

export async function run(c, deps) {
  const list = [...new Set(marketTickers(c))].filter(t => TICKER_RE.test(t));
  if (!list.length) return {evidence: [evidence('market', SOURCE, {status: 'empty'})]};
  const range = RANGE[c.intent?.range] ? c.intent.range : null;
  const [pr, hist] = await Promise.all([
    bindingJSON(deps, 'MARKET', `/api/prices/${list.join(',')}`),
    range ? bindingJSON(deps, 'MARKET', `/api/history/${list.join(',')}?range=${RANGE[range][0]}`).catch(() => null) : null,
  ]);
  const asof = pr.updated || null;
  const items = [];
  for (const t of list) {
    const q = pr.prices && pr.prices[t];
    if (!q) continue;
    items.push({key: `price:${t}`, label: `${t} price`, value: q.price, unit: 'usd', asof});
    items.push({key: `change_pct:${t}`, label: `${t} change today`, value: q.change_pct, unit: 'pct', asof});
    items.push({key: `prev_close:${t}`, label: `${t} previous close`, value: q.prev_close, unit: 'usd', asof});
    let pts = hist?.series?.[t];
    if (range && Array.isArray(pts) && pts.length > 1) {
      const days = RANGE[range][1];
      if (days) { const cut = pts[pts.length - 1][0] - days * 86400; pts = pts.filter(p => p[0] >= cut); }
      const first = pts[0][1], last = pts[pts.length - 1][1];
      if (first > 0 && pts.length > 1) items.push({key: `return:${t}:${range}`, label: `${t} return over ${range}`, value: Math.round((last / first - 1) * 10000) / 100, unit: 'pct', asof: hist.updated || asof});
    }
  }
  return {evidence: [evidence('market', SOURCE, {asof, items})]};
}
