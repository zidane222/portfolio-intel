// Fact checker: rules F1 to F10 over evidence[]. Code only, no AI.
import {neededKeys} from './registry.js';
import {SOURCE as PORTFOLIO_SOURCE} from './data/holdings.js';

export const MAX_FACTS = 60;
const DAY = 86400000;

// F7: parse numbers like 1234, "1,234", "$1.2M", "5.1%". Returns null when unparseable.
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.trim().replace(/,/g, '').match(/^\$?\s*(-?\d+(?:\.\d+)?)\s*([KMB])?\s*%?$/i);
  if (!m) return null;
  const mult = {K: 1e3, M: 1e6, B: 1e9}[(m[2] || '').toUpperCase()] || 1;
  return Number(m[1]) * mult;
}

// Weekdays between two times (a simple trading-day count, holidays ignored).
function tradingDaysBetween(from, to) {
  let n = 0;
  for (let t = from + DAY; t <= to; t += DAY) { const d = new Date(t).getUTCDay(); if (d !== 0 && d !== 6) n++; }
  return n;
}

// F4 freshness. Returns true when stale.
export function isStale(key, asof, now) {
  const t = Date.parse(asof);
  if (!Number.isFinite(t)) return false;
  if (/^(price|change_pct|prev_close):/.test(key)) return tradingDaysBetween(t, now) > 4;
  if (/^rate:/.test(key)) return now - t > 7 * DAY;
  if (/^(trade|count:buys|raise|stats):/.test(key)) return now - t > 3 * DAY;
  return false;
}

// F5 range checks. Returns true when the value is out of range.
export function outOfRange(key, value) {
  if (/^price:|^prev_close:/.test(key)) return !(value > 0);
  if (/:apy$/.test(key)) return !(value >= 0 && value <= 15);
  if (/^change_pct:/.test(key)) return !(value >= -100 && value <= 1000);
  if (/:shares$/.test(key)) return !(value >= 0);
  return false;
}

// F3 tolerance by unit or key.
function within(key, unit, a, b) {
  if (/^(price|prev_close):/.test(key)) return Math.abs(a - b) <= Math.abs(b) * 0.005;
  if (unit === 'pct') return Math.abs(a - b) <= 0.05;
  if (unit === 'usd') return Math.abs(a - b) <= Math.abs(b) * 0.01;
  return a === b;
}

const newest = srcs => [...srcs].sort((x, y) => (Date.parse(y.asof) || 0) - (Date.parse(x.asof) || 0));

