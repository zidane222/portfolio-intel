# Risk register

Likelihood and impact: Low, Medium, High. Reviewed quarterly.

| ID | Risk | L | I | Treatment | Owner | Status |
|---|---|---|---|---|---|---|
| R-01 | Admin account takeover (GitHub, Cloudflare, Supabase, Google) | M | H | MFA everywhere, passkeys, access reviews (C-15) | Owner | Open until MFA confirmed |
| R-02 | Leaked API key | M | H | Secrets Store, gitleaks, rotation, WIF | Owner | Mitigated |
| R-03 | User forgets passcode and loses synced data | M | M | Passkey unlock, clear warnings at setup | Owner | Accepted (by design) |
| R-04 | Prompt injection through news, statements or filings | M | M | Inputs treated as data in tagged blocks, text capped and stripped, fact placeholders (no typed numbers), validator V1/V1b/V4/V8/V9, safe fallback, injection test (C-23, C-28) | appsec | Mitigated |
| R-05 | AI states a wrong number or gives advice | M | M | Fact checker F1 to F10, numbers only from verified facts via placeholders, validator V1 to V12, safe fallback, disclaimer V7 (C-23, C-28) | architect | Mitigated |
| R-06 | Third-party data source changes or blocks scraping (efdsearch, House PTR) | H | M | Fallbacks, alerts on empty runs | server | Open |
| R-07 | Free-tier limits exceeded (Supabase 500MB, Groq, BigQuery) | M | M | Size guards, budget alert, batch jobs | server | Mitigated |
| R-08 | Vulnerable dependency | M | M | Dependabot, CodeQL, weekly scans | appsec | Mitigated |
| R-09 | No security alerting | M | M | SOC monitor agent (Phase 2), GitHub alerts | appsec | Open |
| R-10 | Strategy features read as investment advice | L | H | Simulated only, labels, validator | compliance | Mitigated |
| R-11 | Rate limits are per Worker instance, so total Groq spend cannot be capped | M | L | Per-IP ask limits (6/min, 40/hour, 150/day), Groq call cap 3 per ask, Groq console watched. Accepted for under 10 users. Fix later with a shared counter (Durable Object or Cloudflare rate limiting binding) plus an app-wide daily Groq cap. Review trigger: more than 10 users or Groq paid tier | server | Accepted |
