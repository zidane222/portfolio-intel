// Thin Jira Cloud REST v3 client for pi-sync. fetch is injected. Errors carry a code only, never
// the URL query, headers, body or token. Redirects are not followed so the auth header stays put.
import {jiraType, jiraStatus, adoFromLabels} from './map.js';
import {adfToMd} from './md.js';

export const FIELDS = ['summary', 'status', 'issuetype', 'parent', 'labels', 'updated', 'created', 'description'];

export function normJira(i) {
  const f = (i && i.fields) || {};
  const desc = adfToMd(f.description);
  const hint = /Engineering detail[^\n]*?(?:AB#|ADO\s*#?\s*)(\d+)/i.exec(desc);
  return {
    key: i.key, type: jiraType(f.issuetype && f.issuetype.name), title: String(f.summary || '').trim(),
    status: jiraStatus(f.status && f.status.name), rawStatus: f.status && f.status.name || '',
    parent: f.parent && f.parent.key || null, labels: f.labels || [], ado: adoFromLabels(f.labels),
    updated: f.updated || null, created: f.created || null, desc, hint: hint ? Number(hint[1]) : null,
  };
}

export function makeJira({base, email, token, project = 'KAN', fetch: f, count}) {
  if (!/^https:\/\/[a-z0-9-]+\.atlassian\.net$/.test(String(base || ''))) throw new Error('jira_base_invalid');
  if (!email || !token) throw new Error('jira_secret_missing');
  if (!/^[A-Z][A-Z0-9]+$/.test(project)) throw new Error('jira_project_invalid');
  const auth = 'Basic ' + btoa(email + ':' + token);
  async function call(method, path, body) {
    if (count) count();
    let r;
    try {
      r = await f(base + path, {method, redirect: 'manual', headers: {Authorization: auth, Accept: 'application/json',
        ...(body ? {'Content-Type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined});
    } catch (e) { throw new Error('jira_network'); }
    if (r.status < 200 || r.status > 299) throw new Error('jira_http_' + r.status);
    if (r.status === 204) return null;
    const t = await r.text();
    try { return t ? JSON.parse(t) : null; } catch { throw new Error('jira_bad_json'); }
  }
  async function search(jql, {maxPages = 3} = {}) {
    const out = [];
    let next;
    for (let p = 0; p < maxPages; p++) {
      const r = await call('POST', '/rest/api/3/search/jql', {jql, fields: FIELDS, maxResults: 100, ...(next ? {nextPageToken: next} : {})});
      out.push(...((r && r.issues) || []).map(normJira));
      next = r && r.nextPageToken;
      if (!next || r.isLast) break;
    }
    return out;
  }
  return {
    project,
    search,
    changedSince: minutes => search(`project = ${project} AND issuetype in (Epic, Story, Bug) AND updated >= -${Math.max(1, Math.ceil(minutes))}m ORDER BY updated ASC`),
    all: () => search(`project = ${project} AND issuetype in (Epic, Story, Bug) ORDER BY created ASC`, {maxPages: 5}),
    byKeys: keys => keys.length ? search(`project = ${project} AND key in (${keys.filter(k => /^KAN-\d+$/.test(k)).join(',')})`) : [],
    byLabel: label => /^ado-\d+$/.test(label) ? search(`project = ${project} AND labels = "${label}"`, {maxPages: 1}) : [],
    create: fields => call('POST', '/rest/api/3/issue', {fields: {project: {key: project}, ...fields}}),
    edit: (key, fields, update) => call('PUT', '/rest/api/3/issue/' + encodeURIComponent(key), {...(fields ? {fields} : {}), ...(update ? {update} : {})}),
    transition: (key, id) => call('POST', '/rest/api/3/issue/' + encodeURIComponent(key) + '/transitions', {transition: {id: String(id)}}),
  };
}
