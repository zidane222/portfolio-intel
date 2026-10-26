// Validator: rule-based and independent of the builder (imports nothing from builder.js).
// Number rules V1 and V1b run on the raw draft only; V4 to V11 run on the draft and the rendered text. FLAG when any rule other than V12 fires.
import {DISCLAIMER, PLACEHOLDER} from './render.js';

const ADVICE = [
  /you should (buy|sell|short|move|put|invest)/i,
  /\bI (recommend|suggest) (buying|selling)/i,
  /\b(buy|sell)( \$?[A-Za-z.]{1,6})? now\b/i, // also "buy NVDA now" (plan 15.20)
  /best stock for you/i,
  /allocate \d+(\.\d+)?\s?% to/i,
];
const GUARANTEE = [/guarantee(d)?/i, /risk[- ]free return/i, /can'?t lose/i, /\bsure thing\b/i, /will (definitely|certainly) (rise|go up|double)/i, /100\s?% (safe|certain)/i];
const PII = [
  ['SSN', /\b\d{3}-\d{2}-\d{4}\b/],
  ['account number', /\b\d{8,17}\b/],
  ['email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ['phone', /(?:\+?1[ .-]?)?\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/],
  ['routing number', /routing (number|no\.?)\s*:?\s*\d/i],
];
const ORDER = [/place (an|the) order/i, /\bI (bought|sold|executed)\b/i];
const ECHO = [/system prompt/i, /ignore (all|previous) instructions/i, /"value_display"/, /\{\s*"id"\s*:\s*"f\d+"/];
const UNKNOWN_WORDS = /unknown|not available|sources disagree/i;

// Checks run on a normalized copy: NFKC folds full-width, math, superscript and circled digits
// to ASCII, and format characters (zero-width, soft hyphen, word joiner) are removed so they
// cannot split words or numbers. Any digit left outside ASCII (Arabic-Indic, Devanagari, ...)
// and any vulgar fraction or roman numeral sign is a typed number.
const norm = s => String(s).normalize('NFKC').replace(/\p{Cf}/gu, '');

const sentences = s => String(s).split(/(?<=[.!?])\s+|\n+/);

// V1 (L3): numbers reach the answer only through [[fN]] placeholders. Checked on the draft with
// placeholders removed, so digits inside rendered facts never count. Typed digits are allowed
// only as 4-digit years 1900 to 2099 and as list numbering (1. or 1) at the start of a line).
// Index and account names that contain digits but state no quantity ("VOO tracks the S&P 500").
// A name followed by a unit ("S&P 500 points", "Dow 30-point") is a quantity, not a name. Bare
// "401k" counts as the account only after a possessive ("your 401k"); "worth 401k" is an amount.
const NOT_QTY = String.raw`(?![-\s]*(?:points?|pts|percent|per\s*cent|%|x\b|times|fold|k\b|thousand|million))`;
const INDEX_NAMES = new RegExp(String.raw`(?:\bS&P\s?(?:500|400|600|1500)\b|\bNasdaq[- ]100\b|\bRussell\s(?:1000|2000|3000)\b|\bDow\s(?:Jones\s)?30\b|\b401\s?\(k\)|(?<=\b(?:your|my|our|their|his|her|a|the)\s)401\s?k\b|\b529\s(?:plan|account)s?\b)` + NOT_QTY, 'gi');
function strayNumbers(text) {
  const bad = [];
  const n = norm(text).replace(PLACEHOLDER, ' ').replace(INDEX_NAMES, ' ');
  for (const ch of String(text) + n) if (ch > '\x7F' && /\p{N}/u.test(ch)) bad.push(ch);
  for (const line of n.split('\n')) {
    const body = line.replace(/^\s*\d{1,2}[.)]\s/, '');
    for (const t of body.match(/\d+(?:[.,]\d+)*/g) || []) {
      if (/^(19|20)\d{2}$/.test(t)) continue;
      bad.push(t);
    }
  }
  return bad;
}

// V1b: number words, multipliers and percent or dollar signs typed as quantities. The draft is
// checked with each placeholder replaced by a marker, so "[[f3]] percent" is fine and text from
// facts never reaches this check. Choices to avoid false positives:
//   "one" only counts before a unit word ("one share", "one million"), never as a pronoun
//   ("one of", "no one", "this one"); "half" is allowed in "first/second half" and "half-year";
//   "double" is allowed in "double-check" and "double-edged"; "zero" in "zero-coupon".
const PH = '\u0001';
const UNIT = '(?:shares?|dollars?|cents?|percent|per\\s+cent|points?|basis|hundred|thousand|million|billion|trillion|dozen|times|years?|months?|figures?)';
// Count words zero to twenty are fine as a count of things ("three ETFs", "two of your holdings",
// "one gold fund"): a noun from COUNTED must follow within two words, or "of" plus a determiner.
// Anything else ("roughly zero", "another seven", "two this year", "five thousand dollars",
// "twenty-five", "one share") is a typed quantity. Tens above twenty are always flagged.
const SMALL = 'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty';
const COUNTED = '(?:etfs?|funds?|holdings?|positions?|stocks?|assets?|classes|class|categories|category|sectors?|companies|company|tickers?|accounts?|types?|kinds?|'
  + 'investments?|securities|security|bonds?|raises?|filings?|startups?|sources?|things?|ways?|options?|areas?|groups?|parts?|regions?|countries|markets?|deposits?|'
  + 'items?|factors?|risks?|buckets?|pieces?|names?|indexes|indices|index|vehicles?|products?|members?|trades?|rounds?|states?|cities|city|industries|industry|questions?|points\\s+to)';
const LINK = '(?:[a-z&]+[- ]){0,2}';
const COUNT_OK = new RegExp(`^(?:\\s+${LINK}${COUNTED}\\b|\\s+of\\s+(?:your|the|these|those|them|its|my|our|it|which|all)\\b)`, 'i');
const QTY_AFTER = new RegExp(`^(?:-|\\s+${UNIT}\\b|\\s+(?:x|fold)\\b|-?fold\\b)`, 'i');
const COUNT_RE = new RegExp(`\\b(?:${SMALL})\\b`, 'gi');
const NUMBER_WORDS = [
  /\b(?:thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/i,
  /\b(?:hundreds?|thousands?|millions?|billions?|trillions?|dozens?)\b/i,
  /\b(?:twice|thrice|tripled?|triples|quadrupled?|quadruples|doubled|doubles)\b/i,
  /\bdouble\b(?![- ](?:check|checked|checking|edged|digit))/i,
  /(?<!\b(?:first|second|back|front)\s)\bhalf\b(?![- ]?years?\b)/i,
  /\b(?:[0-9]+|x|n)\s*times\b/i,
  /\b[a-z]+-?fold\b/i,
  /\b(?:one|a)[- ](?:third|quarter|fifth|tenth)s?\b/i,
];
const PCT_WORD = /(\S*)\s*\b(?:percent(?:age points?)?|per\s+cent|basis\s+points?|bps)\b/gi;
function countWords(s) {
  const hits = [];
  for (const m of s.matchAll(COUNT_RE)) {
    const w = m[0].toLowerCase();
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 80);
    const before = s.slice(Math.max(0, m.index - 12), m.index);
    if (/zero$/.test(w) && /^-coupon/i.test(after)) continue;
    if (w === 'one' && !QTY_AFTER.test(after)) continue; // pronoun or "one fund": only a unit after makes it a quantity
    if (/[-]$/.test(before) || QTY_AFTER.test(after) || !COUNT_OK.test(after)) hits.push(w);
  }
  return hits;
}
function numberWords(text) {
  const s = norm(text).replace(PLACEHOLDER, PH);
  const hits = countWords(s);
  for (const re of NUMBER_WORDS) { const m = s.match(re); if (m) hits.push(m[0].trim().toLowerCase()); }
  for (const m of s.matchAll(PCT_WORD)) if (!m[1].endsWith(PH)) hits.push(m[0].trim().toLowerCase());
  if (/[%$]/.test(s)) hits.push('% or $ outside a placeholder');
  return hits;
}

// Rules V4 to V11 on one piece of text. Used for drafts, rendered text and the safe answer.
export function safetyFlags(text, {rendered = false} = {}) {
  const raw = String(text || '');
  const s = norm(raw);
  const flags = [];
  for (const re of ADVICE) if (re.test(s)) { flags.push({rule: 'V4', detail: 'personalized advice wording'}); break; }
  for (const re of GUARANTEE) if (re.test(s)) { flags.push({rule: 'V5', detail: 'guaranteed return wording'}); break; }
  for (const [name, re] of PII) if (re.test(s)) { flags.push({rule: 'V6', detail: name}); break; }
  if (rendered && !s.includes(DISCLAIMER)) flags.push({rule: 'V7', detail: 'disclaimer missing'});
  for (const re of ORDER) if (re.test(s)) { flags.push({rule: 'V8', detail: 'order wording'}); break; }
  for (const re of ECHO) if (re.test(s)) { flags.push({rule: 'V9', detail: 'echoed instructions or data'}); break; }
  if (/[\u2013\u2014]/.test(raw)) flags.push({rule: 'V10', detail: 'em or en dash'});
  const body = rendered ? raw.replace(DISCLAIMER, '') : raw;
  if (!body.trim() || body.length > (rendered ? 1600 : 1200) || /^\s{0,3}#{1,6}\s/m.test(s)) flags.push({rule: 'V11', detail: 'empty, too long or markdown header'});
  return flags;
}

export const lineSafe = line => safetyFlags(line).length === 0;

// Full check of a draft. draft = {text, used}. Returns {status, flags, warnings}.
export function validate({draft, facts = [], question = '', rendered = null}) {
  const text = String(draft && draft.text || '');
  const byId = new Map(facts.map(f => [f.id, f]));
  const flags = [];
  const warnings = [];
  const stray = strayNumbers(text);
  if (stray.length) flags.push({rule: 'V1', detail: `${stray.length} typed number(s)`});
  const words = numberWords(text);
  if (words.length) flags.push({rule: 'V1b', detail: `${words.length} number word(s) or sign(s) outside placeholders`});
  const ids = [...text.matchAll(PLACEHOLDER)].map(m => m[1]);
  const missing = ids.filter(id => !byId.has(id));
  if (missing.length) flags.push({rule: 'V2', detail: `unknown placeholder ${missing[0]}`});
  for (const sent of sentences(text)) {
    for (const m of sent.matchAll(PLACEHOLDER)) {
      const f = byId.get(m[1]);
      if (f && f.status !== 'verified' && !UNKNOWN_WORDS.test(sent)) { flags.push({rule: 'V3', detail: `${m[1]} is ${f.status}`}); break; }
    }
    if (flags.some(f => f.rule === 'V3')) break;
  }
  flags.push(...safetyFlags(text));
  if (rendered !== null) {
    const r = rendered;
    for (const f of safetyFlags(r, {rendered: true})) if (!flags.some(x => x.rule === f.rule)) flags.push(f);
  }
  const usedMissing = (draft && Array.isArray(draft.used) ? draft.used : []).filter(id => !ids.includes(id));
  if (usedMissing.length) warnings.push({rule: 'V12', detail: `${usedMissing.length} used id(s) not in text`});
  return {status: flags.length ? 'FLAG' : 'PASS', flags, warnings};
}

// The code-only answers (safe and out of scope) must pass V4 to V11.
export function validateFinal(text) {
  const flags = safetyFlags(text, {rendered: true});
  return {status: flags.length ? 'FLAG' : 'PASS', flags, warnings: []};
}

// ---------------- Phase 3 news reads: V14 to V21 (plan section 9) ----------------
// validateNewsRead(record, pack) checks a pi/news-verdict/v1 record. validateRole() checks one
// role output inside runNewsRead before the next role sees it. validateRenderedRead() checks the
// code-rendered text (V18 plus V4 to V11 and V19 to V21). V17 lowers an over-cap confidence in
// code and is a warning, never a FLAG.
import {NEWS_LABEL} from './newsread/render.js';
import {confidenceCap} from './newsread/mode.js';

export const STANCES = ['positive', 'negative', 'mixed', 'unclear'];
export const CONFIDENCES = ['low', 'medium', 'high'];
const CITE = /\[\[(e\d{1,2})\]\]/g;
const LIMITS_NEWS = {bull: [3, 220], bear: [3, 220], joint: [4, 220]};
const SUMMARY_MAX = {joint: 400, judge: 500};
const ADVICE_NEWS = [/\b(buy|sell|hold)(s|ing)?\b/i, /\bprice targets?\b/i, /\bupside\b/i, /\bdownside target\b/i, /\boverweight\b/i,
  /\bunderweight\b/i, /\boutperform\w*\b/i, /\baccumulat\w*\b/i, /\bentry points?\b/i, /\btime to\b/i];
const STANCE_WORDS = [/\bbullish\b/i, /\bbearish\b/i, /\bstrong buy\b/i, /\byou should\b/i];
const INSTRUCTION = /\b(ignore|disregard)\b|\bas an ai\b/i;
const MONTHS = 'January February March April May June July August September October November December Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec';
const CAP_OK = new Set(('The A An This These That Those Both Neither Either It Its Their They Bull Bear Case News Headlines Headline Overall '
  + 'On In Of And But Or While However Still Together Most Some Several One Other Another No Yet So Also Even For Taken '
  + MONTHS).split(' '));

const ranks = {low: 0, medium: 1, high: 2};
const strip = s => String(s || '').replace(CITE, ' ');
const citesIn = s => [...String(s || '').matchAll(CITE)].map(m => m[1]);

// V1, V1b and V4 to V11 on one role text, with [[eN]] cites removed first (their digits are ids).
function baseFlags(text) {
  const t = strip(text);
  const out = [];
  if (strayNumbers(t).length) out.push({rule: 'V1', detail: 'typed number'});
  if (numberWords(t).length) out.push({rule: 'V1b', detail: 'number word or sign'});
  return out.concat(safetyFlags(t));
}

// V19 to V21 on any text (role text or rendered text). pack titles feed the copy-run check.
export function newsWordFlags(text, pack) {
  const s = norm(text);
  const flags = [];
  if (ADVICE_NEWS.some(re => re.test(s))) flags.push({rule: 'V19', detail: 'advice or rating word'});
  if (STANCE_WORDS.some(re => re.test(s))) flags.push({rule: 'V20', detail: 'stance word'});
  let inj = /https?:\/\/|\bwww\./i.test(s) || /[<>`]/.test(s) || /\bsystem\b|\bassistant\s*:|\buser\s*:/i.test(s) || INSTRUCTION.test(s);
  if (!inj && pack) {
    const body = ' ' + strip(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
    for (const it of pack.items || []) {
      if (!INSTRUCTION.test(norm(it.title))) continue;
      const w = norm(it.title).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
      for (let i = 0; i + 6 <= w.length; i++) if (body.includes(' ' + w.slice(i, i + 6).join(' ') + ' ')) { inj = true; break; }
      if (inj) break;
    }
  }
  if (inj) flags.push({rule: 'V21', detail: 'link, markup, role word or copied instruction'});
  return flags;
}

const add = (flags, more) => { for (const f of more) if (!flags.some(x => x.rule === f.rule)) flags.push(f); };

// V14 on a list of points. Returns flags.
function pointFlags(role, points, ids) {
  const [maxPts, maxLen] = LIMITS_NEWS[role];
  const flags = [];
  if (!Array.isArray(points) || points.length > maxPts) return [{rule: 'V14', detail: 'too many points'}];
  for (const p of points) {
    const cites = Array.isArray(p && p.cites) ? p.cites : [];
    const inline = citesIn(p && p.text);
    if (typeof (p && p.text) !== 'string' || !p.text.trim() || p.text.length > maxLen) { flags.push({rule: 'V14', detail: 'point text missing or too long'}); break; }
    if (cites.length < 1 || cites.length > 3) { flags.push({rule: 'V14', detail: 'point needs 1 to 3 cites'}); break; }
    if ([...cites, ...inline].some(id => !ids.has(id))) { flags.push({rule: 'V14', detail: 'cite not in pack'}); break; }
  }
  return flags;
}

function textFlags(texts, pack) {
  const flags = [];
  for (const t of texts) { add(flags, baseFlags(t)); add(flags, newsWordFlags(t, pack)); }
  return flags;
}

// V16: capitalized words and ticker-like tokens in judge text must come from the pack.
function introducesFacts(text, pack) {
  const titles = (pack.items || []).map(i => `${i.title} ${i.source}`).join(' ').toLowerCase();
  const known = new Set(titles.match(/[a-z0-9.&'-]+/g) || []);
  for (const sent of sentences(strip(text))) {
    const toks = sent.match(/[A-Za-z][A-Za-z0-9.&'-]*/g) || [];
    for (let i = 0; i < toks.length; i++) {
      const tok = toks[i].replace(/[.'-]+$/, '');
      if (!/^[A-Z]/.test(tok)) continue;
      if (i === 0 || CAP_OK.has(tok) || tok === pack.ticker) continue;
      const low = tok.toLowerCase().replace(/'s$/, '');
      if (known.has(low) || known.has(low + 's') || known.has(low + "'s")) continue;
      return true;
    }
  }
  return false;
}

// One role output inside runNewsRead. ctx = {mode, bull, bear} (validated sides, for the judge).
export function validateRole(role, out, pack, ctx = {}) {
  const ids = new Set((pack.items || []).map(i => i.id));
  const flags = [], warnings = [];
  if (role === 'bull' || role === 'bear') {
    const pts = out && Array.isArray(out.points) ? out.points : [];
    add(flags, pointFlags(role, pts, ids));
    if (pts.length && !pts.some(p => (p.cites || []).length)) add(flags, [{rule: 'V15', detail: 'side cites no headline'}]);
    add(flags, textFlags(pts.map(p => p.text), pack));
  } else if (role === 'joint' || role === 'judge') {
    const summary = out && typeof out.summary === 'string' ? out.summary : '';
    if (!summary.trim() || summary.length > SUMMARY_MAX[role]) add(flags, [{rule: 'V11', detail: 'summary missing or too long'}]);
    if (citesIn(summary).some(id => !ids.has(id))) add(flags, [{rule: role === 'judge' ? 'V16' : 'V14', detail: 'cite not in pack'}]);
    if (!STANCES.includes(out && out.stance) || !CONFIDENCES.includes(out && out.confidence)) add(flags, [{rule: 'V17', detail: 'stance or confidence not allowed'}]);
    let texts = [summary];
    if (role === 'joint') {
      const pts = Array.isArray(out && out.points) ? out.points : [];
      if (!pts.length) add(flags, [{rule: 'V14', detail: 'joint needs points'}]);
      add(flags, pointFlags('joint', pts, ids));
      texts = texts.concat(pts.map(p => p.text));
    } else {
      const sideIds = new Set([...(ctx.bull?.status === 'ok' ? ctx.bull.points : []), ...(ctx.bear?.status === 'ok' ? ctx.bear.points : [])].flatMap(p => p.cites));
      const weighed = Array.isArray(out && out.weighed) ? out.weighed : [];
      if (weighed.some(id => !ids.has(id) || !sideIds.has(id)) || citesIn(summary).some(id => !sideIds.has(id))) add(flags, [{rule: 'V16', detail: 'weighs an id neither side cited'}]);
      if (introducesFacts(summary, pack)) add(flags, [{rule: 'V16', detail: 'name not in any headline'}]);
    }
    add(flags, textFlags(texts, pack));
    const cap = confidenceCap(pack, ctx.mode);
    if (CONFIDENCES.includes(out && out.confidence) && ranks[out.confidence] > ranks[cap]) warnings.push({rule: 'V17', detail: `confidence lowered to ${cap}`});
  }
  return {status: flags.length ? 'FLAG' : 'PASS', flags, warnings};
}

// Code-side V17: lower an over-cap confidence. Returns [confidence, warned].
export function capConfidence(conf, pack, mode) {
  const cap = confidenceCap(pack, mode);
  if (!CONFIDENCES.includes(conf)) return [null, false];
  return ranks[conf] > ranks[cap] ? [cap, true] : [conf, false];
}

// Whole record check (V14 to V17, V19 to V21 and the base rules on every model text).
export function validateNewsRead(record, pack) {
  const flags = [], warnings = [];
  if (!record || record.schema !== 'pi/news-verdict/v1') return {status: 'FLAG', flags: [{rule: 'V14', detail: 'bad record'}], warnings};
  const ids = new Set((pack.items || []).map(i => i.id));
  const mode = record.mode;
  if (record.status !== 'PASS') {
    // thin, fallback, skipped, error carry no model text and no stance
    if (record.stance != null || record.confidence != null || record.summary != null || [record.bull, record.bear, record.joint].some(a => a && a.length)) flags.push({rule: 'V17', detail: 'non PASS record carries model output'});
    return {status: flags.length ? 'FLAG' : 'PASS', flags, warnings};
  }
  if (mode === 'debate') {
    add(flags, pointFlags('bull', record.bull || [], ids));
    add(flags, pointFlags('bear', record.bear || [], ids));
    if (!(record.bull || []).length && !(record.bear || []).length) add(flags, [{rule: 'V15', detail: 'both sides empty in a debate'}]);
    const sideIds = new Set([...(record.bull || []), ...(record.bear || [])].flatMap(p => p.cites || []));
    if (citesIn(record.summary).some(id => !sideIds.has(id))) add(flags, [{rule: 'V16', detail: 'summary cites an id neither side cited'}]);
    if (introducesFacts(record.summary || '', pack)) add(flags, [{rule: 'V16', detail: 'name not in any headline'}]);
  } else if (mode === 'collaborate') {
    if (!(record.joint || []).length) add(flags, [{rule: 'V14', detail: 'joint needs points'}]);
    add(flags, pointFlags('joint', record.joint || [], ids));
  } else add(flags, [{rule: 'V15', detail: 'PASS record in thin mode'}]);
  if (citesIn(record.summary).some(id => !ids.has(id))) add(flags, [{rule: 'V16', detail: 'cite not in pack'}]);
  if (!STANCES.includes(record.stance) || !CONFIDENCES.includes(record.confidence)) add(flags, [{rule: 'V17', detail: 'stance or confidence not allowed'}]);
  else if (ranks[record.confidence] > ranks[confidenceCap(pack, mode)]) add(flags, [{rule: 'V17', detail: 'confidence over cap'}]);
  const texts = [record.summary || '', ...[...(record.bull || []), ...(record.bear || []), ...(record.joint || [])].map(p => p.text)];
  add(flags, textFlags(texts, pack));
  return {status: flags.length ? 'FLAG' : 'PASS', flags, warnings};
}

// V18 plus the rendered checks. Text must start with the code label and end with the disclaimer.
export function validateRenderedRead(text, pack = null) {
  const s = String(text || '');
  const flags = [];
  if (!s.startsWith(NEWS_LABEL) || !s.trimEnd().endsWith(DISCLAIMER)) flags.push({rule: 'V18', detail: 'label or disclaimer missing'});
  add(flags, safetyFlags(s, {rendered: true}));
  add(flags, newsWordFlags(s.replace(DISCLAIMER, ''), pack));
  return {status: flags.length ? 'FLAG' : 'PASS', flags, warnings: []};
}
