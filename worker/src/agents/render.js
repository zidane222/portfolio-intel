// Rendering: placeholder substitution, number formatting, the sources list and the code-only
// answers (safe answer and out of scope). Formatting here is shared with validator V1.

export const DISCLAIMER = 'This is general information from the sources listed, not personalized investment advice. '
  + 'Simulated or past results do not predict future returns.';
export const SIMULATED_LABEL = 'Simulated results from hypothetical backtests on past data, not investment advice. No trades are placed. Past results do not predict future results.';
export const HISTORICAL_LABEL = 'This describes past public disclosures only, not investment advice. Past results do not predict future results.';
// Fixed labels for the facts a text cites (Phase 4): code adds them, the model never writes them.
export function labelsFor(facts, ids) {
  const want = new Set(ids || []);
  const rules = new Set();
  for (const f of facts || []) if (want.has(f.id)) for (const r of f.rules || []) rules.add(r);
  const out = [];
  if (rules.has('simulated')) out.push(SIMULATED_LABEL);
  if (rules.has('historical')) out.push(HISTORICAL_LABEL);
  return out;
}
export const OUT_OF_SCOPE = 'I can help with investing, markets, your portfolio and this app. Try asking about one of your holdings.';
export const SAFE_INTRO = 'Here is what the sources show:';
export const SAFE_EMPTY = 'The sources did not return data for this question right now.';

const comma = (n, d) => n.toLocaleString('en-US', {minimumFractionDigits: d, maximumFractionDigits: d});

export function formatNumber(value, unit) {
  if (unit === 'text' || unit === 'date') return String(value);
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const a = Math.abs(n);
  if (unit === 'usd') {
    const s = n < 0 ? '-' : '';
    if (a >= 1e9) return `${s}$${comma(a / 1e9, 2)}B`;
    if (a >= 1e6) return `${s}$${comma(a / 1e6, 2)}M`;
    return `${s}$${comma(a, 2)}`;
  }
  if (unit === 'pct') return `${comma(n, a >= 100 ? 0 : 2)}%`;
  if (unit === 'count') return comma(Math.round(n), 0);
  if (unit === 'shares') return comma(n, Number.isInteger(n) ? 0 : Math.min(4, (String(n).split('.')[1] || '').length));
  return String(n);
}

// What the user sees for a fact.
export function display(f) {
  if (!f) return 'Unknown';
  if (f.status === 'unknown') return 'Unknown';
  if (f.status === 'conflicting') return 'Sources disagree';
  return formatNumber(f.value, f.unit);
}

// Number tokens that a fact may legitimately put into rendered text (shared with V1).
export const numberTokens = s => (String(s).match(/\d[\d,]*(?:\.\d+)?/g) || []).map(t => t.replace(/,/g, '').replace(/\.0+$/, ''));
export function factNumbers(facts) {
  const out = new Set();
  for (const f of facts || []) {
    for (const t of numberTokens(display(f))) out.add(t);
    if (f.value !== null && f.value !== undefined) for (const t of numberTokens(formatNumber(f.value, f.unit))) out.add(t);
    for (const s of f.sources || []) if (s.value !== null && s.value !== undefined) for (const t of numberTokens(formatNumber(s.value, f.unit))) out.add(t);
  }
  return out;
}

export const PLACEHOLDER = /\[\[(f\d+)\]\]/g;

export function renderText(text, facts) {
  const byId = new Map((facts || []).map(f => [f.id, f]));
  const cited = [...String(text).matchAll(PLACEHOLDER)].map(m => m[1]);
  const labels = labelsFor(facts, cited);
  return String(text).replace(PLACEHOLDER, (_, id) => display(byId.get(id))).trim() + '\n\n' + (labels.length ? labels.join(' ') + '\n\n' : '') + DISCLAIMER;
}

const day = s => (s ? String(s).slice(0, 10) : null);

export function sourceRow(f) {
  const s = (f.sources || [])[0] || {};
  const derived = (f.rules || []).includes('derived');
  return {
    fact: f.id, label: f.label || f.key, value: display(f), status: f.status,
    source: derived ? 'Calculated from the sources listed' : (s.source || 'Unknown'),
    asof: s.asof || null, url: s.url || null,
  };
}

export function sourcesFor(facts, ids) {
  const want = new Set(ids || []);
  return (facts || []).filter(f => want.has(f.id)).map(sourceRow);
}

// Code-only answer: up to 8 verified facts. Lines that fail the safety rules are skipped
// (lineOk comes from the validator so the safe answer always passes V4 to V11).
export function safeAnswer(facts, lineOk = () => true) {
  const lines = [];
  const shown = [];
  for (const f of facts || []) {
    if (lines.length >= 8) break;
    if (f.status !== 'verified') continue;
    const r = sourceRow(f);
    const line = `${r.label}: ${r.value} (${r.source}${r.asof ? ', as of ' + day(r.asof) : ''})`.replace(/[\u2013\u2014]/g, ',');
    if (!lineOk(line)) continue;
    lines.push('* ' + line);
    shown.push(f.id);
  }
  const body = lines.length ? `${SAFE_INTRO}\n${lines.join('\n')}` : SAFE_EMPTY;
  const labels = labelsFor(facts, shown);
  return {text: body + '\n\n' + (labels.length ? labels.join(' ') + '\n\n' : '') + DISCLAIMER, shown};
}

export const outOfScopeAnswer = () => OUT_OF_SCOPE + '\n\n' + DISCLAIMER;
