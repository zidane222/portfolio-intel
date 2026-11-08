// pi-sync tests (plan docs/plans/pi-sync.md section 7). Offline: fake Jira, fake ADO, fake KV.
// Run: node test/sync.mjs
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as M from '../src/modules/sync/map.js';
import {adfToMd, mdToAdf, htmlToMd, mdToHtml} from '../src/modules/sync/md.js';
import {decide, h} from '../src/modules/sync/diff.js';
import {normJira} from '../src/modules/sync/jira.js';
import {normAdo} from '../src/modules/sync/ado.js';
import svc, {tick} from '../src/services/sync.js';
import {_reset as flagsReset, REGISTRY} from '../src/lib/flags.js';
import {resolveSecrets} from '../src/lib/secrets.js';

let n = 0;
const t = async (name, fn) => { flagsReset(); await fn(); n++; console.log('ok', name); };
const fx = name => JSON.parse(readFileSync(new URL('./fixtures/sync/' + name, import.meta.url), 'utf8'));

const SECRETS = {JIRA_EMAIL: 'sync-bot@example.test', JIRA_API_TOKEN: 'jira-token-NOT-REAL-123', ADO_PAT: 'ado-pat-NOT-REAL-456'};
const VARS = {JIRA_BASE: 'https://nadia-b.atlassian.net', JIRA_PROJECT: 'KAN', ADO_ORG_URL: 'https://dev.azure.com/portfolio-intel-279', ADO_PROJECT: 'portfolio-intel'};
const NOW = Date.parse('2026-11-08T12:00:00Z');

function kv(init = {}, {fail = false} = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, {v: typeof v === 'string' ? v : JSON.stringify(v), meta: null}]));
  return {
    m, fail, puts: [],
    async get(k, type) { if (this.fail) throw new Error('down'); const e = m.get(k); if (!e) return null; return type === 'json' ? JSON.parse(e.v) : e.v; },
    async put(k, v, o = {}) { if (this.fail) throw new Error('down'); this.puts.push(k); m.set(k, {v, meta: o.metadata || null}); },
    async list({prefix}) { if (this.fail) throw new Error('down'); const keys = [...m.keys()].filter(k => k.startsWith(prefix)).sort(); return {keys: keys.map(k => ({name: k, metadata: m.get(k).meta})), list_complete: true}; },
  };
}
const flagsKv = flags => kv({'flags:v1': {v: 1, flags: Object.fromEntries(Object.entries(flags).map(([k, on]) => [k, {on}]))}});

