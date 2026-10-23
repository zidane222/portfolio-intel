# Readiness roadmap

| Step | What | Who | When |
|---|---|---|---|
| 1 | Confirm MFA on GitHub, Cloudflare, Supabase, Google, Render, Groq, Plaid (C-15) | Owner | This week |
| 2 | Turn on branch protection for main, secret scanning push protection, private vulnerability reporting | Owner (GitHub settings) | This week |
| 3 | First security scan run, triage findings | appsec | After merge |
| 4 | Privacy page and full account deletion (P-01, P-03) | frontend, server | Next |
| 5 | SOC monitor agent and alerting (C-24, C-25) | Phase 2 | Next |
| 6 | Key rotation, logged (C-12) | Owner | Yearly, first by December |
| 7 | Restore test from BigQuery (A-02) | server | Quarterly |
| 8 | Collect vendor SOC 2 reports (C-04) | compliance | Yearly |
| 9 | Penetration test before Plaid production (G-04) | External | Before other users connect accounts |
| 10 | 3 to 12 months of clean evidence, then a SOC 2 Type I, then Type II, with a CPA firm | Owner | When needed |
