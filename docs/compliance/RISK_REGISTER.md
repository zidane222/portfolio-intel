# Risk register

Likelihood and impact: Low, Medium, High. Reviewed quarterly.

| ID | Risk | L | I | Treatment | Owner | Status |
|---|---|---|---|---|---|---|
| R-01 | Admin account takeover (GitHub, Cloudflare, Supabase, Google) | M | H | MFA everywhere, passkeys, access reviews (C-15) | Owner | Open until MFA confirmed |
| R-02 | Leaked API key | M | H | Secrets Store, gitleaks, rotation, WIF | Owner | Mitigated |
| R-03 | User forgets passcode and loses synced data | M | M | Passkey unlock, clear warnings at setup | Owner | Accepted (by design) |
| R-04 | Prompt injection through news, statements or filings | M | M | Inputs treated as data, validator agent (Phase 2) | appsec | Partial |
| R-05 | AI states a wrong number or gives advice | M | M | Fact checker and validator (Phase 2), disclaimers | architect | Partial |
| R-06 | Third-party data source changes or blocks scraping (efdsearch, House PTR) | H | M | Fallbacks, alerts on empty runs | server | Open |
| R-07 | Free-tier limits exceeded (Supabase 500MB, Groq, BigQuery) | M | M | Size guards, budget alert, batch jobs | server | Mitigated |
| R-08 | Vulnerable dependency | M | M | Dependabot, CodeQL, weekly scans | appsec | Mitigated |
| R-09 | No security alerting | M | M | SOC monitor agent (Phase 2), GitHub alerts | appsec | Open |
| R-10 | Strategy features read as investment advice | L | H | Simulated only, labels, validator | compliance | Mitigated |
