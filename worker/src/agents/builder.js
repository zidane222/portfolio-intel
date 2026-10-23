// Answer builder: Groq call #2 (and #3 on repair) through pi-ai /internal/build.
// The model writes [[fN]] placeholders. Code renders the values (render.js).
import {display} from './render.js';

const FACTS_MAX_BYTES = 12000;

export function factsPayload(facts) {
  let list = (facts || []).map(f => ({
    id: f.id, label: f.label, value_display: display(f), status: f.status,
    source: (f.rules || []).includes('derived') ? 'Calculated from the sources listed' : (f.sources?.[0]?.source || 'Unknown'),
    asof: f.sources?.[0]?.asof || null,
  }));
  while (list.length && JSON.stringify(list).length > FACTS_MAX_BYTES) list = list.slice(0, -1);
  return list;
}

export function parseBuild(out) {
  if (!out || typeof out.text !== 'string') throw new Error('bad build');
  const ids = a => (Array.isArray(a) ? a : []).map(String).filter(x => /^f\d{1,3}$/.test(x));
  return {text: out.text.slice(0, 4000), used: ids(out.used), unknown_mentioned: ids(out.unknown_mentioned)};
}

// flags: [{rule}] from the validator. Only rule IDs are sent (pi-ai adds the plain explanations).
export async function run(c, deps, {attempt = 1, flags = [], timeoutMs = 8000} = {}) {
  const body = {
    intent: {type: c.intent?.type || 'general'},
    facts: factsPayload(c.facts),
    question: c.input.question,
    history: c.input.history,
    timeout_ms: timeoutMs,
  };
  if (flags.length) body.flags = [...new Set(flags.map(f => f.rule))].map(rule => ({rule}));
  const out = parseBuild(await deps.ai('/internal/build', body, timeoutMs));
  return {draft: {text: out.text, used: out.used, attempt}};
}
