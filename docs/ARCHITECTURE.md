# Portfolio Intel architecture

Owner: architect agent. Update this file in the same PR as any structural change.

## System overview

```
Browser / PWA (Cloudflare Pages, mirror on GitHub Pages)
  index.html + js/NN-*.js, strict CSP, encrypted vault (AES-GCM) in localStorage
        │                                   │
        │ HTTPS, origin-checked             │ auth + encrypted sync (RLS)
        ▼                                   ▼
Gateway Worker (portfolio-intel-api)     Supabase (auth: email code, passkeys;
  routes /api/* to private services        tables: synced_data, hist_trades, hist_prices)
  rate limits, CORS allowlist                         ▲
        │ service bindings                            │ daily load, 5-year window
        ▼                                             │
  pi-market  pi-news  pi-rates  pi-ai  pi-broker  pi-disclosures
  (prices,   (news,   (savings  (Groq: (Plaid)    (House/Senate
   history,   feeds)   rates)    Ask,             trades)
   sectors,                      extract)
   dividends)
        ▲
        │ fallback on network or 5xx errors
Render Flask backend (backend/main.py), kept on as fallback

GitHub Actions
  fetch_trades (daily 06:00 UTC): House + Senate PTRs, prices, Supabase + BigQuery
  deploy-worker (push): services then gateway, Secrets Store bindings
  private-markets (daily 11:30 UTC): SEC EDGAR Form D + Form C, rolling 60 days → private_markets.json
  security (PR, push, weekly): secrets, dependencies, CodeQL, ZAP
  main_portfolio-intel (backend changes): Azure Web App deploy (CI/CD showcase)
BigQuery (portfolio-intel-512216): full archive, signed in via Workload Identity Federation
```

## Route contracts (gateway)

| Path | Service | Purpose |
|---|---|---|
| `/api/prices`, `/api/history`, `/api/sectors`, `/api/dividends` | market | Quotes, price history, sector and dividend data |
| `/api/news`, `/api/feeds` | news | Ticker news, with Render fallback for Reddit and Google News |
| `/api/top-rates` | rates | Top savings rates, read by AI from a daily article |
| `/api/ai` | ai | `{mode: "assistant"|"extract", question, context?}` → `{answer}` |
| `/api/plaid/*` | broker | Plaid link and holdings (sandbox) |
| `/api/all-trades` | disclosures | Congressional trades |

## Data classification

| Class | Examples | Where it lives | Protection |
|---|---|---|---|
| Confidential (user) | Holdings, cash, snapshots, Plaid link | Device vault; Supabase `synced_data` as ciphertext only | AES-GCM, key from passcode (PBKDF2 210k) or passkey PRF; RLS |
| Credentials | API keys, service role key, Groq key | Cloudflare Secrets Store, GitHub secrets | Never in code or logs; WIF for GCP |
| Account | Email, passkey public keys | Supabase Auth | Supabase managed |
| Public | Congressional trades, prices, news, SEC Form D and Form C filings | JSON files, Supabase history, BigQuery | Integrity only |

## In-app agent framework (Phase 2, planned)

Supervisor of supervisors → Research, Strategy and Insights supervisors → specialist agents
(news bull/bear/judge, private markets, strategy backtests, data science, learning, SOC monitor).
Agents share a case state and never call each other. A rule-based fact checker gives every number a
source and date; a rule-based validator returns PASS or FLAG before anything reaches the user.
AI runs on Groq; batch work runs in the daily GitHub job. Strategy output is simulated only.

## Dev team

Role agents in `.claude/agents/`, workflow in `CLAUDE.md`.
