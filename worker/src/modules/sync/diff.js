// pi-sync decisions per pair (plan D6 to D9, section 3). Pure: takes normalized items and the pair
// record, returns the planned action, the abstract write ops and the next pair record.
// Each side keeps its own hashes (hash.j, hash.a): a field changed on a side when its current value
// no longer matches that side's hash. One side changed: push it. Both: last updated wins, ties go to Jira.
import * as M from './map.js';
import {normMd, mdToAdf, mdToHtml} from './md.js';

export const PARENT_REL = 'System.LinkTypes.Hierarchy-Reverse';

export function h(v) { // FNV-1a, so KV never holds titles or descriptions
  const s = v === null || v === undefined ? '\u0000' : String(v);
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
  return x.toString(36);
}

const FIELDS = ['title', 'desc', 'status', 'parent'];
const jv = (j, f) => f === 'desc' ? normMd(j.desc) : j[f] === undefined ? null : j[f];
const av = (a, f) => f === 'status' ? M.adoKey(a.state, a.human) : f === 'desc' ? normMd(a.desc) : a[f] === undefined ? null : a[f];
const t = s => { const n = Date.parse(s || ''); return Number.isFinite(n) ? n : 0; };

function tagsWith(tags, add = [], remove = []) {
  let out = tags.filter(x => !remove.some(r => r.toLowerCase() === x.toLowerCase()));
  for (const a of add) if (!M.hasTag(out, a)) out.push(a);
  return out.join('; ');
}

// ctx: {adoForKan(key) -> id|null, kanForAdo(id) -> key|null, parentUrl(id) -> url, now: ISO}
export function decide(rec, j, a, ctx) {
  const key = j.key, type = j.type;
  if (a.internal) return {skip: 'internal', pair: key};
  if (!j.type || j.type !== a.type) return {error: 'type_mismatch', pair: key};
  if (!j.status) return {error: 'unknown_status', pair: key};
  if (!['New', 'Active', 'Closed'].includes(a.state)) return {error: 'unknown_status', pair: key};
  if (rec && rec.jiraUpdated && j.updated === rec.jiraUpdated && a.rev === rec.adoRev) return {skip: 'echo', pair: key};

  const hj = (rec && rec.hash && rec.hash.j) || {}, ha = (rec && rec.hash && rec.hash.a) || {};
  const next = {j: {...hj}, a: {...ha}};
  const fields = type === 'story' ? FIELDS : FIELDS.filter(f => f !== 'parent');
  const jEdit = {}, patch = [], ops = [], notices = [];
  let tagAdd = [], tagRemove = [], toJ = [], toA = [], transition = null, tie = false;

  // Link keys (D6): label on Jira, tag on ADO.
  if (j.ado !== a.id) ops.push({sys: 'jira', op: 'label', key, label: M.linkLabel(a.id)});
  if (a.kan !== key) tagAdd.push(M.linkTag(key));

  const equiv = f => {
    if (f === 'title') return j.title === a.title && a.titlePrefix === key;
    if (f === 'desc') return normMd(j.desc) === normMd(a.desc);
    if (f === 'status') { const m = M.jiraToAdo(j.status); return !!m && M.adoKey(m.state, m.human) === M.adoKey(a.state, a.human); }
    if (f === 'parent') return (j.parent ? ctx.adoForKan(j.parent) : null) === (a.parent || null);
  };

  for (const f of fields) {
    const jc = hj[f] !== h(jv(j, f)), ac = ha[f] !== h(av(a, f));
    if (!jc && !ac && !(f === 'title' && a.titlePrefix !== key)) continue;
    if (equiv(f)) { next.j[f] = h(jv(j, f)); next.a[f] = h(av(a, f)); continue; }
    let dir;
    if (jc && !ac) dir = 'j2a';
    else if (ac && !jc) dir = 'a2j';
    else { const tj = t(j.updated), ta = t(a.changed); if (tj === ta) tie = true; dir = tj >= ta ? 'j2a' : 'a2j'; }
    if (!jc && !ac) dir = 'j2a'; // only the ADO title prefix is missing

    if (f === 'title') {
      if (dir === 'j2a') { patch.push({op: 'add', path: '/fields/System.Title', value: M.addPrefix(key, j.title)}); next.a.title = h(j.title); next.j.title = h(j.title); }
      else { jEdit.summary = a.title; next.j.title = h(a.title); next.a.title = h(a.title); if (a.titlePrefix !== key) patch.push({op: 'add', path: '/fields/System.Title', value: M.addPrefix(key, a.title)}); }
    } else if (f === 'desc') {
      const md = dir === 'j2a' ? normMd(j.desc) : normMd(a.desc);
      if (dir === 'j2a') patch.push({op: 'add', path: '/fields/System.Description', value: mdToHtml(md)});
      else jEdit.description = mdToAdf(md);
      next.j.desc = h(md); next.a.desc = h(md);
    } else if (f === 'status') {
      if (dir === 'j2a') {
        const m = M.jiraToAdo(j.status);
        if (M.closesEpic(type, m)) { notices.push('epic_closed_jira'); next.j.status = h(jv(j, f)); next.a.status = h(av(a, f)); continue; }
        if (type === 'bug' && j.status === 'Done') {
          ops.push({sys: 'ado', op: 'comment', id: a.id, text: `The Jira copy ${key} was closed. ADO owns customer-visible bugs, so this bug stays open until it is closed here.`});
          notices.push('jira_closed_bug'); next.j.status = h(jv(j, f)); next.a.status = h(av(a, f)); continue;
        }
        if (type === 'bug' && a.state === 'Closed') { notices.push('ado_owns_bug'); next.j.status = h(jv(j, f)); next.a.status = h(av(a, f)); continue; }
        patch.push({op: 'add', path: '/fields/System.State', value: m.state});
        if (m.human) tagAdd.push(M.TAG_HUMAN); else if (a.human) tagRemove.push(M.TAG_HUMAN);
        next.j.status = h(j.status); next.a.status = h(M.adoKey(m.state, m.human));
      } else {
        const target = M.adoToJira(a.state, a.human, j.status);
        if (M.closesEpic(type, target)) { notices.push('epic_closed_ado'); next.j.status = h(jv(j, f)); next.a.status = h(av(a, f)); continue; }
        transition = target; next.j.status = h(target); next.a.status = h(av(a, f));
      }
    } else if (f === 'parent') {
      if (dir === 'j2a') {
        const pid = j.parent ? ctx.adoForKan(j.parent) : null;
        if (j.parent && !pid) return {wait: 'parent_unpaired', pair: key};
        if (a.parentIndex >= 0) patch.push({op: 'remove', path: '/relations/' + a.parentIndex});
        if (pid) patch.push({op: 'add', path: '/relations/-', value: {rel: PARENT_REL, url: ctx.parentUrl(pid)}});
        next.j.parent = h(j.parent); next.a.parent = h(pid);
      } else {
        const pk = a.parent ? ctx.kanForAdo(a.parent) : null;
        if (a.parent && !pk) return {wait: 'parent_unpaired', pair: key};
        jEdit.parent = pk ? {key: pk} : null;
        next.j.parent = h(pk); next.a.parent = h(a.parent);
      }
    }
    (dir === 'j2a' ? toA : toJ).push(f);
  }

  if (tagAdd.length || tagRemove.length) patch.push({op: 'add', path: '/fields/System.Tags', value: tagsWith(a.tags, tagAdd, tagRemove)});
  if (patch.length) ops.unshift({sys: 'ado', op: 'update', id: a.id, patch});
  if (Object.keys(jEdit).length) ops.push({sys: 'jira', op: 'edit', key, fields: jEdit});
  if (transition) ops.push({sys: 'jira', op: 'transition', key, status: transition, id: M.TRANSITIONS[transition]});

  const rec2 = {jira: key, ado: a.id, type, jiraUpdated: j.updated, adoRev: a.rev, adoChanged: a.changed, hash: next, at: ctx.now};
  const changedFields = [...new Set([...toA, ...toJ])];
  if (!ops.length) return {skip: notices.length ? notices.join(',') : 'no_change', pair: key, rec: rec2, notices};
  const dir = toA.length && toJ.length ? 'both' : toJ.length ? 'a2j' : 'j2a';
  const reason = [!rec ? 'adopt' : 'changed', tie ? 'tie_jira' : null, ...notices].filter(Boolean).join(',');
  return {action: {pair: key, dir, fields: changedFields.length ? changedFields : ['link'], reason}, ops, rec: rec2, notices};
}

