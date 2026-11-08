# Plan: pi-sync (Jira Cloud and Azure DevOps two-way sync)

Owner: architect. Status: draft for owner review. Branch: `feat/pi-sync` from `main` after PR #144.
Date: 2026-11-08. No AI. No user portfolio data is touched.

## 1. Goal and scope

A private Worker `pi-sync` runs every 5 minutes (Cron Trigger) and keeps Jira project KAN
(nadia-b.atlassian.net, team-managed) and Azure DevOps project portfolio-intel (org
portfolio-intel-279, process "Portfolio Intel Agile") in step for Epics and Stories/User Stories.

In scope: title, description (best effort), status, parent link, creating the missing side of a pair,
the customer-visible Bug route. Out of scope: comments, attachments, assignees, sprints, story points,
deleting items on either side, closing Epics, any app or gateway route.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | New Worker `worker/config/sync.toml`, `name = "pi-sync"`, `workers_dev = false`, `preview_urls = false`, `crons = ["*/5 * * * *"]`. No fetch handler beyond a 404. No gateway binding, no service bindings. | Cron only, smallest surface. It calls only Jira and ADO, never another pi-* service, so the boundary rule holds. |
| D2 | Secrets `JIRA_EMAIL`, `JIRA_API_TOKEN`, `ADO_PAT` linked from the Secrets Store by `deploy-worker.yml` (`link config/sync.toml ...`), added to `NAMES` in `lib/secrets.js`. Skipped with a warning (like pi-newsdesk) until all three exist and `CF_KV_SYNC` is set. | House rule. Other deploys keep working before owner setup. |
| D3 | State in a new KV namespace `pi-sync` (binding `SYNC`, id from repository variable `CF_KV_SYNC`). Reads `FLAGS` read only (from `CF_KV_FLAGS`). | Owner asked for KV. Kept apart from FLAGS so pi-flags stays its only writer. |
| D4 | Two new flags in `REGISTRY` and `scripts/flags_registry.json`: `sync` (default true, fail closed, kind job, "Jira and ADO sync") and `sync_dryrun` (default **true**, fail closed, kind job, "Sync dry run: log only, no writes"). Each tick reads both first. `sync` off: exit. `sync_dryrun` on: compute and log the plan, write nothing to Jira, ADO or the pair records. | Fail closed means a KV outage never writes. Dry run is on by default so the first deploy only logs; the owner turns it off on the flags page. |
| D5 | Pure core: `worker/src/modules/sync/` with `map.js` (status, title, type, routing), `diff.js` (decide per pair), `jira.js` and `ado.js` (thin REST clients, injected `fetch`), `md.js` (description conversion). `worker/src/services/sync.js` wires env and the cron. | Same pattern as newsdesk: testable without network. |
| D6 | Matching: ADO tag `jira-KAN-<n>` is the source of truth. Jira side gets label `ado-<id>` (added on first sync of an existing pair, backfilled in dry run report first). The "Engineering detail" line is read only as a fallback when the label is missing, never parsed for writes. | Labels are machine friendly; free text is not. |
| D7 | Conflict: last updated wins, comparing Jira `fields.updated` and ADO `System.ChangedDate` (UTC). A field is pushed only when the source side changed after the pair record's last sync. | Owner rule. |
| D8 | Loop guard: after every write the Worker stores the new revision of both sides (Jira `updated` value, ADO `System.Rev`). A change whose revision equals the stored one is our own echo and is skipped. Also a pair is never written twice in one tick. | Prevents ping pong and duplicates. |
| D9 | Create guard: before creating a new item, write a KV `pending:<source>` marker, then search the target for the link key; create only if absent. | A tick that dies between create and record will not create a second copy. |
| D10 | Throughput: each tick pulls items changed since a cursor (with a 10 minute overlap), at most 15 pairs per tick, rest next tick. | Free plan limits: 50 subrequests and 10 ms CPU per invocation. |

## 3. Mapping

Types: Jira Epic <-> ADO Epic. Jira Story <-> ADO User Story. ADO Bug tagged `customer-visible` ->
Jira Bug (one way create, then title/status sync both ways, label `ado-<id>`). ADO Task, Feature,
Agent Run and untagged Bug: ignored, never created in Jira. Any other Jira type: ignored.

Title: ADO `KAN-<n> <title>` <-> Jira `<title>`. Strip the prefix going to Jira, add it going to ADO.

Status (Jira status names resolved to transition ids at runtime, cached in KV for a day):

| Jira | ADO | Notes |
|---|---|---|
| Backlog | New | |
| In dev, Verify | Active | ADO Active maps back to In dev unless Jira is already in Verify |
| Human auth | Active + tag `human-auth` | Tag removed when Jira leaves Human auth |
| Done | Closed (User Story, customer Bug) | Epics: never set to Done or Closed by sync. A closed Epic on one side only logs a notice |

