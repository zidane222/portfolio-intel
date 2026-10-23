# Access control policy

- Only the owner holds admin access to production services. No shared accounts.
- MFA is required on every admin account. Passkeys or authenticator apps are preferred over SMS.
- Service credentials are scoped to one job (for example, BigQuery: Data Editor and Job User only) and stored in the Cloudflare Secrets Store or GitHub secrets.
- CI signs in to Google Cloud with Workload Identity Federation, limited to the `zidane222/portfolio-intel` repository. No stored keys.
- Users reach only their own data, enforced by Supabase row level security.
- Access is reviewed quarterly: remove unused keys, tokens, OAuth apps and collaborators. Record the review in EVIDENCE.md.
- Keys are rotated yearly or immediately after suspected exposure.
