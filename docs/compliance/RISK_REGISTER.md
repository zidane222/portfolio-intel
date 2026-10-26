# Risk register

Likelihood and impact: Low, Medium, High. Reviewed quarterly.

| ID | Risk | L | I | Treatment | Owner | Status |
|---|---|---|---|---|---|---|
| R-01 | Admin account takeover (GitHub, Cloudflare, Supabase, Google) | M | H | MFA everywhere, passkeys, access reviews (C-15) | Owner | Open until MFA confirmed |
| R-02 | Leaked API key | M | H | Secrets Store, gitleaks, rotation, WIF | Owner | Mitigated |
| R-03 | User forgets passcode and loses synced data | M | M | Passkey unlock, clear warnings at setup | Owner | Accepted (by design) |
| R-04 | Prompt injection through news, statements or filings | M | M | Inputs treated as data in tagged blocks, text capped and stripped, fact placeholders (no typed numbers), validator V1/V1b/V4/V8/V9, safe fallback, injection test (C-23, C-28). News reads: see R-13 | appsec | Mitigated |
| R-05 | AI states a wrong number or gives advice | M | M | Fact checker F1 to F10, numbers only from verified facts via placeholders, validator V1 to V12, safe fallback, disclaimer V7 (C-23, C-28) | architect | Mitigated |
| R-06 | Third-party data source changes or blocks scraping (efdsearch, House PTR) | H | M | Fallbacks, alerts on empty runs | server | Open |
| R-07 | Free-tier limits exceeded (Supabase 500MB, Groq, BigQuery, Workers KV and cron) | M | M | Size guards, budget alert, batch jobs. News reads: global Groq cap, 2 tickers per cron tick, KV written only after Groq reads (C-37) | server | Mitigated |
| R-08 | Vulnerable dependency | M | M | Dependabot, CodeQL, weekly scans | appsec | Mitigated |
| R-09 | No security alerting | M | M | SOC monitor agent (Phase 2), GitHub alerts | appsec | Open |
| R-10 | Strategy features read as investment advice | L | H | Simulated only, labels, validator | compliance | Mitigated |
| R-11 | Rate limits are per Worker instance, so total Groq spend cannot be capped | M | L | Per-IP ask limits (6/min, 40/hour, 150/day), Groq call cap 3 per ask, Groq console watched. Accepted for under 10 users. Fix later with a shared counter (Durable Object or Cloudflare rate limiting binding) plus an app-wide daily Groq cap. Review trigger: more than 10 users or Groq paid tier | server | Accepted |
| R-12 | A news read is taken as a recommendation or personalized advice | L | H | Code label "News read, not a recommendation." on every read, neutral stance vocabulary (positive, negative, mixed, unclear), no buy/sell/hold output, validator V18 to V20, confidence capped by code, disclaimer, neutral colors, simulated and labeled only (C-33, S-01) | compliance | Mitigated |
| R-13 | Prompt injection through news headlines into the bull, bear and judge agents | M | M | Headlines capped at 160 characters and cleaned, sent in a tagged data block without URLs or tone, cites are ids only, judge sees only validated points, V14 to V16 and V21 (including non-Latin look-alike letters), one repair, safe fallback with no stance, injection fixtures in phase3.mjs (C-33) | appsec | Mitigated |
| R-14 | On-demand reads use up the shared Groq quota, or one visitor goes past the per-visitor cap | M | L | Global daily cap with atomic reservation (90 calls, 180000 tokens, batch share 50), 4 calls per ticker, cached reads cost 0 calls, ticker checked against pi-market first, per-visitor and per-minute limits (C-37). Residual: the per-visitor counter is per Worker instance (R-11) and counts after the response, so concurrent requests from one IP can run in flight together and pass 10 (AppSec finding). Bounded by the 3 a minute limit and the global cap. Accepted under R-11 for under 10 users. Review trigger: same as R-11 | server | Accepted (under R-11) |
| R-15 | Concentration of the Supabase service role key in pi-newsdesk | L | H | Only pi-newsdesk holds it, no public URL, two fixed routes behind X-PI-Internal, key from the Secrets Store and never logged, fixed Supabase URL with redirect: 'error', RLS and definer functions with fixed search_path, no new GitHub credential (C-34, C-35). Rotate yearly (C-12) | appsec | Mitigated |
