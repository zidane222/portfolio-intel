// Portfolio Intel API gateway (Cloudflare Worker).
// The only public entry point. It handles CORS, the overall rate limit and security headers,
// then forwards each request to the service that owns it over a private service binding.
// Services: market, news, rates, ai, broker, disclosures, private, newsdesk (src/services/*.js).
// POST /api/newsdesk/read and /reads are checked here (origin, body size, ticker format, pi-market,
// per-visitor news read quota) before pi-newsdesk is called with the ticker only.
// POST /api/ask is handled here by the agent supervisor (src/agents/), which reaches the
// services only through their bindings.
import {json, corsHeaders, originOk, readCapped} from './lib/http.js';
import {rateLimited, peek, count} from './lib/ratelimit.js';
import {marketHasQuote, newsdeskRead} from './agents/data/newsread.js';
import {MESSAGES} from './agents/newsread/render.js';
import {OWNERS, ownerOf} from './routes.js';
import {handleAsk} from './agents/supervisor.js';

async function health(env) {
  const checks = await Promise.all(OWNERS.map(async ([, name, binding]) => {
    const svc = env[binding];
    if (!svc) return [name, 'not linked'];
    try {
      const r = await svc.fetch('https://internal/health');
      return [name, r.ok ? 'ok' : `HTTP ${r.status}`];
    } catch (e) { return [name, 'unreachable']; }
  }));
  const services = Object.fromEntries(checks);
  const ok = Object.values(services).every(s => s === 'ok');
  return json({status: ok ? 'ok' : 'degraded', service: 'Portfolio Intel API gateway', services, updated: new Date().toISOString()});
}

// Internal headers (X-PI-*) are set only by the gateway itself. Any copy sent by a client is removed
// before routing, so a public request can never pass as internal.
export function stripInternal(req) {
  const drop = [...req.headers.keys()].filter(k => k.toLowerCase().startsWith('x-pi-'));
  if (!drop.length) return req;
  const headers = new Headers(req.headers);
  for (const k of drop) headers.delete(k);
  return new Request(req, {headers});
}

// ---- News reads (plan 3.2, 3.3, 6.4). Tickers travel only in POST bodies and are never logged.
const TICKER = /^[A-Z.\-]{1,6}$/;
const READ_MAX = 1024, READS_MAX = 2048, READS_TICKERS = 40;
const bad = () => json({error: 'Unknown ticker'}, 400);

// Body as a JSON object, or a Response for 413 / 400.
async function jsonBody(req, max) {
  if (Number(req.headers.get('Content-Length') || 0) > max) return json({error: 'Request too large'}, 413);
  const text = await readCapped(req.body, max);
  if (text === null) return json({error: 'Request too large'}, 413);
  try { const b = JSON.parse(text); if (b && typeof b === 'object' && !Array.isArray(b)) return {body: b}; } catch (e) { /* fall through */ }
  return json({error: 'Bad request'}, 400);
}

async function passJSON(r) {
  let d = null;
  try { d = await r.json(); } catch (e) { d = null; }
  if (!d || typeof d !== 'object') return json({error: 'The newsdesk service is unavailable right now.'}, 502);
  return json(d, r.status);
}

