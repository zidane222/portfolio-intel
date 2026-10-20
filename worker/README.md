# Portfolio Intel API (Cloudflare Workers, microservices)

A public **gateway** (`portfolio-intel-api`, `src/index.js`) handles CORS, rate limits and security headers,
then forwards each request over a private service binding to the service that owns it.
Services have no public URL and get only the keys they need from the Cloudflare Secrets Store.

| Service Worker | Entry | Routes | Keys |
|---|---|---|---|
| `pi-market` | `src/services/market.js` | `/api/prices`, `/api/history`, `/api/sectors`, `/api/dividends` | none |
| `pi-news` | `src/services/news.js` | `/api/news`, `/api/news/tickers`, `/api/feeds` | none |
| `pi-rates` | `src/services/rates.js` | `/api/top-rates` | Groq |
| `pi-ai` | `src/services/ai.js` | `/api/ai` | Groq |
| `pi-broker` | `src/services/broker.js` | `/api/plaid/*` | Plaid |
| `pi-disclosures` | `src/services/disclosures.js` | `/api/all-trades` | none |

Configs: `wrangler.toml` (gateway) and `config/<service>.toml`. Route ownership: `src/routes.js`.
`/health` on the gateway reports each service.

Shared code is in `src/lib` (HTTP helpers and cache, rate limits, Groq, Fernet encryption).

- Test: `npm test` (offline, outside services are mocked)
- Deploy: automatic on merge to `main` via `.github/workflows/deploy-worker.yml`
- Secrets live in the Cloudflare Secrets Store and are linked per service at deploy time (store id from the `cfks` GitHub secret). Never in code.