// Fake Jira and ADO behind one fetch. Records every call; writes are anything but search/read.
function world({jira = fx('jira-issues.json'), ado = fx('ado-items.json')} = {}) {
  const w = {calls: [], writes: [], J: new Map(jira.map(i => [i.key, structuredClone(i)])), A: new Map(ado.map(i => [i.id, structuredClone(i)])), comments: [], nextKey: 50, nextId: 500, stamp: '2026-11-08T11:59:00.000+0000'};
  const res = (b, s = 200) => new Response(b === null ? null : JSON.stringify(b), {status: s});
  w.fetch = async (u, init = {}) => {
    u = String(u); const method = init.method || 'GET';
    w.calls.push({u, method, init});
    assert.equal(init.redirect, 'manual');
    const body = init.body ? JSON.parse(init.body) : null;
    if (u.startsWith('https://nadia-b.atlassian.net/')) {
      assert.equal(init.headers.Authorization, 'Basic ' + btoa(SECRETS.JIRA_EMAIL + ':' + SECRETS.JIRA_API_TOKEN));
      const p = u.slice('https://nadia-b.atlassian.net'.length);
      if (p === '/rest/api/3/search/jql') {
        let list = [...w.J.values()];
        const kin = /key in \(([^)]*)\)/.exec(body.jql); if (kin) { const ks = kin[1].split(','); list = list.filter(i => ks.includes(i.key)); }
        const lab = /labels = "([^"]+)"/.exec(body.jql); if (lab) list = list.filter(i => (i.fields.labels || []).includes(lab[1]));
        return res({issues: list, isLast: true});
      }
      w.writes.push({sys: 'jira', method, p, body});
      if (p === '/rest/api/3/issue' && method === 'POST') {
        const key = 'KAN-' + (w.nextKey++);
        w.J.set(key, {key, fields: {...body.fields, status: {name: 'backlog'}, updated: w.stamp, created: w.stamp}});
        return res({key});
      }
      const m = /^\/rest\/api\/3\/issue\/(KAN-\d+)(\/transitions)?$/.exec(p);
      const i = m && w.J.get(m[1]);
      if (!i) return res({}, 404);
      if (m[2]) { const name = Object.entries(M.TRANSITIONS).find(([, id]) => id === body.transition.id)[0]; i.fields.status = {name}; }
      else {
        Object.assign(i.fields, body.fields || {});
        for (const op of (body.update && body.update.labels) || []) i.fields.labels = [...(i.fields.labels || []), op.add];
      }
      i.fields.updated = w.stamp;
      return res(null, 204);
    }
    if (u.startsWith('https://dev.azure.com/portfolio-intel-279/portfolio-intel/')) {
      assert.equal(init.headers.Authorization, 'Basic ' + btoa(':' + SECRETS.ADO_PAT));
      const p = u.slice('https://dev.azure.com/portfolio-intel-279/portfolio-intel'.length);
      if (p.startsWith('/_apis/wit/wiql')) {
        let list = [...w.A.values()];
        const tag = /CONTAINS '([^']+)'/.exec(body.query); if (tag) list = list.filter(i => M.parseTags(i.fields['System.Tags']).includes(tag[1]));
        return res({workItems: list.map(i => ({id: i.id}))});
      }
      if (p.startsWith('/_apis/wit/workitemsbatch')) return res({value: body.ids.map(id => w.A.get(id)).filter(Boolean)});
      w.writes.push({sys: 'ado', method, p, body});
      const c = /^\/_apis\/wit\/workitems\/\$([^?]+)\?/.exec(p);
      if (c) {
        const id = w.nextId++;
        const item = {id, rev: 1, fields: {'System.WorkItemType': decodeURIComponent(c[1]), 'System.State': 'New', 'System.ChangedDate': '2026-11-08T11:59:00Z', 'System.CreatedDate': '2026-11-08T11:59:00Z'}, relations: []};
        applyPatch(item, body); w.A.set(id, item); return res(item);
      }
      const cm = /^\/_apis\/wit\/workItems\/(\d+)\/comments/.exec(p);
      if (cm) { w.comments.push({id: +cm[1], text: body.text}); return res({id: 1}); }
      const up = /^\/_apis\/wit\/workitems\/(\d+)\?/.exec(p);
      const item = up && w.A.get(+up[1]);
      if (!item) return res({}, 404);
      applyPatch(item, body); item.rev++; item.fields['System.ChangedDate'] = '2026-11-08T11:59:00Z';
      return res(item);
    }
    throw new Error('unexpected host ' + u);
  };
  return w;
}
function applyPatch(item, patch) {
  for (const o of patch) {
    if (o.path.startsWith('/fields/')) item.fields[o.path.slice(8)] = o.value;
    else if (o.path === '/relations/-') (item.relations = item.relations || []).push(o.value);
    else if (o.path.startsWith('/relations/') && o.op === 'remove') item.relations.splice(+o.path.slice(11), 1);
  }
}
const env = (extra = {}) => ({...VARS, ...SECRETS, SYNC: kv(), ...extra});
const quiet = () => { const lines = []; return {lines, log: (...a) => lines.push(a.join(' '))}; };
const liveFlags = () => flagsKv({sync: true, sync_dryrun: false});

// ---------- map
await t('title prefix both ways', async () => {
  assert.equal(M.stripPrefix('KAN-12 Build the thing'), 'Build the thing');
  assert.equal(M.stripPrefix('KAN-12: Build'), 'Build');
  assert.equal(M.addPrefix('KAN-12', 'Build the thing'), 'KAN-12 Build the thing');
  assert.equal(M.addPrefix('KAN-12', 'KAN-12 Build'), 'KAN-12 Build');
});

