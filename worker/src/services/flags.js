// pi-flags: the only writer of the feature flag KV key (flags:v1). Owner admin page plus a small JSON API.
// Every route requires a valid Cloudflare Access token for the one allowed email (lib/access.js); without
// Access configured everything answers 403. The gateway never forwards to this Worker.
// Routes: GET /admin (page), /admin/app.js, /admin/app.css, GET /admin/flags, GET /admin/audit?since=ISO,
//         POST /admin/flags {name, on, reason, v} with header X-PI-Flags: 1 and a same-origin Origin.
// Audit: KV audit:{ISO}:{rand} (no TTL) and, when SUPABASE_FLAGS_KEY is bound, a Supabase flag_audit row.
import {json, readCapped} from '../lib/http.js';
import {resolveSecrets} from '../lib/secrets.js';
import {verifyAccess} from '../lib/access.js';
import {makeSupabase} from '../lib/supabase.js';
import {KEY, REGISTRY, NAMES, validDoc} from '../lib/flags.js';
import {PAGE, SCRIPT, STYLE} from './flags-page.js';

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const asset = (body, type) => new Response(body, {headers: {'Content-Type': type, 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store'}});
const deny = () => json({error: 'Not allowed'}, 403, {'Cache-Control': 'no-store'});

// Reason: 3 to 200 characters after trimming, control characters removed. Shown with textContent only.
export function cleanReason(r) {
  if (typeof r !== 'string') return null;
  const s = r.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length >= 3 && s.length <= 200 ? s : null;
}

export function emptyDoc() { return {v: 0, updated: null, flags: {}}; }

async function readDoc(env) {
  const d = await env.FLAGS.get(KEY, 'json');
  if (d === null) return emptyDoc();
  if (!validDoc(d)) throw new Error('stored flags are not valid');
  return d;
}

function view(doc) {
  return {v: doc.v, updated: doc.updated, flags: Object.fromEntries(NAMES.map(n => {
    const f = doc.flags[n];
    return [n, {on: f ? f.on : REGISTRY[n].default, default: REGISTRY[n].default, fail: REGISTRY[n].fail, kind: REGISTRY[n].kind,
      label: REGISTRY[n].label, by: f ? f.by : null, at: f ? f.at : null, reason: f ? f.reason : null}];
  }))};
}

const rand = () => [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');

async function writeAudit(env, rec) {
  const key = `audit:${rec.at}:${rand()}`;
  await env.FLAGS.put(key, JSON.stringify(rec), {metadata: rec});
  if (env.SUPABASE_FLAGS_KEY && typeof env.SUPABASE_FLAGS_KEY === 'string') {
    try {
      const sb = makeSupabase({SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SERVICE_KEY: env.SUPABASE_FLAGS_KEY});
      await sb.rpc('flag_audit_add', {p_id: rec.id, p_at: rec.at, p_flag: rec.name, p_on: rec.on, p_actor: rec.by, p_reason: rec.reason, p_v: rec.v});
    } catch (e) { console.log('flag audit to Supabase failed', String(e && e.message || e).slice(0, 80)); } // message has op and status only
  }
}

export async function listAudit(env, since, limit = 20) {
  const out = [];
  let cursor;
  const floor = since ? `audit:${since}` : 'audit:';
  for (let i = 0; i < 20; i++) {
    const page = await env.FLAGS.list({prefix: 'audit:', cursor, limit: 1000});
    for (const k of page.keys) if (k.name > floor && k.metadata) out.push(k.metadata);
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  out.sort((a, b) => (a.at < b.at ? 1 : -1));
  return out.slice(0, limit);
}

async function postFlag(req, env, actor, url) {
  if (req.headers.get('X-PI-Flags') !== '1') return deny();
  if (req.headers.get('Origin') !== url.origin) return deny();
  const text = await readCapped(req.body, 2048);
  if (text === null) return json({error: 'Request too large'}, 413);
  let b;
  try { b = JSON.parse(text); } catch (e) { b = null; }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return json({error: 'Bad request'}, 400);
  if (!NAMES.includes(b.name)) return json({error: 'Unknown flag'}, 400);
  if (typeof b.on !== 'boolean') return json({error: 'Say on or off.'}, 400);
  const reason = cleanReason(b.reason);
  if (!reason) return json({error: 'Give a reason of 3 to 200 characters.'}, 400);
  if (!Number.isInteger(b.v)) return json({error: 'Bad request'}, 400);
  const doc = await readDoc(env);
  if (b.v !== doc.v) return json({error: 'Someone changed the flags since you loaded them. Reload and try again.', v: doc.v}, 409);
  const at = new Date().toISOString();
  const next = {v: doc.v + 1, updated: at, flags: {...doc.flags, [b.name]: {on: b.on, by: actor.email, at, reason}}};
  await env.FLAGS.put(KEY, JSON.stringify(next));
  await writeAudit(env, {id: crypto.randomUUID(), at, name: b.name, on: b.on, by: actor.email, reason, v: next.v});
  console.log('flag changed', JSON.stringify({name: b.name, on: b.on, v: next.v})); // no actor, no reason
  return json(view(next), 200, {'Cache-Control': 'no-store'});
}

export default {
  async fetch(req, rawEnv) {
    const env = await resolveSecrets(rawEnv);
    const url = new URL(req.url);
    const actor = await verifyAccess(req, env);
    if (!actor) return deny();
    if (!env.FLAGS) return json({error: 'Flags storage is not linked.'}, 503);
    try {
      const p = url.pathname, m = req.method;
      if (m === 'GET' && (p === '/admin' || p === '/admin/')) return asset(PAGE, 'text/html; charset=utf-8');
      if (m === 'GET' && p === '/admin/app.js') return asset(SCRIPT, 'text/javascript; charset=utf-8');
      if (m === 'GET' && p === '/admin/app.css') return asset(STYLE, 'text/css; charset=utf-8');
      if (m === 'GET' && p === '/admin/flags') return json(view(await readDoc(env)), 200, {'Cache-Control': 'no-store'});
      if (m === 'GET' && p === '/admin/audit') {
        const since = url.searchParams.get('since') || '';
        if (since && !/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(since)) return json({error: 'Bad since'}, 400);
        return json({audit: await listAudit(env, since)}, 200, {'Cache-Control': 'no-store'});
      }
      if (m === 'POST' && p === '/admin/flags') return await postFlag(req, env, actor, url);
      return json({error: 'Not found'}, 404);
    } catch (e) {
      console.log('pi-flags error', String(e && e.message || e).slice(0, 80));
      return json({error: 'Server error'}, 500);
    }
  },
};
