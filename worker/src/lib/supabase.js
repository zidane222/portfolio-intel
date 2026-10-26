// Minimal PostgREST client for pi-newsdesk (service role). Never logs headers or bodies:
// errors carry the operation name and HTTP status only.
const URL_RE = /^https:\/\/[a-z0-9-]+\.supabase\.co$/;

export function makeSupabase(env, {timeoutMs = 8000} = {}) {
  const base = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_KEY;
  if (!URL_RE.test(base)) throw new Error('Supabase URL not configured');
  if (!key || typeof key !== 'string') throw new Error('Supabase key not configured');
  const headers = extra => ({'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', ...extra});

  async function send(op, path, init) {
    let r;
    try {
      r = await fetch(`${base}/rest/v1/${path}`, {...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs)});
    } catch (e) {
      throw new Error(`Supabase ${op} failed: network`);
    }
    if (!r.ok) { try { await r.body?.cancel(); } catch { /* ignore */ } throw new Error(`Supabase ${op} failed: ${r.status}`); }
    if (r.status === 204) return null;
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }

  return {
    rpc: (name, args = {}) => send('rpc ' + name, `rpc/${encodeURIComponent(name)}`, {method: 'POST', headers: headers(), body: JSON.stringify(args)}),
    // query is a PostgREST query string without the leading '?', built by the caller from checked values
    select: (view, query) => send('select ' + view, `${encodeURIComponent(view)}?${query}`, {method: 'GET', headers: headers()}),
    upsert: (table, rows, onConflict) => send('upsert ' + table, `${encodeURIComponent(table)}?on_conflict=${encodeURIComponent(onConflict)}`,
      {method: 'POST', headers: headers({'Prefer': 'resolution=merge-duplicates,return=minimal'}), body: JSON.stringify(rows)}),
    patch: (table, query, data) => send('patch ' + table, `${encodeURIComponent(table)}?${query}`,
      {method: 'PATCH', headers: headers({'Prefer': 'return=minimal'}), body: JSON.stringify(data)}),
  };
}