await t('every status row, Jira to ADO and back', async () => {
  assert.deepEqual(M.jiraToAdo('backlog'), {state: 'New', human: false});
  assert.deepEqual(M.jiraToAdo('In dev'), {state: 'Active', human: false});
  assert.deepEqual(M.jiraToAdo('verify'), {state: 'Active', human: false});
  assert.deepEqual(M.jiraToAdo('Human auth'), {state: 'Active', human: true});
  assert.deepEqual(M.jiraToAdo('Done'), {state: 'Closed', human: false});
  assert.equal(M.jiraToAdo('Selected'), null);
  assert.equal(M.adoToJira('New', false, 'In dev'), 'backlog');
  assert.equal(M.adoToJira('Active', false, 'backlog'), 'In dev');
  assert.equal(M.adoToJira('Active', false, 'verify'), 'verify');
  assert.equal(M.adoToJira('Active', true, 'In dev'), 'Human auth');
  assert.equal(M.adoToJira('Closed', false, 'verify'), 'Done');
  assert.equal(M.adoToJira('Resolved', false, 'verify'), null);
  assert.equal(M.jiraStatus('BACKLOG'), 'backlog');
  assert.deepEqual(M.TRANSITIONS, {'backlog': '11', 'In dev': '21', 'verify': '31', 'Done': '41', 'Human auth': '51'});
});

await t('routing: Task, Feature, Agent Run, untagged Bug and internal never reach Jira', async () => {
  const a = fx('ado-items.json').map(normAdo);
  const byId = Object.fromEntries(a.map(x => [x.id, x]));
  for (const id of [102, 103, 104, 105]) assert.equal(M.adoEligible(byId[id]), false, String(id));
  assert.equal(M.adoEligible(byId[101]), true);
  assert.equal(M.adoEligible({...byId[101], tags: ['internal'], internal: true}), false);
  assert.equal(M.adoEligible({...byId[103], tags: ['customer-visible']}), true);
  assert.equal(M.adoEligible({...byId[103], tags: ['customer-visible', 'internal']}), false);
});

await t('description: ADF, markdown and HTML round trip for the supported subset', async () => {
  const md = '# Heading\n\nSome **bold** and `code` and [a link](https://example.com).\n\n- one\n- two\n\n1. first\n2. second\n\n```\nx = 1\n```';
  assert.equal(adfToMd(mdToAdf(md)), md);
  assert.equal(htmlToMd(mdToHtml(md)), md);
  assert.ok(mdToHtml(md).endsWith('<!-- pi-sync -->'));
  assert.ok(!mdToHtml('[x](javascript:alert(1))').includes('javascript:'));
  assert.ok(!mdToHtml('<script>alert(1)</script>').includes('<script>'));
  assert.equal(adfToMd({type: 'doc', content: [{type: 'panel', content: [{type: 'paragraph', content: [{type: 'text', text: 'inside'}]}]}]}), 'inside');
});

// ---------- diff (pure)
const J0 = () => normJira(fx('jira-issues.json')[1]);           // KAN-2 story, backlog, parent KAN-1
const A0 = () => normAdo(fx('ado-items.json')[1]);              // 101 user story, New, parent 100
const CTX = {adoForKan: k => ({'KAN-1': 100, 'KAN-2': 101, 'KAN-9': 109}[k] || null), kanForAdo: id => ({100: 'KAN-1', 101: 'KAN-2', 109: 'KAN-9'}[id] || null), parentUrl: id => 'https://dev.azure.com/portfolio-intel-279/_apis/wit/workItems/' + id, now: '2026-11-08T12:00:00.000Z'};
const synced = (j, a) => ({jira: j.key, ado: a.id, type: j.type, jiraUpdated: j.updated, adoRev: a.rev, hash: {
  j: {title: h(j.title), desc: h(j.desc), status: h(j.status), parent: h(j.parent)},
  a: {title: h(a.title), desc: h(a.desc), status: h(M.adoKey(a.state, a.human)), parent: h(a.parent)}}});

await t('in step pair: no change; same revisions: echo', async () => {
  const j = {...J0(), ado: 101}, a = A0();
  const rec = synced(j, a);
  assert.equal(decide(rec, j, a, CTX).skip, 'echo');
  assert.equal(decide({...rec, jiraUpdated: null}, j, a, CTX).skip, 'no_change');
});