Parent: Story parent Epic (Jira `parent`) <-> User Story parent link to the paired ADO Epic. If the
parent Epic is not paired yet, the child waits a tick. Re-parenting follows last updated wins.

Description: Jira ADF <-> ADO HTML through a small markdown middle step (headings, lists, bold,
links, code). Unknown nodes become plain text. A marker comment keeps a round trip stable. Best
effort; lossy edits are logged, never failed.

## 4. Data contracts

KV keys in `SYNC`:
- `pair:KAN-<n>` -> `{jira: "KAN-12", ado: 345, type: "story"|"epic"|"bug", jiraUpdated: ISO, adoRev: int, adoChanged: ISO, hash: {title, desc, status, parent}, at: ISO}`
- `ado:<id>` -> `"KAN-<n>"` (reverse index)
- `cursor:jira`, `cursor:ado` -> ISO timestamp
- `pending:jira:<key>` / `pending:ado:<id>` -> ISO, TTL 1 h
- `meta:transitions` -> `{statusName: transitionId}`, TTL 24 h
- `run:last` -> `{at, dryrun, scanned, planned, written, skipped, errors: [{pair, code}]}` (no field values)

Planned action (dry run log line, one per pair): `{pair, dir: "j2a"|"a2j"|"create_j"|"create_a", fields: ["title","status"], reason}`.
Logs never include tokens, emails, headers or descriptions.

## 5. Files touched

- New: `worker/config/sync.toml`, `worker/src/services/sync.js`, `worker/src/modules/sync/{map,diff,jira,ado,md}.js`, `worker/test/sync.mjs`, fixtures under `worker/test/fixtures/sync/`, `docs/runbooks/sync.md` (owner setup: PATs scopes, KV, flags).
- Changed: `worker/src/lib/flags.js` and `scripts/flags_registry.json` (two flags), `worker/src/lib/secrets.js` (three names), `.github/workflows/deploy-worker.yml` (deploy pi-sync, skip rule, run `node test/sync.mjs`), `.github/workflows/security.yml` (run sync tests), `docs/ARCHITECTURE.md` (pi-sync box, KV, secrets row), `docs/compliance/CONTROLS.md` and `EVIDENCE.md`.

## 6. Risks

- R1 Token scope. Jira API tokens carry the full user's rights. Mitigation: a dedicated Jira user with access to KAN only; ADO PAT scoped to Work Items read/write, this org only, 90 day expiry. Owner action.
- R2 Loops or duplicates. Mitigated by D8, D9 and dry run default; tests cover echo and crash between create and record.
- R3 KV free tier is 1,000 writes a day. Writes happen only on change plus `run:last` (288 a day). Flag: if traffic grows, `run:last` moves to every 6th tick. No paid cost added.
- R4 Clock skew and same second edits. Ties go to Jira and are logged.
- R5 Workflow drift: renamed Jira statuses or ADO states. Unknown status makes the pair skip with an error code, never a guess.
- R6 Description loss on round trip. Best effort by design; title and status are the contract.
- R7 Epic closure by mistake. Hard rule in `map.js` plus a test.

## 7. Test plan (qa)

- Unit (`worker/test/sync.mjs`, offline, fake fetch): title prefix both ways; every status row; human-auth tag add and remove; Epic never closed either way; routing (Task, Feature, Agent Run, untagged Bug never reach Jira; customer-visible Bug creates one Jira Bug); last updated wins both ways and tie; echo skip; crash between create and record makes no duplicate; parent waits for unpaired Epic; flags `sync` off and KV down (fail closed) write nothing; dry run makes zero write calls; logs contain no secret values.
- Existing suites stay green: `node test/test.mjs "$TOKEN"` with the Fernet test token, `node test/flags.mjs`, `scripts/test_flags.py`.
- Staged rollout: deploy with dry run on, owner reviews a day of `run:last` and logs, then turns dry run off for a single test pair before all.

## 8. Rollback

Turn `sync` off on the flags page (takes effect within about 90 s). Full rollback: revert the PR; the
deploy skips pi-sync and `wrangler delete pi-sync`. Jira labels and ADO tags it added are harmless.

## 9. Open questions for the owner

1. Exact Jira status names in KAN (is it "In dev" and "Verify" as two statuses?) and ADO Epic states to leave untouched.
2. Should a customer-visible Bug closed in Jira close the ADO Bug, or only notify?
3. OK to create a dedicated Jira service user (needs a seat) or use your account token for now?
4. Should items created in Jira before today without an ADO pair be created in ADO, or only items created from now on?
