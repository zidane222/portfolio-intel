// Cloudflare Access JWT check for pi-flags. Fails closed: any missing setting, missing or bad token,
// wrong audience, issuer or email, or expired token gives null (the caller answers 403).
// The actor email comes only from the verified token. Nothing here logs the token or the email.
const TEAM_RE = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
const AUD_RE = /^[a-f0-9]{64}$/;
let JWKS = {team: '', at: 0, keys: []};
// Last forced refetch (unknown kid, for example after Access rotates its keys). At most one a minute per isolate.
let FORCED_AT = -Infinity;
const FORCE_GAP_MS = 60 * 1000;
export function _resetJwks() { JWKS = {team: '', at: 0, keys: []}; FORCED_AT = -Infinity; }

const b64u = s => {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - t.length % 4) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};
const parse = s => JSON.parse(new TextDecoder().decode(b64u(s)));

export function accessConfig(env) {
  const team = String(env.ACCESS_TEAM_DOMAIN || '').trim().replace(/\/+$/, '');
  const aud = String(env.ACCESS_AUD || '').trim().toLowerCase();
  const admins = String(env.ADMIN_EMAIL || '').split(',').map(s => s.trim().toLowerCase()).filter(s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
  if (!TEAM_RE.test(team) || !AUD_RE.test(aud) || admins.length !== 1) return null;
  return {team, aud, admin: admins[0]};
}

async function keys(team, fetcher, now, force = false) {
  if (!force && JWKS.team === team && now - JWKS.at < 10 * 60 * 1000 && JWKS.keys.length) return JWKS.keys;
  const r = await fetcher(`${team}/cdn-cgi/access/certs`, {redirect: 'manual', signal: AbortSignal.timeout(5000)});
  if (!r.ok) throw new Error('certs ' + r.status);
  const d = await r.json();
  const list = Array.isArray(d && d.keys) ? d.keys.filter(k => k && k.kty === 'RSA' && k.kid) : [];
  JWKS = {team, at: now, keys: list};
  return list;
}

// -> {email} or null
export async function verifyAccess(req, env, {fetcher = fetch, now = Date.now()} = {}) {
  const cfg = accessConfig(env);
  if (!cfg) return null;
  const tok = req.headers.get('Cf-Access-Jwt-Assertion') || '';
  const parts = tok.split('.');
  if (parts.length !== 3 || tok.length > 8192) return null;
  try {
    const head = parse(parts[0]), body = parse(parts[1]);
    if (head.alg !== 'RS256' || typeof head.kid !== 'string') return null;
    const fetchedAt = JWKS.at;
    let jwk = (await keys(cfg.team, fetcher, now)).find(k => k.kid === head.kid);
    // Unknown kid from cached keys: refetch once, rate limited. Still null (403) if it is not there.
    if (!jwk && JWKS.at === fetchedAt && now - FORCED_AT >= FORCE_GAP_MS) {
      FORCED_AT = now;
      jwk = (await keys(cfg.team, fetcher, now, true)).find(k => k.kid === head.kid);
    }
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', {kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true},
      {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
    if (!ok) return null;
    const aud = Array.isArray(body.aud) ? body.aud : [body.aud];
    if (!aud.includes(cfg.aud)) return null;
    if (body.iss !== cfg.team) return null;
    const sec = Math.floor(now / 1000);
    if (typeof body.exp !== 'number' || body.exp <= sec) return null;
    if (typeof body.nbf === 'number' && body.nbf > sec + 60) return null;
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email || email !== cfg.admin) return null;
    return {email};
  } catch (e) { return null; }
}
