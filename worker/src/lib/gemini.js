// Gemini chat through Google's OpenAI-compatible endpoint, same signature and error rules as groqChat.
// Free tier: prompts may be used by Google, so only public data goes through here (plan D3).
// Options (all optional): timeoutMs (default 60000), signal (extra AbortSignal). `fallback` is ignored.
// env.GEMINI_API_KEY (Secrets Store) and env.GEMINI_MODEL (config) are both required.
const URL_CHAT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

export async function geminiChat(env, system, user, maxTokens, jsonMode = false, opts = {}) {
  const key = env.GEMINI_API_KEY;
  const model = String(env.GEMINI_MODEL || '').trim();
  if (!key || !model) throw new Error('AI not configured');
  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : 60000;
  const payload = {model, max_tokens: maxTokens, messages: [{role: 'system', content: system}, {role: 'user', content: user}]};
  if (jsonMode) payload.response_format = {type: 'json_object'};
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal && AbortSignal.any ? AbortSignal.any([timeout, opts.signal]) : timeout;
  let r, d;
  try {
    r = await fetch(URL_CHAT, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`},
      body: JSON.stringify(payload),
      signal,
      redirect: 'error',
    });
    d = await r.json().catch(() => null); // a non-JSON error page must still report its status
  } catch (e) { throw new Error(String(e && e.name === 'TimeoutError' ? 'timeout' : e && e.name || e).slice(0, 60)); }
  // Gemini may return an array-wrapped error; status and error code only, never the body (it can echo prompt text).
  d = d || {};
  const err = Array.isArray(d) ? d[0] && d[0].error : d.error;
  if (!r.ok || err) {
    const msg = `${r.status} ${String((err && (err.code || err.status || err.type)) || '').slice(0, 40)}`.trim();
    console.log('Gemini error', msg);
    throw new Error(msg);
  }
  const content = d.choices?.[0]?.message?.content || '';
  if (content.trim()) return content;
  throw new Error('empty answer');
}