await t('human-auth tag added and removed', async () => {
  const j = {...J0(), ado: 101}, a = A0(); const rec = {...synced(j, a), jiraUpdated: null};
  const d = decide(rec, {...j, status: 'Human auth'}, a, CTX);
  const p = d.ops.find(o => o.op === 'update').patch;
  assert.deepEqual(p.find(x => x.path === '/fields/System.State').value, 'Active');
  assert.ok(M.parseTags(p.find(x => x.path === '/fields/System.Tags').value).includes('human-auth'));
  const a2 = {...a, state: 'Active', human: true, tags: [...a.tags, 'human-auth']};
  const rec2 = {...synced({...j, status: 'Human auth'}, a2), jiraUpdated: null};
  const d2 = decide(rec2, {...j, status: 'verify'}, a2, CTX);
  const tags = M.parseTags(d2.ops[0].patch.find(x => x.path === '/fields/System.Tags').value);
  assert.ok(!tags.includes('human-auth') && tags.includes('jira-KAN-2'));
  const d3 = decide(rec2, {...j, status: 'Human auth'}, {...a2, human: false, tags: ['jira-KAN-2'], rev: 9}, CTX);
  assert.equal(d3.ops.find(o => o.op === 'transition').status, 'In dev');
});

await t('Epic is never closed by sync, either way', async () => {
  const je = {...normJira(fx('jira-issues.json')[0])}, ae = normAdo(fx('ado-items.json')[0]);
  const rec = {...synced(je, ae), jiraUpdated: null};
  const d1 = decide(rec, {...je, status: 'Done'}, ae, CTX);
  assert.ok(!d1.ops || !d1.ops.some(o => o.patch && o.patch.some(p => p.value === 'Closed')));
  assert.ok(d1.notices.includes('epic_closed_jira'));
  const d2 = decide(rec, je, {...ae, state: 'Closed', rev: 9}, CTX);
  assert.ok(!d2.ops || !d2.ops.some(o => o.op === 'transition'));
  assert.ok(d2.notices.includes('epic_closed_ado'));
  // and the notice does not repeat next tick
  assert.equal(decide({...d2.rec, jiraUpdated: null}, je, {...ae, state: 'Closed', rev: 10}, CTX).skip, 'no_change');
});

await t('customer bug: ADO close closes Jira; Jira close only comments', async () => {
  const jb = {key: 'KAN-9', type: 'bug', title: 'Crash', status: 'In dev', parent: null, labels: ['ado-109'], ado: 109, updated: '2026-11-08T10:00:00.000+0000', desc: ''};
  const ab = {id: 109, rev: 3, type: 'bug', title: 'Crash', titlePrefix: 'KAN-9', tags: ['customer-visible', 'jira-KAN-9'], kan: 'KAN-9', state: 'Active', human: false, internal: false, parent: null, parentIndex: -1, changed: '2026-11-08T10:00:00Z', desc: ''};
  const rec = {...synced(jb, ab), jiraUpdated: null};
  const d1 = decide(rec, jb, {...ab, state: 'Closed', rev: 4}, CTX);
  assert.deepEqual(d1.ops.find(o => o.op === 'transition'), {sys: 'jira', op: 'transition', key: 'KAN-9', status: 'Done', id: '41'});
  const d2 = decide(rec, {...jb, status: 'Done'}, ab, CTX);
  assert.ok(!d2.ops.some(o => o.op === 'update' && o.patch.some(p => p.path === '/fields/System.State')));
  assert.equal(d2.ops.filter(o => o.op === 'comment').length, 1);
});

await t('last updated wins both ways, tie goes to Jira', async () => {
  const j = {...J0(), ado: 101}, a = A0(); const rec = {...synced(j, a), jiraUpdated: null};
  const jt = {...j, title: 'Jira title', updated: '2026-11-08T10:05:00.000+0000'};
  const at = {...a, title: 'ADO title', rev: 3, changed: '2026-11-08T10:04:00Z'};
  assert.equal(decide(rec, jt, at, CTX).action.dir, 'j2a');
  assert.equal(decide(rec, jt, {...at, changed: '2026-11-08T10:06:00Z'}, CTX).ops.find(o => o.op === 'edit').fields.summary, 'ADO title');
  const tie = decide(rec, jt, {...at, changed: '2026-11-08T10:05:00Z'}, CTX);
  assert.equal(tie.action.dir, 'j2a'); assert.ok(tie.action.reason.includes('tie_jira'));
});

