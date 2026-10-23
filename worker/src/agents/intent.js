// Intent agent: rules pre-pass, then Groq call #1 through pi-ai /internal/intent.
// Falls back to the rules result when Groq fails, times out or returns invalid JSON.
import {INTENT_TYPES, TICKER_RE} from './case.js';

export const STAGES = ['Pre-seed / seed', 'Seed / Series A', 'Growth', 'Late stage', 'Undisclosed'];
export const RANGES = ['1mo', '3mo', '1y'];
const STATE_NAMES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'puerto rico': 'PR',
};
export const STATES = new Set(Object.values(STATE_NAMES));
const STOP = new Set(['I', 'A', 'AI', 'AM', 'AN', 'AND', 'ARE', 'AS', 'AT', 'BE', 'BUY', 'BY', 'CD', 'CDS', 'CEO', 'CFO', 'DO', 'ETF', 'ETFS', 'FOR',
  'GDP', 'HOW', 'HYSA', 'IF', 'IN', 'IPO', 'IRA', 'IS', 'IT', 'ME', 'MY', 'NO', 'NOT', 'OF', 'OK', 'ON', 'OR', 'PE', 'PTR', 'SEC', 'SELL', 'SO',
  'THE', 'TO', 'UP', 'US', 'USA', 'USD', 'VS', 'WE', 'WHAT', 'WHO', 'WHY', 'APY', 'YTD', 'EPS', 'FAQ', 'FED', 'API', 'LLC', 'INC', 'Q', 'TX', 'NY', 'CA',
  'FORM', 'D', 'C', 'DCA', 'ROI', 'ROTH', 'K', 'S', 'P', 'EU', 'UK']);
const FINANCE = /\b(stock|stocks|share|shares|etf|fund|portfolio|invest|investing|investment|market|markets|price|dividend|yield|apy|savings|cash|bond|bonds|rate|rates|interest|congress|senator|trade|trades|ticker|holding|holdings|allocation|diversif\w*|return|returns|crypto|bitcoin|money|finance|financial|budget|retire\w*|401k|ira|roth|startup|raise|raises|funding|seed|series|sec|filing|filings|app|dashboard|p\/e|earnings|valuation)\b/i;
const OUT_HIGH = /\b(poem|poetry|song|lyrics|joke|recipe|haiku|limerick|essay|bedtime story|short story|love letter|horoscope|homework|translate)\b/i;

