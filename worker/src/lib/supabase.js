// Minimal PostgREST client for pi-newsdesk (service role). Never logs headers or bodies:
// errors carry the operation name and HTTP status only.
const URL_RE = /^https:\/\/[a-z0-9-]+\.supabase\.co$/;

export function makeSupabase(env, {timeoutMs = 8000} = {}) {
  // Secrets pasted into a store often carry a trailing newline, spaces or quotes. A header value with
  // a newline makes fetch throw before any request is sent, which looked like a network failure.
  const clean = v => String(v == null ? '' : v).replace(/\s+/g, '').replace(/^["']+|["']+$/g, '');
  const base = clean(env.SUPABASE_URL).replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  const key = typeof env.SUPABASE_SERVICE_KEY === 'string' ? clean(env.SUPABASE_SERVICE_KEY) : null; // only a string is a key
  if (!URL_RE.test(base)) throw new Error('Supabase URL not configured');
  if (!key || typeof key !== 'string') throw new Error('Supabase key not configured');
  const headers = extra => ({'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', ...extra});

  async function send(op, path, init) {
    let r;
    try {
      // Workers' fetch rejects redirect: 'error', so use 'manual' and refuse any redirect below
      r = await fetch(`${base}/rest/v1/${path}`, {...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs)});
    } catch (e) {
      // The error class and a fixed hint, never the error text itself (it can echo a header value)
      const kind = String(e && e.name || 'Error').replace(/[^A-Za-z]/g, '').slice(0, 30);
      const m = String(e && e.message || '');
      const hint = /header/i.test(m) ? 'bad header' : /url/i.test(m) ? 'bad url' : /time ?out|timed out|abort/i.test(m + kind) ? 'timeout'
        : /connect|network|refused|reset|lost|dns|tls|ssl/i.test(m) ? 'connection' : 'other';
      throw new Error(`Supabase ${op} failed: network (${kind}, ${hint})`);
    }
    if (r.status >= 300 && r.status < 400) { try { await r.body?.cancel(); } catch { /* ignore */ } throw new Error(`Supabase ${op} failed: redirect`); }
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