// Creating the missing side. Only items created after the first live run (owner decision 4).
export function eligibleForCreate(created, firstLive) {
  return !!firstLive && t(created) > t(firstLive);
}

export function planCreateAdo(j, ctx) {
  if (!M.jiraMayCreateAdo(j)) return {skip: 'jira_type_not_created'};
  if (!j.status) return {error: 'unknown_status', pair: j.key};
  let parentId = null;
  if (j.type === 'story' && j.parent) { parentId = ctx.adoForKan(j.parent); if (!parentId) return {wait: 'parent_unpaired', pair: j.key}; }
  const patch = [
    {op: 'add', path: '/fields/System.Title', value: M.addPrefix(j.key, j.title)},
    {op: 'add', path: '/fields/System.Tags', value: M.linkTag(j.key)},
  ];
  const md = normMd(j.desc);
  if (md) patch.push({op: 'add', path: '/fields/System.Description', value: mdToHtml(md)});
  if (parentId) patch.push({op: 'add', path: '/relations/-', value: {rel: PARENT_REL, url: ctx.parentUrl(parentId)}});
  return {action: {pair: j.key, dir: 'create_a', fields: ['title', 'desc', 'parent'], reason: 'new_jira'},
    create: {sys: 'ado', typeName: M.ADO_TYPE_NAME[j.type], patch, source: j.key, link: M.linkTag(j.key)},
    // status null on the Jira side, so the next tick pushes the Jira status onto the new item
    hash: {j: {title: h(j.title), desc: h(md), status: null, parent: h(j.parent)}, a: {title: h(j.title), desc: h(md), parent: h(parentId)}},
    type: j.type};
}

export function planCreateJira(a, ctx) {
  if (!M.adoEligible(a)) return {skip: a.internal ? 'internal' : 'ado_type_not_synced'};
  if (!['New', 'Active', 'Closed'].includes(a.state)) return {error: 'unknown_status', pair: 'ado:' + a.id};
  let parentKey = null;
  if (a.type === 'story' && a.parent) { parentKey = ctx.kanForAdo(a.parent); if (!parentKey) return {wait: 'parent_unpaired', pair: 'ado:' + a.id}; }
  const md = normMd(a.desc);
  const fields = {summary: a.title, issuetype: {name: M.JIRA_TYPE_NAME[a.type]}, labels: [M.linkLabel(a.id)]};
  if (md) fields.description = mdToAdf(md);
  if (parentKey) fields.parent = {key: parentKey};
  return {action: {pair: 'ado:' + a.id, dir: 'create_j', fields: ['title', 'desc', 'parent'], reason: a.type === 'bug' ? 'customer_bug' : 'new_ado'},
    create: {sys: 'jira', fields, source: a.id},
    hash: {j: {title: h(a.title), desc: h(md), parent: h(parentKey)}, a: {title: h(a.title), desc: h(md), status: null, parent: h(a.parent)}},
    type: a.type};
}
