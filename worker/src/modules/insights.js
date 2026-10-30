// Insights module: serves insights.json and strategies.json (Pages) per the Phase 4 contract
// (docs/plans/phase4-data-science-strategy.md section 7). Files are fetched only from the fixed
// INSIGHTS_DATA_URL var (never from input), checked for schema and size, reduced to the known
// top-level keys, cached 1 h, and the last good copy is served up to 48 h when Pages fails.
import {json, memGet, memSet, readCapped} from '../lib/http.js';
import {rateLimited} from '../lib/ratelimit.js';

const FRESH_S = 3600, STALE_S = 48 * 3600, MAX_BYTES = 5 * 1024 * 1024, FETCH_MS = 10000;
const STALE_AFTER_MS = 10 * 86400000;

export const KINDS = {
  insights: {file: 'insights.json', schema: 'pi/insights/v1', keys: ['schema', 'method_version', 'generated', 'code_version', 'data_asof', 'label', 'params', 'coverage', 'tests_run', 'findings', 'tested', 'scan_summary', 'descriptive', 'news_stance', 'caveats'], lists: ['findings', 'caveats']},
  strategies: {file: 'strategies.json', schema: 'pi/strategies/v1', keys: ['schema', 'method_version', 'generated', 'data_asof', 'label', 'benchmark', 'assumptions', 'strategies_tried', 'runs', 'caveats'], lists: ['runs', 'caveats']},
};

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

// Checks the parsed file and drops unknown top-level keys. Throws on a bad shape. Exported for tests.
export function checkDoc(kind, data) {
  const k = KINDS[kind];
  if (!isObj(data) || data.schema !== k.schema) throw new Error('bad schema');
  if (typeof data.generated !== 'string' || isNaN(Date.parse(data.generated))) throw new Error('bad generated');
  if (typeof data.label !== 'string' || !data.label) throw new Error('missing label');
  for (const l of k.lists) if (!Array.isArray(data[l])) throw new Error(l + ' must be a list');
  const out = {};
  for (const key of k.keys) if (Object.hasOwn(data, key)) out[key] = data[key];
  return out;
}

// Adds served_asof and stale (generated more than 10 days ago, or unreadable).
export function decorate(doc, now = Date.now()) {
  const gen = Date.parse(doc.generated);
  return {...doc, served_asof: new Date(now).toISOString(), stale: !(now - gen <= STALE_AFTER_MS)};
}

function urlFor(env, kind) {
  const base = String(env.INSIGHTS_DATA_URL || '');
  if (!/^https:\/\/[a-z0-9.-]+\.pages\.dev\/insights\.json$/.test(base)) return null;
  return base.replace(/insights\.json$/, KINDS[kind].file);
}

async function fetchText(env, kind) {
  const url = urlFor(env, kind);
  if (!url) { console.log('insights', 'INSIGHTS_DATA_URL is not set to a Pages URL'); return null; }
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  try {
    const hit = cache && await cache.match(url);
    if (hit) return await hit.text();
  } catch { /* cache is best effort */ }
  try {
    const r = await fetch(url, {redirect: 'manual', signal: AbortSignal.timeout(FETCH_MS), headers: {Accept: 'application/json'}});
    if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) throw new Error('redirect refused');
    if (!r.ok) throw new Error('status ' + r.status);
    const ct = r.headers.get('Content-Type') || '';
    if (!/^application\/json\b/i.test(ct)) throw new Error('content type ' + ct.slice(0, 40));
    if (Number(r.headers.get('Content-Length') || 0) > MAX_BYTES) throw new Error('too large');
    const text = await readCapped(r.body, MAX_BYTES);
    if (text === null) throw new Error('too large');
    try {
      if (cache) await cache.put(url, new Response(text, {headers: {'Content-Type': 'application/json', 'Cache-Control': `max-age=${FRESH_S}`}}));
    } catch { /* best effort */ }
    return text;
  } catch (e) {
    console.log('insights', 'fetch failed', kind, String(e && e.message || e));
    return null;
  }
}

const loading = {};
// Returns the checked document, or null when no copy (fresh or up to 48 h old) exists.
export async function loadDoc(env, kind) {
  const fresh = memGet(`insights:${kind}`);
  if (fresh) return fresh;
  if (!loading[kind]) {
    loading[kind] = (async () => {
      const text = await fetchText(env, kind);
      if (text) {
        try {
          const doc = checkDoc(kind, JSON.parse(text));
          memSet(`insights:${kind}`, doc, FRESH_S);
          memSet(`insights:${kind}:last`, doc, STALE_S);
          return doc;
        } catch (e) { console.log('insights', 'parse failed', kind, String(e && e.message || e)); }
      }
      const last = memGet(`insights:${kind}:last`);
      if (last) memSet(`insights:${kind}`, last, 300); // retry the fetch in 5 minutes
      return last || null;
    })().finally(() => { loading[kind] = null; });
  }
  return loading[kind];
}

const limited = req => { try { return rateLimited(req, 'insights'); } catch { return false; } };
const internal = req => req.headers.get('X-PI-Internal') === '1';

function route(kind) {
  return async (req, env) => {
    if (!internal(req)) return json({error: 'Not found'}, 404);
    if (limited(req)) return json({error: 'Too many requests. Try again in a minute.'}, 429);
    const doc = await loadDoc(env, kind);
    if (!doc) return json({error: 'Insights data is not available right now'}, 502);
    return json(decorate(doc), 200, {'Cache-Control': 'no-store'});
  };
}
export const getInsights = route('insights');
export const getStrategies = route('strategies');
