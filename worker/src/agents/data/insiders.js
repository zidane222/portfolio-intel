// Insiders agent: corporate insider purchases (SEC Form 4 open-market buys by officers, directors
// and 10% owners), served by pi-disclosures from insiders.json. These are not trades by Congress.
// The filing window comes from the question ("this week" by default); "big" questions sort by value,
// which is always the order here. When the window is empty, the newest buys are shown and a fact says so.
import {bindingJSON, evidence, cleanText, TICKER_RE} from '../case.js';

export const SOURCE = 'SEC EDGAR Form 4';
const DAY = 86400000;
const MAX_ITEMS = 8;
// No single open-market insider purchase comes near this; a larger value is a parse or filing error
// (for example a price that is the share count over 1,000). Such rows are held back and noted.
export const MAX_PLAUSIBLE_USD = 1e9;

const ENTITIES = {'&amp;': '&', '&lt;': '', '&gt;': '', '&quot;': '"', '&#39;': "'", '&apos;': "'"};
const decode = s => String(s == null ? '' : s).replace(/&(?:amp|lt|gt|quot|#39|apos);/g, m => ENTITIES[m]);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Window start (YYYY-MM-DD, by filed date) and a label for it.
export function windowOf(question, now = Date.now()) {
  const q = String(question || '');
  const iso = t => new Date(t).toISOString().slice(0, 10);
  const d = new Date(now);
  if (/\btoday\b/i.test(q)) return {since: iso(now), label: 'today'};
  if (/\bthis month\b|\bmonth to date\b/i.test(q)) return {since: iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)), label: 'this month'};
  // Labels in words: the model copies labels into its draft, and a typed digit there fails V1
  if (/\b(?:past|last) (?:30 days|month)\b/i.test(q)) return {since: iso(now - 30 * DAY), label: 'in the past month'};
  if (/\b(?:past|last) (?:two|2) weeks\b/i.test(q)) return {since: iso(now - 14 * DAY), label: 'in the past fortnight'};
  return {since: iso(now - 7 * DAY), label: 'this past week'}; // "this week", "recent" and no period
}

// Joint filers (a fund and its manager, say) each report the same purchase. One row per purchase,
// with the owners named together.
export function mergeJoint(buys) {
  const out = new Map();
  for (const b of buys) {
    const k = [String(b.ticker).toUpperCase(), b.date, b.shares, b.price].join('|');
    const owner = decode(b.owner);
    const cur = out.get(k);
    if (!cur) out.set(k, {...b, owners: [owner]});
    else if (!cur.owners.includes(owner)) cur.owners.push(owner);
  }
  return [...out.values()];
}
const ownersText = o => (o.length <= 2 ? o.join(' and ') : `${o[0]}, ${o[1]} and other joint filers`);

export async function run(c, deps) {
  const d = await bindingJSON(deps, 'DISCLOSURES', '/api/insiders');
  const asof = d.updated || null;
  const tick = new Set(c.intent?.tickers || []);
  // "insider buying in my portfolio": the user's own tickers (sent from the device), not every filing
  if (!tick.size && /\bmy (?:portfolio|holdings|stocks|positions)\b/i.test(String(c.input?.question || '')))
    for (const h of c.input?.portfolio?.holdings || []) if (TICKER_RE.test(String(h.ticker || ''))) tick.add(String(h.ticker));
  let buys = (d.buys || []).filter(b => b && typeof b === 'object' && TICKER_RE.test(String(b.ticker || '').toUpperCase()) && num(b.value) > 0);
  if (tick.size) buys = buys.filter(b => tick.has(String(b.ticker).toUpperCase()));
  const win = windowOf(c.input?.question, typeof deps.now === 'function' ? deps.now() : Date.now());
  const inWin = b => String(b.filed || '') >= win.since;
  const heldBack = buys.filter(b => num(b.value) > MAX_PLAUSIBLE_USD && inWin(b)).length;
  buys = mergeJoint(buys.filter(b => num(b.value) <= MAX_PLAUSIBLE_USD));

  let shown = buys.filter(inWin);
  const items = [{key: 'insider:scope', label: 'What this data covers', value: tick.size && /\bmy (?:portfolio|holdings|stocks|positions)\b/i.test(String(c.input?.question || ''))
    ? 'Open-market purchases by company insiders in the stocks you hold, from SEC filings. Sales are not included'
    : 'Open-market purchases by company insiders from SEC filings. Sales are not included', unit: 'text', asof}];
  if (!shown.length && buys.length) {
    shown = [...buys].sort((a, b) => String(b.filed || '').localeCompare(String(a.filed || ''))).slice(0, MAX_ITEMS);
    items.push({key: 'insider:window', label: 'Filing window', value: `No insider buys were filed ${win.label}; showing the newest filed instead`, unit: 'text', asof});
  } else {
    items.push({key: 'insider:window', label: 'Filing window', value: `Insider buys filed ${win.label}`, unit: 'text', asof});
    items.push({key: 'count:insider_buys', label: `Insider buys filed ${win.label}`, value: shown.length, unit: 'count', asof});
  }
  if (heldBack) items.push({key: 'insider:held_back', label: 'Filings held back', value: `Left out ${heldBack === 1 ? 'one filing' : 'some filings'} whose reported value looks like a data error`, unit: 'text', asof});

  shown = [...shown].sort((a, b) => num(b.value) - num(a.value)).slice(0, MAX_ITEMS);
  shown.forEach((b, i) => {
    const t = String(b.ticker).toUpperCase();
    const who = cleanText(ownersText(b.owners || [decode(b.owner)]), 90), role = cleanText(decode(b.role), 40);
    items.push({key: `insider:${i + 1}`, label: `Insider buy ${t}`, value: cleanText(`${t} (${cleanText(decode(b.company), 50)}), bought by ${who}${role ? ', ' + role : ''}, filed ${cleanText(b.filed, 10)}`, 200), unit: 'text', asof});
    items.push({key: `insider:${i + 1}:value`, label: `Value of ${t} insider buy`, value: num(b.value), unit: 'usd', asof});
    if (num(b.shares) > 0) items.push({key: `insider:${i + 1}:shares`, label: `Shares in ${t} insider buy`, value: num(b.shares), unit: 'shares', asof});
  });
  const tickers = [...new Set(shown.map(b => String(b.ticker).toUpperCase()))].slice(0, 5);
  return {evidence: [evidence('insiders', SOURCE, {asof, url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4', items, tickers})]};
}
