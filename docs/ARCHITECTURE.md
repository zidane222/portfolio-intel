# Portfolio Intel architecture

Owner: architect agent. Update this file in the same PR as any structural change.

## System overview

```
Browser / PWA (Cloudflare Pages, mirror on GitHub Pages)
  index.html + js/NN-*.js, strict CSP, encrypted vault (AES-GCM) in localStorage
  Ask panel and chat: POST /api/ask, falls back to /api/ai
        │                                   │
        │ HTTPS, origin-checked             │ auth + encrypted sync (RLS)
        ▼                                   ▼
Gateway Worker (portfolio-intel-api)     Supabase (auth: email code, passkeys, passcode;
  routes /api/* to private services        tables: synced_data, hist_trades, hist_prices)
  rate limits, CORS allowlist,                        ▲
  strips client X-PI-* headers                        │ daily load, 5-year window
  agents/ (POST /api/ask): supervisor, intent,        │
    data agents, fact checker, builder, validator     │
        │ service bindings                            │
        ▼                                             │
  pi-market  pi-news  pi-rates  pi-ai  pi-broker  pi-disclosures  pi-private  pi-insights  pi-newsdesk
  (prices,   (news,   (savings  (Groq: (Plaid)    (House/Senate   (SEC Form D/C,  (news reads:
   history,   feeds)   rates)    Ask,             trades)          filters, stats) cron batch,
   sectors,                      extract,                                          on demand,
   dividends)                    /internal/intent,                                 no public URL)
                                 /internal/build)                                      │
                                                                  Workers KV NEWSREADS ┤ Supabase service key
                                                                  Supabase news tables ┘ (RLS, definer functions)
        ▲
        │ fallback on network or 5xx errors
Feature flags (live since 2026-11-10): pi-flags Worker (workers.dev URL behind Cloudflare Access,
  GitHub login, owner email only; the only code that writes flags)
  → Workers KV FLAGS (namespace pi-flags: flags:v1, audit:r:*), bound to the gateway, pi-flags,
  pi-newsdesk and pi-sync → read by the gateway (10 s isolate cache), pi-newsdesk (cron and on demand)
  and the pi-sync cron; public GET /api/flags → app, Render fallback, GitHub jobs, SOC monitor.
  Audit order on a flip: KV audit record first (no record, no flip), then flags:v1, then a Supabase
  flag_audit row (SUPABASE_FLAGS_KEY, best effort), archived to BigQuery by history_load.py
Work tracking sync: pi-sync Worker (Cron Trigger every 5 min, no URL, no bindings to other pi-*)
  ↔ Jira Cloud KAN and Azure DevOps portfolio-intel; state in Workers KV SYNC; reads FLAGS
Render Flask backend (backend/main.py), kept on as fallback (has no /api/ask; news routes answer
  "no stored reads" and "paused", no Groq, no storage)

GitHub Actions
  fetch_trades (daily 06:00 UTC): House + Senate PTRs, prices, Supabase + BigQuery
  deploy-worker (push): services (including private) then gateway, Secrets Store bindings
  insights (weekly Sun 07:30 UTC + manual; push on scripts/analytics/** is a dry run): BigQuery via WIF,
    two jobs. `insights` (contents: read, id-token: write): offline tests, auth, scripts/analytics/run.py,
    lint, upload artifact. `commit` (contents: write only, runs only on main): commits insights.json and
    strategies.json. Documented exception: this bot commits data files directly to main, like the daily data jobs.
  private-markets (daily 11:30 UTC): SEC EDGAR Form D + Form C, rolling 60 days → private_markets.json
  security (PR, push, weekly): secrets, dependencies, CodeQL, ZAP
  main_portfolio-intel (backend changes): Azure Web App deploy (CI/CD showcase)
  Save to history step (inside fetch_trades): scripts/history_load.py also copies the last 3 days of
    Supabase news_verdicts into BigQuery (MERGE on id) and purges verdicts over 2 years
SOC monitor (soc-monitor.yml, 13:15 UTC daily + manual): scripts/soc_monitor.py, stdlib + requests, no AI.
  Reads Cloudflare Workers telemetry (cfk/cfkd, all pi-* and portfolio-intel-api), Supabase news_jobs,
  news_verdicts and news_budget (SP/SR, read-only), GitHub runs and alert counts (GITHUB_TOKEN).
  Severity OK/WARN/ALERT in code; WARN or ALERT opens or updates one issue labeled soc-monitor, OK closes it.
  ALERT: cron failure streak >= 5, > 20 5xx, 0 verdicts after 06:00 UTC, failed fetch_trades or private-markets run.
  WARN: budget >= 80%, request/exception/429 spikes (> 3x 7-day baseline), job errors, failed workflows, open alerts.
  Exit 1 only if Cloudflare or Supabase is unreachable. Output carries no secrets, IPs, emails, tickers or bodies.
Meta supervisor (meta-supervisor.yml, 14:10 UTC daily + manual): scripts/meta_supervisor.py, stdlib + requests, no AI.
  Checks the other supervisors (A validator canary, B news judge, C insights files) and owns source
  reconciliation (D): official House and Senate records vs FMP, read from trades.json on main. fetch_trades
  computes the cross-check at 06:00 (it holds the FMP key); check D judges it. House: ALERT below 80% of
  FMP's trades in our scrape, or a member FMP shows with 2+ trades and none in our data (cause unknown);
  WARN below 95%, FMP accuracy below 95%, a member missing because a filing is unreadable, failed downloads
  or parses. Year-long known gaps (scanned filings, dates after filing) are noted as OK lines. Senate:
  compared only on days the official site answers; staleness stays with the SOC monitor, which no longer
  judges reconciliation. A crash in check D becomes an ALERT finding. One issue, label meta-supervisor.
  E Ask health: the gateway's {"ask":1} log lines of the last 24 h (Cloudflare telemetry, read-only cfk/cfkd,
  the SOC monitor's helpers): WARN at 25% of answers falling back to sources only, ALERT at 50% (5+ cases),
  WARN for an intent with 3+ cases and 2/3 falling back; top rule IDs listed. F heartbeat: the SOC monitor
  ran in the last 26 h (ALERT if not); the SOC monitor checks the meta supervisor the same way.
BigQuery (portfolio-intel-512216): full archive, signed in via Workload Identity Federation

Cloudflare Cron Trigger (pi-newsdesk, "*/3 4,5 * * *", 04:00 to 05:57 UTC every 3 minutes, before
fetch_trades at 06:00): each tick claims at most 2 tickers from Supabase news_jobs, reads headlines,
runs the news read agents and upserts news_verdicts.
```