const KW = {
  private: /\b(pre-?seed|seed round|seed rounds|series a|series b|startup|startups|fund ?rais\w*|funding round|raises?|raised|form d|form c|crowdfund\w*|venture|private (market|companies|company|raise))/i,
  disclosures: /\b(congress\w*|senator|senators|senate|house member|representative|politician\w*|pelosi|ptr|disclos\w*|lawmaker\w*)/i,
  rates: /\b(savings|high[- ]yield|hysa|apy|money market|interest rate|cash (yield|earn|options?)|where should my cash|earn more on (my )?cash|cd rates?)\b/i,
  holdings: /\b(my portfolio|my holdings|my stocks|my positions|diversif\w*|my allocation|allocation|rebalanc\w*|am i|my gains?|my losses?|my income|largest holding|biggest holding|concentrat\w*)\b/i,
  general: /\b(what is|what are|what's|explain|how does|how do|define|meaning of|difference between)\b/i,
};

export function extractTickers(question, held = []) {
  const heldSet = new Set(held);
  const out = [];
  for (const m of String(question).matchAll(/(\$)?\b([A-Z]{1,5}(?:\.[A-Z])?)\b/g)) {
    const t = m[2];
    if (!TICKER_RE.test(t)) continue;
    if (m[1] || heldSet.has(t) || (!STOP.has(t) && t.length >= 2)) if (!out.includes(t)) out.push(t);
  }
  return out.slice(0, 5);
}

function rulesFilters(q) {
  const f = {state: null, city: null, stage: null, industry: null, form: null, q: null};
  const lower = q.toLowerCase();
  for (const [name, code] of Object.entries(STATE_NAMES)) if (new RegExp(`\\b${name}\\b`).test(lower)) { f.state = code; break; }
  if (!f.state) { const m = q.match(/\b([A-Z]{2})\b/g); const s = (m || []).find(x => STATES.has(x)); if (s) f.state = s; }
  if (/pre-?seed/i.test(q)) f.stage = 'Pre-seed / seed';
  else if (/\bseed\b|series a\b/i.test(q)) f.stage = 'Seed / Series A';
  else if (/\bgrowth\b/i.test(q)) f.stage = 'Growth';
  else if (/late[- ]stage/i.test(q)) f.stage = 'Late stage';
  if (/form c\b|crowdfund/i.test(q)) f.form = 'C'; else if (/form d\b/i.test(q)) f.form = 'D';
  return f;
}

function rulesRange(q) {
  if (/\b(this|past|last|1|one) month\b|\b30 days\b/i.test(q)) return '1mo';
  if (/\b(3|three) months\b|\bquarter\b|\b90 days\b/i.test(q)) return '3mo';
  if (/\b(this|past|last|1|one) year\b|\b12 months\b|\bytd\b|\b1y\b/i.test(q)) return '1y';
  return null;
}

function rulesPeople(q) {
  const skip = new Set(['What', 'How', 'Who', 'Why', 'Which', 'When', 'Is', 'Are', 'Did', 'Does', 'Show', 'Tell', 'Congress', 'Senate', 'Senator',
    'House', 'Representative', 'Rep', 'The', 'I', 'My', 'Any', 'Recent', 'Latest', 'Has', 'Have', 'Can', 'Trades', 'Trade', 'Buying', 'Selling']);
  return [...new Set((String(q).match(/\b[A-Z][a-z]{2,20}\b/g) || []).filter(w => !skip.has(w)))].slice(0, 3);
}

// Very high confidence out of scope only (the supervisor then skips the Groq intent call).
export const clearlyOutOfScope = q => OUT_HIGH.test(q) && !FINANCE.test(q);

export function rulesIntent(question, held = []) {
  const q = String(question || '');
  const tickers = extractTickers(q, held);
  let type = 'general';
  if (clearlyOutOfScope(q)) type = 'out_of_scope';
  else if (KW.private.test(q)) type = 'private';
  else if (KW.disclosures.test(q)) type = 'disclosures';
  else if (KW.rates.test(q)) type = 'rates';
  else if (tickers.length) type = 'ticker';
  else if (KW.holdings.test(q)) type = 'holdings';
  else if (!FINANCE.test(q) && !KW.general.test(q)) type = 'out_of_scope';
  const heldSet = new Set(held);
  return {
    type,
    tickers: type === 'private' || type === 'out_of_scope' ? [] : tickers,
    people: type === 'disclosures' ? rulesPeople(q) : [],
    private_filters: type === 'private' ? rulesFilters(q) : emptyFilters(),
    range: rulesRange(q),
    needs_portfolio: type === 'holdings' || type === 'rates' || tickers.some(t => heldSet.has(t)),
    confidence: type === 'out_of_scope' && clearlyOutOfScope(q) ? 0.95 : 0.6,
    via: 'rules',
  };
}

const emptyFilters = () => ({state: null, city: null, stage: null, industry: null, form: null, q: null});
const str = (v, n) => (typeof v === 'string' && v.trim() ? v.replace(/[<>`]/g, '').trim().slice(0, n) : null);

// Check Groq output against allowlists. Anything invalid falls back to the rules value.
export function normalizeIntent(raw, rules, held = []) {
  if (!raw || typeof raw !== 'object' || !INTENT_TYPES.includes(raw.type)) return rules;
  const tickers = [...new Set((Array.isArray(raw.tickers) ? raw.tickers : []).map(t => String(t).toUpperCase().replace(/^\$/, '')).filter(t => TICKER_RE.test(t) && !STOP.has(t)))].slice(0, 5);
  const people = (Array.isArray(raw.people) ? raw.people : []).map(p => str(p, 40)).filter(p => p && /^[A-Za-z .'-]+$/.test(p)).slice(0, 3);
  const pf = raw.private_filters && typeof raw.private_filters === 'object' ? raw.private_filters : {};
  const state = typeof pf.state === 'string' && STATES.has(pf.state.toUpperCase()) ? pf.state.toUpperCase() : null;
  const filters = {
    state,
    city: str(pf.city, 40),
    stage: STAGES.includes(pf.stage) ? pf.stage : null,
    industry: str(pf.industry, 60),
    form: pf.form === 'D' || pf.form === 'C' ? pf.form : null,
    q: str(pf.q, 60),
  };
  const conf = Number(raw.confidence);
  const heldSet = new Set(held);
  return {
    type: raw.type,
    tickers: raw.type === 'ticker' && !tickers.length ? rules.tickers : tickers,
    people,
    private_filters: raw.type === 'private' ? filters : emptyFilters(),
    range: RANGES.includes(raw.range) ? raw.range : null,
    needs_portfolio: typeof raw.needs_portfolio === 'boolean' ? raw.needs_portfolio : tickers.some(t => heldSet.has(t)),
    confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.5,
    via: 'groq',
  };
}

export async function run(c, deps) {
  const held = (c.input.portfolio?.holdings || []).map(h => h.ticker).filter(t => TICKER_RE.test(t));
  const rules = rulesIntent(c.input.question, held);
  try {
    const out = await deps.ai('/internal/intent', {question: c.input.question, history: c.input.history.slice(-2), tickers: held}, 5000);
    return {intent: normalizeIntent(out && out.intent, rules, held)};
  } catch (e) {
    return {intent: rules};
  }
}