export function factcheck(c, now = Date.now()) {
  const groups = new Map();
  const dropped = [];
  for (const ev of c.evidence || []) {
    for (const it of ev.items || []) {
      if (!it || typeof it.key !== 'string') continue;
      const unit = it.unit || 'text';
      let value = it.value;
      if (unit !== 'text' && unit !== 'date') {
        value = toNumber(value); // F7
        if (value === null) { dropped.push(it.key); continue; }
      } else value = String(value == null ? '' : value);
      const g = groups.get(it.key) || {key: it.key, label: it.label || it.key, unit, sources: []};
      g.sources.push({source: ev.source, asof: it.asof || ev.asof || null, url: it.url || ev.url || null, value});
      groups.set(it.key, g);
    }
  }
  if (dropped.length) console.log('factcheck dropped unparseable', dropped.slice(0, 10).join(',')); // keys only (F7)

  const facts = [];
  for (const g of groups.values()) {
    const srcs = newest(g.sources);
    const f = {key: g.key, label: g.label, unit: g.unit, value: srcs[0].value, status: 'verified', sources: srcs, rules: []};
    if (g.unit === 'text') f.rules.push('F8'); // text exists at the source; numbers in it are never facts
    if (!srcs.some(s => s.source && s.asof)) { f.status = 'unknown'; f.rules.push('F1'); }
    if (g.unit !== 'text' && g.unit !== 'date') {
      if (outOfRange(g.key, f.value)) { f.status = 'unknown'; f.rules.push('F5'); }
      if (srcs.length > 1) {
        const agree = srcs.every(s => within(g.key, g.unit, s.value, srcs[0].value));
        f.rules.push('F3');
        if (!agree) f.status = 'conflicting';
      }
    }
    if (f.status === 'verified' && srcs[0].asof && isStale(g.key, srcs[0].asof, now)) { f.status = 'unknown'; f.stale = true; f.rules.push('F4'); }
    if (srcs.every(s => s.source === PORTFOLIO_SOURCE) && f.status === 'verified') f.rules.push('F6');
    facts.push(f);
  }
  const byKey = new Map(facts.map(f => [f.key, f]));

  // F6: recompute holding value = shares x price and compare with the device value (2%).
  for (const f of facts) {
    const m = f.key.match(/^holding:(.+):value$/);
    if (!m) continue;
    const sh = byKey.get(`holding:${m[1]}:shares`), px = byKey.get(`price:${m[1]}`);
    if (!sh || !px || sh.status !== 'verified' || px.status !== 'verified' || f.status !== 'verified') continue;
    const calc = Math.round(sh.value * px.value * 100) / 100;
    if (Math.abs(calc - f.value) > Math.abs(calc) * 0.02) {
      f.status = 'conflicting';
      f.sources.push({source: px.sources[0].source, asof: px.sources[0].asof, url: null, value: calc});
      f.rules.push('F6');
    }
  }

  // F10: derived facts, from verified facts only, computed in code.
  const derived = [];
  const total = byKey.get('portfolio:total');
  if (total && total.status === 'verified' && total.value > 0) {
    for (const f of facts) {
      const m = f.key.match(/^holding:(.+):value$/);
      if (!m || f.status !== 'verified') continue;
      derived.push({key: `share:${m[1]}`, label: `${m[1]} share of portfolio`, unit: 'pct', value: Math.round(f.value / total.value * 10000) / 100,
        status: 'verified', sources: [...f.sources, ...total.sources], rules: ['derived', 'F10']});
    }
  }
  const held = facts.filter(f => /^holding:.+:value$/.test(f.key) && f.status === 'verified');
  if (held.length) derived.push({key: 'derived:holdings_count', label: 'Holdings counted', unit: 'count', value: held.length, status: 'verified', sources: held.map(f => f.sources[0]), rules: ['derived', 'F10']});
  const trades = facts.filter(f => /^trade:/.test(f.key) && f.status === 'verified');
  if (trades.length) derived.push({key: 'derived:trades_shown', label: 'Disclosed trades shown', unit: 'count', value: trades.length, status: 'verified', sources: [trades[0].sources[0]], rules: ['derived', 'F10']});
  for (const d of derived) if (!byKey.has(d.key)) { facts.push(d); byKey.set(d.key, d); }

  // F2: keys the intent needs with no evidence become unknown facts.
  const need = neededKeys(c);
  for (const k of need) {
    if (byKey.has(k)) continue;
    const f = {key: k, label: k.replace(/^price:/, '').replace(/^portfolio:total$/, 'Portfolio total value').replace(/^stats:count$/, 'Matching filings') + (k.startsWith('price:') ? ' price' : ''),
      unit: k.startsWith('price:') || k === 'portfolio:total' ? 'usd' : 'count', value: null, status: 'unknown', sources: [], rules: ['F2']};
    facts.push(f); byKey.set(k, f);
  }

  // F9: intent keys first, cap 60, ids f1..fN.
  const tick = c.intent?.tickers || [];
  const prio = f => (need.includes(f.key) ? 0 : tick.some(t => f.key.includes(':' + t)) ? 1 : 2);
  const ordered = facts.map((f, i) => [f, i]).sort((a, b) => prio(a[0]) - prio(b[0]) || a[1] - b[1]).map(([f]) => f).slice(0, MAX_FACTS);
  return {facts: ordered.map((f, i) => ({id: 'f' + (i + 1), ...f}))};
}

export async function run(c, deps) {
  return factcheck(c, deps && deps.now ? deps.now() : Date.now());
}