pi-newsdesk (plan: `docs/plans/phase3-news-agents.md`) is the only service holding
`SUPABASE_SERVICE_KEY` (with `GROQ_API_KEY`, both from the Secrets Store). It has no public URL; the
gateway reaches it over the `NEWSDESK` binding. Its two routes return 404 without `X-PI-Internal`.
Storage:
- Supabase `news_verdicts` (batch reads, 2 years), `news_jobs` (14 days), `news_budget` (30 days)
  and view `news_reads_7d`. RLS on, no policies, no grants for anon or authenticated; access only
  through the service role and SECURITY DEFINER functions with a fixed search_path
  (`supabase/news.sql`).
- Workers KV `NEWSREADS`: key `r:{TICKER}:{YYYY-MM-DD}`, 36 h TTL, on-demand reads written only after
  a Groq read. No user identifier in key or value. The Cache API sits in front (per data center).
- BigQuery `news_verdicts`: archive copy made by `scripts/history_load.py` (no Groq key in GitHub).

pi-private reads only `PRIVATE_DATA_URL` (the `private_markets.json` file on Pages), with
`redirect: 'error'`, a 5 MB streamed cap, a 1 h cache, and the last good copy for up to 48 h.

## Route contracts (gateway)

| Path | Service | Purpose |
|---|---|---|
| `/api/prices`, `/api/history`, `/api/sectors`, `/api/dividends` | market | Quotes, price history, sector and dividend data |
| `/api/news`, `/api/feeds` | news | Ticker news, with Render fallback for Reddit and Google News |
| `/api/top-rates` | rates | Top savings rates, read by AI from a daily article. `?cached=1` returns memory only (no fetch, no Groq call) |
| `/api/ai` | ai | `{mode: "assistant"|"extract", question, context?}` → `{answer}` |
| `/api/ask` | gateway (agents/supervisor.js) | `POST {question, history?, portfolio?, client_asof}` → `{answer, sources[], check: {status: PASS|FLAG|fallback, flags, attempts}, intent, case_id, ms}`. Worker only; the app falls back to `/api/ai`. Body at most 32 KB (413) |
| `/api/private` | private | `GET ?state&city&stage&industry&form&q&limit&offset` → `{updated, total, count, offset, raises[]}` |
| `/api/newsdesk/reads` | newsdesk (special-cased in `index.js`) | `POST {tickers: [1 to 40]}` → `{updated, window_days: 7, reads: {T: [record...]}}`. Latest batch verdict or today's shared read per ticker. 0 Groq calls, counts against no cap. Body at most 2 KB. Tickers only in the POST body |
| `/api/newsdesk/read` | newsdesk (special-cased in `index.js`) | `POST {ticker}` → `{status: ok|thin|fallback|limited|busy, cached, groq_calls, quota_left, read, message}`. Gateway order: origin, `api` limit, 1 KB body, ticker regex, pi-market quote check (invalid is 400 with no Groq call), per-visitor quota (`newsread` bucket: 3 a minute, 10 uncached a day; pi-newsdesk gets only `X-PI-Quota: ok|over`, never the IP). pi-newsdesk order: Cache API, KV, today's batch row, then quota, thin check (0 calls), global cap, Groq. 503 when `NEWS_ONDEMAND_ENABLED = "0"` |
| `/api/private/stats` | private | Same filters → `{updated, count, total_amt, by_stage, by_form, by_state_top, by_industry_top}` |
| `/api/insights` | insights | `GET` (no params) → `insights.json` (`pi/insights/v1`) plus `served_asof`, `stale` (generated over 10 days ago). Service answers 404 without `X-PI-Internal: 1` (gateway sets it for public reads, the Ask data agent sends it). Reads only `INSIGHTS_DATA_URL` on Pages, `redirect: 'manual'` and any 3xx refused, 5 MB streamed cap, 1 h cache, last good copy 48 h, else 502 |
| `/api/insights/strategies` | insights | `GET` → `strategies.json` (`pi/strategies/v1`) plus `served_asof`, `stale`. Same rules |
| `/api/plaid/*` | broker | Plaid link and holdings (sandbox) |
| `/api/flags` | gateway (`index.js`, `lib/flags.js`) | `GET` → `{v, updated, flags: {name: bool}}` only (no who, when or why). `flags` rate bucket 30/min, `Cache-Control: public, max-age=15`. Browsers need an allowed Origin; server callers send none. Never flaggable. Render serves the same shape from its last poll |
| any flaggable route, flag off | gateway and Render | HTTP 503, `Retry-After: 60`, `X-PI-Flag: off`, `{"error": "This feature is turned off for now. Try again later.", "disabled": true, "flag": "<name>"}`. The app does not fall back to Render on this answer |
| `/admin`, `/admin/*` | none (404 at the gateway) | Live only on pi-flags |
| `/api/all-trades` | disclosures | Congressional trades |
| `/api/insiders` (binding only) | disclosures | `GET` → `{buys[], updated}` from `insiders.json` (SEC Form 4 open-market buys, built by `scripts/smart_money.py`); the `seen` index is not returned. Used by the `insiders` Ask agent; no public gateway route |

