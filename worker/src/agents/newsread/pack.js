// Evidence pack (contract 6.1 pack). Pure code: cleans, drops old items, clusters syndicated
// copies (one story counts once), caps at 8 and gives stable ids e1..e8, newest first.
import {cleanText, TICKER_RE} from '../case.js';
import {tone} from './lexicon.js';

export const WINDOW_DAYS = 7;
export const MAX_ITEMS = 8;
const DAY = 86400000;

// Headline text is attacker controlled. Fold look-alike characters, drop zero-width and other
// format characters, URLs and anything that could break the <headlines> tag or the [[eN]] cites.
export function cleanTitle(s) {
  const t = String(s == null ? '' : s).normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[–—]/g, ',')
    .replace(/\bhttps?:\/\/\S+/gi, ' ').replace(/\bwww\.\S+/gi, ' ').replace(/\|/g, ' ');
  return cleanText(t, 160);
}
// What the model sees. The safety rules ban typed figures (V1, V1b) and rating words (V19) in its
// text, and headlines are full of both ("raises price target to $200", "shares jump 8%"). The
// model copies what it reads, so figures and rating phrases are replaced with plain words here.
// Only the model's copy changes: the stored pack, sources shown to the user and checks keep the real title.
const NUM = String.raw`(?<![A-Za-z])[$€£]?\d+(?:[.,]\d+)*(?:\s*(?:%|percent|pct|bps|basis points|[kmbt]n?\b|thousand|million|billion|trillion))?`;
const INDEX_KEEP = /\b(?:S&P\s*500|S&P\s*400|S&P\s*600|Russell\s*(?:1000|2000|3000)|Nasdaq(?:-|\s)100|Dow\s*30|FTSE\s*100|Nikkei\s*225)\b/gi;
const VERB = {buy: 'acquire', buys: 'acquires', buying: 'acquiring', sell: 'shed', sells: 'sheds', selling: 'shedding', hold: 'keep', holds: 'keeps', holding: 'position'};
const YEAR = /^(?:19|20)\d{2}$/;
const RATING_SWAPS = [
  [/\b(?:Q[1-4]|[1-4]Q)\b/g, 'quarterly'], [/\b(?:H[12]|[12]H)\b/g, 'half-year'],
  [/\b(an?)\s+(?:buy|sell|hold)\b/gi, '$1 rating'],
  [/\bprice targets?\b/gi, 'analyst forecast'], [/\bPTs?\b/g, 'analyst forecast'],
  [/\bupside\b/gi, 'room to rise'], [/\bdownside\b/gi, 'room to fall'],
  [/\b(?:strong\s+)?(?:buy|sell|hold|overweight|underweight|outperform|underperform|neutral|equal[- ]weight)\s+(?:rating|call)\b/gi, 'rating'],
  // Analyst ratings are written capitalized ("upgrades to Buy"); lowercase buy/sell/hold are verbs.
  [/\b(to|at|as|a|an|reiterates?|reiterated|maintains?|maintained|keeps?|kept)\s+(?:Strong\s+)?(?:Buy|Sell|Hold|BUY|SELL|HOLD)\b/g, '$1 rating'],
  [/\b(?:buy|sell|hold)(?:s|ing)?\b/gi, m => VERB[m.toLowerCase()]],
  [/\b(?:overweight|underweight|outperform\w*|underperform\w*|accumulat\w*)\b/gi, 'rating'],
  [/\b(?:bullish|bearish)\b/gi, 'notable'],
];
const WORD_SWAPS = [
  [/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|hundred|thousand|million|billion|trillion)s?\b/gi, 'some'],
  [/[%$€£#]/g, ' '],
  [/\b(?:some\s+){2,}/gi, 'some '],
];
const MARK = i => `${String.fromCharCode(65 + i)}`;
const protect = s => { const keep = []; return {s: String(s || '').replace(INDEX_KEEP, m => MARK(keep.push(m) - 1)), keep}; };
const restore = (s, keep) => s.replace(/([A-Z])/g, (_, c) => keep[c.charCodeAt(0) - 65]);

// Figures in a headline ("$200", "8%", "$53 billion"), in order. Years and index names are not figures.
export function headlineFigures(title) {
  const {s, keep} = protect(title);
  return [...s.matchAll(new RegExp(NUM, 'g'))].map(m => restore(m[0].trim(), keep)).filter(f => !YEAR.test(f));
}

// figures: [{id: 'h1', text: '$200'}, ...] for this headline. Each figure is shown to the model as
// its [[hN]] id, which code later swaps back for the exact text, so the model never types a figure.
export function modelTitle(title, figures = []) {
  const {s: p, keep} = protect(title);
  let k = 0;
  let s = p.replace(new RegExp(NUM, 'g'), m => {
    if (YEAR.test(m.trim())) return m;
    const f = figures[k++];
    return f ? ` [[${f.id}]] ` : 'some';
  });
  for (const [re, rep] of RATING_SWAPS) s = s.replace(re, rep);
  // Words of a figure that stay outside its id (a trailing "billion") would read as typed numbers
  s = s.replace(/\[\[(h\d{1,2})\]\]/g, '$1');
  for (const [re, rep] of WORD_SWAPS) s = s.replace(re, rep);
  s = restore(s, keep).replace(/(h\d{1,2})/g, '[[$1]]');
  return s.replace(/\s+([,.;:!?])/g, '$1').replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
}
const cleanSource = s => cleanTitle(s).replace(/[^\w &.'/-]/g, '').trim().slice(0, 40) || 'Unknown';
const key = t => new Set(String(t).toLowerCase().match(/[a-z0-9]+/g) || []);
function similar(a, b) {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 && inter / union >= 0.6;
}

export function buildPack(ticker, headlines, now = Date.now()) {
  const t = String(ticker || '').toUpperCase();
  if (!TICKER_RE.test(t)) throw new Error('bad ticker');
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
  const rows = [];
  for (const h of Array.isArray(headlines) ? headlines : []) {
    if (!h || typeof h !== 'object') continue;
    const title = cleanTitle(h.title);
    if (title.length < 8) continue;
    const when = new Date(h.published || h.date || '').getTime();
    if (!Number.isFinite(when) || when < nowMs - WINDOW_DAYS * DAY || when > nowMs + DAY) continue;
    const link = String(h.link || h.url || '');
    const source = cleanSource(h.source);
    rows.push({title, source, when, url: /^https:\/\/[^\s<>"']+$/.test(link) ? link.slice(0, 500) : null,
      social: h.social === true || /^r\//i.test(source)});
  }
  rows.sort((a, b) => b.when - a.when);
  const clusters = [];
  const items = [];
  let figN = 0;
  for (const r of rows) {
    const k = key(r.title);
    if (clusters.some(c => similar(c, k))) continue; // syndicated copy of a story already in the pack
    clusters.push(k);
    const figures = headlineFigures(r.title).slice(0, 4).map(text => ({id: `h${++figN}`, text: text.slice(0, 24)}));
    items.push({id: `e${items.length + 1}`, title: r.title, source: r.source, date: new Date(r.when).toISOString().slice(0, 10),
      url: r.url, tone: tone(r.title), cluster: clusters.length, social: r.social, figures});
    if (items.length >= MAX_ITEMS) break;
  }
  return {ticker: t, asof: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z'), window_days: WINDOW_DAYS, items};
}
