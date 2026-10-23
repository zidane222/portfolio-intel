// Groq chat with a fallback model, same behavior as the old Python server.
// Options (all optional, defaults keep the original behavior):
//   timeoutMs  per-model request timeout (default 60000)
//   fallback   false skips the second model (default true)
//   signal     extra AbortSignal (for example the /api/ask deadline)
// env.GROQ_MODEL sets the first model (default openai/gpt-oss-120b).
const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const FALLBACK_MODEL = 'llama-3.3-70b-versatile';

export function groqModels(env, fallback = true) {
  const first = String((env && env.GROQ_MODEL) || '').trim() || DEFAULT_MODEL;
  if (!fallback) return [first];
  return first === FALLBACK_MODEL ? [first] : [first, FALLBACK_MODEL];
}

export async function groqChat(env, system, user, maxTokens, jsonMode = false, opts = {}) {
  const key = env.GROQ_API_KEY;
  if (!key) throw new Error('AI not configured');
  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : 60000;
  let last = '';
  for (const model of groqModels(env, opts.fallback !== false)) {
    const payload = {model, max_tokens: maxTokens, messages: [{role: 'system', content: system}, {role: 'user', content: user}]};
    if (model.startsWith('openai/')) payload.reasoning_effort = 'low';
    if (jsonMode) payload.response_format = {type: 'json_object'};
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal && AbortSignal.any ? AbortSignal.any([timeout, opts.signal]) : timeout;
    let r, d;
    try {
      r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`},
        body: JSON.stringify(payload),
        signal,
      });
      d = await r.json();
    } catch (e) { last = String(e); continue; }
    if (!r.ok || d.error) { // Status and error code only: Groq error bodies (e.g. json_validate_failed.failed_generation) can echo prompt data.
      last = `${r.status} ${String((d.error && (d.error.code || d.error.type)) || '').slice(0, 40)}`; console.log('Groq error', model, last); continue; }
    const content = d.choices?.[0]?.message?.content || '';
    if (content.trim()) return content;
    last = 'empty answer';
  }
  throw new Error(last || 'no answer');
}