pi-flags admin routes (own workers.dev URL, every route 403 unless a valid Cloudflare Access JWT
is present: RS256 signature against the team JWKS, `aud` = `ACCESS_AUD`, `iss` = team domain, `exp`,
email from the token equal to the one `ADMIN_EMAIL`; any missing setting is 403). Live since
2026-11-10: one Access application covers the whole pi-flags host, login method GitHub only (the
default "accept all identity providers", which includes the one-time PIN by email, is turned off),
policy Allow for the owner email only, Zero Trust Free plan (no cost):

| Route | Contract |
|---|---|
| `GET /admin` (+ `/admin/app.js`, `/admin/app.css`) | Mobile page, CSP `default-src 'none'; script-src 'self'`, text set with textContent only |
| `GET /admin/flags` | `{v, updated, flags: {name: {on, default, fail, kind, label, by, at, reason}}}` |
| `POST /admin/flags` | `{name, on, reason (3 to 200 chars), v}` with header `X-PI-Flags: 1` and `Origin` equal to the Worker origin (else 403). 2 KB cap. 409 `{error, v}` when `v` is stale. Writes the KV audit record first (503 and no flag change if that fails), then `flags:v1` with `v + 1`, then the Supabase row (best effort: skipped without a log line when `SUPABASE_FLAGS_KEY` is not bound, logged and ignored when the insert fails; the flip still answers 200). If the `flags:v1` write fails after the KV audit record, the answer is 500, the flag is unchanged and the KV audit holds a record for a `v` that never landed. The version check is a read then a write, not atomic; fine with one admin |
| `GET /admin/audit?since=ISO` | `{audit: [record...]}`, newest first, at most 20, from one KV list page |

