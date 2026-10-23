// Validator: rule-based and independent of the builder (imports nothing from builder.js).
// Checks the raw draft, then the rendered text. FLAG when any rule other than V12 fires.
import {DISCLAIMER, PLACEHOLDER, factNumbers, numberTokens} from './render.js';

const ADVICE = [
  /you should (buy|sell|short|move|put|invest)/i,
  /\bI (recommend|suggest) (buying|selling)/i,
  /\b(buy|sell) now\b/i,
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

// V1: numbers outside placeholders must come from the question, a fact, a year, or a list ordinal.
function strayNumbers(text, facts, question) {
  const allowed = factNumbers(facts);
  for (const t of numberTokens(question || '')) allowed.add(t);
  const bad = [];
  for (const line of String(text).replace(PLACEHOLDER, ' ').split('\n')) {
    const ord = line.match(/^\s*(\d{1,2})[.)]\s/);
    let body = line;
    if (ord && +ord[1] >= 1 && +ord[1] <= 10) body = line.slice(ord[0].length);
    for (const t of numberTokens(body)) {
      const n = Number(t);
      if (allowed.has(t)) continue;
      if (/^\d{4}$/.test(t) && n >= 1990 && n <= 2100) continue;
      bad.push(t);
    }
  }
  return bad;
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
  const stray = strayNumbers(text, facts, question);
  if (stray.length) flags.push({rule: 'V1', detail: `${stray.length} number(s) not from facts`});
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
    if (strayNumbers(r.replace(DISCLAIMER, ''), facts, question).length && !flags.some(f => f.rule === 'V1')) flags.push({rule: 'V1', detail: 'rendered number not from facts'});
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
