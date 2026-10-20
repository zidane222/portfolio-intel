// Builds a service Worker from a route table. Services are private (no public URL) and are
// reached only through the gateway, which handles CORS and the overall rate limit.
import {json} from './http.js';
import {resolveSecrets} from './secrets.js';

export function matchRoute(routes, req, url) {
  const hit = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
  if (!hit) return null;
  const raw = url.pathname.match(hit[1])[1];
  return [hit[2], raw ? decodeURIComponent(raw) : raw];
}

export function makeService(name, routes) {
  return {
    async fetch(req, rawEnv) {
      const env = await resolveSecrets(rawEnv);
      const url = new URL(req.url);
      if (url.pathname === '/health') return json({service: name, status: 'ok'});
      try {
        const m = matchRoute(routes, req, url);
        if (!m) return json({error: 'Not found'}, 404);
        return await m[0](req, env, url, m[1]);
      } catch (e) {
        console.log(name, 'error', url.pathname, String(e && e.stack || e));
        return json({error: 'Server error'}, 500);
      }
    },
  };
}