Audit record: `{id (uuid), at (ISO), name, on, by (actor email from the JWT), reason, v}`. KV key
`audit:r:{13-digit 9999999999999 minus epoch ms}:{12 hex}` with no TTL (value and metadata), so key order is newest first. The KV record is the one a flip depends on; `/admin/audit` lists only the newest 20. Supabase `flag_audit` is the queryable history, written after the flip and best effort, so it can miss a row that KV has. Supabase `flag_audit` (`supabase/flags.sql`, applied 2026-11-10:
RLS on, no policies, grants revoked from anon and authenticated, insert only through SECURITY DEFINER
`flag_audit_add`, 450 MB guard), archived to BigQuery `flag_audit` (MERGE on id, 3-day window, 9 GB
guard), Supabase rows over 1 year purged after a good merge.

pi-sync (cron `*/5 * * * *`, plan `docs/plans/pi-sync.md`, runbook `docs/runbooks/sync.md`) has no
routes: every fetch answers 404, it has no gateway binding and no service bindings, and it calls only
Jira Cloud (nadia-b.atlassian.net, project KAN) and Azure DevOps (portfolio-intel-279/portfolio-intel).
It holds JIRA_EMAIL, JIRA_API_TOKEN and ADO_PAT (Secrets Store) and the SYNC KV namespace; it reads FLAGS.

| Contract | Shape |
|---|---|
| KV `pair:KAN-<n>` | `{jira, ado, type: epic|story|bug, jiraUpdated, adoRev, adoChanged, hash: {j: {title, desc, status, parent}, a: {...}}, at}`. Hashes are FNV-1a of each side's last synced value, so KV holds no titles or descriptions |
| KV `ado:<id>` | value and metadata `{k: "KAN-<n>"}` (reverse index, loaded with one list call) |
| KV `cursor:jira`, `cursor:ado`, `meta:first_live` | ISO time. `meta:first_live` is set on the first tick with dry run off; only items created after it are ever created on the other side (no backfill) |
| KV `pending:jira:<key>`, `pending:ado:<id>` | ISO, TTL 1 h, written before a create (create guard) |
| KV `run:last` | `{at, dryrun, scanned, planned, written, skipped, waiting, errors: [{pair, code}], notices: [{pair, codes}], unpaired: {jira: [keys], ado: [ids], jira_n, ado_n}, calls, truncated}`. No field values |
| Log line `sync plan` | `{pair, dir: j2a|a2j|both|create_j|create_a, fields: [title|desc|status|parent|link], reason}` |

Rules: ADO tag `jira-KAN-<n>` is the pair key, Jira label `ado-<id>` its mirror. Statuses: backlog = New,
In dev and verify = Active, Human auth = Active plus tag `human-auth`, Done = Closed; Jira transitions use
the fixed ids 11, 21, 31, 41 (Done), 51 (Human auth). Epics never close by sync. ADO items tagged
`internal` never sync. ADO owns customer-visible Bugs: an ADO Bug tagged `customer-visible` creates the
Jira Bug, an ADO close closes it, a Jira close only adds a comment on the ADO bug. Last updated wins,
ties go to Jira. Flags `sync` (off: exit) and `sync_dryrun` (default on: plan and log only). Flags KV or
SYNC KV unreadable: no writes. At most 15 pairs and 45 subrequests per tick.

Render fallback: `POST /api/newsdesk/reads` returns empty reads and `POST /api/newsdesk/read` returns
503 "News reads are paused." with the same origin, size and ticker checks, no Groq call, nothing
stored, tickers not logged.

`/internal/intent` and `/internal/build` exist only on pi-ai. They are not in `OWNERS`, so the
gateway returns 404 for them; only the supervisor reaches them over `AI_SVC` with `X-PI-Internal: 1`.

## Feature flags registry

