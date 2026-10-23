# Business continuity and disaster recovery

| Scenario | Fallback | Target |
|---|---|---|
| Cloudflare Worker down | Front end falls back to Render automatically | Minutes |
| Cloudflare Pages down | GitHub Pages mirror | Minutes |
| Supabase down | App works offline from the device vault; sync resumes later | Hours |
| Supabase data loss | Rebuild history from BigQuery archive; users re-sync from devices | 1 day |
| GitHub Actions down | Daily data job reruns when restored; data is idempotent (MERGE/upsert) | 1 day |
| Groq down | AI features show an error; rest of the app works | Hours |

Quarterly: restore a sample of history from BigQuery to confirm backups work. Record in EVIDENCE.md.
