# Feature flags: owner setup and use

Feature flags let you turn one part of Portfolio Intel off from your phone, without a deploy.
A change usually reaches the app and the jobs within a minute, and within about 90 seconds at worst.
Workers KV takes up to about 60 seconds to reach every Cloudflare location, then the gateway cache (10 s)
and the /api/flags browser cache (15 s) add a little. The Render fallback polls every 60 seconds, so it
can take up to about 2.5 minutes.

## What each flag does

| Flag | Default | If flags cannot be read | Turns off |
|---|---|---|---|
| maintenance | off | last known, else off | Every app route at once (when turned on). Health and /api/flags stay up |
| broker | on | last known, else off | Brokerage linking (/api/plaid/*) |
| sync_writes | on | last known, else off | Cloud sync uploads. The app keeps your changes on the device, encrypted, and uploads them when the flag is back on |
| ai | on | last known, else on | The assistant (/api/ask and /api/ai) |
| news | on | last known, else on | News headlines, news reads and the daily news-read batch. Works together with NEWS_ONDEMAND_ENABLED and NEWS_BATCH_ENABLED: news runs only if the flag and the variable both say on |
| disclosures | on | last known, else on | Congressional trades (/api/all-trades) |
| market | on | last known, else on | Prices, history, sectors, dividends |
| house_scrape | on | default | Daily House scrape step in fetch_trades |
| senate_scrape | on | default | Both daily Senate steps in fetch_trades |
| fmp_fill | on | default | FMP paper filing fill step in fetch_trades |
| recon_v2 | off | default | Reserved for the next reconciliation check. That check is not built yet, so today the current house check runs either way |
| sync | on | pi-sync writes nothing on that tick | The Jira and ADO sync (pi-sync). Off means each 5 minute tick exits without reading or writing |
| sync_dryrun | on | pi-sync writes nothing on that tick (it never falls to off) | Writes by pi-sync. On means it only plans and logs. Turn it off to let the sync write |

Rates, private markets and insights have no flag of their own; only maintenance turns them off.

When a flag is off, the route answers HTTP 503 with `Retry-After: 60`, `X-PI-Flag: off` and
`{"error":"This feature is turned off for now. Try again later.","disabled":true,"flag":"<name>"}`.
The app shows a short notice at the top of the page and does not retry on Render for that answer.

If the FLAGS KV namespace is not set up at all, every flag reads its default and the app works as before.

## One time setup

Status: done. Setup was completed on 2026-11-10 and the flags are live. The admin page sits behind
Cloudflare Access, with your email as the only one allowed. Login method: GitHub (you reported
GitHub only since 2026-11-10; a sign-in after the switch is not yet captured, see EVIDENCE.md).
The page fails closed: if any Access setting is missing (team domain, AUD tag or admin email), it
answers 403 for everyone, by design.

Keep the steps below for a rebuild. Follow them in this order. The order matters because the AUD tag
(step 9) only exists after the Worker has been deployed once (step 6).

1. **Create the KV namespace.** Cloudflare dashboard > Storage and databases > Workers KV > Create
   namespace, name it `pi-flags`. Copy its id (32 characters).
2. **Set up the Supabase audit table and its key (required).** In Supabase SQL Editor run
   `supabase/flags.sql` once. Then create a separate secret key for pi-flags (Project settings >
   API keys > Secret keys > New, name it pi-flags) and add it to the Cloudflare Secrets Store as
   `SUPABASE_FLAGS_KEY`.
   Why this is required: without the table or the key, a flip still succeeds and the Supabase row is
   silently skipped. Nothing on the flags page tells you. The change is then recorded in KV only, and
   the long term history in Supabase and BigQuery has a gap.
   This key is service_role equivalent: it bypasses RLS. It is a separate key only so it can be rotated
   and revoked on its own without touching the main service key. A custom role limited to
   flag_audit_add is a follow-up.
   The daily fetch_trades job copies flag_audit to BigQuery and removes Supabase rows over 1 year.
3. **Turn on Zero Trust (Free plan).** Cloudflare dashboard > Zero Trust. Pick a team name and the
   Free plan (up to 50 users, no charge; a payment card may be asked for). The team domain is
   `https://<team name>.cloudflareaccess.com`.
4. **Add GitHub as the login method.** Zero Trust > Settings > Authentication > Login methods > Add new >
   GitHub. Follow the steps to create a GitHub OAuth app (Settings > Developer settings > OAuth Apps on
   GitHub, callback URL `https://<team name>.cloudflareaccess.com/cdn-cgi/access/callback`), paste its
   client id and secret, then Test.
5. **Add the GitHub settings you have so far** (repository Settings > Secrets and variables > Actions).
   - Variable `CF_KV_FLAGS` = the KV id from step 1.
   - Variable `CF_ACCESS_TEAM` = your team domain from step 3, for example
     `https://yourteam.cloudflareaccess.com`.
   - Secret `FLAGS_ADMIN_EMAIL` = the one email allowed to change flags (the email on your GitHub
     account). Store it in lowercase with no spaces or line breaks, so it matches the token and GitHub
     masks it in logs. It is kept out of the code and the commits.
   Leave `CF_ACCESS_AUD` for step 9. It does not exist yet.
6. **First deploy.** Run the Deploy API Worker workflow (or push to main). It binds the KV namespace
   to the gateway, pi-flags, pi-newsdesk and pi-sync (the gateway, pi-newsdesk and pi-sync bindings
   are writable; they only read by convention, since KV bindings have no read only mode), fills in the
   Access settings it has, and links the Supabase key. The run prints the pi-flags URL
   (`https://pi-flags.<your subdomain>.workers.dev`).
   At this point the admin page answers 403 for everyone, and the run shows a warning that the AUD is
   not set. That is expected. If the run warns "Secrets Store has no SUPABASE_FLAGS_KEY", go back to
   step 2 before going on.
7. **Create the Access application.** Zero Trust > Access > Applications > Add an application >
   Self-hosted:
   - Domain: the pi-flags workers.dev host. Path: leave empty (covers the whole Worker).
     Exact host only, never a wildcard such as `*.<subdomain>.workers.dev`, which would put the gateway
     behind Access.
   - Session duration: 1 hour.
   - Login methods: GitHub only. Turn on instant auth if offered.
   - Policy: Allow, Include, Emails, your email only. No other rules.
   - Save.
   Warning, learned at go-live: a new Access application accepts every login method by default,
   including the one-time PIN sent by email. Turn off "Accept all available identity providers" and
   select GitHub only. Open the application again after saving and check that GitHub is the only
   method listed.
   Cloudflare may also offer a one-click "Enable Cloudflare Access" on the Worker's Settings > Domains
   and Routes for workers.dev. Either way, use the AUD of that one application.
8. **Check nothing else is behind Access.** Zero Trust > Access > Applications must list only pi-flags.
   No application may cover `portfolio-intel-api.<subdomain>.workers.dev` or the Pages site
   (`portfolio-intel-279.pages.dev`); if one does, the app stops working for everyone.
9. **Add the AUD tag.** Open the application's Overview, copy the **Application Audience (AUD) Tag**
   and save it as the GitHub repository variable `CF_ACCESS_AUD`.
10. **Second deploy.** Run the Deploy API Worker workflow again so pi-flags picks up the AUD. The
    warning from step 6 should be gone.
11. **Test the login.** Open `https://pi-flags.<subdomain>.workers.dev/admin` in a private window. You
    should see the GitHub login only (no email PIN option), then the flags page. Another GitHub
    account must be refused by Cloudflare Access.
12. **Run the go-live test** (next section).

## Go-live test

Use this after setup, and any time you want proof that the flags work end to end.

1. Open `https://portfolio-intel-api.<subdomain>.workers.dev/api/flags` and note the `v` number.
   Before the very first flip it shows `v: 0` and `updated: null`. That means no value has been saved
   yet and every flag is at its default.
2. On the flags page, flip `recon_v2` with a reason such as "go-live test". This flag is safe to use
   because it gates nothing today.
3. Wait about a minute, then reload `/api/flags`. `recon_v2` shows the new value and `v` has gone up
   by 1. A `v` of 1 or more is the proof that the values come from KV and not from the defaults.
4. In Supabase > Table Editor > `flag_audit`, confirm a new row with the same `v`. If the row is
   missing, the flip worked but the Supabase audit did not: check step 2 of the setup.
5. Flip `recon_v2` back, and confirm `v` went up again and a second row appeared.

Never use `sync_dryrun` as a test flag. Turning it off lets pi-sync write to Jira and ADO.

Result on 2026-11-10: `recon_v2` on at 05:02:59 UTC and off at 05:08:16 UTC, two `flag_audit` rows
(v 1 and v 2), and `/api/flags` returned the saved value.

## Flip a flag from your phone

1. Open `https://pi-flags.<subdomain>.workers.dev/admin` (save it to your home screen).
2. Sign in with GitHub if asked (sessions last 1 hour).
3. Type a reason (3 to 200 characters), then tap the On or Off button next to the flag.
4. The change shows in the list and in "Last 20 changes". The app follows within about a minute (90 seconds at worst).
   If someone else changed a flag since you loaded the page, you get a "Reload and try again" message.
   The version check is not atomic (two saves in the same instant can both pass). That is fine with one admin.
   If the audit record cannot be saved, the flag is not changed and you see "Could not record the change".
   That protection covers the KV record only. The Supabase row is written after the flag has changed.
   If that write fails, the flag still changes and the page shows no error.

## How the jobs behave

- fetch_trades reads `/api/flags` in its first step (`scripts/flags.py`, 5 s timeout, 2 tries). If the
  gateway cannot be reached, each flag takes its default and the run shows a warning.
- A skipped scrape leaves yesterday's data in place; the rest of the run carries on.
- The pi-newsdesk batch checks the news flag on every tick.
- pi-sync reads the sync and sync_dryrun flags on every 5 minute tick. If it cannot read the flags, it writes nothing.
- The SOC monitor reads `/api/flags` daily. It warns when the endpoint is unreachable or when a flag has
  been away from its default for over 24 hours, and lists suggested flips next to related findings.
  It never changes a flag.
- The Render fallback reads `/api/flags` every 60 seconds. Until it has reached the gateway once, it keeps
  broker off and the other flags at their defaults.