await t('parent waits for an unpaired Epic, then follows re-parenting', async () => {
  const j = {...J0(), ado: 101}, a = A0(); const rec = {...synced(j, a), jiraUpdated: null};
  assert.equal(decide(rec, {...j, parent: 'KAN-77'}, a, CTX).wait, 'parent_unpaired');
  const d = decide(rec, {...j, parent: 'KAN-9'}, a, CTX);
  const p = d.ops[0].patch;
  assert.deepEqual(p.map(x => x.op), ['remove', 'add']);
  assert.ok(p[1].value.url.endsWith('/109'));
});

await t('internal tagged ADO item never syncs, even when paired', async () => {
  const j = J0(), a = {...A0(), tags: ['jira-KAN-2', 'internal'], internal: true};
  assert.equal(decide(null, j, a, CTX).skip, 'internal');
});

await t('unknown status skips the pair with an error, never a guess', async () => {
  assert.equal(decide(null, {...J0(), status: null}, A0(), CTX).error, 'unknown_status');
  assert.equal(decide(null, J0(), {...A0(), state: 'Resolved'}, CTX).error, 'unknown_status');
});

// ---------- tick (service)
await t('flags: sync off writes nothing; flags KV down fails closed', async () => {
  const w = world();
  let e = env({FLAGS: flagsKv({sync: false, sync_dryrun: false})});
  assert.equal((await tick(e, {fetch: w.fetch, now: NOW, log: quiet().log})).skipped, 'sync_off');
  flagsReset();
  const down = flagsKv({}); down.fail = true;
  e = env({FLAGS: down});
  assert.equal((await tick(e, {fetch: w.fetch, now: NOW, log: quiet().log})).skipped, 'flags_unreadable');
  assert.equal(w.calls.length, 0); assert.equal(e.SYNC.puts.length, 0);
  assert.equal(REGISTRY.sync.fail, 'closed'); assert.equal(REGISTRY.sync_dryrun.default, true);
});

await t('sync KV down: no calls, no writes', async () => {
  const w = world(); const e = env({SYNC: kv({}, {fail: true})});
  const r = await tick(e, {fetch: w.fetch, now: NOW, log: quiet().log});
  assert.equal(r.skipped, 'kv_unreadable'); assert.equal(w.writes.length, 0);
});

await t('dry run (default, no FLAGS binding): plans, zero write calls, unpaired report both sides', async () => {
  const w = world(); const e = env(); const q = quiet();
  const r = await tick(e, {fetch: w.fetch, now: NOW, log: q.log});
  assert.equal(r.dryrun, true);
  assert.equal(w.writes.length, 0);
  assert.deepEqual(e.SYNC.puts, ['run:last']);
  assert.ok(r.actions.some(a => a.pair === 'KAN-2' && a.fields.includes('link')));
  assert.deepEqual(r.unpaired.jira, ['KAN-3']);
  assert.deepEqual(r.unpaired.ado, [106]);
  assert.ok(q.lines.some(l => l.startsWith('sync plan')));
});

await t('logs and run:last hold no secret values, emails, headers or descriptions', async () => {
  const w = world(); const q = quiet(); const e = env({FLAGS: liveFlags()});
  await tick(e, {fetch: w.fetch, now: NOW, log: q.log});
  const all = q.lines.join('\n') + e.SYNC.m.get('run:last').v + [...e.SYNC.m.values()].map(x => x.v).join('');
  for (const s of [SECRETS.JIRA_API_TOKEN, SECRETS.ADO_PAT, SECRETS.JIRA_EMAIL, 'Basic ', 'Authorization', 'Epic body', 'Map statuses']) assert.ok(!all.includes(s), s);
  // HTTP errors carry a code only
  const bad = async () => new Response('token ' + SECRETS.JIRA_API_TOKEN, {status: 401});
  flagsReset(); const q2 = quiet();
  const r = await tick(env({FLAGS: liveFlags()}), {fetch: bad, now: NOW, log: q2.log});
  assert.ok(r.errors.some(x => /^(jira|ado)_http_401$/.test(x.code)));
  assert.ok(!q2.lines.join('').includes(SECRETS.JIRA_API_TOKEN));
});

