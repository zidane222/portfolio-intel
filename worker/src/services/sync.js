// pi-sync: keeps Jira KAN and Azure DevOps portfolio-intel in step (plan docs/plans/pi-sync.md).
// Cron only (config/sync.toml, every 5 minutes). No public URL, no gateway binding, no service
// bindings: every fetch answers 404. Calls only Jira Cloud and Azure DevOps.
// Secrets JIRA_EMAIL, JIRA_API_TOKEN, ADO_PAT come from the Secrets Store and are never logged.
// Flags: sync (off: exit) and sync_dryrun (on: plan and log only). Flags unreadable: write nothing.
import {resolveSecrets} from '../lib/secrets.js';
import {load as loadFlags, resolve as flagValue} from '../lib/flags.js';
import {makeJira} from '../modules/sync/jira.js';
import {makeAdo} from '../modules/sync/ado.js';
import * as M from '../modules/sync/map.js';
import {decide, eligibleForCreate, planCreateAdo, planCreateJira} from '../modules/sync/diff.js';

export const BUDGET = 45;        // of the 50 subrequests a free plan invocation allows
export const OVERLAP_MS = 10 * 60 * 1000;
const LIST_CAP = 50;

const code = e => { const m = String(e && e.message || e); return /^[a-z_0-9]+$/.test(m) ? m : 'error'; };