export async function newsdeskReadRoute(req, env) {
  if (!env.NEWSDESK) return json({error: 'The newsdesk service is not available.'}, 503);
  const got = await jsonBody(req, READ_MAX);
  if (got instanceof Response) return got;
  const t = typeof got.body.ticker === 'string' ? got.body.ticker.trim().toUpperCase() : '';
  if (!TICKER.test(t)) return bad(); // no pi-market call, no Groq
  const state = peek(req, 'newsread');
  if (state.minute) return json({error: 'Too many news reads. Try again in a minute.'}, 429);
  let known;
  try { known = await marketHasQuote(env.MARKET, t); } catch (e) { return json({error: 'The market service is not available.'}, 503); }
  if (!known) return bad(); // pi-newsdesk is never called for an unknown ticker
  const r = await newsdeskRead(env.NEWSDESK, t, state.over ? 'over' : 'ok');
  if (!r.ok) return passJSON(r);
  let d;
  try { d = await r.json(); } catch (e) { return json({error: 'The newsdesk service is unavailable right now.'}, 502); }
  if (!d || typeof d !== 'object') return json({error: 'The newsdesk service is unavailable right now.'}, 502);
  // Count against the visitor only when pi-newsdesk actually ran Groq for this request.
  const after = d.cached === false && Number(d.groq_calls) > 0 ? count(req, 'newsread') : state;
  const out = {...d, quota_left: after.left};
  if (out.status === 'limited' && !out.message) out.message = MESSAGES.limited;
  return json(out, 200);
}

export async function newsdeskReadsRoute(req, env) {
  if (!env.NEWSDESK) return json({error: 'The newsdesk service is not available.'}, 503);
  const got = await jsonBody(req, READS_MAX);
  if (got instanceof Response) return got;
  const raw = got.body.tickers;
  if (!Array.isArray(raw) || !raw.length || raw.length > READS_TICKERS) return json({error: 'Send 1 to 40 tickers.'}, 400);
  const list = [];
  for (const x of raw) {
    const t = typeof x === 'string' ? x.trim().toUpperCase() : '';
    if (!TICKER.test(t)) return bad();
    if (!list.includes(t)) list.push(t);
  }
  const r = await env.NEWSDESK.fetch(new Request('https://internal/reads', {
    method: 'POST', headers: {'Content-Type': 'application/json', 'X-PI-Internal': '1'}, body: JSON.stringify({tickers: list}),
  }));
  return passJSON(r);
}

export default {
  async fetch(req, env) {
    req = stripInternal(req);
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
    let res;
    try {
      if (url.pathname === '/' || url.pathname === '/health') res = await health(env);
      else if (!url.pathname.startsWith('/api/')) res = json({error: 'Not found'}, 404);
      else if (rateLimited(req, 'api')) res = json({error: 'Too many requests. Try again in a minute.'}, 429);
      else if (url.pathname === '/api/ask') {
        if (req.method !== 'POST') res = json({error: 'Not found'}, 404);
        else if (!originOk(req, env)) res = json({error: 'Not allowed'}, 403);
        else if (rateLimited(req, 'ask')) res = json({error: 'You have reached the assistant limit for now. Try again later.'}, 429);
        else res = await handleAsk(req, env);
      }
      else if (url.pathname.startsWith('/api/newsdesk/')) {
        const route = url.pathname === '/api/newsdesk/read' ? newsdeskReadRoute : url.pathname === '/api/newsdesk/reads' ? newsdeskReadsRoute : null;
        if (!route || req.method !== 'POST') res = json({error: 'Not found'}, 404);
        else if (!originOk(req, env)) res = json({error: 'Not allowed'}, 403);
        else res = await route(req, env);
      }
      else {
        const owner = ownerOf(url.pathname);
        const svc = owner && env[owner[2]];
        if (!owner) res = json({error: 'Not found'}, 404);
        else if (!svc) res = json({error: `The ${owner[1]} service is not available.`}, 503);
        else if (owner[1] === 'insights') { // the gateway vouches for public reads of the static analysis files
          const h = new Headers(req.headers); h.set('X-PI-Internal', '1');
          res = await svc.fetch(new Request(req, {headers: h}));
        }
        else res = await svc.fetch(req); // original method, path, headers (Origin, visitor IP) and body
      }
    } catch (e) {
      console.log('Gateway error', url.pathname, String(e && e.stack || e));
      res = json({error: 'The service is unavailable right now.'}, 502);
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    out.headers.set('X-Content-Type-Options', 'nosniff');
    out.headers.set('X-Frame-Options', 'DENY');
    return out;
  },
};