await t('live: existing pairs get link keys, no backfill of old unpaired items', async () => {
  const w = world(); const e = env({FLAGS: liveFlags()});
  const r = await tick(e, {fetch: w.fetch, now: NOW, log: quiet().log});
  assert.equal(r.dryrun, false);
  assert.ok(w.J.get('KAN-2').fields.labels.includes('ado-101'));
  assert.equal(w.writes.filter(x => x.p === '/rest/api/3/issue' || /workitems\/\$/.test(x.p)).length, 0, 'no creates');
  assert.ok(e.SYNC.m.has('meta:first_live') && e.SYNC.m.has('pair:KAN-2') && e.SYNC.m.get('ado:101').meta.k === 'KAN-2');
  // second tick: in step, nothing written
  flagsReset(); const before = w.writes.length;
  const r2 = await tick(e, {fetch: w.fetch, now: NOW + 300000, log: quiet().log});
  assert.equal(w.writes.length, before); assert.equal(r2.planned, 0);
});

await t('live: new Jira story after first live run creates one ADO item; echo makes no more writes', async () => {
  const w = world(); const e = env({FLAGS: liveFlags()});
  await tick(e, {fetch: w.fetch, now: NOW, log: quiet().log});
  w.J.set('KAN-20', {key: 'KAN-20', fields: {summary: 'New story', status: {name: 'In dev'}, issuetype: {name: 'Story'}, parent: {key: 'KAN-1'}, labels: [], updated: '2026-11-08T12:01:00.000+0000', created: '2026-11-08T12:01:00.000+0000', description: null}});
  flagsReset(); await tick(e, {fetch: w.fetch, now: NOW + 300000, log: quiet().log});
  const made = [...w.A.values()].filter(i => M.parseTags(i.fields['System.Tags']).includes('jira-KAN-20'));
  assert.equal(made.length, 1);
  assert.equal(made[0].fields['System.Title'], 'KAN-20 New story');
  assert.ok(made[0].relations[0].url.endsWith('/100'));
  assert.ok(w.J.get('KAN-20').fields.labels.includes('ado-' + made[0].id));
  flagsReset(); await tick(e, {fetch: w.fetch, now: NOW + 600000, log: quiet().log}); // status follows
  assert.equal(w.A.get(made[0].id).fields['System.State'], 'Active');
  for (let i = 3; i < 6; i++) { flagsReset(); await tick(e, {fetch: w.fetch, now: NOW + i * 300000, log: quiet().log}); }
  assert.equal([...w.A.values()].filter(i => M.parseTags(i.fields['System.Tags']).includes('jira-KAN-20')).length, 1);
  const n0 = w.writes.length; flagsReset(); await tick(e, {fetch: w.fetch, now: NOW + 7 * 300000, log: quiet().log});
  assert.equal(w.writes.length, n0, 'no ping pong');
});

await t('crash between create and record makes no duplicate', async () => {
  const w = world(); const e = env({FLAGS: liveFlags()});
  await tick(e, {fetch: w.fetch, now: NOW, log: quiet().log});
  w.A.set(300, {id: 300, rev: 1, fields: {'System.WorkItemType': 'Bug', 'System.Title': 'Customer crash', 'System.State': 'New', 'System.Tags': 'customer-visible', 'System.ChangedDate': '2026-11-08T12:02:00Z', 'System.CreatedDate': '2026-11-08T12:02:00Z'}});
  // the ADO tag write fails after the Jira create: the pair record is never written
  const crashing = async (u, init) => { if (init.method === 'PATCH' && String(u).includes('/workitems/300')) throw new Error('boom'); return w.fetch(u, init); };
  flagsReset(); const r = await tick(e, {fetch: crashing, now: NOW + 300000, log: quiet().log});
  assert.ok(r.errors.some(x => x.code === 'ado_network'));
  assert.ok(!e.SYNC.m.has('ado:300'));
  flagsReset(); await tick(e, {fetch: w.fetch, now: NOW + 600000, log: quiet().log});
  const copies = [...w.J.values()].filter(i => (i.fields.labels || []).includes('ado-300'));
  assert.equal(copies.length, 1); assert.equal(copies[0].fields.issuetype.name, 'Bug');
  assert.ok(M.parseTags(w.A.get(300).fields['System.Tags']).includes('jira-' + copies[0].key));
  assert.ok(w.A.get(300).fields['System.Title'].startsWith(copies[0].key + ' '));
});

