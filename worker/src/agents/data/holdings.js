// Holdings agent: no binding. Reads the user-supplied portfolio for this request only.
// Never stores, caches or logs it.
import {evidence} from '../case.js';

export const SOURCE = 'Your portfolio (on this device)';
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export async function run(c) {
  const p = c.input.portfolio;
  if (!p) return {evidence: [evidence('holdings', SOURCE, {status: 'empty'})]};
  const asof = p.asof || null;
  const type = c.intent?.type;
  const asked = new Set(c.intent?.tickers || []);
  const items = [];
  const add = (key, label, value, unit) => { if (value !== null && value !== undefined) items.push({key, label, value, unit, asof}); };
  add('portfolio:total', 'Portfolio total value', num(p.total), 'usd');
  for (const h of p.holdings || []) {
    if (type === 'ticker' && !asked.has(h.ticker)) continue;
    if (type === 'rates' && !h.isCash) continue;
    const t = h.ticker;
    if (h.isCash) {
      add(`holding:${t}:value`, `${t} cash balance`, num(h.value), 'usd');
      add(`cash:${t}:apy`, `${t} cash yield`, num(h.apy), 'pct');
      continue;
    }
    add(`holding:${t}:shares`, `${t} shares held`, num(h.shares), 'shares');
    add(`holding:${t}:value`, `${t} holding value`, num(h.value), 'usd');
    add(`holding:${t}:avgCost`, `${t} average cost per share`, num(h.avgCost), 'usd');
    const cost = num(h.shares) && num(h.avgCost) ? h.shares * h.avgCost : null;
    if (cost && num(h.value) !== null) add(`holding:${t}:gain_pct`, `${t} gain since purchase`, Math.round((h.value / cost - 1) * 10000) / 100, 'pct');
  }
  if (type !== 'ticker') {
    for (const [k, v] of Object.entries(p.allocation || {})) add(`alloc:${k}`, `${k} share of portfolio`, num(v), 'pct');
    if (type !== 'rates') add('portfolio:income_annual', 'Estimated annual income', num(p.income_annual), 'usd');
  }
  return {evidence: [evidence('holdings', SOURCE, {asof, items})]};
}
