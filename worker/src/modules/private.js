// Private markets module: SEC Form D and Form C raises from private_markets.json on Pages.
// The file is fetched only from the fixed PRIVATE_DATA_URL var (never from input), parsed once
// per isolate, and kept as a compact index sorted by filed date (newest first).
import {json, memGet, memSet, readCapped} from '../lib/http.js';
import {rateLimited} from '../lib/ratelimit.js';

export const STAGES = ['Pre-seed / seed', 'Seed / Series A', 'Growth', 'Late stage', 'Undisclosed'];
const FRESH_S = 3600;              // memory and Cache API freshness
const STALE_S = 48 * 3600;         // serve the last good copy this long after a failed fetch
const MAX_BYTES = 5 * 1024 * 1024; // size cap for the data file
const FETCH_MS = 10000;
const LIMIT_MAX = 100, LIMIT_DEFAULT = 25, OFFSET_MAX = 5000;

// Builds the in-memory index from the parsed file. Exported for tests.
export function buildIndex(data) {
  if (!data || !Array.isArray(data.raises)) throw new Error('bad data shape');
  const rows = data.raises.filter(r => r && typeof r === 'object' && typeof r.n === 'string')
    .sort((a, b) => String(b.d || '').localeCompare(String(a.d || '')));
  const idx = rows.map(r => ({
    st: String(r.st || '').toUpperCase(),
    city: String(r.city || '').toLowerCase(),
    ind: String(r.ind || '').toLowerCase(),
    n: String(r.n).toLowerCase(),
  }));
  return {updated: typeof data.updated === 'string' ? data.updated : null, rows, idx};
}

const err = msg => { const e = new Error(msg); e.bad = true; return e; };
const cleanText = (v, max, name) => {
  const s = String(v).trim().replace(/\s+/g, ' ');
  if (!s) return undefined;
  if (s.length > max || /[\u0000-\u001f<>]/.test(s)) throw err(`${name} is invalid`);
  return s;
};
const int = (v, lo, hi, name) => {
  if (!/^\d{1,5}$/.test(v)) throw err(`${name} must be a whole number`);
  const n = Number(v);
  if (n < lo || n > hi) throw err(`${name} must be ${lo} to ${hi}`);
  return n;
};

// Turns URLSearchParams (or a plain object) into checked filters. Throws {bad: true} on bad values.
// Unknown params are ignored.
export function parseFilters(params) {
  const get = k => {
    const v = params instanceof URLSearchParams ? params.get(k) : params[k];
    return v === null || v === undefined || v === '' ? undefined : String(v);
  };
  const f = {limit: LIMIT_DEFAULT, offset: 0};
  const st = get('state');
  if (st !== undefined) {
    if (!/^[A-Za-z]{2}$/.test(st.trim())) throw err('state must be 2 letters');
    f.state = st.trim().toUpperCase();
  }
  const city = get('city'); if (city !== undefined) f.city = cleanText(city, 40, 'city')?.toLowerCase();
  const stage = get('stage');
  if (stage !== undefined) {
    const hit = STAGES.find(s => s.toLowerCase() === stage.trim().toLowerCase());
    if (!hit) throw err('stage must be one of: ' + STAGES.join(', '));
    f.stage = hit;
  }
  const ind = get('industry'); if (ind !== undefined) f.industry = cleanText(ind, 60, 'industry')?.toLowerCase();
  const form = get('form');
  if (form !== undefined) {
    const u = form.trim().toUpperCase();
    if (u !== 'D' && u !== 'C') throw err('form must be D or C');
    f.form = u;
  }
  const q = get('q'); if (q !== undefined) f.q = cleanText(q, 60, 'q')?.toLowerCase();
  const limit = get('limit'); if (limit !== undefined) f.limit = int(limit, 1, LIMIT_MAX, 'limit');
  const offset = get('offset'); if (offset !== undefined) f.offset = int(offset, 0, OFFSET_MAX, 'offset');
  for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
  return f;
}

function matches(index, f) {
  const out = [];
  const {rows, idx} = index;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], x = idx[i];
    if (f.state && x.st !== f.state) continue;
    if (f.form && r.f !== f.form) continue;
    if (f.stage && r.stage !== f.stage) continue;
    if (f.city && x.city !== f.city) continue;
    if (f.industry && !x.ind.includes(f.industry)) continue;
    if (f.q && !x.n.includes(f.q) && !x.city.includes(f.q)) continue;
    out.push(r);
  }
  return out;
}