One registry: `worker/src/lib/flags.js` (`REGISTRY`), copied in `scripts/flags_registry.json`;
`worker/test/flags.mjs` and `scripts/test_flags.py` fail if they differ. KV namespace `pi-flags`,
binding `FLAGS`, key `flags:v1` = `{v, updated, flags: {name: {on, by, at, reason}}}`. The deploy
workflow (`deploy-worker.yml`) adds the binding from repository variable `CF_KV_FLAGS` to four
Workers: the gateway, pi-flags, pi-newsdesk (when it is deployed) and pi-sync (when it is deployed).
Only pi-flags writes; the other three bindings are writable too (KV has no read only mode) and read
by convention. Without the variable pi-flags is skipped and every flag reads its default. Owner
setup: `docs/runbooks/feature-flags.md`.

Live state (2026-11-10, PR #144, no code change at go-live): namespace bound, pi-flags deployed
behind Access, `supabase/flags.sql` applied, `SUPABASE_FLAGS_KEY` in the Secrets Store and linked.
Go-live test: `recon_v2` flipped on then off, two `flag_audit` rows (v 1 and v 2), `/api/flags`
returned the KV value. `/api/flags` answers `v: 0` and `updated: null` until the first flip, so
`v` of 1 or more shows values come from KV.

Propagation: pi-flags writes KV; other Cloudflare locations can serve the old value for up to about
60 s (KV's documented eventual consistency). Add the gateway isolate cache (10 s) and the
`/api/flags` browser cache (15 s): a change is usually live within a minute and within about 90 s at
worst. The Render fallback polls every 60 s, so it can lag up to about 2.5 minutes.

Documented exceptions:
- pi-flags is reachable on its own workers.dev URL, not only through the gateway binding. It is the
  owner admin page and is gated by Cloudflare Access plus the JWT check in `lib/access.js`; the
  gateway answers 404 for `/admin/*` and never forwards to it.
- pi-sync is cron only with no gateway binding (it serves no app route). Its tests live in
  `worker/test/sync.mjs` (run by `security.yml` and `deploy-worker.yml`), not `worker/test/test.mjs`.
- Flag tests live in `worker/test/flags.mjs` (run by `security.yml`), not `worker/test/test.mjs`. qa owns tests.

| Flag | Default | Fail mode | Where |
|---|---|---|---|
| maintenance | off | last | Gateway and Render: every `/api/*` route except `/api/flags` |
| broker | on | closed | `/api/plaid/*` |
| sync_writes | on | closed | Client only (`js/29a-account.js`): uploads pause, data stays encrypted on the device. Hard stop in Supabase is a follow-up |
| ai | on | open | `/api/ask`, `/api/ai` |
| news | on | open | `/api/news`, `/api/feeds`, `/api/newsdesk/*`, pi-newsdesk cron (ANDed with `NEWS_*_ENABLED`) |
| disclosures | on | open | `/api/all-trades` (Render also house and senate routes) |
| market | on | open | `/api/prices`, `/api/history`, `/api/sectors`, `/api/dividends` |
| house_scrape, senate_scrape, fmp_fill | on | open | fetch_trades steps (`scripts/flags.py`) |
| recon_v2 | off | open | fetch_trades house check (v2 not built; the current check runs) |
| sync | on | closed | pi-sync cron: off means the tick exits |
| sync_dryrun | on | closed | pi-sync cron: on means plan and log only, no writes to Jira, ADO or pair records. Owner turns it off on the flags page after reviewing `run:last` |

Reading: 10 s isolate cache (`CACHE_MS` in `lib/flags.js`), then KV (KV itself propagates in about 60 s). KV unreadable or invalid:
the last known value in the isolate, else off for closed flags and the default for the rest. No
binding: defaults. Health, `/api/flags` and the monitors are never flaggable.

## Data classification

| Class | Examples | Where it lives | Protection |
|---|---|---|---|
| Confidential (user) | Holdings, cash, snapshots, Plaid link | Device vault; Supabase `synced_data` as ciphertext only | AES-GCM, key from passcode (PBKDF2 210k) or passkey PRF; RLS. A holdings summary may be sent with a question as request context (as with /api/ai). Used in memory only, never stored or logged. Chat keeps only the user's questions in sessionStorage |
| Credentials | API keys, service role key, Groq key | Cloudflare Secrets Store, GitHub secrets | Never in code or logs; WIF for GCP. The Supabase service key is bound only to pi-newsdesk among Workers; pi-flags has its own separate Supabase key (SUPABASE_FLAGS_KEY). JIRA_EMAIL, JIRA_API_TOKEN (dedicated KAN-only Jira user) and ADO_PAT (Work Items read and write only) are bound only to pi-sync |
| Owner (admin) | Owner email in flag audit records, admin allowlist | KV audit keys, Supabase flag_audit, BigQuery flag_audit, GitHub secret FLAGS_ADMIN_EMAIL | Not public: GET /api/flags returns booleans only; audit read only behind Access |
| Account | Email, passkey public keys, hash of the passcode login secret | Supabase Auth | Supabase managed. The login secret is PBKDF2 (600k, salt from the email, separate purpose) of the passcode, so it can't recover the passcode or the data key |
| Public | Congressional trades, prices, news, SEC Form D and Form C filings, news reads (model text over public headlines) | JSON files, Supabase history and `news_verdicts`, KV, BigQuery | Integrity only. Reads carry no user identifier |
| Confidential (user), news list | The user's own ticker list for News "My reads" | Device vault (`state.newsList`), ciphertext when synced | Sent to the gateway as plain tickers in a POST body to get reads, with no user identifier (control C-39, accepted disclosure) |

## In-app agent framework (in place, Phase 2)

Code: `worker/src/agents/`. Plan: `docs/plans/phase2-supervisor.md`.

Flow for one `POST /api/ask` case:
1. Gateway checks origin, the `api` and `ask` rate limits, and the body (32 KB, streamed).
2. `supervisor.js` creates the case state (`case.js`, schema `pi/case-state/v1`) and owns it.
   Agents return patches; `applyPatch` rejects any key the agent does not own.
3. `intent.js`: rules pre-pass, then Groq call #1 via pi-ai `/internal/intent`. On failure, the rules
   result (`via: rules`). Clear out of scope skips Groq and returns a canned answer.
4. Data agents from `registry.js`, run in parallel per stage: `holdings` (device portfolio, no binding),
   `market` (MARKET), `news` (NEWS), `disclosures` (DISCLOSURES), `rates` (RATES, `?cached=1`),
   `private` (PRIVATE), `insiders` (DISCLOSURES `/api/insiders`: corporate insider buys, not Congress; rules
   route "insider", "Form 4" and officer or director purchases here and skip Groq call #1; window from the
   question, "this week" by default; largest first; joint filings merged; any single buy over $1B held back
   as a data error and noted; the answer is a code-built numbered list from the verified facts with no builder call, unless the data is stale). Each failure becomes an evidence row with status `error` or `timeout`.
5. `factcheck.js` (rules F1 to F10): sources and as-of dates, unknown for missing keys, cross-source
   tolerance, freshness, range checks, portfolio recompute, parsing, text as text only, cap of 60
   facts, derived facts in code only.
6. `builder.js`: Groq call #2 via pi-ai `/internal/build`. The model writes `[[fN]]` placeholders,
   never numbers; `render.js` fills in formatted values.
7. `validator.js` (rules, imports nothing from the builder): V1 typed digits, V1b number words and
   `%`/`$` signs, V2 to V3 placeholder checks, V4 advice, V5 guarantees, V6 PII, V7 disclaimer, V8
   order wording, V9 echoed instructions, V10 dashes, V11 length and headers, V12 warning only. Text
   is NFKC normalized and stripped of zero-width characters first.
8. FLAG: one repair (Groq call #3) with rule IDs only. Still FLAG: the safe answer (verified facts
   list plus disclaimer, `check.status = fallback`), which the app shows as sources only.

Budgets: at most 3 Groq calls per case (2 normally, 1 for out of scope), the supervisor refuses a
4th. Intent 5 s, data agents 6 s each and 7 s per step, builder 8 s, repair 6 s only if 6 s remain,
25 s hard deadline shared through an AbortController. Rate limit `ask`: 6/min, 40/hour, 150/day per
IP (per Worker instance, risk R-11 accepted). Logs: one line per case with ids, intent, counts, rule
IDs and timings, never user text.

Boundaries: agents never call each other; only the supervisor sequences them. Data reaches agents
only through service bindings with fixed paths (tickers checked with `^[A-Z.\-]{1,6}$`). Groq is
called only from pi-ai, pi-rates and pi-newsdesk.

### News read agents (in place, Phase 3)

Code: `worker/src/agents/newsread/` (pure modules, bundled into pi-newsdesk) and
`worker/src/modules/newsdesk.js`. Plan: `docs/plans/phase3-news-agents.md`.

- `pack.js` builds the evidence pack from the last 7 days of headlines (cleaned, deduped by cluster,
  max 8, ids `e1`..`e8`). `lexicon.js` scores tone and `mode.js` picks the mode in code: `thin` (no
  Groq call), `collaborate` (one joint brief) or `debate` (bull and bear in parallel on the same
  frozen pack, then the judge). The mode basis is stored in the record.
- `roles.js`: `bull`, `bear`, `joint`, `judge` are `(case, deps) => patch` functions over
  `case.ext.news`; they never call each other and the judge sees only validated points. `deps.groq`
  and `deps.take` are injected by pi-newsdesk. `supervisor.js` `runNewsRead` sequences them, repairs
  one failing role once, applies the confidence cap and falls back to the cited headline list.
- `validator.js` adds V14 to V21 and `validateNewsRead` (cites exist, each side cites, judge adds no
  facts, stance and confidence enums and cap, code label, advice words, stance words, injection
  echo). V13 was reserved for Strategy and is now built (Phase 4). `render.js` writes the label "News read, not a
  recommendation." and the cite text; the front end renders from the same record (`pi/news-verdict/v1`).
- Ask: intent `news_read` (rules pre-pass, no Groq intent call) runs the data agent
  `agents/data/newsread.js`, which calls `NEWSDESK /read` with the same quota flag, then renders the
  record. The chat shows the same read card. The Phase 2 case cap of 3 Groq calls covers the gateway;
  the read's own calls are counted by pi-newsdesk.
- Caps: at most 4 Groq calls per ticker; global daily cap in Supabase `news_take` (90 calls, 180000
  tokens, batch share 50, reserved atomically before each call); per-visitor cap in the gateway
  (above). Cap reached: batch marks the ticker `skipped`, on-demand answers `busy`.
- Universe: SPY, QQQ, AAPL, MSFT, NVDA, AMZN, GOOGL, META, TSLA, GLD plus the top 20 congressional
  tickers of the last 30 days (`news_universe()`), cap 30. Any other valid ticker is read on demand
  and never stored long term.
- Per-user list: News "My reads" uses the device list (watchlist plus portfolio tickers, editable),
  stored in the encrypted vault.

Extension points (not built):
- `registry.js` maps intent to agents. Research, Strategy and Insights supervisors keep the
  `(case, deps) => patch` shape and a top-level router picks one; `case.ext.<domain>` is reserved.
- News bull/bear/judge are built (Phase 3, above). A Research supervisor can reuse them as `news`
  evidence without changing the fact checker or validator.
- Learning agent: reads `news_verdicts` (or the BigQuery copy) by `run_date` and `ticker`, joins
  `hist_prices` from `price_ref_date`. Not built.
- Strategy facts must carry `rules: ["simulated"]`; validator V13 "simulated label present" is built (Phase 4, below).
- Data science on BigQuery and the learning agent run in the daily GitHub job, publish JSON to
  Pages, and are read by a data agent like pi-private.
- SOC monitor reads the per-case log line and `trace` (timings, rule IDs, no user text).

## Insights and simulated strategies (in place, Phase 4)

Plan: `docs/plans/phase4-data-science-strategy.md`. No Groq in the job; text comes from fixed templates.
- Weekly job (`insights.yml`) runs `scripts/analytics/` against BigQuery with Workload Identity Federation
  (no stored key). Least privilege is split across two jobs: analysis (`contents: read`, `id-token: write`)
  and commit (`contents: write`, main only). Exception: the bot commits `insights.json` and `strategies.json`
  directly to main, like the daily data jobs.
- Lint gate (`scripts/analytics/lint.py`) runs on the published files before upload: advice words, labels,
  dashes, schema. A lint failure writes nothing.
- `pi-insights` is a private service reached over the `INSIGHTS` binding. It reads only
  `INSIGHTS_DATA_URL` on Pages (`redirect: 'manual'`, 5 MB cap, 1 h cache, last good copy 48 h) and answers 404
  without `X-PI-Internal: 1`. The gateway sets `X-PI-Internal` only on the insights route (`index.js`), after
  the client-sent X-PI-* headers are stripped. Every other route is forwarded unchanged.
- Validator: V13 (simulated result needs the "simulated" and "not investment advice" labels), V22 (historical
  result needs "past results do not predict future results"), and a wider V4 advice pattern list. Labels are
  rendered in code (`render.js`), never by the model.
- Insights page (front end) renders the two files; Render fallback answers 503 for `/api/insights*`.

## Dev team

Role agents in `.claude/agents/`, workflow in `CLAUDE.md`.
