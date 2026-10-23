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
Gateway Worker (portfolio-intel-api)     Supabase (auth: email code, passkeys;
  routes /api/* to private services        tables: synced_data, hist_trades, hist_prices)
  rate limits, CORS allowlist,                        ▲
  strips client X-PI-* headers                        │ daily load, 5-year window
  agents/ (POST /api/ask): supervisor, intent,        │
    data agents, fact checker, builder, validator     │
        │ service bindings                            │
        ▼                                             │
  pi-market  pi-news  pi-rates  pi-ai  pi-broker  pi-disclosures  pi-private
  (prices,   (news,   (savings  (Groq: (Plaid)    (House/Senate   (SEC Form D/C,
   history,   feeds)   rates)    Ask,             trades)          filters, stats)
   sectors,                      extract,
   dividends)                    /internal/intent,
                                 /internal/build)
        ▲
        │ fallback on network or 5xx errors
Render Flask backend (backend/main.py), kept on as fallback (has no /api/ask)

GitHub Actions
  fetch_trades (daily 06:00 UTC): House + Senate PTRs, prices, Supabase + BigQuery
  deploy-worker (push): services (including private) then gateway, Secrets Store bindings
  private-markets (daily 11:30 UTC): SEC EDGAR Form D + Form C, rolling 60 days → private_markets.json
  security (PR, push, weekly): secrets, dependencies, CodeQL, ZAP
  main_portfolio-intel (backend changes): Azure Web App deploy (CI/CD showcase)
BigQuery (portfolio-intel-512216): full archive, signed in via Workload Identity Federation
```

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
| `/api/private/stats` | private | Same filters → `{updated, count, total_amt, by_stage, by_form, by_state_top, by_industry_top}` |
| `/api/plaid/*` | broker | Plaid link and holdings (sandbox) |
| `/api/all-trades` | disclosures | Congressional trades |

`/internal/intent` and `/internal/build` exist only on pi-ai. They are not in `OWNERS`, so the
gateway returns 404 for them; only the supervisor reaches them over `AI_SVC` with `X-PI-Internal: 1`.

## Data classification

| Class | Examples | Where it lives | Protection |
|---|---|---|---|
| Confidential (user) | Holdings, cash, snapshots, Plaid link | Device vault; Supabase `synced_data` as ciphertext only | AES-GCM, key from passcode (PBKDF2 210k) or passkey PRF; RLS. A holdings summary may be sent with a question as request context (as with /api/ai). Used in memory only, never stored or logged. Chat keeps only the user's questions in sessionStorage |
| Credentials | API keys, service role key, Groq key | Cloudflare Secrets Store, GitHub secrets | Never in code or logs; WIF for GCP |
| Account | Email, passkey public keys | Supabase Auth | Supabase managed |
| Public | Congressional trades, prices, news, SEC Form D and Form C filings | JSON files, Supabase history, BigQuery | Integrity only |

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
   `private` (PRIVATE). Each failure becomes an evidence row with status `error` or `timeout`.
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
called only from pi-ai and pi-rates.

Extension points (not built):
- `registry.js` maps intent to agents. Research, Strategy and Insights supervisors keep the
  `(case, deps) => patch` shape and a top-level router picks one; `case.ext.<domain>` is reserved.
- News bull/bear/judge can produce `news` evidence inside the Research supervisor without changing
  the fact checker or validator.
- Strategy facts must carry `rules: ["simulated"]`, plus a new validator rule V13 "simulated label present".
- Data science on BigQuery and the learning agent run in the daily GitHub job, publish JSON to
  Pages, and are read by a data agent like pi-private.
- SOC monitor reads the per-case log line and `trace` (timings, rule IDs, no user text).

## Dev team

Role agents in `.claude/agents/`, workflow in `CLAUDE.md`.
