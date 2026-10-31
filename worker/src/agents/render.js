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
    return `${s}$${comma(a, Number.isInteger(n) && a >= 1000 ? 0 : 2)}`; // whole amounts: $999,996, not $999,996.00
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
// Insider buys (SEC Form 4): the answer is built here from the checked facts, in the agent's order
// (largest first), so no model can reorder lines or drop the buyer, role and date. Returns null when
// the window fact is not verified (for example stale data), and the builder path handles it.
export function insidersAnswer(facts, lineOk = () => true) {
  const by = new Map((facts || []).map(f => [f.key, f]));
  const ok = f => f && f.status === 'verified';
  const win = by.get('insider:window');
  if (!ok(win)) return null;
  const ids = [win.id];
  const cnt = by.get('count:insider_buys');
  const head = [ok(cnt) ? `${win.value}: ${display(cnt)}.` : `${win.value}.`];
  if (ok(cnt)) ids.push(cnt.id);
  const held = by.get('insider:held_back');
  if (ok(held)) { head.push(`${held.value}.`); ids.push(held.id); }
  const lines = [];
  for (let i = 1; by.has(`insider:${i}`); i++) {
    const t = by.get(`insider:${i}`), v = by.get(`insider:${i}:value`);
    if (!ok(t) || !ok(v)) continue;
    if (!lineOk(`${t.value}, worth ${display(v)}.`)) continue; // one hostile filer name drops its line, not the answer
    lines.push({text: `${lines.length + 1}. ${t.value}, worth ${display(v)}.`, ids: [t.id, v.id]});
  }
  const scope = by.get('insider:scope');
  const tail = ok(scope) ? [`${scope.value}.`] : [];
  if (ok(scope)) ids.push(scope.id);
  const build = n => [head.join(' '), ...lines.slice(0, n).map(l => l.text), ...tail].join('\n');
  let n = lines.length;
  while (n > 1 && build(n).length > 1500) n--; // V11 limit on the rendered body is 1600
  for (const l of lines.slice(0, n)) ids.push(...l.ids);
  return {text: build(n) + '\n\n' + DISCLAIMER, ids};
}

// Congress trades (House and Senate PTRs): a code-built list from checked facts, no builder call.
// The trade lines already carry every number, so nothing typed by a model reaches the answer.
export function disclosuresAnswer(facts, lineOk = () => true) {
  const by = new Map((facts || []).map(f => [f.key, f]));
  const ok = f => f && f.status === 'verified';
  const win = by.get('disclosure:window'), scope = by.get('disclosure:scope');
  if (!ok(win)) return null;
  const ids = [win.id];
  const cnt = by.get('count:disclosed');
  const head = [ok(cnt) ? `${win.value}: ${display(cnt)}.` : `${win.value}.`];
  if (ok(cnt)) ids.push(cnt.id);
  const lines = [];
  for (let i = 1; by.has(`trade:${i}`); i++) {
    const t = by.get(`trade:${i}`);
    if (!ok(t) || !lineOk(`${t.value}.`)) continue;
    lines.push({text: `${lines.length + 1}. ${t.value}.`, ids: [t.id]});
  }
  const most = (facts || []).filter(f => ok(f) && /^count:buys:/.test(f.key) && f.value > 1).sort((a, b) => b.value - a.value).slice(0, 3);
  const tail = [];
  if (most.length) { tail.push('Bought more than once: ' + most.map(f => `${f.key.slice(11)} (${display(f)})`).join(', ') + '.'); ids.push(...most.map(f => f.id)); }
  if (ok(scope)) { tail.push(`${scope.value}. Filings can lag the trade date by weeks.`); ids.push(scope.id); }
  const build = n => [head.join(' '), ...lines.slice(0, n).map(l => l.text), ...tail].join('\n');
  let n = lines.length;
  while (n > 1 && build(n).length > 1500) n--;
  for (const l of lines.slice(0, n)) ids.push(...l.ids);
  return {text: build(n) + '\n\n' + DISCLAIMER, ids};
}

// Cash yield ("how much more could my cash earn"): code-built from the cash gap facts in factcheck.
export function ratesAnswer(facts, lineOk = () => true) {
  const by = new Map((facts || []).map(f => [f.key, f]));
  const ok = f => f && f.status === 'verified';
  const best = by.get('rate:best:apy');
  if (!ok(best)) {
    // Rates cache is cold: show what the cash earns now and say the comparison isn't available yet.
    const out = ['Current savings rates are not available right now, so the comparison can\'t be made yet. Try again in a few minutes.'], ids = [];
    for (const f of facts || []) {
      const m = ok(f) && f.key.match(/^cash:(.+):apy$/);
      const bal = m && by.get(`holding:${m[1]}:value`);
      if (!m || !ok(bal)) continue;
      const line = `* ${m[1]}: ${display(bal)} at ${display(f)}.`;
      if (lineOk(line)) { out.push(line); ids.push(bal.id, f.id); }
    }
    return {text: out.join('\n') + '\n\n' + DISCLAIMER, ids};
  }
  const ids = [best.id], out = [];
  const total = by.get('cash_gap:total');
  if (ok(total)) {
    out.push(`At the best listed savings rate, ${best.label.replace(/^Best listed APY /, '').replace(/[()]/g, '')} at ${display(best)}, your cash would earn about ${display(total)} more per year than it does now.`);
    ids.push(total.id);
    for (const f of facts) {
      const m = ok(f) && f.key.match(/^cash_gap:(.+)$/);
      if (!m || m[1] === 'total') continue;
      const now = by.get(`cash_now:${m[1]}`), bal = by.get(`holding:${m[1]}:value`), apy = by.get(`cash:${m[1]}:apy`);
      if (![now, bal, apy].every(ok)) continue;
      const line = `* ${m[1]}: ${display(bal)} at ${display(apy)} earns ${display(now)} a year; about ${display(f)} more at the best rate.`;
      if (!lineOk(line)) continue;
      out.push(line); ids.push(f.id, now.id, bal.id, apy.id);
    }
  } else {
    out.push(`The best listed savings rate is ${display(best)}. No cash balances with a yield were sent from this device, so the difference for your cash can't be worked out.`);
  }
  const top = facts.filter(f => ok(f) && /^rate:.+:apy$/.test(f.key) && f.key !== 'rate:best:apy').slice(0, 5);
  if (top.length) { out.push('Top savings rates listed now:'); for (const f of top) { const l = `* ${f.label.replace(/ APY$/, '')}: ${display(f)}`; if (lineOk(l)) { out.push(l); ids.push(f.id); } } }
  out.push('Rates change often and may have balance limits or conditions. Estimates assume the balance stays the same for a year.');
  return {text: out.join('\n') + '\n\n' + DISCLAIMER, ids};
}

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
