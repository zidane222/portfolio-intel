// Intent to data agents. This is the extension point for later supervisors (Research, Strategy,
// Insights): each adds entries here and keeps the same (case, deps) => patch shape.
// stage 2 agents run after stage 1 and can read stage 1 evidence (for example market tickers
// taken from the disclosures list). Agents never call each other.
import * as holdings from './data/holdings.js';
import * as market from './data/market.js';
import * as news from './data/news.js';
import * as disclosures from './data/disclosures.js';
import * as rates from './data/rates.js';
import * as privateAgent from './data/private.js';
import * as newsread from './data/newsread.js';
import * as insights from './data/insights.js';
import * as insiders from './data/insiders.js';

export const AGENTS = {holdings, market, news, disclosures, rates, private: privateAgent, newsread, insights, insiders};

const hasPortfolio = c => !!(c.input.portfolio && Array.isArray(c.input.portfolio.holdings) && c.input.portfolio.holdings.length);
const heldTickers = c => new Set((c.input.portfolio?.holdings || []).map(h => h.ticker));
const holdsAsked = c => hasPortfolio(c) && (c.intent?.tickers || []).some(t => heldTickers(c).has(t));

export const REGISTRY = {
  holdings: {agents: [['holdings', 1, hasPortfolio], ['market', 1, hasPortfolio]], needs: c => ['portfolio:total']},
  ticker: {agents: [['market', 1], ['news', 1], ['disclosures', 1], ['holdings', 1, holdsAsked]], needs: c => (c.intent?.tickers || []).map(t => 'price:' + t)},
  disclosures: {agents: [['disclosures', 1], ['holdings', 1, hasPortfolio], ['market', 2]], needs: c => []},
  rates: {agents: [['rates', 1], ['holdings', 1, hasPortfolio]], needs: c => []},
  private: {agents: [['private', 1]], needs: c => ['stats:count']},
  // Corporate insider buys (SEC Form 4), not Congress. The count is needed so an empty window says so.
  insiders: {agents: [['insiders', 1]], needs: c => ['insider:window']},
  news_read: {agents: [['newsread', 1]], needs: c => []},
  // Phase 4: weekly analysis and simulated backtests (pi-insights). Needs the lead keys the agent chose, so a missing value shows as unknown.
  insights: {agents: [['insights', 1]], needs: c => (c.evidence || []).filter(e => e.agent === 'insights').flatMap(e => e.wanted || [])},
  general: {agents: [], needs: c => []},
  out_of_scope: {agents: [], needs: c => []},
};

// The data agents to run for a case, grouped by stage.
export function plan(c) {
  const entry = REGISTRY[c.intent?.type] || REGISTRY.general;
  const stages = {};
  for (const [name, stage, when] of entry.agents) {
    if (when && !when(c)) continue;
    (stages[stage] = stages[stage] || []).push(name);
  }
  return Object.keys(stages).sort().map(k => stages[k]);
}

export const neededKeys = c => (REGISTRY[c.intent?.type] || REGISTRY.general).needs(c);
