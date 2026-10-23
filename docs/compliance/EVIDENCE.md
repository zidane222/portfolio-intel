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
