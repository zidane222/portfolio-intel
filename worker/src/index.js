// Portfolio Intel API gateway (Cloudflare Worker).
// The only public entry point. It handles CORS, the overall rate limit and security headers,
// then forwards each request to the service that owns it over a private service binding.
// Services: market, news, rates, ai, broker, disclosures, private (src/services/*.js).
// POST /api/ask is handled here by the agent supervisor (src/agents/), which reaches the
// services only through their bindings.
import {json, corsHeaders, originOk} from './lib/http.js';
import {rateLimited} from './lib/ratelimit.js';
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

export default {
  async fetch(req, env) {
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
      else {
        const owner = ownerOf(url.pathname);
        const svc = owner && env[owner[2]];
        if (!owner) res = json({error: 'Not found'}, 404);
        else if (!svc) res = json({error: `The ${owner[1]} service is not available.`}, 503);
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
