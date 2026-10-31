# Control map

Status: **In place** (working, evidence exists), **Partial** (some coverage), **Gap** (not yet).
SOC 2 criteria are the 2017 Trust Services Criteria (revised points of focus 2022). NIST = CSF 2.0 function.

## Common criteria (Security)

| ID | Control | SOC 2 | NIST | Status | Evidence | Gap / next step |
|---|---|---|---|---|---|---|
| C-01 | Security owner designated (Hisham) and policies approved | CC1.1, CC1.3 | GV | In place | policies/information-security.md | Annual sign-off |
| C-02 | Written security policies, reviewed quarterly | CC1.4, CC5.3 | GV | In place | policies/ | Record each review in EVIDENCE.md |
| C-03 | Risk assessment and register | CC3.1–CC3.4 | ID.RA | In place | RISK_REGISTER.md | Quarterly review |
| C-04 | Vendor inventory and review | CC9.2 | GV.SC | In place | policies/vendor-management.md | Save vendors' SOC 2 reports yearly |
| C-05 | Change management: all changes via PR, owner approval, tests | CC8.1 | PR.PS | In place | PR history, CLAUDE.md | Turn on branch protection for main |
| C-06 | Code review for security (OWASP ASVS) | CC8.1 | PR.PS | In place | .claude/agents/appsec.md, PR reviews | |
| C-07 | Automated secret scanning | CC6.1, CC7.1 | DE.CM | In place | security.yml (gitleaks), GitHub secret scanning | Enable push protection |
| C-08 | Dependency vulnerability scanning | CC7.1 | ID.RA | In place | dependabot.yml, security.yml | |
| C-09 | Static analysis (CodeQL) | CC7.1 | ID.RA | In place | security.yml | |
| C-10 | Dynamic scan of the live site (OWASP ZAP baseline) | CC7.1 | DE.CM | In place | security.yml weekly | Triage findings monthly |
| C-11 | Secrets in a vault, never in code | CC6.1 | PR.DS | In place | Cloudflare Secrets Store, GitHub secrets. pi-newsdesk binds GROQ_API_KEY and SUPABASE_SERVICE_KEY (C-34) | Rotation schedule (C-12) |
| C-12 | Key rotation | CC6.1 | PR.AA | Partial | | Rotate Groq, Supabase service role, Plaid keys yearly; log in EVIDENCE.md |
| C-13 | Keyless cloud auth for CI | CC6.1 | PR.AA | In place | Workload Identity Federation for BigQuery | |
| C-14 | Least privilege service accounts | CC6.3 | PR.AA | In place | BQ: Data Editor + Job User only; per-service secret bindings | |
| C-15 | MFA on admin accounts (GitHub, Cloudflare, Supabase, Google, Render, Plaid) | CC6.1 | PR.AA | Partial | | Owner to confirm MFA on each, record in EVIDENCE.md |
| C-16 | User authentication: email one-time code, passkeys | CC6.1 | PR.AA | In place | 29a-account.js, 29c-passkey.js | |
| C-17 | Tenant isolation: row level security | CC6.1 | PR.AA | In place | supabase/schema.sql | |
| C-18 | Encryption at rest of user data (client-side AES-GCM) | CC6.1, C1.1 | PR.DS | In place | 02-state.js vault | |
| C-19 | Encryption in transit (HTTPS, HSTS) | CC6.7 | PR.DS | In place | _headers | HSTS preload optional |
| C-20 | Browser hardening: CSP, frame-ancestors, nosniff, COOP | CC6.6 | PR.PS | In place | index.html CSP, _headers | Move CSP to header, drop 'unsafe-inline' styles later |
| C-21 | CORS allowlist and origin checks | CC6.6 | PR.AA | In place | wrangler.toml ALLOWED_ORIGINS, originOk | |
| C-22 | Rate limiting on public routes | CC6.6, A1.1 | PR.PS | In place | lib/ratelimit.js | Per instance only; shared counter (R-11). News reads add the newsread bucket and a global Groq cap (C-37) |
| C-23 | AI input treated as data, prompts server-side; validator, fact checker, numbers only through fact placeholders | CC6.6 | PR.PS | In place | modules/ai.js, agents/validator.js, agents/factcheck.js, agents/render.js; phase2.mjs (V1 to V12, V1b, L3, F1 to F10, injection headline test); news read agents follow the same rules (C-33) | Shared rate-limit store (later, R-11) |
| C-28 | AI output validation: V-rules on every draft, one repair, then safe fallback built from verified facts; Groq call budget (max 3 per ask, 4th refused); 25 s deadline with shared abort, in-flight calls aborted when a case ends | CC6.6, CC7.1 | PR.PS, DE.CM | In place | agents/supervisor.js, agents/validator.js, agents/render.js, lib/groq.js; phase2.mjs (FLAG then PASS, FLAG twice fallback and call cap 3, builder error, slow binding deadline, hanging builder cut off, safe answer passes V4 to V11) | Tune V1 false positives from flag counts |
| C-29 | Chat storage limited to user questions: answers not persisted, session storage keeps the last 30 user questions only; role allowlist; https-only source links | CC6.1, C1.1, P3.1 | PR.DS | In place | js/18-assistant.js, js/17-ask.js; tests/journeys/ask.mjs | |
| C-30 | Gateway strips client-sent X-PI-* internal headers before forwarding; /internal/* routes give 404 from outside | CC6.6, CC6.1 | PR.AA | In place | lib/http.js, index.js; phase2.mjs (strips X-PI-*, X-PI-Internal cannot reach pi-ai /internal/*, /internal/* 404) | |
| C-31 | Request body size caps enforced while streaming (32 KB on /api/ask, also with no Content-Length) | CC6.6, A1.1 | PR.PS | In place | lib/http.js; phase2.mjs (body over 32 KB 413, chunked body over 32 KB 413) | |
| C-32 | pi-private SSRF guard: fetches only the fixed PRIVATE_DATA_URL Pages var, redirect: 'error', 5 MB streamed cap, content type check, last good copy on failure | CC6.6 | PR.DS, PR.PS | In place | modules/private.js; phase2.mjs (only the Pages URL is fetched, bad URL or content type 502, body over 5 MB refused while streaming) | |
| C-33 | News read validation: every read is checked by V14 to V21 (cites exist, each side cites, judge adds no new facts, confidence capped by code, code label and disclaimer, advice words, stance words, injection echo including non-Latin look-alike letters); one repair per failing role, then a safe fallback (cited headlines, no stance). Rendered text always starts with "News read, not a recommendation." | CC6.6, CC7.1, PI1.2 | PR.PS, DE.CM | In place | agents/validator.js (validateRole, validateNewsRead, validateRenderedRead), agents/newsread/supervisor.js, roles.js, render.js; worker/test/phase3.mjs (V14 to V21 pass and fail fixtures, injection fixtures, call cap 4, fallback paths, record shape) | Tune V21 and V16 false positives from flag counts |
| C-34 | pi-newsdesk least privilege: the only service holding SUPABASE_SERVICE_KEY (plus GROQ_API_KEY), no public URL (workers_dev and preview_urls off), two fixed routes that return 404 without X-PI-Internal, key resolved at run time and never logged, Supabase client uses redirect: 'error' and a fixed SUPABASE_URL | CC6.1, CC6.3, CC6.6 | PR.AA, PR.DS | In place | worker/config/newsdesk.toml, services/newsdesk.js, lib/supabase.js, lib/secrets.js, deploy-worker.yml; worker/test/newsdesk.mjs (key from Secrets Store only, key absent from errors, 404 without X-PI-Internal, no user field in records) | Rotate the service key with C-12 |
| C-35 | News tables locked in the database: RLS on news_verdicts, news_jobs, news_budget with no policies and all grants revoked from anon and authenticated; the 7-day view uses security_invoker with no grants; every news function is SECURITY DEFINER with a fixed search_path (public, pg_temp) and executable by service_role only | CC6.1, CC6.3 | PR.AA, PR.DS | In place | supabase/news.sql; QA SQL check on Postgres 16 (not a repo test, attach the output to EVIDENCE.md; anon select and rpc denied, news_take batch share reserved in SQL) | Re-run the anon check against the live project after the owner runs news.sql |
| C-36 | News cache privacy: KV (NEWSREADS) and Cache API entries are keyed by ticker and UTC day only (r:{TICKER}:{day}), values hold no user id, IP or origin; only Groq-produced reads go to KV (36 h TTL); on-demand reads are never written to news_verdicts; the gateway passes only the ticker and an ok or over quota flag | CC6.1, C1.1, P3.1 | PR.DS | In place | modules/newsdesk.js, agents/data/newsread.js, index.js; worker/test/newsdesk.mjs (KV key pattern, no user, ip or user_id in key or value, on-demand not in verdicts); phase3.mjs (client X-PI-Quota stripped, no IP to pi-newsdesk) | |
| C-37 | Groq spend caps for news reads: global daily cap in Supabase (news_take reserves calls and tokens atomically before every call: 90 calls, 180000 tokens, batch share 50), 4 calls per ticker, per-visitor cap (10 uncached reads a day, 3 a minute, counted only when Groq ran) | A1.1, CC6.6 | PR.PS, ID.AM | In place | modules/newsdesk.js, supabase/news.sql (news_take), lib/ratelimit.js (newsread bucket), index.js; worker/test/newsdesk.mjs (take false means skipped or busy, batch share, no 5th call, cap not passed by on-demand); phase3.mjs (counter only on cached false and groq_calls above 0, 11th read limited) | Per-visitor counter is per instance and counts after the response (R-14). Shared counter later (R-11) |
| C-38 | Per-user news list kept inside the encrypted vault (state.newsList, synced as ciphertext like the watchlist); never sent as a query string; at most 40 tickers, regex checked | CC6.1, C1.1 | PR.DS | In place | js/02-state.js (newsList, vault only), js/11a-news-reads.js; tests/journeys/news.mjs (default list, add and remove persists after reload) | |
| C-39 | Documented disclosure (AppSec Medium #2, accepted by the owner): to get news reads the app sends the user's own tickers from the device list (which defaults to portfolio tickers plus the watchlist) to the gateway as plain tickers in a POST body. No user identifier, share counts, values or account data are sent; the gateway forwards only the ticker. A ticker set can still hint at holdings to the network path and Cloudflare, and it is not encrypted beyond HTTPS | CC2.3, P3.1, P6.1 | GV.OC, PR.DS | Accepted | js/11a-news-reads.js (POST /api/newsdesk/reads and /read), index.js; C-36 and C-38; docs/plans/phase3-news-agents.md (D16, owner decisions 3 and 4) | Show a one line notice on My reads and list this in the privacy page (P-01). User can remove any ticker from the list. Review if the list gets sent anywhere that logs bodies |
| C-40 | pi-insights least privilege: private service, no secrets, reads only the fixed INSIGHTS_DATA_URL (Pages) with redirect: manual, schema and size checks (5 MB), known keys only. Gateway sets X-PI-Internal: 1 only for the insights route; client-sent X-PI-* is stripped first (C-30). Service answers 404 without it | CC6.1, CC6.6 | PR.AA, PR.DS | In place | worker/src/modules/insights.js, worker/src/index.js; worker/test/insights.mjs, phase4.mjs | |
| C-41 | Weekly insights job with least-privilege split: analysis job contents: read + id-token: write (WIF, no stored key); commit job contents: write only, main only; concurrency group; workflow default contents: read. Documented exception: the bot commits data files directly to main, like the daily data jobs | CC6.1, CC6.3, CC8.1 | PR.AA, PR.PS | Partial | .github/workflows/insights.yml | Pin actions to SHAs. Confirm the WIF attribute condition and read-only BigQuery roles on the service account in GCP (see R-16) |
| C-42 | Output controls for insights and strategies: validator V13 (simulated label) and V22 (historical label), expanded V4 advice patterns, labels rendered in code, lint gate on published files (advice words, labels, dashes, schema) so a failing file is never published | PI1.2, CC7.1 | PR.DS, DE.CM | In place | validator.js, render.js, scripts/analytics/lint.py; worker/test/phase4.mjs; scripts/analytics/tests/test_contracts.py | |
| C-43 | Insider buys in Ask: pi-disclosures `/api/insiders` is binding only (no gateway route), reads the fixed insiders.json URL with redirect: manual and a 2 MB cap, drops the internal seen index; the agent keeps purchases only, holds back any single buy over $1B as a data error, merges joint filings, decodes entities then strips markup (cleanText); rules route only purchase-activity questions. The answer is built in code from verified facts (largest first, each line checked with lineSafe, then validateFinal V4 to V11); no model writes it unless the data is stale | CC6.1, PI1.2 | PR.DS | In place | worker/src/modules/disclosures.js, worker/src/agents/data/insiders.js, worker/src/agents/intent.js; worker/test/insiders.mjs, tests/journeys/ask.mjs | |
| C-24 | Logging and monitoring | CC7.2 | DE.CM | In place | Cloudflare observability, Supabase logs, daily SOC monitor summary (`.github/workflows/soc-monitor.yml`, `scripts/soc_monitor.py`); daily meta supervisor (`.github/workflows/meta-supervisor.yml`, `scripts/meta_supervisor.py`) checks the other monitors and reconciles official House and Senate records against FMP (check D, also PI1 processing integrity), watches the Ask pipeline's fallback rate (check E), and it and the SOC monitor each alert when the other has not run in 26 h (check F) | Review the monitor's first live runs; tune thresholds in code |
| C-25 | Security alerting | CC7.3 | DE.AE | In place | SOC monitor opens or updates one `soc-monitor` issue on WARN or ALERT and closes it on OK; severity rules unit tested (`scripts/test_soc_monitor.py`). Meta supervisor keeps one `meta-supervisor` issue the same way, including source reconciliation; rules unit tested (`scripts/test_meta_supervisor.py`) | GitHub security alerts to email (owner setting) |
| C-26 | Incident response plan | CC7.3–CC7.5 | RS | In place | policies/incident-response.md | Tabletop test yearly |
| C-27 | Device lock (passcode, 5 minutes away) | CC6.1 | PR.AA | In place | 16-lock.js | |

## Availability

| ID | Control | SOC 2 | NIST | Status | Evidence | Gap / next step |
|---|---|---|---|---|---|---|
| A-01 | Redundant hosting: Pages + GitHub mirror, Worker + Render fallback | A1.1 | RC | In place | 01-config.js, 03-helpers.js | |
| A-02 | Data backup: Supabase 5-year history + BigQuery archive; user data on device and cloud | A1.2 | PR.DS | In place | history_load.py | Test a restore quarterly |
| A-03 | Business continuity plan | A1.3 | RC | In place | policies/business-continuity.md | |
| A-04 | Capacity guards (450MB Supabase, 9GB BigQuery, budget alert) | A1.1 | ID.AM | In place | history_load.py, GCP budget | |

## Confidentiality

| ID | Control | SOC 2 | NIST | Status | Evidence | Gap / next step |
|---|---|---|---|---|---|---|
| CF-01 | Data classification | C1.1 | ID.AM | In place | ARCHITECTURE.md | |
| CF-02 | Disposal: delete cloud copy, sign out, forget passcode wipes device | C1.2 | PR.DS | In place | 29a-account.js, 16-lock.js | Account deletion request flow |
| CF-03 | Statements processed for import never stored server-side | C1.1 | PR.DS | In place | modules/ai.js (stateless) | Document Groq data retention |

## Privacy

| ID | Control | SOC 2 | NIST | Status | Evidence | Gap / next step |
|---|---|---|---|---|---|---|
| P-01 | Privacy notice | P1.1 | GV | Gap | | Publish a privacy page in the app |
| P-02 | Data minimization: no SSN, account numbers stripped from imports | P3.1 | PR.DS | In place | extract prompt | |
| P-03 | User access and deletion | P5.1, P4.3 | PR.DS | Partial | Delete cloud copy | Full account deletion button |
| P-04 | Third-party disclosure only to listed vendors | P6.1 | GV.SC | In place | vendor-management.md | |

## Other frameworks

| ID | Requirement | Framework | Status | Gap / next step |
|---|---|---|---|---|
| G-01 | Qualified individual oversees the program | GLBA 314.4(a) | In place | Owner |
| G-02 | Written risk assessment | GLBA 314.4(b) | In place | |
| G-03 | Encryption, MFA, access controls, change management | GLBA 314.4(c) | Partial | C-15 MFA confirmation |
| G-04 | Monitoring and annual penetration test, vulnerability scans twice a year | GLBA 314.4(d) | Partial | ZAP weekly; schedule a pen test before Plaid production |
| G-05 | Report to the owner/board yearly; FTC notice within 30 days for breaches of 500+ people | GLBA 314.4(i), 314.4(j) | In place | incident-response.md |
| PL-01 | Plaid: security questionnaire, MFA, encryption, access controls, vulnerability management | Plaid | Partial | Same gaps as above |
| S-01 | No personalized investment advice; strategies simulated and labeled | SEC Advisers Act guardrail | In place | AI prompt, validator V4 (advice wording) and V7 (disclaimer), safe fallback (C-28). News reads add V18 (code label), V19 (advice and rating words), V20 (stance words) and neutral stance vocabulary (C-33). Phase 4 adds V13 and V22 labels rendered in code, expanded V4 patterns and the lint gate on published files (C-42). Insider buys add V4 patterns for signal, sign and insider-confidence wording and a builder rule that a buy is never a signal to buy (C-43) |
