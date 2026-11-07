# Vendor management

| Vendor | Purpose | Data shared | Assurance to collect |
|---|---|---|---|
| Cloudflare | Pages hosting, Workers, Secrets Store, Workers KV (news read cache, keyed by ticker and day, no user data), Cron Triggers | Requests, ciphertext in transit, public news reads | SOC 2 Type II, ISO 27001 |
| Supabase | Auth, encrypted sync, history | Email, ciphertext, public data | SOC 2 Type II |
| Google Cloud | BigQuery archive | Public data only | SOC 2 Type II, ISO 27001 |
| GitHub | Code, CI, Pages mirror | Code, public data | SOC 2 Type II |
| Groq | AI inference | Questions, statement text for import | SOC 2 Type II (confirm), data retention terms |
| Google (Gemini API, free tier) | Second AI provider for news reads in pi-newsdesk only (generativelanguage.googleapis.com). Ask stays on Groq | Public data only: tickers and public headlines. Free tier may use prompts for product improvement and human review (R-18) | Terms of service and data use for unpaid services (Google Cloud SOC 2 Type II covers the platform) |
| Render | Fallback backend | Requests | SOC 2 Type II |
| Plaid | Brokerage connection (sandbox) | Linked account data | SOC 2 Type II |
| Microsoft Azure | CI/CD showcase deploy | Backend code | SOC 2 Type II |

Review yearly: download each vendor's current SOC 2 report or trust page, note it in EVIDENCE.md.
New vendors need an architect and appsec review before use.
