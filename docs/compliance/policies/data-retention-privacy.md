# Data retention and privacy policy

- **Collected:** email (sign-in), passkey public keys, encrypted portfolio data, public market and disclosure data.
- **Not collected:** SSNs, card numbers, bank account numbers, passwords. Imports strip account numbers, names and addresses.
- **Retention:** encrypted sync data until the user deletes it; public history 5 years in Supabase, full archive in BigQuery; logs per vendor default (Cloudflare, Supabase).
- **Deletion:** users can delete their cloud copy in the app; account deletion on request until a self-service button ships.
- **Sharing:** only with the vendors in vendor-management.md, only to run the service. Never sold.
- **AI:** statements sent for import are processed by Groq and not stored by Portfolio Intel.
