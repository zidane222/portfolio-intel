// Disclosures module: the daily trades file built by the GitHub Actions job.
import {json, grab, memGet, memSet, readCapped} from '../lib/http.js';

const TRADES_JSON = 'https://raw.githubusercontent.com/zidane222/portfolio-intel/main/trades.json';
// Corporate insider purchases (SEC Form 4, open-market buys), built daily by scripts/smart_money.py.
const INSIDERS_JSON = 'https://raw.githubusercontent.com/zidane222/portfolio-intel/main/insiders.json';

export async function allTrades() {
  let d = memGet('trades');
  if (!d) {
    d = await grab(TRADES_JSON, {timeout: 10000});
    if (d) memSet('trades', d, 300);
  }
  if (!d) return json({trades: [], house_count: 0, senate_count: 0, updated: null});
  return json({trades: (d.trades || []).slice(0, 150), house_count: d.house_count || 0, senate_count: d.senate_count || 0, updated: d.updated || null});
}

const INSIDERS_MAX_BYTES = 2 * 1024 * 1024; // the file is about 250 KB

async function fetchInsiders() {
  try {
    const r = await fetch(INSIDERS_JSON, {redirect: 'manual', signal: AbortSignal.timeout(10000), headers: {Accept: 'application/json'}});
    if (!r.ok || r.type === 'opaqueredirect') return null;
    if (Number(r.headers.get('Content-Length') || 0) > INSIDERS_MAX_BYTES) return null;
    const text = await readCapped(r.body, INSIDERS_MAX_BYTES);
    return text === null ? null : JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// Insider buys only. The file's "seen" index of processed filings is internal and not returned.
export async function insiderBuys() {
  let d = memGet('insiders');
  if (!d) {
    d = await fetchInsiders();
    if (d) memSet('insiders', d, 300);
  }
  if (!d) return json({buys: [], updated: null});
  const buys = (Array.isArray(d.buys) ? d.buys : []).filter(b => b && typeof b === 'object').slice(0, 300);
  return json({buys, updated: d.updated || null});
}
