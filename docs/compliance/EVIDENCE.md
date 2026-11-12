# Evidence log

One row per change or review. This is what a SOC 2 Type II auditor samples.

| Date | Item | Type | Tests | Scans | Reviewer | Link |
|---|---|---|---|---|---|---|
| 2026-10-20 | Email code sign-in | Change | Headless journeys pass | n/a | architect, owner | PR #58 |
| 2026-10-20 | Passkeys sign-in and unlock | Change | Virtual authenticator PRF tests pass | n/a | appsec, owner | PR #59 |
| 2026-10-20 | Welcome and one-step passcode | Change | Headless journeys pass | n/a | owner | PR #60 |
| 2026-10-20 | BigQuery WIF, stored key retired | Access | Load run passes | n/a | owner | commit 1ace502 |
| 2026-10-23 | Dev team agents, security scanning, compliance pack | Change | Worker tests pass | gitleaks clean (140 commits), CodeQL clean | owner | PR #61 |
| 2026-10-23 | First pip-audit found 4 vulnerable backend packages (flask, flask-cors, requests, gunicorn); upgraded, re-audit clean, app and gunicorn config checked | Vulnerability fix | Flask test client, gunicorn --check-config | pip-audit clean | appsec, owner | PR #61 |
| 2026-10-23 | Private markets page (SEC Form D and Form C) | Change | Headless journey at 390px, filters, no console errors; collector test run in Actions | gitleaks, CodeQL on PR | owner | PR (private markets) |
| 2026-10-23 | Phase 2 plan: in-app agent supervisor, /api/ask, pi-private; owner decisions recorded | Change (plan) | n/a | n/a | architect, owner | commits 3c08c79, a00608b |
| 2026-10-23 | Phase 2 build (server): supervisor, intent, data agents, fact checker, builder, validator, /api/ask; Groq error bodies and tickers no longer logged | Change | Worker tests pass | gitleaks, CodeQL on PR | architect | commits adb8e9f, 1a32051 |
| 2026-10-23 | Phase 2 build (microservices): pi-private with server-side filters and stats | Change | Worker tests pass | gitleaks, CodeQL on PR | architect | commit e7755f8 |
| 2026-10-23 | Phase 2 build (frontend): Ask and chat on /api/ask, Sources list, Checked badge, fallback to /api/ai | Change | Ask journey | gitleaks, CodeQL on PR | architect | commit c60e071 |
| 2026-10-23 | Phase 2 QA: worker tests and ask journey added; 2 bugs fixed (V4 missed "buy X now", in-flight calls not aborted after a case ended) | Test | 82 worker tests, ask journey (390px and desktop) | n/a | qa | commit bde1c4a |
| 2026-10-23 | Phase 2 AppSec review: 1 High, 3 Medium, 5 Low. Fixes: V1b number words and digits only via placeholders, streamed body caps, X-PI-* stripped at gateway, chat stores only user questions (M3), https-only source links, role allowlist | Security review | 93 worker tests, ask journey 52 checks pass | gitleaks, CodeQL on PR | appsec | commits 27190ab, fde7529 |
| 2026-10-23 | Phase 2 AppSec re-review: all findings resolved; found and fixed Unicode digit, fraction, roman numeral and zero-width bypasses of V1 and V4 (text normalized before checks); non-English number words logged as Low | Security review | 95 worker tests pass | gitleaks, CodeQL on PR | appsec | Not blocked |
| 2026-10-26 | Phase 3 plan: competing news agents, pi-newsdesk cron batch, Supabase verdicts, KV cache, caps; owner decisions recorded (no Groq key in GitHub, default list, per-user list, any valid ticker) | Change (plan) | n/a | n/a | architect, owner | commits ab90e86, d121107, 307a1e0, 7f053b3; docs/plans/phase3-news-agents.md |
| 2026-10-26 | Phase 3 build by 3 builders: server (news read agents, V14 to V21, gateway routes, caps, Ask news_read), microservices (pi-newsdesk, supabase/news.sql, history_load.py copy, Render fallback routes, deploy), frontend (My reads, read cards on News, ticker page and Ask) | Change | Worker tests pass | gitleaks, CodeQL on PR | architect | commits 563d907, 3f8fb3a, 6d2759c, 20b72ba |
| 2026-10-26 | Phase 3 QA: tests added for agents, validator, gateway, pi-newsdesk tick, cache order and caps; chat shows the news read card | Test | 161 worker tests, 5 Python tests, ask journey 52 checks, news journey 56 checks | n/a | qa | commit 64b9262 |
| 2026-10-26 | Phase 3 AppSec review against ASVS and CONTROLS.md. Not blocked. Medium #2 (user tickers sent to the gateway) accepted by the owner and recorded as C-39. Found and fixed: non-Latin look-alike letters in news text now raise V21. Found and recorded: per-IP in-flight race on the visitor counter (R-14, under R-11) | Security review | 161 worker tests pass | gitleaks, CodeQL on PR | appsec | commit 7881935 |
| 2026-10-26 | SQL fix: news_take reserves the batch share inside the SQL statement; all news functions use search_path public, pg_temp. Verified on Postgres 16 by QA (reported by the qa agent; the check output is not stored in the repo, attach it before Type I sampling) | Vulnerability fix | Postgres 16 run of supabase/news.sql, anon denied | n/a | qa, appsec | commit 64b9262 |
| 2026-10-30 | SOC monitor: daily GitHub Actions job (13:15 UTC) reads Cloudflare Workers telemetry, Supabase news tables and GitHub runs; rule-based severity OK, WARN, ALERT; opens or closes one soc-monitor issue. C-24 and C-25 moved to In place, R-09 to Mitigated | Change | 16 unit tests for severity rules and scrubbing, fixture dry run | gitleaks, CodeQL on PR | architect, appsec | branch feat/soc-monitor; scripts/soc_monitor.py, scripts/test_soc_monitor.py, .github/workflows/soc-monitor.yml |
| 2026-10-30 | Phase 4 build: weekly BigQuery insights job (WIF, split least-privilege jobs), scripts/analytics engine, pi-insights service, gateway X-PI-Internal for the insights route only, validator V13, V22 and wider V4, lint gate, simulated labels in code, Insights page | Change | See QA row | gitleaks, CodeQL on PR | architect | branch phase4/data-science; docs/plans/phase4-data-science-strategy.md |
| 2026-10-30 | Phase 4 QA | Test | 194 worker tests, 41 analytics tests, 42 backend/scripts tests, ask journey 52/0, insights journey 50/50 | n/a | qa | branch phase4/data-science |
| 2026-10-30 | Phase 4 AppSec review against ASVS and CONTROLS.md. No blockers. Medium M1 to M3 fixed. Open Low: pin actions to SHAs, confirm WIF attribute condition and BigQuery service account read-only roles in GCP, cosmetic double-escape in insChart. Recorded as C-41 and R-16 | Security review | Worker tests pass | gitleaks, CodeQL on PR | appsec | commit 24fae1f |
| 2026-10-30 | House completeness: cross-check matcher normalizes tickers and share classes and labels every miss; scraper reports unreadable filings, retries downloads, fixes or flags trade dates after filing | Change | 79 offline script tests pass | n/a | qa, appsec | PR #105 |
| 2026-10-30 | Meta supervisor check D: source reconciliation of official House and Senate records against FMP; SOC monitor reconciliation warnings moved to it; C-24 and C-25 updated | Change | 96 offline script tests pass | n/a | qa, appsec | PR #106 |
| 2026-10-30 | Ask insider buys: insiders intent and data agent (SEC Form 4 via pi-disclosures /api/insiders), purchase-only routing, value cap, joint-filer merge, V4 signal wording; C-43 added, S-01 extended | Change | 204 worker tests, ask journey passes (phone and desktop) | n/a | qa, appsec | PR #107 |
| 2026-10-30 | Ask insider buys follow-up: drafts failed V1/V1b on Form 4, 10% owner and counts of buys; named terms (not before "of"), counted nouns, imperative V4 rule, prescribed builder format, window labels in words | Change | 207 worker tests | n/a | qa, appsec | PR #108 |
| 2026-10-30 | Ask insider buys: code-built answer (order, buyer, role, date fixed in code; unsafe lines dropped), whole-dollar formatting; C-43 updated | Change | 208 worker tests; end to end on real insiders.json (4 questions PASS, no Groq); app in Chromium phone and desktop PASS; ask journey PASS | n/a | appsec | PR #109 |
| 2026-10-31 | pi-newsdesk Supabase client: clean pasted key and URL (whitespace, quotes, trailing /rest/v1), log the fetch error class and a fixed hint instead of a bare "network" | Change | 209 worker tests; old client reproduces the logged failure with a key containing a line break | n/a | appsec | PR #110 |
| 2026-10-31 | Meta supervisor check E (Ask pipeline fallback rate from gateway logs) and check F (meta supervisor and SOC monitor heartbeat each other); actions: read and cfk/cfkd on the run step only; C-24 updated | Change | 106 offline script tests | n/a | appsec | PR #111 |
| 2026-10-31 | Insider buys source fix: smart_money.py drops implausible Form 4 purchases (non-finite or non-positive, or over $1B; the LeonaBio $9.9B row) at parse time and from stored rows | Change | 8 offline parser tests; only LONA of 170 real rows is affected | n/a | appsec | PR #112 |
| 2026-10-31 | House scraper: OCR scanned paper PTRs (pdftoppm + tesseract, no shell, temp dir, 120 s timeouts, 20-page cap); OCR rows need ticker, type and date and are tagged ocr | Change | 110 offline script tests incl. end-to-end OCR of a synthetic scanned PDF | n/a | appsec | PR (this) |
| 2026-10-31 | House parse report: temporary ocr_sample (first 1,500 chars of OCR text) on scanned filings that gave no rows, to fit the OCR row parser to real paper forms. Public disclosure text only | Change | 110 offline script tests | n/a | appsec | PR (this) |
| 2026-10-31 | fetch_trades commit step: rebase on main and retry the push up to 3 times, so a PR merged mid-run no longer drops the day's trades | Change | workflow YAML reviewed; failure seen in run 41235958630 | n/a | appsec | PR (this) |
| 2026-11-01 | House scanned paper filings: trades for members with a no-text-layer PTR filled from FMP (via=fmp, paper_filing=true, kept in house_paper_last.json, dropped once the official scrape reads them); completeness check reports official rate and coverage_rate separately; meta supervisor installs bs4/lxml (its tests had failed since 10-31, so no report was posted); temporary ocr_sample removed | Change | 123 offline script tests (6 new) | n/a | appsec | PR (this) |
| 2026-11-01 | House completeness headline: rate = official reads plus FMP fills for unreadable paper filings; official_rate kept; supervisor line shows both. Official site stays the source of truth (fills dropped once official reads them; FMP accuracy check unchanged) | Change | 123 offline script tests | n/a | appsec | PR (this) |
| 2026-11-07 | Runtime feature flags (kill switches), branch feat/feature-flags, commits 200d62d, 4ab1aa1, f6f2a32, 9a54b54, 8a41f65, 644c006, 39264e7: pi-flags admin, gateway, Render, client and job checks, audit before each flip (C-44, C-05, C-11, C-12, C-14, C-34 updated) | Change | worker flags.mjs 36 tests; test.mjs 214 ok; Python 9/9/26/5/13/21; journeys flags 19/19, flags-ui 26/26, passcode 13/13, ask 66/66, news 56/56; insights journey fails, pre-existing on main | n/a | appsec (approved with follow-ups: JWKS refetch, audit metadata cap, unknown flag names, SB_URL escaping in flags.toml done; newsdesk.toml escaping, atomic version check, custom role open) | https://github.com/zidane222/portfolio-intel/pull/144 |
| 2026-11-08 | pi-sync build (Jira KAN and ADO two-way sync), branch feat/pi-sync: Worker, mapping, clients, flags sync and sync_dryrun (dry run on), deploy step with skip rule, owner decisions 1 to 5 recorded (C-45 added, C-11 updated) | Change | sync.mjs 23 tests; test.mjs 214 ok; flags.mjs 36; disclosures 5, rates 3, groq-fast 3; test_flags.py 9 | n/a | microservices (appsec and architect review pending) | branch feat/pi-sync, AB#230 |
| 2026-11-08 | pi-sync review fixes: appsec base URL pinning (205785d), qa tests (196d410), then untagged paired Bug skipped, label-only pairing checked and confirmed by tag (M1), fresh pending marker skips create (M2), L3 to L5; C-45 updated | Change | sync.mjs 39; test.mjs 214 ok; flags.mjs 36; disclosures 5, rates 3, groq-fast 3; test_flags.py 9 | n/a | appsec, qa | branch feat/pi-sync, AB#230 |
| 2026-11-10 | Kill switches go-live (KAN-79, AB#231), times UTC. No code change (code from PR #144). Owner created KV namespace pi-flags and set repository variables CF_KV_FLAGS, CF_ACCESS_TEAM, CF_ACCESS_AUD and secret FLAGS_ADMIN_EMAIL (values not readable from the session, inferred from the deploy result). pi-flags Worker first created 04:01:57Z; the deploy re-run (commit 9ef24f8, finished about 05:00Z) printed "Deployed pi-flags (behind Cloudflare Access)" with no missing-key and no missing-Access warning (the notice is printed on every deploy and the Access warning only fires on an empty AUD or admin email; the proof of valid Access settings is the two accepted flips). supabase/flags.sql applied to the live project about 04:39Z by the assistant with the owner's approval. Owner created a separate Supabase secret key named pi-flags, stored in the Cloudflare Secrets Store as SUPABASE_FLAGS_KEY (owner statement, supported by the audit rows being written). Cloudflare Zero Trust team hk7 (free plan), Access application on the pi-flags workers.dev host, policy allows the owner's email only. Login at go-live was a one-time PIN to email; the owner then added GitHub as identity provider (Cloudflare's provider test returned the owner's identity) and reports switching the application to GitHub only about 07:00Z. All flags are back at defaults. C-44 corrected to match the code and kept Partial; C-05 and CF-01 wording updated | Access | Live SQL check: public.flag_audit exists, RLS on, 0 policies, anon and authenticated have no select on the table and no execute on flag_audit_add or flag_audit_purge, service_role has insert and execute. Flip 1: recon_v2 ON at 05:02:59.105Z, reason "KAN-79 go-live test", flag_audit row b3bd1458-1729-439f-9314-00f4456cb275 (is_on true, v 1); gateway /api/flags then returned v 1, updated 2026-11-10T05:02:59.105Z, recon_v2 true, all other flags at default (read pasted about 05:05Z, so seen within about 2 minutes). Flip 2: recon_v2 OFF at 05:08:16.842Z, reason "KAN-79 go-live test, restore default", flag_audit row 07d92acd-e861-4d7d-8b13-95982547c20b (is_on false, v 2). Unauthenticated: a private window opening /admin about 05:09Z was redirected to the Cloudflare Access login for pi-flags (team hk7), the flags page was not served. NOT verified: a second GitHub account getting "Not allowed"; /api/flags showing v 2 after flip 2 (only the Supabase row shows v 2); the KV "Last 20 changes" list (no screenshot, the KV record is inferred from the code path, which writes it before the flag changes); propagation timed against the 90 second target; a GitHub-only sign-in after the provider switch (owner report, no captured result); the BigQuery archive of flag_audit (runs with the next daily fetch_trades job) | n/a | compliance, owner | https://github.com/zidane222/portfolio-intel/actions/runs/42519107277 ; code: https://github.com/zidane222/portfolio-intel/pull/144 |
| 2026-11-11 | Live verification, roadmap 24, KAN-113, at main f3a052e. Partial: GitHub settings, the Supabase advisor, the private service hosts, pi-flags /admin and Render were checked; the two gateway POST checks were run from the owner's Terminal; the owner checks are not done yet. Results per check in the section "Live verification 2026-11-11 (KAN-113)" below. C-44 stays Partial. No code change | Review | n/a | n/a | qa, compliance | KAN-113 |

## Live verification 2026-11-11 (KAN-113)

Times are UTC. Result is one of PASS, FAIL, NOT RUN (with the reason) or OWNER (waiting on the owner). One request per check, nothing was changed, no flag was flipped. Checks done earlier the same day (07:26Z, through the browser on the owner's computer) are listed first for completeness.

How the checks were sent: the review session's own shell, and the sandboxed shell on the owner's computer, are both refused workers.dev and onrender.com by network policy (proxy 403 on connect at 07:30:05Z, 07:30:42Z and 07:38:18Z, so no request reached either service). From 07:38Z the GET checks were sent through the browser pane of the Claude desktop app on the owner's computer, one page load or one fetch each. A browser cannot send a POST with no Origin or a forged Origin, so those two checks were run with curl in the owner's Terminal. The browser shows the status code but not the response headers of a page load. Some GitHub API paths are closed to the session token.

### Already recorded (07:26Z)

| Check | Result | Detail | Belongs to |
|---|---|---|---|
| App page headers, portfolio-intel-279.pages.dev | PASS with notes | HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy, COOP present. Header CSP is only frame-ancestors 'none', the full CSP is a meta tag. Access-Control-Allow-Origin: * on static files (Pages default) | Roadmap 16 |
| Gateway GET /health | FAIL | Public, lists 9 internal service names | Roadmap 18 |
| Gateway GET /api/plaid/status | FAIL | Public, returns the client id length, its first 4 characters and the secret length | Roadmap 18 |
| Gateway GET /api/flags | PASS | v 2, updated 2026-11-10T05:08:16Z, all flags at defaults, sync_dryrun on. Closes the "unconfirmed v 2" note from 2026-11-10 | Roadmap 14 |

### 1. Gateway and private services

| Check | Result | Detail |
|---|---|---|
| POST /api/ask with no Origin, expect 403 | PASS (observed) | Owner's Terminal, curl with body {}. HTTP/2 403, response date header 07:44:16Z. content-type application/json, content-length 23, Vary: Origin, Referrer-Policy no-referrer, X-Content-Type-Options nosniff, X-Frame-Options DENY, server cloudflare. Body discarded by the command. No Strict-Transport-Security header in the response |
| POST /api/ai with Origin https://evil.example, expect 403 | PASS (owner reported) | Owner's Terminal, 2026-11-11, exact time not kept. Reported: HTTP/2 403, body {"error":"Not allowed"}, same security headers. The terminal output was not kept with this evidence. The request was sent twice (once without and once with body capture) |
| OPTIONS preflight to /api/ai from https://evil.example (added check) | PASS (owner reported) | Owner's Terminal, 2026-11-11, exact time not kept. Reported: HTTP/2 204, Vary: Origin, no Access-Control-Allow-Origin, Allow-Methods or Allow-Headers. The terminal output was not kept with this evidence |

Limits of these three results: a 403 shows the request was refused, not which layer refused it or that authentication is sound. The Origin header is still the only gate on these routes (roadmap 18), and any non-browser caller can set it. The preflight from the real app origin (https://portfolio-intel-279.pages.dev, from ALLOWED_ORIGINS in worker/wrangler.toml) has not been checked yet.
| GET pi-ai.viphashkahn.workers.dev/health, expect no answer from the Worker | PASS | about 07:38:40Z, HTTP 404 with Cloudflare's own "There is nothing here yet" page, which is what workers.dev serves when a Worker has no public route. The Worker did not answer |
| GET pi-newsdesk.viphashkahn.workers.dev/health, expect no answer from the Worker | PASS | about 07:39:10Z, HTTP 404, same Cloudflare page |

### 2. pi-flags /admin with no session

| Check | Result | Detail |
|---|---|---|
| Only the Cloudflare Access sign-in is served, GitHub is the only method | PASS, one point for the owner to confirm | about 07:39:40Z, browser pane with no Access session: /admin was not served, the load was redirected straight to the GitHub sign-in page (github.com, "Sign in to GitHub"). No Cloudflare method list and no one-time PIN option was shown. Cloudflare Access skips its method list only when the application has a single login method, so this points to GitHub only. Owner to confirm on the Access application's login methods screen |

### 3. Render fallback

| Check | Result | Detail |
|---|---|---|
| GET /health body | PASS with note | 07:40:18Z, 200. Public. Body: service name, status ok, a time stamp and a list of 13 public route patterns. No internal service names, no secrets |
| GET /api/plaid/status body | PASS | 07:40:27Z, 503 with Retry-After 60 and Cache-Control no-store. Body has only disabled true, a fixed error text and the flag name: the broker flag is off, so nothing about the Plaid credentials is returned. Recheck when broker is turned on (roadmap 18) |
| GET /api/flags with X-Forwarded-For: 1.2.3.4, then read the Render log (KAN-107) | Request sent, question NOT ANSWERED | 07:40:27Z, 200. The Render log cannot answer which position holds the real address: the service has no platform request log (the request log type returned nothing) and the gunicorn access log line shows only 127.0.0.1 and not the X-Forwarded-For value. KAN-107 stays open: the code still keys the limit on the first X-Forwarded-For value (backend/main.py client_ip, read at f3a052e). It can be settled inside the KAN-107 fix by logging the header once, or by test |

Security headers on the two Render fetches: X-Content-Type-Options nosniff, X-Frame-Options DENY, Referrer-Policy no-referrer. Notes from the same responses:

| Note | Result | Detail | Belongs to |
|---|---|---|---|
| No Strict-Transport-Security header on the Render responses | FAIL (low) | not among the response headers of either fetch | Roadmap 16, or a small server story under KAN-106 |
| Access-Control-Allow-Origin: http://localhost:8765 on a same-origin request | FAIL (low) | confirms KAN-110 live on Render | KAN-110 |
| Render /api/flags returned v 0, updated null, all defaults, while the gateway returned v 2 | Note for server | The flag values match today because everything is at defaults. Whether Render reads the live flags or only its built-in defaults should be checked before relying on a kill switch for the fallback | Roadmap 14 follow-up, C-44 |

### 4. GitHub settings (gh api, 07:30:55Z to 07:31:30Z)

| Check | Result | Detail | Belongs to |
|---|---|---|---|
| Branch protection on main | FAIL | GET branches/main/protection: 404 "Branch not protected". branches/main: protected false. One ruleset, "Restrict deletions", enforcement disabled. No CODEOWNERS file | C-05 follow-up, roadmap 23 (bot commits to main must move first) |
| Secret scanning | FAIL | security_and_analysis.secret_scanning: disabled. gitleaks still runs in security.yml | Roadmap 7 |
| Push protection | FAIL | secret_scanning_push_protection: disabled | Roadmap 7 |
| Open code scanning alert count | NOT RUN | GET code-scanning/alerts: 403 "Resource not accessible by integration" (session token has no security events scope). Known: default setup is not-configured, CodeQL runs from security.yml. Owner to read the count on the Security tab | Roadmap 7 |
| Dependabot | FAIL | Dependabot alerts disabled for the repository, dependabot_security_updates disabled. pip-audit in security.yml is the only dependency check | Roadmap 7, with roadmap 19 |
| Private vulnerability reporting | FAIL (low) | enabled false | Roadmap 23 |
| Pages status | FAIL | Repository is public, has_pages true, last github-pages deployment 2026-11-10T18:46:11Z at f3a052e, so the github.io copy is still served. GET pages (HTTPS setting, source) is closed to the session | Roadmap 7, KAN-110 |
| Who can dispatch workflows | NOT RUN | The collaborators and Actions permissions paths are closed to the session. Known: personal repository (anyone with write access can dispatch), all 12 workflows have workflow_dispatch, none uses pull_request_target. Owner to confirm that Settings, Collaborators lists the owner only | KAN-109, roadmap 19 |

### 5. Owner checks

| Check | Result | Detail | Belongs to |
|---|---|---|---|
| GitHub sign-in to /admin after the switch to GitHub only | OWNER | not yet captured | C-44 |
| Second GitHub account refused by Access | OWNER | not yet captured | C-44 |
| 2FA on the GitHub account and the Cloudflare account | OWNER | not yet captured | C-15, C-44 |
| Screenshot of "Last 20 changes" | OWNER | not yet captured | C-44 |
| Timed flip of recon_v2 against the 90 second target | OWNER | not yet captured | C-44 |
| Supabase sign-ups open or closed | OWNER | not readable from SQL or the advisor | Roadmap 20 |
| Supabase leaked password protection | FAIL | Security advisor read 07:31:35Z: "Leaked Password Protection Disabled" (WARN). Owner toggle | Roadmap 3a |
| Supabase email code expiry | OWNER | The advisor raised no long OTP expiry warning, which points to one hour or less. Exact value to be read in the dashboard | Roadmap 20 |
| MFA on the owner's Supabase account | OWNER | not yet captured | C-15 |

Same advisor read, already tracked: rls_auto_enable() executable by anon and authenticated, ping() executable by anon (roadmap 3a); 4 tables with RLS on and no policies (flag_audit, news_budget, news_jobs, news_verdicts), which is the intended deny-all.

### Outcome

- C-44 stays Partial. None of its 5 owner checks is captured yet, and the first BigQuery flag_audit archive is still unconfirmed.
- C-05 follow-up (branch protection) is confirmed open. C-15 stays Partial.
- KAN-107 is still open. The log check could not confirm or close it.
- Failed checks: gateway /health and /api/plaid/status public (roadmap 18); Render sends no HSTS header (roadmap 16) and allows the localhost origin (KAN-110); no branch protection (C-05, roadmap 23); secret scanning, push protection and Dependabot off (roadmap 7); Pages still live (roadmap 7, KAN-110); private vulnerability reporting off (roadmap 23); leaked password protection off (roadmap 3a).
