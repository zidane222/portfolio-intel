# Feature flags: owner setup and use

Feature flags let you turn one part of Portfolio Intel off from your phone, without a deploy.
A change reaches the app, the Render fallback and the jobs within about 60 seconds.

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

Rates, private markets and insights have no flag of their own; only maintenance turns them off.

When a flag is off, the route answers HTTP 503 with `Retry-After: 60`, `X-PI-Flag: off` and
`{"error":"This feature is turned off for now. Try again later.","disabled":true,"flag":"<name>"}`.
The app shows a short notice at the top of the page and does not retry on Render for that answer.

If the FLAGS KV namespace is not set up at all, every flag reads its default and the app works as before.

## One time setup

Cloudflare Access is not set up yet. Until it is, the admin page answers 403 for everyone, by design.

1. **Create the KV namespace.** Cloudflare dashboard > Storage and databases > Workers KV > Create
   namespace, name it `pi-flags`. Copy its id (32 characters).
2. **Add GitHub repository variables** (Settings > Secrets and variables > Actions > Variables):
   - `CF_KV_FLAGS` = the KV id from step 1.
   - `CF_ACCESS_TEAM` = your team domain, for example `https://yourteam.cloudflareaccess.com` (step 4).
   - `CF_ACCESS_AUD` = the Access application AUD tag (step 6).
3. **Add a GitHub repository secret** `FLAGS_ADMIN_EMAIL` = the one email allowed to change flags
   (the email on your GitHub account). It is kept out of the code and the commits.
4. **Turn on Zero Trust (Free plan).** Cloudflare dashboard > Zero Trust. Pick a team name and the
   Free plan (up to 50 users, no charge; a payment card may be asked for). The team domain is
   `https://<team name>.cloudflareaccess.com`.
5. **Add GitHub as the login method.** Zero Trust > Settings > Authentication > Login methods > Add new >
   GitHub. Follow the steps to create a GitHub OAuth app (Settings > Developer settings > OAuth Apps on
   GitHub, callback URL `https://<team name>.cloudflareaccess.com/cdn-cgi/access/callback`), paste its
   client id and secret, then Test.
6. **Create the Access application.** Run the Deploy API Worker workflow once first so `pi-flags` exists
   and prints its URL (`https://pi-flags.<your subdomain>.workers.dev`). Then Zero Trust > Access >
   Applications > Add an application > Self-hosted:
   - Domain: the pi-flags workers.dev host. Path: leave empty (covers the whole Worker).
   - Session duration: 1 hour.
   - Login methods: GitHub only. Turn on instant auth if offered.
   - Policy: Allow, Include, Emails, your email only. No other rules.
   - Save, then open the app's Overview and copy the **Application Audience (AUD) Tag** into `CF_ACCESS_AUD`.
   Cloudflare may also offer a one-click "Enable Cloudflare Access" on the Worker's Settings > Domains
   and Routes for workers.dev. Either way, use the AUD of that one application.
7. **Check nothing else is behind Access.** Zero Trust > Access > Applications must list only pi-flags.
   No application may cover `portfolio-intel-api.<subdomain>.workers.dev` or the Pages site
   (`portfolio-intel-279.pages.dev`); if one does, the app stops working for everyone.
8. **Optional: Supabase audit table.** In Supabase SQL Editor run `supabase/flags.sql` once. Then create a
   separate secret key for pi-flags (Project settings > API keys > Secret keys > New, name it pi-flags) and
   add it to the Cloudflare Secrets Store as `SUPABASE_FLAGS_KEY`. Without it the audit stays in KV only.
   The daily fetch_trades job copies flag_audit to BigQuery and removes Supabase rows over 1 year.
9. **Deploy.** Run the Deploy API Worker workflow (or push to main). It binds the KV namespace to the
   gateway, pi-newsdesk and pi-flags, fills in the Access settings, and links the Supabase key if it exists.
10. **Test.** Open `https://pi-flags.<subdomain>.workers.dev/admin` in a private window. You should see the
    GitHub login, then the flags page. Another GitHub account must get "Not allowed".

## Flip a flag from your phone

1. Open `https://pi-flags.<subdomain>.workers.dev/admin` (save it to your home screen).
2. Sign in with GitHub if asked (sessions last 1 hour).
3. Type a reason (3 to 200 characters), then tap the On or Off button next to the flag.
4. The change shows in the list and in "Last 20 changes". The app follows within about 60 seconds.
   If someone else changed a flag since you loaded the page, you get a "Reload and try again" message.

## How the jobs behave

- fetch_trades reads `/api/flags` in its first step (`scripts/flags.py`, 5 s timeout, 2 tries). If the
  gateway cannot be reached, each flag takes its default and the run shows a warning.
- A skipped scrape leaves yesterday's data in place; the rest of the run carries on.
- The pi-newsdesk batch checks the news flag on every tick.
- The SOC monitor reads `/api/flags` daily. It warns when the endpoint is unreachable or when a flag has
  been away from its default for over 24 hours, and lists suggested flips next to related findings.
  It never changes a flag.
- The Render fallback reads `/api/flags` every 60 seconds. Until it has reached the gateway once, it keeps
  broker off and the other flags at their defaults.
