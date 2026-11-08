# Jira and ADO sync (pi-sync): owner setup and use

pi-sync keeps Jira project KAN and the Azure DevOps project portfolio-intel in step every 5 minutes.
It syncs Epics and Stories (User Stories), plus ADO Bugs tagged `customer-visible`. Plan:
`docs/plans/pi-sync.md`. It ships with dry run on, so the first deploy only logs.

## What it does

- Title, description (best effort), status and parent link, both ways. Last updated wins; a tie goes to Jira.
- Statuses: backlog = New, In dev and verify = Active, Human auth = Active plus tag `human-auth`, Done = Closed.
- Epics never close by sync, either way. A closed Epic on one side only shows a notice.
- ADO items tagged `internal` never sync. Tasks, Features, Agent Runs and untagged Bugs never sync.
- ADO owns customer-visible Bugs: tagging an ADO Bug `customer-visible` creates the Jira Bug, closing the
  ADO bug closes the Jira copy, closing the Jira copy only adds a comment on the ADO bug.
- Pairs are matched by the ADO tag `jira-KAN-<n>`. The Jira side gets the label `ado-<id>`.
- No backfill: items created before the first live run (dry run off) are never created on the other
  side. They are listed as unpaired in `run:last` and the `sync tick` log so you can pair them by hand
  (add the `jira-KAN-<n>` tag in ADO).

## Setup (one time)

1. Jira: create a dedicated user with access to project KAN only. Sign in as that user and create an API
   token at id.atlassian.com. Make sure the user can move issues through every KAN status.
2. ADO: create a PAT with scope Work Items (Read and write) only, organization portfolio-intel-279 only,
   90 day expiry. Put the expiry date in your calendar.
3. Cloudflare Secrets Store (same store as the other Worker secrets): add `JIRA_EMAIL` (the dedicated
   user's email), `JIRA_API_TOKEN` and `ADO_PAT`. Never paste them anywhere else.
4. Workers KV: create a namespace named `pi-sync`. Add its 32 character id as the GitHub repository
   variable `CF_KV_SYNC`.
5. Check that the repository variable `CF_KV_FLAGS` is set (without it the flags read their defaults:
   sync on, dry run on).
6. Run the Deploy API Worker workflow. Until steps 3 and 4 are done it skips pi-sync with a warning.

## Rollout

1. Leave `sync_dryrun` on for a day. In the Cloudflare dashboard, open pi-sync logs and read the
   `sync plan` lines and the `sync tick` summary (planned, errors, unpaired). Nothing is written.
2. Pair any unpaired items you want synced by adding the `jira-KAN-<n>` tag in ADO.
3. Turn `sync_dryrun` off on the flags page. The first live tick records the start time; only items
   created after it get a copy on the other side.

## Stop it

Turn `sync` off on the flags page (takes effect within about 90 seconds). Full rollback: revert the PR
and run `wrangler delete pi-sync`. Labels and tags it added are harmless.

## Error codes in the log

`unknown_status` (a status or state outside the table; the pair is skipped), `type_mismatch`,
`parent_unpaired` (counted as waiting; the child syncs once its Epic is paired), `jira_http_<n>`,
`ado_http_<n>` (401 or 403 usually means a token expired or lost scope), `jira_missing`, `ado_missing`.