await t('live: internal and non-synced ADO types are never created in Jira', async () => {
  const w = world(); const e = env({FLAGS: liveFlags()});
  await tick(e, {fetch: w.fetch, now: NOW, log: quiet().log});
  const base = {'System.State': 'New', 'System.ChangedDate': '2026-11-08T12:02:00Z', 'System.CreatedDate': '2026-11-08T12:02:00Z'};
  w.A.set(400, {id: 400, rev: 1, fields: {...base, 'System.WorkItemType': 'User Story', 'System.Title': 'Internal', 'System.Tags': 'internal'}});
  w.A.set(401, {id: 401, rev: 1, fields: {...base, 'System.WorkItemType': 'Task', 'System.Title': 'Task', 'System.Tags': ''}});
  w.A.set(402, {id: 402, rev: 1, fields: {...base, 'System.WorkItemType': 'Bug', 'System.Title': 'Bug', 'System.Tags': ''}});
  w.A.set(403, {id: 403, rev: 1, fields: {...base, 'System.WorkItemType': 'Bug', 'System.Title': 'Bug', 'System.Tags': 'customer-visible; internal'}});
  flagsReset(); await tick(e, {fetch: w.fetch, now: NOW + 300000, log: quiet().log});
  assert.equal(w.writes.filter(x => x.p === '/rest/api/3/issue').length, 0);
});

await t('at most 15 pairs per tick and within the subrequest budget', async () => {
  const jira = [], ado = [];
  for (let i = 1; i <= 30; i++) {
    jira.push({key: 'KAN-' + i, fields: {summary: 'S' + i, status: {name: 'backlog'}, issuetype: {name: 'Epic'}, labels: [], updated: '2026-11-01T10:00:00.000+0000', created: '2026-10-01T10:00:00.000+0000'}});
    ado.push({id: 1000 + i, rev: 1, fields: {'System.WorkItemType': 'Epic', 'System.Title': 'KAN-' + i + ' S' + i, 'System.State': 'New', 'System.Tags': 'jira-KAN-' + i, 'System.ChangedDate': '2026-11-01T10:00:00Z', 'System.CreatedDate': '2026-10-01T10:00:00Z'}});
  }
  const w = world({jira, ado}); const e = env({FLAGS: liveFlags()});
  const r = await tick(e, {fetch: w.fetch, now: NOW, log: quiet().log});
  assert.equal(r.planned, 15); assert.ok(r.calls <= 45, String(r.calls)); assert.equal(r.truncated, true);
  assert.ok(!e.SYNC.m.has('cursor:jira'), 'cursor holds while work remains');
  flagsReset(); const r2 = await tick(e, {fetch: w.fetch, now: NOW + 300000, log: quiet().log});
  assert.equal(r2.planned, 15);
  flagsReset(); const r3 = await tick(e, {fetch: w.fetch, now: NOW + 600000, log: quiet().log});
  assert.equal(r3.planned, 0); assert.ok(e.SYNC.m.has('cursor:jira'));
});

await t('service: fetch answers 404; secrets resolve from the Secrets Store', async () => {
  assert.equal((await svc.fetch(new Request('https://x/health'))).status, 404);
  const r = await resolveSecrets({JIRA_EMAIL: {get: async () => 'a'}, JIRA_API_TOKEN: {get: async () => 'b'}, ADO_PAT: {get: async () => 'c'}});
  assert.deepEqual([r.JIRA_EMAIL, r.JIRA_API_TOKEN, r.ADO_PAT], ['a', 'b', 'c']);
});

await t('clients refuse a base URL outside Jira Cloud or dev.azure.com', async () => {
  const w = world(); const q = quiet();
  const r = await tick(env({JIRA_BASE: 'https://evil.example'}), {fetch: w.fetch, now: NOW, log: q.log});
  assert.equal(r.skipped, 'jira_base_invalid'); assert.equal(w.calls.length, 0);
  const r2 = await tick(env({ADO_PAT: ''}), {fetch: w.fetch, now: NOW, log: q.log});
  assert.equal(r2.skipped, 'ado_secret_missing');
});

console.log(`\n${n} sync tests passed`);
