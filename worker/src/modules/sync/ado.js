// Thin Azure DevOps Work Items REST client for pi-sync. fetch is injected. Errors carry a code only.
import {adoType, parseTags, hasTag, kanFromTags, stripPrefix, TAG_HUMAN, TAG_INTERNAL, TAG_CUSTOMER} from './map.js';
import {htmlToMd} from './md.js';

const V = 'api-version=7.1';
const PARENT = 'System.LinkTypes.Hierarchy-Reverse';

export function normAdo(w) {
  const f = (w && w.fields) || {};
  const tags = parseTags(f['System.Tags']);
  const title = String(f['System.Title'] || '');
  const rels = (w.relations || []);
  const pi = rels.findIndex(r => r.rel === PARENT);
  const pid = pi >= 0 ? Number(String(rels[pi].url).split('/').pop()) : (f['System.Parent'] || null);
  const pre = /^\s*(KAN-\d+)\b/i.exec(title);
  return {
    id: w.id, rev: w.rev, type: adoType(f['System.WorkItemType']), rawType: f['System.WorkItemType'] || '',
    title: stripPrefix(title), titlePrefix: pre ? pre[1].toUpperCase() : null, tags,
    kan: kanFromTags(tags), state: f['System.State'] || '', human: hasTag(tags, TAG_HUMAN),
    internal: hasTag(tags, TAG_INTERNAL), customer: hasTag(tags, TAG_CUSTOMER),
    parent: pid ? Number(pid) : null, parentIndex: pi, changed: f['System.ChangedDate'] || null,
    created: f['System.CreatedDate'] || null, desc: htmlToMd(f['System.Description']),
  };
}

export function makeAdo({org, project, pat, fetch: f, count}) {
  if (String(org || '') !== 'https://dev.azure.com/portfolio-intel-279') throw new Error('ado_org_invalid');
  if (!/^[A-Za-z0-9 ._-]+$/.test(String(project || ''))) throw new Error('ado_project_invalid');
  if (!pat) throw new Error('ado_secret_missing');
  const base = org + '/' + encodeURIComponent(project);
  const auth = 'Basic ' + btoa(':' + pat);
  async function call(method, path, body, ctype = 'application/json') {
    if (count) count();
    let r;
    try {
      r = await f(base + path, {method, redirect: 'manual', headers: {Authorization: auth, Accept: 'application/json',
        ...(body ? {'Content-Type': ctype} : {})}, body: body ? JSON.stringify(body) : undefined});
    } catch (e) { throw new Error('ado_network'); }
    if (r.status < 200 || r.status > 299) throw new Error('ado_http_' + r.status);
    const t = await r.text();
    try { return t ? JSON.parse(t) : null; } catch { throw new Error('ado_bad_json'); }
  }
  async function wiql(where) {
    const q = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] IN ('Epic', 'User Story', 'Bug')${where ? ' AND ' + where : ''} ORDER BY [System.ChangedDate] ASC`;
    const r = await call('POST', '/_apis/wit/wiql?timePrecision=true&$top=1000&' + V, {query: q});
    return ((r && r.workItems) || []).map(x => x.id);
  }
  async function get(ids, {maxCalls = 5} = {}) {
    const out = [];
    for (let i = 0; i < ids.length && i / 200 < maxCalls; i += 200) {
      const r = await call('POST', '/_apis/wit/workitemsbatch?' + V, {ids: ids.slice(i, i + 200), $expand: 'Relations'});
      out.push(...((r && r.value) || []).map(normAdo));
    }
    return out;
  }
  const iso = d => new Date(d).toISOString();
  return {
    base,
    parentUrl: id => org + '/_apis/wit/workItems/' + Number(id),
    changedSince: async since => get(await wiql(`[System.ChangedDate] >= '${iso(since)}'`)),
    all: async () => get(await wiql('')),
    byIds: ids => ids.length ? get(ids.map(Number).filter(Number.isInteger)) : [],
    byTag: async tag => /^jira-KAN-\d+$/.test(tag) ? get(await wiql(`[System.Tags] CONTAINS '${tag}'`), {maxCalls: 1}) : [],
    create: (typeName, patch) => call('POST', '/_apis/wit/workitems/$' + encodeURIComponent(typeName) + '?' + V, patch, 'application/json-patch+json'),
    update: (id, patch) => call('PATCH', '/_apis/wit/workitems/' + Number(id) + '?' + V, patch, 'application/json-patch+json'),
    comment: (id, text) => call('POST', '/_apis/wit/workItems/' + Number(id) + '/comments?api-version=7.1-preview.4', {text}),
  };
}
