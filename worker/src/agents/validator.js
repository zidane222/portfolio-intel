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

const sentences = s => String(s).split(/(?<=[.!?])\s+|\n+/);

// V1 (L3): numbers reach the answer only through [[fN]] placeholders. Checked on the draft with
// placeholders removed, so digits inside rendered facts never count. Typed digits are allowed
// only as 4-digit years 1900 to 2099 and as list numbering (1. or 1) at the start of a line).
function strayNumbers(text) {
  const bad = [];
  for (const line of String(text).replace(PLACEHOLDER, ' ').split('\n')) {
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
const UNIT = '(?:shares?|dollars?|cents?|percent|per\\s+cent|points?|basis|hundred|thousand|million|billion|trillion|dozen|times|years?|months?|stocks?|funds?|holdings?)';
const NUMBER_WORDS = [
  new RegExp(`\\bone\\s+${UNIT}\\b`, 'i'),
  /\b(?:zero(?!-coupon)|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/i,
  /\b(?:hundreds?|thousands?|millions?|billions?|trillions?|dozens?)\b/i,
  /\b(?:twice|thrice|tripled?|triples|quadrupled?|quadruples|doubled|doubles)\b/i,
  /\bdouble\b(?![- ](?:check|checked|checking|edged))/i,
  /(?<!\b(?:first|second|back|front)\s)\bhalf\b(?![- ]?years?\b)/i,
  /\b(?:[0-9]+|x|n)\s*times\b/i,
];
const PCT_WORD = /(\S*)\s*\b(?:percent(?:age points?)?|per\s+cent|basis\s+points?|bps)\b/gi;
function numberWords(text) {
  const s = String(text).replace(PLACEHOLDER, PH);
  const hits = [];
  for (const re of NUMBER_WORDS) { const m = s.match(re); if (m) hits.push(m[0].trim().toLowerCase()); }
  for (const m of s.matchAll(PCT_WORD)) if (!m[1].endsWith(PH)) hits.push(m[0].trim().toLowerCase());
  if (/[%$]/.test(s)) hits.push('% or $ outside a placeholder');
  return hits;
}

// Rules V4 to V11 on one piece of text. Used for drafts, rendered text and the safe answer.
export function safetyFlags(text, {rendered = false} = {}) {
  const s = String(text || '');
  const flags = [];
  for (const re of ADVICE) if (re.test(s)) { flags.push({rule: 'V4', detail: 'personalized advice wording'}); break; }
  for (const re of GUARANTEE) if (re.test(s)) { flags.push({rule: 'V5', detail: 'guaranteed return wording'}); break; }
  for (const [name, re] of PII) if (re.test(s)) { flags.push({rule: 'V6', detail: name}); break; }
  if (rendered && !s.includes(DISCLAIMER)) flags.push({rule: 'V7', detail: 'disclaimer missing'});
  for (const re of ORDER) if (re.test(s)) { flags.push({rule: 'V8', detail: 'order wording'}); break; }
  for (const re of ECHO) if (re.test(s)) { flags.push({rule: 'V9', detail: 'echoed instructions or data'}); break; }
  if (/[\u2013\u2014]/.test(s)) flags.push({rule: 'V10', detail: 'em or en dash'});
  const body = rendered ? s.replace(DISCLAIMER, '') : s;
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
