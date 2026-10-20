// Groq chat with a fallback model, same behavior as the old Python server.
export async function groqChat(env, system, user, maxTokens, jsonMode = false) {
  const key = env.GROQ_API_KEY;
  if (!key) throw new Error('AI not configured');
  let last = '';
  for (const model of ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile']) {
    const payload = {model, max_tokens: maxTokens, messages: [{role: 'system', content: system}, {role: 'user', content: user}]};
    if (model.startsWith('openai/')) payload.reasoning_effort = 'low';
    if (jsonMode) payload.response_format = {type: 'json_object'};
    let r, d;
    try {
      r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`},
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60000),
      });
      d = await r.json();
    } catch (e) { last = String(e); continue; }
    if (!r.ok || d.error) { last = `${r.status} ${JSON.stringify(d.error || '')}`; console.log('Groq error', model, last); continue; }
    const content = d.choices?.[0]?.message?.content || '';
    if (content.trim()) return content;
    last = 'empty answer';
  }
  throw new Error(last || 'no answer');
}
