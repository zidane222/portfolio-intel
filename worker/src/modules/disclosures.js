// Disclosures module: the daily trades file built by the GitHub Actions job.
import {json, grab, memGet, memSet} from '../lib/http.js';

const TRADES_JSON = 'https://raw.githubusercontent.com/zidane222/portfolio-intel/main/trades.json';

export async function allTrades() {
  let d = memGet('trades');
  if (!d) {
    d = await grab(TRADES_JSON, {timeout: 10000});
    if (d) memSet('trades', d, 300);
  }
  if (!d) return json({trades: [], house_count: 0, senate_count: 0, updated: null});
  return json({trades: (d.trades || []).slice(0, 150), house_count: d.house_count || 0, senate_count: d.senate_count || 0, updated: d.updated || null});
}
