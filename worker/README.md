# Portfolio Intel API (Cloudflare Worker)

One Worker built from modules. Each can later become its own Worker behind `src/index.js`.

| Module | Routes |
|---|---|
| `market` | `/api/prices`, `/api/history`, `/api/sectors`, `/api/dividends` |
| `news` | `/api/news`, `/api/news/tickers`, `/api/feeds` |
| `rates` | `/api/top-rates` |
| `ai` | `/api/ai` |
| `broker` | `/api/plaid/*` |
| `disclosures` | `/api/all-trades` |

Shared code is in `src/lib` (HTTP helpers and cache, rate limits, Groq, Fernet encryption).

- Test: `npm test` (offline, outside services are mocked)
- Deploy: automatic on merge to `main` via `.github/workflows/deploy-worker.yml`
- Secrets (set in the Cloudflare dashboard, never in code): `GROQ_API_KEY`, `PLAID_CLIENT_ID`, `PLAID_SECRET`
