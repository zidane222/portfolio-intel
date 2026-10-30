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
const FINANCE = /\b(insiders?|stock|stocks|share|shares|etf|fund|portfolio|invest|investing|investment|market|markets|price|dividend|yield|apy|savings|cash|bond|bonds|rate|rates|interest|congress|senator|trade|trades|ticker|holding|holdings|allocation|diversif\w*|return|returns|crypto|bitcoin|money|finance|financial|budget|retire\w*|401k|ira|roth|startup|raise|raises|funding|seed|series|sec|filing|filings|app|dashboard|p\/e|earnings|valuation)\b/i;
const OUT_HIGH = /\b(poem|poetry|song|lyrics|joke|recipe|haiku|limerick|essay|bedtime story|short story|love letter|horoscope|homework|translate)\b/i;

// news_read: matched by rules only (with a ticker), so the Groq intent call is skipped (plan D15).
export const NEWS_READ_RE = /\bnews read\b|\bbull(?:ish)? (?:and|or|vs\.?|versus) bear(?:ish)?\b|\bbear(?:ish)? (?:and|or|vs\.?|versus) bull(?:ish)?\b|\b(?:bull|bear) case\b|\bcase (?:for|against)\b|\bwhat(?: is|'s) the news saying\b|\bwhat does the news say\b/i;

// insights: weekly analysis of disclosed trades and simulated strategy backtests. Rules only (no Groq call #1 when it matches).
// Plain phrases only: a bare "strategy" or "beat the market" stays a general question.
export const INSIGHTS_RE = new RegExp([
  String.raw`\bback-?test\w*`,
  String.raw`\bcopy(?:ing)?[- ](?:congress\w*|senators?|the senate|the house|house members?|politicians?|lawmakers?|pelosi)\b`,
  String.raw`\b(?:congress(?:ional)?|senate|senators?|politicians?|lawmakers?|copy)[- ](?:trading[- ])?strateg(?:y|ies)\b`,
  String.raw`\b(?:congress\w*|senat\w*|politicians?|lawmakers?|representatives?|house members?|pelosi)\b.{0,50}\b(?:beat|beats|beating|outperform\w*|underperform\w*)\b`,
  String.raw`\b(?:beat|beats|beating|outperform\w*)\b.{0,50}\b(?:congress\w*|senat\w*|politicians?|lawmakers?)\b`,
  String.raw`\b(?:congress\w*|senat\w*|politicians?|lawmakers?|house members?)\b.{0,50}\b(?:vs\.?|versus|against|compared (?:to|with))\b.{0,20}\b(?:spy|s&p|the market|the index)\b`,
  String.raw`\b(?:copy-senate-buys|copy-house-buys|copy-top-members|momentum-sectors|dividend-basket|tbill-proxy|balanced-(?:annual|never|band))\b`,
  String.raw`\b(?:filing|disclosure|reporting) delays?\b`,
  String.raw`\b60\/40 (?:strategy|backtest|portfolio rebalanc\w*)`,
  String.raw`\b(?:weekly analysis|insights page|data science)\b`,
].join('|'), 'i');

const KW = {
  private: /\b(pre-?seed|seed round|seed rounds|series a|series b|startup|startups|fund ?rais\w*|funding round|raises?|raised|form d|form c|crowdfund\w*|venture|private (market|companies|company|raise))/i,
  // Corporate insiders (SEC Form 4): officers, directors and 10% owners. Checked before Congress, so
  // "insider" questions never land on the PTR data. "Congress insider trading" still goes to disclosures.
  insiders: /\binsiders?\b|\bform 4s?\b|\b(?:ceos?|cfos?|executives?|directors?|officers?|10% owners?)\b.{0,30}\b(?:bought|buys?|buying|purchas\w*)\b|\b(?:bought|buys?|buying|purchas\w*)\b.{0,30}\bby (?:ceos?|cfos?|executives?|directors?|officers?|10% owners?)\b/i,
  // The insiders data is filings of purchases: route only questions asking for that activity.
  // Concept questions ("what is insider trading", "is it illegal") and selling go to Groq or general.
  insiderActivity: /\b(?:buys?|bought|buying|purchas\w*|filed|filings|recent(?:ly)?|latest|this (?:week|month)|today|any|biggest|largest|big|top)\b/i,
  insiderSelling: /\b(?:sell|sells|selling|sold|sales?|dump\w*)\b/i,
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

// Common startup cities, so "Austin raises" filters without a state in the question.
const CITIES = {austin: 'TX', houston: 'TX', dallas: 'TX', 'san antonio': 'TX', 'fort worth': 'TX', 'san francisco': 'CA', 'los angeles': 'CA',
  'san diego': 'CA', 'palo alto': 'CA', 'san jose': 'CA', boston: 'MA', cambridge: 'MA', seattle: 'WA', denver: 'CO', boulder: 'CO', miami: 'FL',
  atlanta: 'GA', chicago: 'IL', nashville: 'TN', 'salt lake city': 'UT', phoenix: 'AZ', portland: 'OR', 'new york': 'NY', brooklyn: 'NY', pittsburgh: 'PA', philadelphia: 'PA'};

// Topic words that are not SEC industry groups. Values are pi-private topic keys.
const TOPIC_WORDS = [[/\b(?:ai|a\.i\.|artificial intelligence|machine learning|ml|llms?|gen(?:erative)? ?ai)\b/i, 'ai'],
  [/\bfin-?tech\b|\bpayments?\b/i, 'fintech'], [/\bbio-?tech\w*|\bbiotechnology\b|\bpharma\w*/i, 'biotech'],
  [/\bhealth ?(?:care|tech)?\b|\bmedtech\b/i, 'health'], [/\b(?:clean ?tech|energy|climate ?tech|solar)\b/i, 'energy'], [/\b(?:crypto\w*|web3|blockchain)\b/i, 'crypto']];
export const topicOf = s => { const t = String(s || ''); for (const [re, k] of TOPIC_WORDS) if (re.test(t)) return k; return null; };
const TOPIC_KEYS = new Set(TOPIC_WORDS.map(x => x[1]));

// Filed-date window words. pi-private gets a since date computed from this (data/private.js).
export const PERIODS = ['this_month', '30d', '90d', 'this_year'];
function periodOf(q) {
  if (/\bthis month\b|\bmonth to date\b|\bmtd\b/i.test(q)) return 'this_month';
  if (/\b(?:past|last|1|one) month\b|\b30 days\b|\brecent(?:ly)?\b|\blatest\b/i.test(q)) return '30d';
  if (/\b(?:3|three|past|last) (?:months|quarter)\b|\bthis quarter\b|\b90 days\b/i.test(q)) return '90d';
  if (/\bthis year\b|\bytd\b/i.test(q)) return 'this_year';
  return null;
}

function rulesFilters(q) {
  const f = {state: null, city: null, stage: null, industry: null, form: null, q: null, topic: topicOf(q), period: periodOf(q)};
  const lower = q.toLowerCase();
  for (const [name, code] of Object.entries(CITIES)) if (new RegExp(`\\b${name}\\b`).test(lower)) { f.city = name; f.state = code; break; }
  if (!f.state) for (const [name, code] of Object.entries(STATE_NAMES)) if (new RegExp(`\\b${name}\\b`).test(lower)) { f.state = code; break; }
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
  else if (NEWS_READ_RE.test(q) && tickers.length) type = 'news_read';
  else if (INSIGHTS_RE.test(q)) type = 'insights';
  else if (KW.private.test(q)) type = 'private';
  else if (KW.insiders.test(q) && KW.insiderActivity.test(q) && !KW.insiderSelling.test(q) && !KW.disclosures.test(q)) type = 'insiders';
  else if (KW.disclosures.test(q)) type = 'disclosures';
  else if (KW.rates.test(q)) type = 'rates';
  else if (tickers.length) type = 'ticker';
  else if (KW.holdings.test(q)) type = 'holdings';
  else if (!FINANCE.test(q) && !KW.general.test(q)) type = 'out_of_scope';
  const heldSet = new Set(held);
  return {
    type,
    tickers: type === 'private' || type === 'out_of_scope' || type === 'insights' ? [] : type === 'news_read' ? tickers.slice(0, 1) : tickers,
    people: type === 'disclosures' ? rulesPeople(q) : [],
    private_filters: type === 'private' ? rulesFilters(q) : emptyFilters(),
    range: rulesRange(q),
    needs_portfolio: type === 'holdings' || type === 'rates' || tickers.some(t => heldSet.has(t)),
    confidence: type === 'out_of_scope' && clearlyOutOfScope(q) ? 0.95 : ['news_read', 'insights', 'insiders'].includes(type) ? 0.9 : 0.6,
    via: 'rules',
  };
}

const emptyFilters = () => ({state: null, city: null, stage: null, industry: null, form: null, q: null, topic: null, period: null});
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
    city: str(pf.city, 40)?.replace(/,\s*[A-Za-z]{2}$/, '') || null,
    stage: STAGES.includes(pf.stage) ? pf.stage : null,
    industry: str(pf.industry, 60),
    form: pf.form === 'D' || pf.form === 'C' ? pf.form : null,
    q: str(pf.q, 60),
    topic: TOPIC_KEYS.has(pf.topic) ? pf.topic : null,
    period: PERIODS.includes(pf.period) ? pf.period : null,
  };
  // A topic word in industry or q ("AI", "fintech") is not an SEC industry or a company name:
  // it becomes a topic filter. Topic and period from the question rules fill gaps Groq left.
  const rf = rules.private_filters || {};
  for (const k of ['industry', 'q']) { const tp = topicOf(filters[k]); if (tp) { filters.topic = filters.topic || tp; filters[k] = null; } }
  if (filters.q && filters.city && filters.q.toLowerCase() === filters.city.toLowerCase()) filters.q = null;
  filters.topic = filters.topic || rf.topic || null;
  filters.period = filters.period || rf.period || null;
  if (!filters.city && rf.city) { filters.city = rf.city; filters.state = filters.state || rf.state; }
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

export const isNewsRead = (q, held = []) => rulesIntent(q, held).type === 'news_read';

export async function run(c, deps) {
  const held = (c.input.portfolio?.holdings || []).map(h => h.ticker).filter(t => TICKER_RE.test(t));
  const rules = rulesIntent(c.input.question, held);
  if (['news_read', 'insights', 'insiders'].includes(rules.type)) return {intent: rules}; // rules pre-pass: no Groq call #1
  try {
    const out = await deps.ai('/internal/intent', {question: c.input.question, history: c.input.history.slice(-2), tickers: held}, 5000);
    return {intent: normalizeIntent(out && out.intent, rules, held)};
  } catch (e) {
    return {intent: rules};
  }
}
