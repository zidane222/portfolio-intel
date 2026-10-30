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
| `/api/all-trades` | disclosures | Congressional trades |

Render fallback: `POST /api/newsdesk/reads` returns empty reads and `POST /api/newsdesk/read` returns
503 "News reads are paused." with the same origin, size and ticker checks, no Groq call, nothing
stored, tickers not logged.

`/internal/intent` and `/internal/build` exist only on pi-ai. They are not in `OWNERS`, so the
gateway returns 404 for them; only the supervisor reaches them over `AI_SVC` with `X-PI-Internal: 1`.

## Data classification

| Class | Examples | Where it lives | Protection |
|---|---|---|---|
| Confidential (user) | Holdings, cash, snapshots, Plaid link | Device vault; Supabase `synced_data` as ciphertext only | AES-GCM, key from passcode (PBKDF2 210k) or passkey PRF; RLS. A holdings summary may be sent with a question as request context (as with /api/ai). Used in memory only, never stored or logged. Chat keeps only the user's questions in sessionStorage |
| Credentials | API keys, service role key, Groq key | Cloudflare Secrets Store, GitHub secrets | Never in code or logs; WIF for GCP. The Supabase service key is bound only to pi-newsdesk among Workers |
| Account | Email, passkey public keys | Supabase Auth | Supabase managed |
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
