// Feature flags: one registry, read by the gateway, pi-newsdesk and (through GET /api/flags) the app,
// the Render fallback and the GitHub jobs. Only pi-flags writes the KV key.
// scripts/flags_registry.json must match REGISTRY exactly (worker/test/flags.mjs checks it).
//
// fail: what a flag reads as when KV cannot be read.
//   'closed' -> last known value if this isolate has one, else off
//   'last'   -> last known value, else the default
//   'open'   -> last known value, else the default (same as 'last'; kept separate so intent is clear)
// When the FLAGS binding is not configured at all (feature not set up yet), every flag reads its default.
import {json} from './http.js';

export const KEY = 'flags:v1';
// Isolate cache. With /api/flags max-age (FLAGS_MAX_AGE) and KV propagation (up to about 60 s) this keeps
// a change visible within about a minute in most cases and about 90 s at worst.
export const CACHE_MS = 10 * 1000;
export const FLAGS_MAX_AGE = 15;

export const REGISTRY = {
  maintenance:   {default: false, fail: 'last',   kind: 'route', label: 'Maintenance: every flaggable route off'},
  broker:        {default: true,  fail: 'closed', kind: 'route', label: 'Brokerage link (Plaid)'},
  sync_writes:   {default: true,  fail: 'closed', kind: 'client', label: 'Cloud sync uploads'},
  ai:            {default: true,  fail: 'open',   kind: 'route', label: 'AI assistant (/api/ask and /api/ai)'},
  news:          {default: true,  fail: 'open',   kind: 'route', label: 'News and news reads'},
  disclosures:   {default: true,  fail: 'open',   kind: 'route', label: 'Congressional trades'},
  market:        {default: true,  fail: 'open',   kind: 'route', label: 'Prices, history, sectors, dividends'},
  house_scrape:  {default: true,  fail: 'open',   kind: 'job', label: 'Daily House scrape'},
  senate_scrape: {default: true,  fail: 'open',   kind: 'job', label: 'Daily Senate fetch'},
  fmp_fill:      {default: true,  fail: 'open',   kind: 'job', label: 'FMP paper filing fill'},
  recon_v2:      {default: false, fail: 'open',   kind: 'job', label: 'Reconciliation v2 (off runs the current check)'},
  sync:          {default: true,  fail: 'closed', kind: 'job', label: 'Jira and ADO sync'},
  sync_dryrun:   {default: true,  fail: 'closed', kind: 'job', label: 'Sync dry run: log only, no writes'},
};
export const NAMES = Object.keys(REGISTRY);

// Disabled answer shared by the gateway and the Render fallback.
export const DISABLED_MSG = 'This feature is turned off for now. Try again later.';
export function disabled(name) {
  return json({error: DISABLED_MSG, disabled: true, flag: name}, 503, {'Retry-After': '60', 'X-PI-Flag': 'off', 'Cache-Control': 'no-store'});
}

// Read a stored document: it needs a numeric version and a flags object, and every known flag
// in it must hold a boolean. Names no longer in REGISTRY (removed or renamed flags) are dropped,
// so one stale name never makes the whole document unreadable. Returns the cleaned doc or null.
export function cleanDoc(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d) || !Number.isInteger(d.v) || d.v < 0) return null;
  if (!d.flags || typeof d.flags !== 'object' || Array.isArray(d.flags)) return null;
  const flags = {};
  for (const n of NAMES) {
    if (!Object.prototype.hasOwnProperty.call(d.flags, n)) continue;
    const f = d.flags[n];
    if (!f || typeof f !== 'object' || typeof f.on !== 'boolean') return null;
    flags[n] = f;
  }
  return {...d, flags};
}
export function validDoc(d) { return cleanDoc(d) !== null; }

// Isolate state. MEM is the 10 s cache; LAST is the last good document read from KV.
let MEM = {at: 0, doc: null, state: 'unset'};
let LAST = null;
export function _reset() { MEM = {at: 0, doc: null, state: 'unset'}; LAST = null; } // tests

// -> {doc, state}: state 'ok' (read, doc may be null when the key was never written),
// 'error' (binding present but unreadable or invalid) or 'unset' (no binding).
export async function load(env, now = Date.now()) {
  if (!env || !env.FLAGS || typeof env.FLAGS.get !== 'function') return {doc: null, state: 'unset'};
  if (MEM.state !== 'unset' && now - MEM.at < CACHE_MS) return MEM;
  let doc = null, state = 'ok';
  try {
    doc = await env.FLAGS.get(KEY, 'json');
    if (doc !== null) { doc = cleanDoc(doc); if (doc === null) state = 'error'; }
  } catch (e) { state = 'error'; }
  if (state === 'ok' && doc) LAST = doc;
  MEM = {at: now, doc, state};
  return MEM;
}

export function resolve(name, {doc, state}) {
  const reg = REGISTRY[name];
  if (!reg) return true; // unknown names never turn anything off
  if (state === 'ok') return doc && doc.flags[name] ? doc.flags[name].on : reg.default;
  if (state === 'unset') return reg.default;
  if (LAST && LAST.flags[name]) return LAST.flags[name].on; // unreadable: last known first
  return reg.fail === 'closed' ? false : reg.default;
}

export async function flagOn(env, name) { return resolve(name, await load(env)); }

export async function publicFlags(env) {
  const got = await load(env);
  const base = got.state === 'ok' ? got.doc : LAST;
  const flags = Object.fromEntries(NAMES.map(n => [n, resolve(n, got)]));
  return {v: base ? base.v : 0, updated: base ? base.updated || null : null, flags};
}

// Which flags guard a gateway path. Health and /api/flags are never flaggable (callers check first).
// maintenance covers every other /api/* route, including the unflagged ones (rates, private, insights).
export function flagsFor(path, ownerFlag) {
  const out = ['maintenance'];
  if (path === '/api/ask') out.push('ai');
  else if (ownerFlag) out.push(ownerFlag);
  return out;
}

// First flag in the list that is off, or null.
export async function firstOff(env, names) {
  const got = await load(env);
  for (const n of names) {
    const on = resolve(n, got);
    if (n === 'maintenance' ? on : !on) return n; // maintenance on means the routes are off
  }
  return null;
}
