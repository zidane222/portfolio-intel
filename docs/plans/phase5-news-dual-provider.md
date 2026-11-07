# Phase 5: News reads on two AI providers (Groq + Gemini)

Status: approved, in PR. Builds on `docs/plans/phase3-news-agents.md`.

## 1. Goal

News reads (pi-newsdesk) and Ask (pi-ai) share one Groq free-tier quota. On Oct 31, 6 of 15
batch verdicts fell back to headlines only. This phase gives news its own provider so the two
features stop competing, and keeps each provider as the other's backup.

1. Add Gemini (free tier) as a second AI provider for pi-newsdesk only.
2. **Trial week:** Groq stays primary. Gemini runs the same daily batch in shadow, stored but
   never shown to users. A daily comparison reports which provider did better.
3. **After the trial:** the owner decides. Expected result: Gemini primary for news with Groq
   as fallback, Ask stays on Groq. Switching is one config value, no code change.

Not in scope: Ask on Gemini, the learning agent, paid tiers, any new user-facing screen.

## 2. Decisions

- **D1. Same microservice layout.** No new Worker. Gemini is a new client in `worker/src/lib`,
  injected through the existing `deps.groqChat` seam in `modules/newsdesk.js`. The agents
  (`agents/newsread/*`) do not change.
- **D2. Gemini through its OpenAI-compatible endpoint**
  (`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`), so the request
  shape matches Groq. JSON mode as today.
- **D3. Ask stays on Groq.** Ask can carry the user's holdings context. Gemini's free tier
  ("unpaid services") may use prompts to improve Google products and allows human review, so
  only public data goes there: tickers from the fixed list and the news universe, plus public
  headlines. No user id, holdings, IP or watchlist owner is ever sent. This is already true of
  the news pack (plan phase 3, 6.1); QA adds a test that locks it.
- **D4. Separate budgets per provider.** `news_budget` gets a `provider` column so Gemini has
  its own daily caps. Groq's caps stay as they are. Each provider keeps its own cap so neither
  is maxed out.
- **D5. Shadow rows never reach users.** New origin `shadow`. The 7-day view and on-demand
  lookup already filter `origin = 'batch'`, so nothing in the app changes.
- **D6. Failover per call.** When the primary provider returns 429, a 5xx, a timeout or an
  empty answer, the same call retries once on the other provider if that provider's budget
  allows. The record notes which provider wrote each role (`providers` field).
- **D7. Model is config.** `GEMINI_MODEL` in `config/newsdesk.toml`. The owner confirms a model
  and its free limits in Google AI Studio before the first deploy (limits are per Google Cloud
  project and reset at midnight Pacific).

## 3. Config (`worker/config/newsdesk.toml`)

```
NEWS_PROVIDER     = "groq"        # primary for batch and on-demand: groq | gemini
NEWS_FALLBACK     = "gemini"      # second provider for failover, or "" to disable
NEWS_SHADOW       = "gemini"      # provider for the shadow batch, or "" to disable
NEWS_SHADOW_UNTIL = "2026-11-10"  # last run_date with a shadow run (7 batch days)
GEMINI_MODEL      = "<set by owner from AI Studio>"
GEMINI_CALLS_DAY  = "90"
GEMINI_TOKENS_DAY = "180000"
GEMINI_BATCH_CALLS = "60"
```

Secret: `GEMINI_API_KEY` in the Cloudflare Secrets Store, linked to pi-newsdesk only by
`deploy-worker.yml`. If the secret is missing, the deploy warns and the Worker runs exactly as
today (no shadow, no failover).

## 4. Flow

### 4.1 Batch tick (unchanged schedule, `*/3 4,5 * * *`, 2 tickers per tick)
1. Claim jobs as today.
2. For each ticker, in parallel: primary read (origin `batch`), and while
   `run_date <= NEWS_SHADOW_UNTIL`, a shadow read (origin `shadow`) on `NEWS_SHADOW`.
   Both reuse one headline fetch and one pack, so they judge the same input.
3. Upsert both rows. Only the primary result sets `news_jobs.status`.
4. A shadow failure never fails the job.

Subrequests per tick: about 2 tickers x (1 headline fetch + up to 4 AI calls x 2 + 4 Supabase
calls) = about 30, under the Workers free limit of 50. Tick deadline stays 25 s; the two reads
run in parallel, so wall time does not double.

