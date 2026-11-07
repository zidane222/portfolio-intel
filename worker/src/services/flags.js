// pi-flags: the only writer of the feature flag KV key (flags:v1). Owner admin page plus a small JSON API.
// Every route requires a valid Cloudflare Access token for the one allowed email (lib/access.js); without
// Access configured everything answers 403. The gateway never forwards to this Worker.
// Routes: GET /admin (page), /admin/app.js, /admin/app.css, GET /admin/flags, GET /admin/audit?since=ISO,
//         POST /admin/flags {name, on, reason, v} with header X-PI-Flags: 1 and a same-origin Origin.
// Audit: KV audit:r:{inverted ms}:{rand} (no TTL, newest sorts first) written BEFORE the flag change, and,
// when SUPABASE_FLAGS_KEY is bound, a Supabase flag_audit row (the full history).
import {json, readCapped} from '../lib/http.js';
import {resolveSecrets} from '../lib/secrets.js';
import {verifyAccess} from '../lib/access.js';
import {makeSupabase} from '../lib/supabase.js';
import {KEY, REGISTRY, NAMES, cleanDoc} from '../lib/flags.js';
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
  const c = cleanDoc(d); // drops names no longer in REGISTRY; a POST then writes the cleaned doc
  if (c === null) throw new Error('stored flags are not valid');
  return c;
}

function view(doc) {
  return {v: doc.v, updated: doc.updated, flags: Object.fromEntries(NAMES.map(n => {
    const f = doc.flags[n];
    return [n, {on: f ? f.on : REGISTRY[n].default, default: REGISTRY[n].default, fail: REGISTRY[n].fail, kind: REGISTRY[n].kind,
      label: REGISTRY[n].label, by: f ? f.by : null, at: f ? f.at : null, reason: f ? f.reason : null}];
  }))};
}

const rand = () => [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');

// Reverse-timestamp key: KV lists keys in ascending order, so the newest record is first and
// /admin/audit reads one page of 20 instead of every key.
export const AUDIT_PREFIX = 'audit:r:';
const MAX_MS = 9999999999999;
export const auditKey = at => `${AUDIT_PREFIX}${String(MAX_MS - Date.parse(at)).padStart(13, '0')}:${rand()}`;

// KV metadata is capped at 1024 bytes of JSON. The value keeps the full record; the metadata (what
// /admin/audit lists) trims the reason by UTF-8 bytes, then drops it, so a long non-ASCII reason plus
// a long email never fails the write. rt: true marks a trimmed reason.
export const META_MAX = 1000; // margin under the 1024 byte limit
const u8len = s => new TextEncoder().encode(s).length;
export function auditMeta(rec) {
  if (u8len(JSON.stringify(rec)) <= META_MAX) return rec;
  const cps = [...String(rec.reason || '')];
  let lo = 0, hi = cps.length;
  while (lo < hi) { // longest prefix that fits
    const mid = Math.ceil((lo + hi) / 2);
    if (u8len(JSON.stringify({...rec, reason: cps.slice(0, mid).join(''), rt: true})) <= META_MAX) lo = mid; else hi = mid - 1;
  }
  const m = {...rec, reason: cps.slice(0, lo).join(''), rt: true};
  if (u8len(JSON.stringify(m)) <= META_MAX) return m;
  return {id: rec.id, at: rec.at, name: rec.name, on: rec.on, v: rec.v, by: String(rec.by || '').slice(0, 200), reason: '', rt: true};
}

// KV record first. Throws when KV cannot store it, so the caller never changes a flag without one.
async function writeAuditKv(env, rec) {
  await env.FLAGS.put(auditKey(rec.at), JSON.stringify(rec), {metadata: auditMeta(rec)});
}

async function writeAuditSupabase(env, rec) {
  if (!env.SUPABASE_FLAGS_KEY || typeof env.SUPABASE_FLAGS_KEY !== 'string') return;
  try {
    const sb = makeSupabase({SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SERVICE_KEY: env.SUPABASE_FLAGS_KEY});
    await sb.rpc('flag_audit_add', {p_id: rec.id, p_at: rec.at, p_flag: rec.name, p_on: rec.on, p_actor: rec.by, p_reason: rec.reason, p_v: rec.v});
  } catch (e) { console.log('flag audit to Supabase failed', String(e && e.message || e).slice(0, 80)); } // message has op and status only
}

// One list call: newest first by key order. since (ISO) keeps only records after it.
export async function listAudit(env, since, limit = 20) {
  const page = await env.FLAGS.list({prefix: AUDIT_PREFIX, limit});
  const out = [];
  for (const k of page.keys) {
    const m = k.metadata;
    if (!m) continue;
    if (since && !(m.at > since)) break; // keys are newest first, so everything after is older
    out.push(m);
  }
  return out;
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
  const rec = {id: crypto.randomUUID(), at, name: b.name, on: b.on, by: actor.email, reason, v: next.v};
  try { await writeAuditKv(env, rec); } catch (e) {
    console.log('flag audit write failed, flag not changed', String(e && e.message || e).slice(0, 80));
    return json({error: 'Could not record the change, so the flag was not changed. Try again.'}, 503, {'Cache-Control': 'no-store'});
  }
  // If this put fails the audit holds a record for v that never landed; the flags doc v shows the truth.
  await env.FLAGS.put(KEY, JSON.stringify(next));
  await writeAuditSupabase(env, rec);
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
