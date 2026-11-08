// pi-sync mapping rules (plan docs/plans/pi-sync.md section 3, owner decisions 2026-11-08).
// Pure functions only: types, routing, titles, statuses. No network, no env.

// KAN statuses and their fixed Jira transition ids (owner decision 1).
export const JIRA_STATUSES = ['backlog', 'In dev', 'verify', 'Human auth', 'Done'];
export const TRANSITIONS = {'backlog': '11', 'In dev': '21', 'verify': '31', 'Done': '41', 'Human auth': '51'};

export const TAG_CUSTOMER = 'customer-visible';
export const TAG_INTERNAL = 'internal';
export const TAG_HUMAN = 'human-auth';

// Case-insensitive status name to the canonical KAN name, or null when unknown.
export function jiraStatus(name) {
  const n = String(name || '').trim().toLowerCase();
  return JIRA_STATUSES.find(s => s.toLowerCase() === n) || null;
}

// Jira type name -> 'epic' | 'story' | 'bug' | null.
export function jiraType(name) {
  const n = String(name || '').trim().toLowerCase();
  return n === 'epic' ? 'epic' : n === 'story' ? 'story' : n === 'bug' ? 'bug' : null;
}
export const JIRA_TYPE_NAME = {epic: 'Epic', story: 'Story', bug: 'Bug'};

export function adoType(name) {
  const n = String(name || '').trim().toLowerCase();
  return n === 'epic' ? 'epic' : n === 'user story' ? 'story' : n === 'bug' ? 'bug' : null;
}
export const ADO_TYPE_NAME = {epic: 'Epic', story: 'User Story', bug: 'Bug'};

export function parseTags(s) {
  return String(s || '').split(';').map(t => t.trim()).filter(Boolean);
}
export function hasTag(tags, t) { return tags.some(x => x.toLowerCase() === t.toLowerCase()); }

// Matching keys (D6): ADO tag jira-KAN-<n> is the source of truth, Jira label ado-<id>.
export const linkTag = key => 'jira-' + key;
export const linkLabel = id => 'ado-' + id;
export function kanFromTags(tags) {
  for (const t of tags) { const m = /^jira-(KAN-\d+)$/i.exec(t); if (m) return m[1].toUpperCase(); }
  return null;
}
export function adoFromLabels(labels) {
  for (const l of labels || []) { const m = /^ado-(\d+)$/.exec(l); if (m) return Number(m[1]); }
  return null;
}

// Title: ADO "KAN-<n> <title>" <-> Jira "<title>".
export function stripPrefix(t) { return String(t || '').replace(/^\s*KAN-\d+\s*[:\-]?\s*/i, '').trim(); }
export function addPrefix(key, t) { return key + ' ' + stripPrefix(t); }

// Routing. ADO: Epic, User Story and customer-visible Bug only, never anything tagged internal
// (owner decision 5). Task, Feature, Agent Run and untagged Bug are ignored.
export function adoEligible(a) {
  if (!a || !a.type) return false;
  if (hasTag(a.tags, TAG_INTERNAL)) return false;
  if (a.type === 'bug') return hasTag(a.tags, TAG_CUSTOMER);
  return a.type === 'epic' || a.type === 'story';
}
// Jira: Epic and Story; Bug only as the copy of an ADO bug (never created in ADO from Jira).
export function jiraEligible(j) { return !!j && (j.type === 'epic' || j.type === 'story' || j.type === 'bug'); }
export function jiraMayCreateAdo(j) { return !!j && (j.type === 'epic' || j.type === 'story'); }

// Status. ADO side is kept as a key: state plus "+human-auth" when tagged.
export function adoKey(state, human) { return String(state || '') + (human ? '+' + TAG_HUMAN : ''); }

export function jiraToAdo(js) {
  switch (jiraStatus(js)) {
    case 'backlog': return {state: 'New', human: false};
    case 'In dev': case 'verify': return {state: 'Active', human: false};
    case 'Human auth': return {state: 'Active', human: true};
    case 'Done': return {state: 'Closed', human: false};
    default: return null;
  }
}

// ADO Active maps back to In dev unless Jira is already in verify.
export function adoToJira(state, human, curJira) {
  switch (String(state || '')) {
    case 'New': return 'backlog';
    case 'Active': return human ? 'Human auth' : (jiraStatus(curJira) === 'verify' ? 'verify' : 'In dev');
    case 'Closed': return 'Done';
    default: return null;
  }
}

// Hard rule (R7): Epics never close by sync, in either direction.
export function closesEpic(type, target) {
  return type === 'epic' && (target === 'Done' || target === 'Closed' || (target && target.state === 'Closed'));
}