### 4.2 On-demand read
Primary provider plus failover (D6). No shadow, to protect quota.

## 5. Files

### Server / microservices
- `worker/src/lib/gemini.js` (new): `geminiChat(env, system, user, maxTokens, jsonMode, opts)`,
  same signature and error rules as `groqChat` (status and error code only in logs, never
  response bodies, since they can echo prompt text).
- `worker/src/lib/llm.js` (new): `chat(provider, env, ...)` and `providerChain(env)`.
- `worker/src/modules/newsdesk.js`: `makeDeps` builds a per-provider chat; `budgetFor` takes a
  provider; `produce` accepts `provider` and `origin`; `tick` adds the shadow read; record gains
  `provider` and `providers`.
- `worker/config/newsdesk.toml`: section 3 values.
- `.github/workflows/deploy-worker.yml`: link `GEMINI_API_KEY` to newsdesk when present.

### Database (`supabase/news.sql`, applied as a migration)
- `news_verdicts.origin` check: `in ('batch', 'shadow')`. Unique key unchanged
  (`ticker, run_date, origin`).
- `news_verdicts.provider text` (nullable for old rows).
- `news_budget`: add `provider text not null default 'groq'`, primary key `(day, provider)`.
- `news_take(...)`: new `p text default 'groq'` argument. Old signature kept until the deploy
  lands, then dropped.
- BigQuery archive: add `provider` and keep `origin`, so the learning agent can score both.

### Comparison
- `scripts/news_provider_compare.py` (new, stdlib + requests): for each day in the trial,
  pairs `batch` and `shadow` rows by ticker and reports per provider: verdicts completed,
  PASS rate, fallback rate, validator flags, average AI calls and tokens, and stance agreement
  between the two. Writes `news_provider_compare.json`.
- `scripts/meta_supervisor.py`: new check G, one line per provider from that file. WARN when a
  provider's PASS rate is under 80% for the day.

### Frontend
None.

## 6. Decision rule after the trial (owner decides)

Recommend Gemini as news primary when, over the 7 days:
- Gemini PASS rate is at least Groq's and at least 90%,
- no day with Gemini quota errors on more than 2 tickers,
- validator flags no higher than Groq's.

Otherwise keep Groq primary with Gemini as failover only. Accuracy against later prices comes
from the learning agent once it has data; this rule only measures reliability.

## 7. QA tests
- `gemini.js`: request shape, JSON mode, 429/5xx/timeout handling, no body text in errors.
- Failover: primary 429 retries on the other provider, budget denial on both gives fallback.
- Budget: Gemini calls never touch the Groq row and the reverse.
- Shadow: rows stored with origin `shadow`, absent from `/reads` and on-demand lookups, a shadow
  error leaves the job `ok`, no shadow after `NEWS_SHADOW_UNTIL`.
- Privacy lock: the payload sent to Gemini contains no user, ip, holdings or watchlist field.
- Missing `GEMINI_API_KEY`: behavior identical to today.
- Existing suites (`newsdesk.mjs`, `phase3.mjs`, `test.mjs`) still pass.

## 8. AppSec
- New outbound host `generativelanguage.googleapis.com`, from pi-newsdesk only.
- Prompt injection through headlines: unchanged controls (headlines treated as data, validator
  on output); the same validator runs on Gemini output.
- Key scope: create the key in a Google Cloud project with no billing, restrict it to the
  Generative Language API.

## 9. Compliance
- Vendor list and data-flow map: add Google (Gemini API, free tier), public data only.
- Risk register: new risk, free-tier provider may use prompts for product improvement;
  treatment is D3 (public data only) plus the privacy test. Status Mitigated.
- R-11 (Groq quota) gets a note: split quota reduces it.
- Evidence rows for this PR.

## 10. Owner steps (about 10 minutes)
1. In Google AI Studio, create an API key in a new project with no billing.
2. In AI Studio's rate limit page, pick a Flash or Flash-Lite model and note its free
   requests per minute and per day.
3. Add the key to the Cloudflare Secrets Store as `GEMINI_API_KEY`.
4. Tell Claude the model name and its daily limit, so the caps are set under it.

## 11. Risks
- Gemini free limits change without notice: caps are config, and failover covers a bad day.
- Shadow doubles news AI calls during the trial: Gemini calls use Gemini's quota only, so Groq
  usage does not rise.
- Two models may disagree often: that is reported, not hidden, and does not change what users
  see during the trial.
