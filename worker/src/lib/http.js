// Shared HTTP helpers: JSON responses, CORS, origin checks, outside fetches and a small cache.

export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36';

export function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
}

export function originOk(req, env) {
  const o = req.headers.get('Origin') || '';
  if (!o) return false;
  return allowedOrigins(env).includes(o) || /^https:\/\/[a-z0-9-]+\.portfolio-intel-279\.pages\.dev$/.test(o);
}

export function corsHeaders(req, env) {
  const o = req.headers.get('Origin') || '';
  const h = {'Vary': 'Origin'};
  if (o && originOk(req, env)) {
    h['Access-Control-Allow-Origin'] = o;
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      ...extra,
    },
  });
}

export const nowIso = () => new Date().toISOString();

export function tickers(raw, max) {
  return String(raw || '').split(',').map(t => t.trim().toUpperCase()).filter(t => /^[A-Z0-9.^=-]{1,12}$/.test(t)).slice(0, max);
}

// Outside fetch with a timeout. Never throws; returns null on failure.
export async function grab(url, {timeout = 8000, as = 'json', headers = {}, method = 'GET', body} = {}) {
  try {
    const r = await fetch(url, {method, body, headers: {'User-Agent': UA, ...headers}, signal: AbortSignal.timeout(timeout)});
    if (!r.ok) return null;
    return as === 'text' ? await r.text() : await r.json();
  } catch (e) {
    return null;
  }
}

// In-memory cache per Worker instance. Instances live for a while, so this saves repeat calls
// without any setup. Entries expire after their own time to live.
const MEM = new Map();
export function memGet(key) {
  const hit = MEM.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.exp) { MEM.delete(key); return undefined; }
  return hit.val;
}
export function memSet(key, val, seconds) {
  if (MEM.size > 3000) MEM.delete(MEM.keys().next().value);
  MEM.set(key, {val, exp: Date.now() + seconds * 1000});
}

// Run tasks with a cap on how many run at once (the free plan allows ~50 outside calls per request).
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const run = async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } };
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, run));
  return out;
}

export function unescapeHtml(s) {
  return String(s).replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
export function memClear() { MEM.clear(); } // used by tests
