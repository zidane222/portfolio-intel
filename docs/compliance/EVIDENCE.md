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
| 2026-10-23 | Phase 2 AppSec re-review | Security review | see PR | see PR | appsec | see PR |
