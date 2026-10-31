// Disclosures agent: pi-disclosures House and Senate periodic transaction reports.
// Filters by the question: tickers or people named, the user's own stocks ("my stocks"), buy or
// sell side, and a filed-date window ("this month"). When the window or filter is empty, the
// newest filings are shown and a fact says so, so the answer never claims a quiet month it can't see.
import {bindingJSON, evidence, cleanText, TICKER_RE} from '../case.js';

export const SOURCE = 'House/Senate PTR';
const DAY = 86400000;
const MAX_ITEMS = 12;
const MINE_RE = /\bmy (?:portfolio|holdings|stocks|positions|shares)\b|\bstocks? I (?:own|hold)\b/i;

// Filed-date window from the question, or null for "newest filings". Labels are words only (V1).
export function windowOf(question, now = Date.now()) {
  const q = String(question || '');
  const iso = t => new Date(t).toISOString().slice(0, 10);
  const d = new Date(now);
  if (/\btoday\b/i.test(q)) return {since: iso(now), label: 'today'};
  if (/\bthis month\b|\bmonth to date\b/i.test(q)) return {since: iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)), label: 'this month'};
  if (/\b(?:past|last) (?:30 days|month)\b/i.test(q)) return {since: iso(now - 30 * DAY), label: 'in the past month'};
  if (/\bthis week\b|\b(?:past|last) week\b/i.test(q)) return {since: iso(now - 7 * DAY), label: 'this past week'};
  if (/\bthis year\b|\bytd\b/i.test(q)) return {since: iso(Date.UTC(d.getUTCFullYear(), 0, 1)), label: 'this year'};
  return null;
}

export function sideOf(question) {
  const q = String(question || '');
  const buy = /\b(?:buy|buys|buying|bought|purchas\w*)\b/i.test(q), sell = /\b(?:sell|sells|selling|sold|sales?|dump\w*)\b/i.test(q);
  return buy && !sell ? 'BUY' : sell && !buy ? 'SELL' : null;
}

const sideText = x => (/purchase|buy/i.test(x.type || '') ? 'BUY' : /sale|sell/i.test(x.type || '') ? 'SELL' : cleanText(x.type, 20));

export async function run(c, deps) {
  const d = await bindingJSON(deps, 'DISCLOSURES', '/api/all-trades');
  const question = String(c.input?.question || '');
  const asof = d.updated || null;
  const tick = new Set(c.intent?.tickers || []);
  const mine = MINE_RE.test(question);
  const held = (c.input?.portfolio?.holdings || []).filter(h => !h.isCash).map(h => String(h.ticker || '').toUpperCase()).filter(t => TICKER_RE.test(t));
  if (mine && !tick.size) held.forEach(t => tick.add(t));
  const people = (c.intent?.people || []).map(p => p.toLowerCase());
  const side = sideOf(question);
  const win = windowOf(question, typeof deps.now === 'function' ? deps.now() : Date.now());

  let trades = (d.trades || []).filter(x => x && typeof x === 'object');
  if (tick.size) trades = trades.filter(x => tick.has(String(x.ticker || '').toUpperCase()));
  if (people.length) trades = trades.filter(x => people.some(p => String(x.representative || '').toLowerCase().includes(p)));
  if (side) trades = trades.filter(x => sideText(x) === side);
  trades.sort((a, b) => String(b.filed || '').localeCompare(String(a.filed || '')));

  const what = side === 'BUY' ? 'buys' : side === 'SELL' ? 'sales' : 'trades';
  const items = [];
  const scope = mine
    ? (held.length ? `Stock ${what} by members of Congress in the stocks you hold, from House and Senate filings` : 'No stock holdings were sent from this device, so this shows all Congress filings')
    : `Stock ${what} by members of Congress, from House and Senate filings`;
  items.push({key: 'disclosure:scope', label: 'What this data covers', value: scope, unit: 'text', asof});

  let shown = trades;
  if (win) {
    const inWin = trades.filter(x => String(x.filed || '') >= win.since);
    if (inWin.length) {
      shown = inWin;
      items.push({key: 'disclosure:window', label: 'Filing window', value: `Congress ${what} filed ${win.label}`, unit: 'text', asof});
      items.push({key: 'count:disclosed', label: `Congress ${what} filed ${win.label}`, value: inWin.length, unit: 'count', asof});
    } else if (trades.length) {
      items.push({key: 'disclosure:window', label: 'Filing window', value: `No matching Congress ${what} were filed ${win.label}; showing the newest filed instead`, unit: 'text', asof});
    }
  } else if (trades.length) {
    items.push({key: 'disclosure:window', label: 'Filing window', value: `Newest Congress ${what} filed`, unit: 'text', asof});
  }
  if (!trades.length) {
    items.push({key: 'disclosure:window', label: 'Filing window', value: mine && held.length ? `No Congress ${what} were found in the stocks you hold` : `No matching Congress ${what} were found`, unit: 'text', asof});
  }

  // Count per ticker over the whole window, before the display cut
  const buys = {}, freq = {};
  for (const x of shown) {
    const t = String(x.ticker || '').toUpperCase();
    if (!TICKER_RE.test(t)) continue;
    freq[t] = (freq[t] || 0) + 1;
    if (sideText(x) === 'BUY') buys[t] = (buys[t] || 0) + 1;
  }
  shown.slice(0, MAX_ITEMS).forEach((x, i) => {
    const name = cleanText(x.ticker, 8) || cleanText(x.description, 40);
    items.push({key: `trade:${i + 1}`, label: 'Disclosed trade', value: cleanText(`${x.representative}, ${sideText(x)} ${name}, ${x.amount}, filed ${x.filed}`), unit: 'text', asof});
  });
  for (const [t, n] of Object.entries(buys)) items.push({key: `count:buys:${t}`, label: `Disclosed buys of ${t}`, value: n, unit: 'count', asof});
  const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, 5);
  return {evidence: [evidence('disclosures', SOURCE, {asof, items, tickers: top})]};
}