// Filtered, date-sorted page of raises. `f` is the output of parseFilters().
export function filterRaises(index, f = {}) {
  const all = matches(index, f);
  const limit = Math.min(Math.max(f.limit || LIMIT_DEFAULT, 1), LIMIT_MAX);
  const offset = Math.min(Math.max(f.offset || 0, 0), OFFSET_MAX);
  const raises = all.slice(offset, offset + limit);
  return {updated: index.updated, total: all.length, count: raises.length, offset, raises};
}

const top = (m, n) => Object.entries(m).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);

// Totals for the same filters (limit and offset do not apply).
export function statsOf(index, f = {}) {
  const all = matches(index, f);
  const by_stage = Object.fromEntries(STAGES.map(s => [s, 0]));
  const by_form = {D: 0, C: 0}, st = {}, ind = {};
  let total = 0;
  for (const r of all) {
    if (typeof r.amt === 'number' && isFinite(r.amt) && r.amt > 0) total += r.amt;
    if (r.stage in by_stage) by_stage[r.stage]++;
    if (r.f in by_form) by_form[r.f]++;
    if (r.st) st[r.st] = (st[r.st] || 0) + 1;
    if (r.ind) ind[r.ind] = (ind[r.ind] || 0) + 1;
  }
  return {updated: index.updated, count: all.length, total_amt: Math.round(total),
    by_stage, by_form, by_state_top: top(st, 10), by_industry_top: top(ind, 10)};
}

// Fetches the fixed data URL. Returns the text, or null on any failure.
async function fetchText(env) {
  const url = String(env.PRIVATE_DATA_URL || '');
  if (!/^https:\/\/[a-z0-9.-]+\.pages\.dev\/private_markets\.json$/.test(url)) {
    console.log('private', 'PRIVATE_DATA_URL is not set to a Pages URL');
    return null;
  }
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  try {
    const hit = cache && await cache.match(url);
    if (hit) return await hit.text();
  } catch { /* cache is best effort */ }
  try {
    const r = await fetch(url, {redirect: 'error', signal: AbortSignal.timeout(FETCH_MS), headers: {Accept: 'application/json'}});
    if (!r.ok) throw new Error('status ' + r.status);
    const ct = r.headers.get('Content-Type') || '';
    if (!/^application\/json\b/i.test(ct)) throw new Error('content type ' + ct.slice(0, 40));
    const len = Number(r.headers.get('Content-Length') || 0);
    if (len > MAX_BYTES) throw new Error('too large');
    const text = await readCapped(r.body, MAX_BYTES); // enforced while streaming, Content-Length or not
    if (text === null) throw new Error('too large');
    try {
      if (cache) await cache.put(url, new Response(text, {headers: {'Content-Type': 'application/json', 'Cache-Control': `max-age=${FRESH_S}`}}));
    } catch { /* best effort */ }
    return text;
  } catch (e) {
    console.log('private', 'fetch failed', String(e && e.message || e));
    return null;
  }
}

let loading = null;
// Returns the index, or null when no copy (fresh or up to 48 h old) is available.
export async function loadIndex(env) {
  const fresh = memGet('private:idx');
  if (fresh) return fresh;
  if (!loading) {
    loading = (async () => {
      const text = await fetchText(env);
      if (text) {
        try {
          const index = buildIndex(JSON.parse(text));
          memSet('private:idx', index, FRESH_S);
          memSet('private:last', index, STALE_S);
          return index;
        } catch (e) { console.log('private', 'parse failed', String(e && e.message || e)); }
      }
      const last = memGet('private:last');
      if (last) memSet('private:idx', last, 300); // retry the fetch in 5 minutes
      return last || null;
    })().finally(() => { loading = null; });
  }
  return loading;
}

const limited = req => { try { return rateLimited(req, 'private'); } catch { return false; } };

async function handle(req, env, url, fn) {
  if (limited(req)) return json({error: 'Too many requests. Try again in a minute.'}, 429);
  let f;
  try { f = parseFilters(url.searchParams); } catch (e) {
    if (e.bad) return json({error: e.message}, 400);
    throw e;
  }
  const index = await loadIndex(env);
  if (!index) return json({error: 'Private markets data is not available right now'}, 502);
  return json(fn(index, f), 200, {'Cache-Control': 'no-store'});
}

export const list = (req, env, url) => handle(req, env, url, filterRaises);
export const stats = (req, env, url) => handle(req, env, url, statsOf);