export async function tick(env, {fetch: f = globalThis.fetch, now = Date.now(), log = console.log} = {}) {
  const at = new Date(now).toISOString();
  const got = await loadFlags(env, now);
  if (got.state === 'error') { log('sync tick', JSON.stringify({at, skipped: 'flags_unreadable'})); return {skipped: 'flags_unreadable'}; }
  if (!flagValue('sync', got)) { log('sync tick', JSON.stringify({at, skipped: 'sync_off'})); return {skipped: 'sync_off'}; }
  const dryrun = flagValue('sync_dryrun', got);
  const kv = env.SYNC;
  if (!kv || typeof kv.get !== 'function') { log('sync tick', JSON.stringify({at, skipped: 'no_kv'})); return {skipped: 'no_kv'}; }

  let calls = 0;
  const count = () => { calls++; };
  let jira, ado;
  try {
    jira = makeJira({base: env.JIRA_BASE, email: env.JIRA_EMAIL, token: env.JIRA_API_TOKEN, project: env.JIRA_PROJECT || 'KAN', fetch: f, count});
    ado = makeAdo({org: env.ADO_ORG_URL, project: env.ADO_PROJECT, pat: env.ADO_PAT, fetch: f, count});
  } catch (e) { log('sync tick', JSON.stringify({at, skipped: code(e)})); return {skipped: code(e)}; }

  const maxPairs = Math.max(1, Math.min(15, Number(env.SYNC_MAX_PAIRS) || 15));
  const sum = {at, dryrun, scanned: 0, planned: 0, written: 0, skipped: 0, waiting: 0, errors: [], notices: [], unpaired: {jira: [], ado: [], jira_n: 0, ado_n: 0}, calls: 0};
  const actions = [];
  let truncated = false;

  // State (fail closed: KV unreadable means no writes at all).
  let cursorJ, cursorA, firstLive, index;
  try {
    [cursorJ, cursorA, firstLive] = await Promise.all([kv.get('cursor:jira'), kv.get('cursor:ado'), kv.get('meta:first_live')]);
    index = await loadIndex(kv);
  } catch (e) { log('sync tick', JSON.stringify({at, skipped: 'kv_unreadable'})); return {skipped: 'kv_unreadable'}; }

  if (!dryrun && !firstLive) { firstLive = at; await kv.put('meta:first_live', at); }

  // Scan. Dry run reads everything so the unpaired report is complete; live reads changes since the cursor.
  let js, as;
  try {
    const full = dryrun || !cursorJ || !cursorA;
    [js, as] = full ? await Promise.all([jira.all(), ado.all()])
      : await Promise.all([jira.changedSince((now - Date.parse(cursorJ) + OVERLAP_MS) / 60000), ado.changedSince(Date.parse(cursorA) - OVERLAP_MS)]);
  } catch (e) { sum.errors.push({pair: 'scan', code: code(e)}); return finish(); }

  const J = new Map(js.filter(M.jiraEligible).map(j => [j.key, j]));
  const A = new Map(as.filter(a => a.type).map(a => [a.id, a]));
  sum.scanned = J.size + A.size;

  // Pair key per side: ADO tag first (source of truth), then the KV index, then the Jira label.
  const keyForAdo = a => a.kan || index.byAdo.get(a.id) || [...J.values()].find(j => j.ado === a.id)?.key || null;
  const adoForKey = j => { for (const a of A.values()) if (a.kan === j.key) return a.id; return index.byKan.get(j.key) || j.ado || null; };

  const pairs = new Map(); // key -> ado id
  for (const a of A.values()) { const k = keyForAdo(a); if (k) pairs.set(k, a.id); }
  for (const j of J.values()) { const id = adoForKey(j); if (id && !pairs.has(j.key)) pairs.set(j.key, id); }

  // Fetch the other side of changed pairs (live mode).
  try {
    const needJ = [...pairs.keys()].filter(k => !J.has(k)), needA = [...pairs.values()].filter(id => !A.has(id));
    const [moreJ, moreA] = await Promise.all([jira.byKeys(needJ.slice(0, 50)), ado.byIds(needA.slice(0, 200))]);
    for (const j of moreJ) if (M.jiraEligible(j)) J.set(j.key, j);
    for (const a of moreA) if (a.type) A.set(a.id, a);
  } catch (e) { sum.errors.push({pair: 'counterpart', code: code(e)}); return finish(); }

  const ctx = {
    adoForKan: k => pairs.get(k) || index.byKan.get(k) || null,
    kanForAdo: id => { for (const [k, v] of pairs) if (v === id) return k; return index.byAdo.get(id) || null; },
    parentUrl: ado.parentUrl, now: at,
  };

  const plans = [];
  const pairedA = new Set();
  for (const [key, id] of pairs) {
    const j = J.get(key), a = A.get(id);
    pairedA.add(id);
    if (!j || !a) { if (a && a.internal) { sum.skipped++; continue; } sum.errors.push({pair: key, code: !j ? 'jira_missing' : 'ado_missing'}); continue; }
    let rec = null;
    try { rec = await kv.get('pair:' + key, 'json'); } catch (e) { sum.errors.push({pair: key, code: 'kv_unreadable'}); continue; }
    plans.push({kind: 'pair', d: decide(rec, j, a, ctx), j, a, key});
  }
  for (const j of J.values()) {
    if (pairs.has(j.key) || j.type === 'bug') continue;
    if (!M.jiraMayCreateAdo(j) || !eligibleForCreate(j.created, firstLive)) { unpaired('jira', j.hint ? j.key + '~ado:' + j.hint : j.key); continue; }
    plans.push({kind: 'create', d: planCreateAdo(j, ctx), src: j});
  }
  for (const a of A.values()) {
    if (pairedA.has(a.id) || !M.adoEligible(a)) continue;
    if (!eligibleForCreate(a.created, firstLive)) { unpaired('ado', a.id); continue; }
    plans.push({kind: 'create', d: planCreateJira(a, ctx), src: a});
  }

  for (const p of plans) {
    const d = p.d;
    if (d.error) { sum.errors.push({pair: d.pair, code: d.error}); continue; }
    if (d.wait) { sum.waiting++; continue; }
    if (d.skip) {
      sum.skipped++;
      if (d.notices && d.notices.length) sum.notices.push({pair: d.pair, codes: d.notices});
      if (d.rec && !dryrun && d.skip !== 'echo' && d.skip !== 'internal') await safePut(kv, 'pair:' + d.rec.jira, d.rec, sum);
      continue;
    }
    if (sum.planned >= maxPairs) { truncated = true; continue; }
    sum.planned++;
    actions.push(d.action);
    log('sync plan', JSON.stringify(d.action));
    if (d.notices && d.notices.length) sum.notices.push({pair: d.action.pair, codes: d.notices});
    if (dryrun) continue;
    const need = p.kind === 'create' ? 4 : d.ops.filter(o => o.op !== 'none').length;
    if (calls + need > BUDGET) { truncated = true; continue; }
    try {
      if (p.kind === 'pair') await runOps(d.ops, {jira, ado});
      else await runCreate(p, d, {jira, ado, kv, at});
      if (p.kind === 'pair') { await kv.put('pair:' + d.rec.jira, JSON.stringify({...d.rec, adoRev: d.adoRevAfter || d.rec.adoRev, jiraUpdated: d.ops.some(o => o.sys === 'jira') ? null : d.rec.jiraUpdated})); await putIndex(kv, d.rec.ado, d.rec.jira); }
      sum.written++;
    } catch (e) { sum.errors.push({pair: d.action.pair, code: code(e)}); }
  }

  if (!dryrun && !truncated && !sum.errors.some(e => e.pair === 'scan' || e.pair === 'counterpart')) {
    try { await Promise.all([kv.put('cursor:jira', at), kv.put('cursor:ado', at)]); } catch (e) { sum.errors.push({pair: 'cursor', code: 'kv_write'}); }
  }
  return finish();

  function unpaired(side, id) { sum.unpaired[side + '_n']++; if (sum.unpaired[side].length < LIST_CAP) sum.unpaired[side].push(id); }
  async function finish() {
    sum.calls = calls; sum.truncated = truncated || undefined;
    sum.errors = sum.errors.slice(0, 30);
    try { await kv.put('run:last', JSON.stringify(sum)); } catch (e) { /* run:last is best effort */ }
    log('sync tick', JSON.stringify(sum));
    return {...sum, actions};
  }
}

async function safePut(kv, k, v, sum) { try { await kv.put(k, JSON.stringify(v)); } catch (e) { sum.errors.push({pair: v.jira, code: 'kv_write'}); } }

// Reverse index ado:<id> -> KAN key, with the key in metadata so one list call loads it all.
async function loadIndex(kv) {
  const byAdo = new Map(), byKan = new Map();
  let cursor;
  for (let i = 0; i < 5; i++) {
    const r = await kv.list({prefix: 'ado:', ...(cursor ? {cursor} : {})});
    for (const k of r.keys) { const id = Number(k.name.slice(4)); const key = k.metadata && k.metadata.k; if (id && key) { byAdo.set(id, key); byKan.set(key, id); } }
    if (r.list_complete || !r.cursor) break;
    cursor = r.cursor;
  }
  return {byAdo, byKan};
}
const putIndex = (kv, id, key) => kv.put('ado:' + id, key, {metadata: {k: key}});

async function runOps(ops, {jira, ado}) {
  for (const o of ops) {
    if (o.sys === 'ado' && o.op === 'update') await ado.update(o.id, o.patch);
    else if (o.sys === 'ado' && o.op === 'comment') await ado.comment(o.id, o.text);
    else if (o.sys === 'jira' && o.op === 'edit') await jira.edit(o.key, o.fields);
    else if (o.sys === 'jira' && o.op === 'label') await jira.edit(o.key, null, {labels: [{add: o.label}]});
    else if (o.sys === 'jira' && o.op === 'transition') await jira.transition(o.key, o.id);
  }
}

// Create guard (D9): pending marker, then search the target for the link key, create only if absent.
async function runCreate(p, d, {jira, ado, kv, at}) {
  const c = d.create;
  if (c.sys === 'ado') {
    const key = c.source;
    await kv.put('pending:jira:' + key, at, {expirationTtl: 3600});
    const found = await ado.byTag(c.link);
    let id;
    if (found.length) id = found[0].id;
    else { const w = await ado.create(c.typeName, c.patch); id = w && w.id; if (!id) throw new Error('ado_create_failed'); }
    await jira.edit(key, null, {labels: [{add: M.linkLabel(id)}]});
    await kv.put('pair:' + key, JSON.stringify({jira: key, ado: id, type: d.type, jiraUpdated: null, adoRev: null, adoChanged: null, hash: found.length ? {j: {}, a: {}} : d.hash, at}));
    await putIndex(kv, id, key);
  } else {
    const a = p.src;
    await kv.put('pending:ado:' + a.id, at, {expirationTtl: 3600});
    const found = await jira.byLabel(M.linkLabel(a.id));
    let key;
    if (found.length) key = found[0].key;
    else { const r = await jira.create(c.fields); key = r && r.key; if (!key || !/^KAN-\d+$/.test(key)) throw new Error('jira_create_failed'); }
    await ado.update(a.id, [
      {op: 'add', path: '/fields/System.Title', value: M.addPrefix(key, a.title)},
      {op: 'add', path: '/fields/System.Tags', value: [...a.tags.filter(t => !/^jira-KAN-\d+$/i.test(t)), M.linkTag(key)].join('; ')},
    ]);
    await kv.put('pair:' + key, JSON.stringify({jira: key, ado: a.id, type: d.type, jiraUpdated: null, adoRev: null, adoChanged: null, hash: found.length ? {j: {}, a: {}} : d.hash, at}));
    await putIndex(kv, a.id, key);
  }
}

export default {
  async fetch() { return new Response('Not found', {status: 404}); },
  async scheduled(event, rawEnv, ctx) {
    const env = await resolveSecrets(rawEnv);
    ctx.waitUntil(tick(env, {now: event.scheduledTime || Date.now()})
      .catch(e => console.log('sync tick failed', code(e))));
  },
};
