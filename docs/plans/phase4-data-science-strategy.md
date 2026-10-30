# Phase 4 plan: data science agent and strategy agent

Status: proposed. Author: architect. Branch: `phase4/data-science`. Builds on
`docs/plans/phase2-supervisor.md` (registry, case state, fact checker, validator) and
`docs/plans/phase3-news-agents.md` (news_verdicts, learning agent extension point).

## 1. Goal

Two offline agents that run weekly in GitHub Actions against BigQuery and publish plain JSON:

- **Data science agent.** Looks for patterns in the congressional trade history and reports only
  results that survive statistical tests: multiple-testing control, minimum sample sizes,
  confidence intervals and an out-of-sample check. A weak result is never shown as a finding.
- **Strategy agent.** Defines a small set of rule-based strategies and backtests them on the same
  history. Simulated only. It never places trades and never recommends. Metrics are honest: CAGR,
  volatility, max drawdown, Sharpe, against SPY, with cost and filing-delay assumptions and
  survivorship caveats stated next to the numbers.

Results appear on a new **Insights** page and are readable by the Ask supervisor through a new data
agent under an `insights` intent. Everything describes history. Nothing predicts or advises.

Out of scope for v1: committee analysis (no committee data yet, see open question 1), intraday or
options data, tax effects, any live signal, any push alert, any user-specific backtest, any Groq call
in the weekly job.

## 2. Decisions

| # | Decision | Reason |
|---|---|---|
| D1 | Weekly GitHub Actions job (`insights.yml`, Sunday 07:30 UTC, after the 06:00 daily load), plus manual dispatch. Python runner, SQL in `analytics/sql/*.sql`. | Data changes daily but findings do not need daily refresh; weekly keeps BigQuery bytes and the multiple-testing count small and stable. |
| D2 | BigQuery does joins and window lookups. Python (numpy, pandas, scipy) does statistics and backtests on the returned frames. | Event table is about 30K rows per horizon, panel is under 100 MB. Python is testable with synthetic frames and no BigQuery. |
| D3 | **No Groq in the job. Plain-language text comes from fixed templates** (`analytics/narrate.py`). | Numbers in text must equal the numbers in the JSON; templates guarantee it and are unit-testable. No Groq key in GitHub (owner decision 2026-10-26). Value of AI wording over templates is low. Ask already has the builder (placeholders, validator) for conversational wording, so no new Groq call anywhere. |
| D4 | Output files `insights.json` and `strategies.json` committed to the repo root on `main` by the job (same pattern as `private_markets.json`), served by Pages. | Existing pattern, free, no new storage. Equity curves are monthly so files stay small (budget in section 12). |
| D5 | New private service **pi-insights** reads the Pages files (like pi-private) and serves them through the gateway. The app and the Ask data agent both use it. | Keeps "front end talks only to the gateway" and "agents reach data only through bindings". The app may fall back to the same-origin static file if the gateway is down. |
| D6 | Confirmatory and exploratory test families (section 5.3). Exploratory findings must replicate on a fixed hold-out. | Honest handling of scans over members and sectors. |
| D7 | Primary entry clock is the **filing date** (next trading close after it). Trade-date entry is shown only as a labeled "not achievable" comparison. | The public could only act after the filing. Trade-date results measure member timing, not what a follower could get. |
| D8 | "Tested, no evidence" is published as counts and a short list for the confirmatory family, never as findings. | Avoids hiding the number of looks. Satisfies "report only results that pass" for findings while keeping the denominator visible. |
| D9 | Strategy parameters are fixed in advance. No parameter search in v1. The count of strategies tried is published. | Removes tuning as a source of overfit. |
| D10 | Prices get a nullable `adj_close` column in BigQuery (not Supabase), and a fixed benchmark ticker set is always loaded (section 4.2). | `close` omits dividends, which biases dividend and bond comparisons. SPY and sector ETFs are not guaranteed to be in the traded-ticker set. |

No decision adds cost. See section 12.

## 3. Architecture

```
GitHub Actions: insights.yml (Sun 07:30 UTC, workflow_dispatch; push on analytics/** runs a dry run)
  1. pytest analytics/tests (synthetic known-effect and null tests). Fail stops the job.
  2. auth with Workload Identity Federation (same provider as fetch_trades), BQ_PROJECT
  3. analytics/run.py
       preflight   : coverage + required tickers + dry-run bytes per query (abort over budget)
       sql stage   : analytics/sql/*.sql, parameterized, return DataFrames
       ds stage    : analytics/ds/*.py  (A1..A7)  -> findings, tested, scan summaries
       strat stage : analytics/strategies/*.py (S1..S6) -> runs, metrics, curves
       narrate     : analytics/narrate.py templates -> summary strings
       lint        : analytics/lint.py (advice words, labels, dashes, schema) ; failure = no publish
       write       : out/insights.json, out/strategies.json
  4. upload artifact; on main only: commit the two files (retry rebase, like private-markets)

Cloudflare Pages: /insights.json  /strategies.json   (public, derived aggregates only)
        |  INSIGHTS_DATA_URL, redirect: 'error', 5 MB streamed cap, 1 h cache, last good 48 h
pi-insights (new, no public URL)   routes below
        |  service binding INSIGHTS
Gateway: GET /api/insights, /api/insights/strategies   (origin check, `api` rate limit)
        |                                   |
  Insights page (js/29e-insights.js)   Ask: intent `insights` -> data agent insights.js
```

Boundaries kept: the weekly job never calls a Worker; Workers never call BigQuery; the app talks
only to the gateway (static fallback is same origin); the data agent reaches pi-insights only
through the `INSIGHTS` binding with `X-PI-Internal: 1`; agents in the app still never call each other.

### 3.1 Files in `analytics/`

```
analytics/
  config.py            pre-declared constants (section 5.1), one place, versioned (method_version)
  run.py               orchestrator and budget guard
  sql/00_coverage.sql  row counts, date ranges, null shares, required-ticker coverage
  sql/10_events.sql    trade events with entry/exit prices and SPY over the same dates, 3 horizons
  sql/20_news.sql      verdicts joined to price_ref_date and +1/+5/+20 trading days, with SPY
  sql/30_panel.sql     daily adj_close/close panel for benchmark, ETF and copy-strategy tickers
  ds/stats.py          cluster-block bootstrap, BH, Benjamini-Yekutieli CI, holdout check, shrinkage
  ds/a1_headline.py ... a7_news.py
  strategies/engine.py daily simulator, costs, delay, metrics, bootstrap vs SPY
  strategies/s1_copy.py s2_members.py s3_momentum.py s4_dividend.py s5_tbill.py s6_balanced.py
  narrate.py  lint.py  schema/insights.v1.json  schema/strategies.v1.json
  ref/sectors.csv      built from the repo's sectors.json (ticker to sector), no network
  tests/               synth.py + pytest files (section 10)
```

## 4. Data and caveats

### 4.1 What is in BigQuery (from `scripts/history_load.py`)

- `trades(id, chamber, member, ticker, asset, kind, tx_type, amount, amount_low, amount_high, traded, filed)`, about 30K rows, 2021+.
- `prices(ticker, d, close)`, about 2.6M rows, 2,555 tickers, monthly partitions on `d`.
- `news_verdicts(... run_date, ticker, stance, confidence, status, price_ref_date ...)`, grows from Phase 3.

### 4.2 Data changes needed (small PR 1, merge first)

- `prices` gains `adj_close FLOAT64 NULLABLE` (Yahoo chart `adjclose`). `history_load.py` adds the column with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (the `bq_ensure` helper does not alter existing tables) and **strips `adj_close` before the Supabase upsert** (that table has no such column and PostgREST rejects unknown keys). A one-time `--prices max` run through `history-backfill.yml` fills history. Until then analyses use `close` and publish `price_basis: "close"` plus a caveat.
- Always-load benchmark set, added to the ticker set regardless of trades: `SPY QQQ SHV IEF AGG` and the 11 sector ETFs `XLK XLF XLV XLY XLP XLE XLI XLB XLU XLRE XLC` and `SCHD VYM DGRO VIG`. About 25 tickers, negligible rows. The runner `preflight` fails (and publishes nothing) if a required ticker has under 95 percent of trading days since its first date, or the last SPY date is over 5 days old.

### 4.3 Caveats (published in `caveats[]`, shown next to every number they affect)

| id | Caveat |
|---|---|
| `amount_ranges` | Amounts are disclosed ranges, not exact. Size buckets use `amount_low`; "Over $X" has no upper bound. Dollar-weighted results are not computed. |
| `filing_delay` | Filings arrive up to 45 days after the trade (sometimes later). Rows with `filed` missing, before `traded`, or more than 365 days after are dropped and counted. Trade-date entry is not achievable. |
| `missing_tickers` | Rows without a usable ticker (bonds, funds without symbols, private assets, options kinds) are excluded and counted in `coverage.dropped`. Ticker renames and reuse can mismatch. |
| `survivorship` | The price universe is tickers Congress traded plus a fixed ETF set. Delisted or acquired names may be missing or truncated, which flatters any stock-picking result. Copy strategies are reported with this caveat; the sector-ETF momentum strategy avoids it. |
| `universe_bias` | Congress trades large, popular US names. Beating SPY can reflect that tilt. A1 therefore also tests against a same-universe placebo (5.4). |
| `short_history` | About 5 years, one market regime (2022 drawdown, strong 2023 to 2025). Few independent windows at 180 days. |
| `price_basis` | `adj_close` when present, else `close` (price return only). |
| `owner_unknown` | The data does not show whether a trade was the member's, a spouse's or a dependent's. |
| `no_wrongdoing` | A statistical pattern in disclosed trades does not show use of nonpublic information. |
| `costs` | Costs are assumptions (section 7.1), not measurements. No taxes, no market impact, execution at the close. |
| `data_license` | Source terms (see section 11). Only derived aggregates are published, never raw rows or price series. |

## 5. Data science agent: v1 analyses

### 5.1 Common method (pre-declared in `config.py`, version `ds-1`)

- **Event.** One disclosed trade with a valid ticker, `tx_type` purchase (A1, A3 to A6) or sale (A2), both prices available. Partial and full sales both count as sales; exchanges are dropped.
- **Calendar.** SPY trading days. Entry day = first SPY day strictly after `filed` (D7). Exit day = first trading day on or after entry + h calendar days, h in {30, 90, 180}. If the exit is after the last price date the event is dropped for that horizon (no partial windows). Missing stock price on the entry day: use the next day up to 3 trading days, else drop and count.
- **Excess return.** `stock_return - SPY_return` over the same two dates, in percent, minus nothing. The **net** figure subtracts a 50 bps round trip.
- **Cluster.** Events are grouped by filing month (they share market conditions and overlap in time). All tests resample or aggregate by month, never by event.
- **Test.** Moving-block bootstrap over filing-month cluster means, block length `ceil(h/30)` months (1, 3, 6), 10,000 resamples, fixed seed 42, two-sided percentile p-value and 95 percent CI.
- **Minimum sample** (all must hold, else status `insufficient_data` and the cell is not tested or counted as a test): headline cells 200 events, 24 months, 20 tickers; subgroups 30 events (members), 100 events (sectors, buckets), 12 months (members) or 24 months (others), 10 tickers; months also at least 4 times the block length.
- **Practical floor.** A finding also needs net mean excess of at least 0.5 pt at 30d, 1.5 pt at 90d, 3.0 pt at 180d in absolute value.
- **Hold-out.** Fixed split date 2024-01-01 (constant, reviewed once a year, never tuned). Discovery uses events with `filed` before it; hold-out uses events on or after it.

### 5.2 The analyses

| ID | Question | Method and test | Family | Extra thresholds |
|---|---|---|---|---|
| A1 | Do disclosed **purchases** beat SPY over 30/90/180 days, by chamber (Senate, House)? | Per chamber and horizon, mean excess from filing-day entry, block bootstrap. Also trade-date entry shown as "not achievable". Must also beat the placebo (5.4). 6 tests. | confirmatory | Headline minimums |
| A2 | Do disclosed **sales** precede lagging or leading returns (both chambers pooled, 3 horizons)? | Same as A1 on sales, two-sided. 3 tests. | confirmatory | Headline minimums |
| A3 | Filing delay effect. (a) How much of the post-trade move is gone by the filing date: return from trade date to entry minus SPY, by delay bucket (0-15, 16-30, 31-45, over 45 days). (b) Does the filing-entry 90d excess differ between fast (up to 15 days) and slow (over 30 days) filers? | (a) descriptive, no finding. (b) difference of means, block bootstrap on the difference. 1 test. | confirmatory | Each bucket 100 events |
| A4 | Which **members**: is any member's purchase excess at 90d reliably different from zero? | One test per eligible member at the primary horizon (90d only, pre-declared). Reported value is an empirical-Bayes shrunk estimate; raw mean shown too. Discovery period selects, hold-out confirms. | exploratory | 30 events, 12 months, 10 tickers in discovery |
| A5 | Which **sectors** (from `ref/sectors.csv`; unmapped tickers go to "Unknown" and are not tested) show reliable 90d purchase excess? | One test per sector with enough events; discovery selects, hold-out confirms. | exploratory | 100 events, 24 months |
| A6 | **Trade size.** Does excess rise with disclosed size? | Bucket by `amount_low`: up to 15K, 15K to 50K, 50K to 250K, over 250K. Test the slope of event excess on log2(amount_low), month-clustered, at each horizon. 3 tests. Bucket means shown descriptively. | confirmatory | 100 events per bucket |
| A7 | **News stance vs later returns.** After a news read says `positive` or `negative`, how do 1/5/20 trading-day returns after `price_ref_date` compare with SPY? | Stance groups from `news_verdicts` where `status = PASS`, one row per ticker per `run_date`. Excess vs SPY, month-clustered bootstrap, positive-minus-negative difference as the test. 3 tests. Computed in SQL, no outcomes table in v1. | exploratory | Gate: at least 200 scored verdicts, 40 distinct `run_date`s, 30 per stance group. Below the gate the page shows progress ("57 of 200"). |

### 5.3 Multiple testing and the finding rule

1. Every test that meets its minimum sample is counted in `tests_run` for its family.
2. **Confirmatory family** (A1, A2, A3b, A6; at most 15 tests): Benjamini-Hochberg at q = 0.10 over the family.
3. **Exploratory family** (A4, A5, A7): BH at q = 0.10 over the family, and the hold-out rule below is mandatory.
4. A result becomes a **finding** only if all hold: sample minimums, BH-adjusted p at most 0.10, reported 95 percent CI excludes zero (CI widened by the Benjamini-Yekutieli factor `1 - q*R/m` for the selected set), net practical floor met, the placebo check for A1, and **hold-out replication**: same sign, at least the minimum hold-out sample (half the discovery minimum), one-sided p at most 0.10. For confirmatory tests the hold-out must also agree in sign.
5. Anything else gets a status: `no_evidence`, `insufficient_data` or `unstable` (full sample significant but hold-out disagrees). Only the confirmatory family lists these individually; exploratory scans publish counts (`scan_summary`).

### 5.4 Placebo control (part of A1)

For every A1 event, draw 200 random tickers from the same priced traded-universe on the same entry
date (same horizon) and compute the same excess. The event cohort's mean is compared with the
placebo distribution of cohort means (1,000 draws). A1 requires the real mean to exceed the 95th
percentile (purchases) of the placebo means, so a "Congress beats SPY" result that is only a
large-cap or popular-name tilt is not reported.

## 6. Strategy agent: v1 strategies

Six definitions, nine runs. All fixed in advance (D9). Every run is labeled SIMULATED.

| ID | Definition | Signal and rules |
|---|---|---|
| S1 `copy-senate-buys`, `copy-house-buys` | Copy all disclosed purchases of one chamber | On each filing, buy at the next close, hold 90 calendar days, ignore sales. Equal weight across active positions each day. No position means cash at 0 percent. Single-stock cost. |
| S2 `copy-top-members` | Copy the 5 members with the best **discovery-window** shrunk 90d excess (at least 30 purchases) | Selected using data before 2024-01-01 only, then simulated **only on the hold-out period**. The in-sample period is shown labeled "reference, not evidence". Same mechanics as S1. |
| S3 `momentum-sectors` | Sector ETF momentum | Month end: rank the 11 sector SPDRs by 12-1 month total return, hold the top 3 equal weight for the next month. ETF cost. Starts after 13 months of data. |
| S4 `dividend-basket` | Dividend ETF basket | Equal weight SCHD, VYM, DGRO, VIG, rebalance each January. Uses `adj_close`; if absent the run is marked price-return-only. |
| S5 `tbill-proxy` | T-bill ladder proxy | Hold SHV (0 to 1 year Treasury ETF). Named a proxy; a real ladder needs a yield series (open item, not in v1). Used as the risk-free rate for Sharpe. |
| S6 `balanced-annual`, `balanced-never`, `balanced-band` | 60/40 SPY and IEF, three rebalancing rules | Rebalance every January; never; or when any weight drifts more than 5 points from target. Shows the effect of rebalancing on return, drawdown and turnover. |

### 6.1 Simulator rules (`strategies/engine.py`)

- Daily closes only. A signal known at the close of day t trades at the close of the next trading day. The test suite proves no signal uses data after t.
- Filing-delay assumption: copy strategies use the **filing** date. A variant `trade_date_hypothetical` (entry the day after the trade date) is reported as a comparison only and labeled "not achievable".
- Costs per side on notional traded: 25 bps single stocks, 5 bps ETFs. Sensitivity: the same run at double cost is published.
- Cash earns 0 unless a strategy holds SHV. Taxes, dividends reinvested only via `adj_close`, no leverage, no shorting, whole-share rounding ignored.
- Metrics (full period and a **common window** from 2021-01-01 so runs are comparable): CAGR, annualized volatility, max drawdown, Sharpe (excess over the SHV daily return), turnover, average invested percent, number of trades. Same metrics for SPY over the same dates.
- Relative to SPY: excess CAGR with a 95 percent CI from a stationary bootstrap of the daily return difference (10,000 resamples, seed 42), beta, annualized alpha, information ratio.
- Evidence tag: `ahead` only if the excess-CAGR CI lower bound is above zero **and** the out-of-sample or hold-out period has the same sign; `behind` mirrors it; otherwise `not_distinguishable`. The template wording follows the tag; "beat" is never used without it.
- Always published with each run: period, benchmark, cost assumptions, caveat ids (`survivorship`, `costs`, `filing_delay`, `short_history`, `price_basis`).

## 7. Contracts

### 7.1 `insights.json` (`pi/insights/v1`)

```json
{
  "schema": "pi/insights/v1",
  "method_version": "ds-1",
  "generated": "2026-11-01T07:41:00Z",
  "code_version": "git sha",
  "data_asof": {"trades": "2026-10-30", "prices": "2026-10-29", "news_verdicts": "2026-10-30"},
  "label": "Historical analysis of public disclosures. Not investment advice. Past results do not predict future results.",
  "params": {"fdr_q": 0.10, "split_date": "2024-01-01", "primary_horizon_days": 90,
             "cost_bps_roundtrip": 50, "resamples": 10000, "seed": 42, "price_basis": "adj_close"},
  "coverage": {"trades_total": 30412, "events_used": 21870, "tickers_priced": 1980,
               "dropped": {"no_ticker": 0, "bad_dates": 0, "no_price": 0, "too_recent": 0}},
  "tests_run": {"confirmatory": 15, "exploratory": 74},
  "findings": [{
    "id": "a1-senate-purchases-90",
    "analysis": "A1", "family": "confirmatory",
    "title": "Senate disclosed purchases vs SPY, 90 days",
    "summary": "template text built from the numbers below",
    "subject": {"chamber": "senate", "tx_type": "purchase", "member": null, "sector": null, "bucket": null},
    "horizon_days": 90, "entry": "filing_next_close",
    "n_events": 0, "n_months": 0, "n_tickers": 0,
    "mean_excess_pct": 0.0, "ci95_pct": [0.0, 0.0], "net_mean_excess_pct": 0.0,
    "p_adj": 0.0, "placebo_pct": 0.0,
    "holdout": {"n_events": 0, "mean_excess_pct": 0.0, "p_one_sided": 0.0, "replicates": true},
    "not_achievable_trade_date_pct": 0.0,
    "caveats": ["filing_delay", "universe_bias", "survivorship", "short_history"]
  }],
  "tested": [{"id": "a1-house-purchases-30", "analysis": "A1", "status": "no_evidence",
              "n_events": 0, "mean_excess_pct": 0.0, "ci95_pct": [0.0, 0.0], "reason": "ci_includes_zero"}],
  "scan_summary": {"members": {"eligible": 0, "tested": 0, "findings": 0},
                   "sectors": {"eligible": 0, "tested": 0, "findings": 0}},
  "descriptive": {"filing_delay_buckets": [{"bucket": "0-15", "n": 0, "trade_to_filing_excess_pct": 0.0}],
                  "size_buckets": [{"bucket": "<=15K", "n": 0, "mean_excess_pct_90d": 0.0}]},
  "news_stance": {"status": "gated", "scored": 57, "needed": 200, "distinct_days": 12, "days_needed": 40},
  "caveats": [{"id": "amount_ranges", "text": "..."}]
}
```

Rules: every number in `summary` is formatted from fields in the same object. Percents are plain
numbers in percent units, rounded to 2 decimals. `member` is non-null only if open question 2 is
answered "yes" and the finding replicated. `findings` may be empty; the page then says so.

### 7.2 `strategies.json` (`pi/strategies/v1`)

```json
{
  "schema": "pi/strategies/v1",
  "method_version": "st-1",
  "generated": "2026-11-01T07:44:00Z",
  "data_asof": {"prices": "2026-10-29", "trades": "2026-10-30"},
  "label": "SIMULATED. Hypothetical backtests on past data. Not investment advice, not a recommendation, no trades are placed. Past results do not predict future results.",
  "benchmark": "SPY",
  "assumptions": {"entry": "next close after signal", "cost_bps_per_side": {"stock": 25, "etf": 5},
                  "cash_return": "0 unless SHV held", "taxes": "none", "price_basis": "adj_close",
                  "filing_delay": "copy runs enter after the filing date", "common_window_start": "2021-01-01"},
  "strategies_tried": 6,
  "runs": [{
    "id": "copy-senate-buys", "name": "Copy Senate purchases (simulated)", "family": "copy",
    "rules": ["simulated"],
    "description": "template text",
    "params": {"chamber": "senate", "hold_days": 90, "weighting": "equal_active"},
    "period": {"start": "2021-03-02", "end": "2026-10-29"},
    "metrics": {"full": {"cagr_pct": 0.0, "vol_pct": 0.0, "max_dd_pct": 0.0, "sharpe": 0.0,
                         "turnover_x": 0.0, "avg_invested_pct": 0.0, "trades": 0},
                "common": {"cagr_pct": 0.0, "vol_pct": 0.0, "max_dd_pct": 0.0, "sharpe": 0.0}},
    "benchmark_metrics": {"full": {"cagr_pct": 0.0, "vol_pct": 0.0, "max_dd_pct": 0.0, "sharpe": 0.0},
                          "common": {"cagr_pct": 0.0, "vol_pct": 0.0, "max_dd_pct": 0.0, "sharpe": 0.0}},
    "relative": {"excess_cagr_pct": 0.0, "excess_cagr_ci95_pct": [0.0, 0.0], "beta": 0.0,
                 "alpha_ann_pct": 0.0, "info_ratio": 0.0},
    "sensitivity": {"cost_x2_cagr_pct": 0.0, "trade_date_hypothetical_cagr_pct": 0.0},
    "holdout": {"start": "2024-01-01", "excess_cagr_pct": 0.0, "same_sign": true},
    "evidence": "ahead|not_distinguishable|behind",
    "curve": {"dates": ["2021-03-31"], "strategy": [100.0], "benchmark": [100.0]},
    "caveats": ["survivorship", "costs", "filing_delay", "short_history", "price_basis"]
  }],
  "caveats": [{"id": "survivorship", "text": "..."}]
}
```

`curve` is month-end growth of 100 (derived index values, not raw prices). `holdout` is required
for S2 and filled for all runs where the period overlaps 2024.

### 7.3 Service routes (pi-insights, `X-PI-Internal: 1` required, else 404)

| Gateway path | Returns |
|---|---|
| `GET /api/insights` | `insights.json` content plus `served_asof` and `stale: bool` (older than 10 days) |
| `GET /api/insights/strategies` | `strategies.json` content plus the same fields |

Both are GET, no parameters, no user data. The service validates `schema` and size, strips unknown
top-level keys, and serves the last good copy for up to 48 h if Pages fails.

## 8. Frontend: Insights page

New page "Insights" next to Private in the page switcher.

- Header: the `label` text, `generated` date, data as-of dates. Stale banner when `stale`.
- **Findings** section: one card per finding in plain words from `summary`, the number line (mean excess with CI, events, months), the hold-out line, the placebo line, caveat chips. Empty state: "No result passed all tests this week. N tests were run." (honest, shown plainly).
- **What was tested** (collapsed): confirmatory table with status per row and scan counts for members and sectors.
- **Filing delay and size** (descriptive): two small bar charts from `descriptive`, labeled descriptive.
- **News stance**: progress bar toward the gate until it opens.
- **Strategies** tab: table of runs (period, CAGR, volatility, max drawdown, Sharpe, vs SPY, evidence tag) with a "Simulated" badge in every row, a common-window toggle, a growth-of-100 line chart per run (strategy vs SPY), and the assumptions block. Badge and label cannot be hidden.
- Neutral colors; no green or red buy/sell cues; evidence tags in words ("ahead of SPY, not statistically distinguishable").
- All text from the files rendered with `textContent`, never `innerHTML`. No share-card for strategies in v1.
- Accessibility: tables with headers, charts with a text summary, keyboard-reachable toggles. Light and dark styles.

## 9. Ask integration

- **Intent** `insights` added to `INTENT_TYPES` in `case.js`. Rules pre-pass in `intent.js` for clear phrases (backtest, "beat the S&P", "copy Congress", strategy names, "do senators", "filing delay"). The Groq intent prompt in pi-ai `/internal/intent` gets the new enum value; unmatched phrasing still works through the model.
- **Registry** `insights: {agents: [['insights', 1]]}`. Domain: Insights. Case state: `case.ext.insights` owned by agent key `insights` (`OWN_KEYS` gains `insights: ['ext.insights.items']`).
- **Data agent** `agents/data/insights.js`: calls `INSIGHTS /api/insights` and `/api/insights/strategies`, selects the findings or runs that match the question (by id or keyword, in code), and emits evidence items: `insight:<id>:mean_excess_pct`, `:ci_low`, `:ci_high`, `:n_events`, `:holdout_mean`, `strategy:<id>:cagr`, `:max_dd`, `:sharpe`, `:vol`, `benchmark:SPY:cagr`, `:excess_cagr`. Source "Portfolio Intel weekly analysis (BigQuery)", asof = `generated`. Also emits a text item for the label and one per caveat id used.
- **Fact checker.** F2 treats these keys as needed for the intent. F4 adds: insights data older than 10 days is `unknown` (shown as stale). F5 adds ranges: `-100 <= pct <= 1000`, `0 <= n`. Strategy facts carry `rules: ["simulated"]` (the Phase 2 extension rule); insight facts carry `rules: ["historical"]`.
- **Validator.** New **V13** (reserved earlier): any answer that cites a `simulated` fact must contain the word "simulated" and the phrase "not investment advice" (rendered by `render.js`, not by the model). New **V22**: any answer citing a `historical` fact must contain "past results do not predict future results". V4 (advice words), V5 (guarantees), V8 (order wording) apply unchanged; V4 gains the forward-looking phrases "will beat", "expected to outperform", "best strategy". The model writes `[[fN]]` placeholders only, as now.
- **Advice questions** ("should I copy Pelosi?", "which strategy should I buy?"): intent `insights` still, but the builder instruction and V4 produce the history-only answer: what the history shows, the label, and no recommendation. Questions asking for a personal plan route to the existing out-of-scope answer.
- **Budget.** Groq calls per case unchanged (2 normal, 3 with repair). pi-insights adds no Groq call. The data agent has the standard 6 s timeout.
- **Chat card.** `js/17-ask.js` shows the answer plus a small "Open Insights" link; no new card type.

## 10. Files per engineer

### Server (analytics, runner, gateway agents)

| Path | Change |
|---|---|
| `analytics/**` | New, as in section 3.1. |
| `.github/workflows/insights.yml` | New. Triggers: weekly cron, `workflow_dispatch`, push on `analytics/**` (dry run, no commit). `permissions: contents: write, id-token: write`. `concurrency: insights`. Steps: checkout, Python 3.12, `pip install` pinned `google-cloud-bigquery pandas numpy scipy pyarrow pytest`, pytest, WIF auth, run, lint, artifact, commit on main only. `timeout-minutes: 30`. |
| `scripts/history_load.py` | `adj_close` column and `ALTER TABLE`, strip it for Supabase, always-load benchmark tickers, `adjclose` parsing in `fetch_prices`. |
| `insights.json`, `strategies.json` | Generated by the job (not hand written). Initial placeholder with `findings: []` so the page and service work before the first run. |
| `worker/src/agents/case.js` | `insights` intent, `OWN_KEYS`, `ext.insights.*` paths. |
| `worker/src/agents/intent.js` | Rules for `insights`. |
| `worker/src/agents/registry.js` | `insights` entry and needed keys. |
| `worker/src/agents/data/insights.js` | New (section 9). |
| `worker/src/agents/factcheck.js` | F4 and F5 additions. |
| `worker/src/agents/validator.js` | V13, V22, V4 phrase additions. Imports nothing from builder. |
| `worker/src/agents/render.js` | Fixed label text for simulated and historical facts. |
| `worker/src/agents/supervisor.js` | Route `insights` through data agent, fact checker, builder, validator (standard path). |

### Microservices (route and deploy)

| Path | Change |
|---|---|
| `worker/src/services/insights.js`, `worker/src/modules/insights.js` | New, modeled on `private.js`: fixed `INSIGHTS_DATA_URL` Pages var (never from input), `redirect: 'error'`, content-type check, 5 MB streamed cap, schema check, 1 h cache, last good copy 48 h, 502 on failure. |
| `worker/config/insights.toml` | New. `name = "pi-insights"`, `workers_dev = false`, `preview_urls = false`, vars `SERVICE`, `INSIGHTS_DATA_URL`. |
| `worker/wrangler.toml` | `{ binding = "INSIGHTS", service = "pi-insights" }`. |
| `worker/src/routes.js` | `[/^\/api\/insights(\/strategies)?$/, 'insights', 'INSIGHTS']`. |
| `.github/workflows/deploy-worker.yml` | Add `insights` to `SERVICES`. No secrets needed. |
| `render` backend (`backend/main.py`) | `GET /api/insights*` returns `503 {"error":"Insights unavailable"}` (fallback has no analytics). |

### Frontend

| Path | Change |
|---|---|
| `js/29e-insights.js` | New. Load via gateway, static fallback; render findings, tested table, descriptive charts, strategies table and curves; `textContent` only. |
| `js/29b-pages.js` | Register the Insights page. |
| `js/17-ask.js` | "Open Insights" link on `insights` answers. |
| `index.html` | Script tag, page markup, styles (light and dark), `Simulated` badge style. CSP unchanged (same origin and API origin). |

### Shared (qa, appsec, compliance, architect; not builders)

`analytics/tests/**` (qa owns the synthetic generator and asserts), `worker/test/phase4.mjs`,
`tests/journeys/insights.mjs`, `docs/ARCHITECTURE.md` (add pi-insights, `insights.yml`, new
intent and data agent, V13 and V22, the extension-point text for Insights, BigQuery `adj_close`),
`docs/compliance/CONTROLS.md`, `RISK_REGISTER.md`, `EVIDENCE.md`.

### PR slicing (each independently revertible)

1. **PR 1 data foundation:** `history_load.py` changes, then owner runs the `--prices max` backfill.
2. **PR 2 engine:** `analytics/**`, `insights.yml`, first published files. No app change.
3. **PR 3 surface:** pi-insights, gateway route, Insights page, Ask integration, V13/V22, ARCHITECTURE.md.

## 11. QA, AppSec and compliance

### 11.1 QA tests

Python (`analytics/tests`, run in CI before the job and on PRs) uses an in-memory synthetic world:
random-walk prices for 300 tickers plus SPY, synthetic trades with filing delays and amount ranges.
No BigQuery.

| # | Test | Pass condition |
|---|---|---|
| T1 | Known effect, headline: inject +4 pt 90d excess into Senate purchases only (about 1,500 events, 5 years) | A1 reports a Senate 90d finding, CI contains 4 within tolerance, House has none |
| T2 | Known effect, one member: inject +6 pt for one of 40 members (60 events) | A4 finds that member after shrinkage and hold-out; the other 39 are not found |
| T3 | Known effect, sector and size slope | A5 finds the injected sector; A6 detects the injected slope |
| T4 | Known effect on the strategy side: a prices world where the top-momentum sector persists | S3 `ahead` tag, positive excess CI |
| T5 | **Null world:** same shapes, no effect, 200 seeds | Share of seeds with any confirmatory finding at most 10 percent (FDR target); a fixed set of 20 seeds has zero findings; exploratory findings need hold-out and also show zero in the fixed set |
| T6 | Hold-out guard: effect only before 2024 | Status `unstable`, no finding |
| T7 | Minimum sample guard: a member with 29 events and a huge effect | `insufficient_data`, not counted in `tests_run` |
| T8 | Multiple-testing: 200 members, none with an effect | `scan_summary.members.findings` is 0 in the fixed seeds |
| T9 | Placebo: universe that drifts above SPY for every stock, purchases have no extra effect | A1 does not report a finding |
| T10 | Delay: effect that exists only between trade and filing | Filing-entry A1 shows none; trade-date comparison shows it labeled not achievable |
| T11 | Backtest known answers: constant-growth series, zero costs gives exact CAGR; hand-built drawdown gives exact max drawdown; costs reduce return by exactly the traded notional times bps; Sharpe on flat returns is undefined and handled |
| T12 | No lookahead: altering any price after day t does not change the position decided at t; entry is always the next close after the filing |
| T13 | Contracts: both outputs validate against `schema/*.json`; every `summary` number equals its field; labels present; no forbidden advice phrases; no em or en dashes; lint failure blocks the write |
| T14 | Budget guard: a query whose dry run exceeds the limit aborts before running |
| T15 | Determinism: same inputs and seed give byte-identical JSON apart from `generated` |

Worker (`worker/test/phase4.mjs`): pi-insights serves only the fixed URL, rejects redirects,
oversize bodies and wrong content type, serves last good copy, 404 without `X-PI-Internal`; gateway
route and origin check; intent rules route the example questions to `insights`; data agent maps to
facts with `rules`; stale data becomes unknown; V13 and V22 fire when labels are missing and pass
when `render.js` adds them; an advice question yields a history-only answer; prompt-injection text
inside a finding title is treated as data. Journey (`tests/journeys/insights.mjs`): page loads,
empty-findings state, badge always visible, strategies table, Ask question shows the label.

### 11.2 AppSec notes (ASVS)

- **Advice guardrail.** Three layers: template language in the job, `lint.py` block on publish, and V4/V13/V22 at Ask time. No imperative or forward-looking wording; no buy/sell colors. Member-level wording is neutral and carries `no_wrongdoing`.
- **Workflow.** Least privilege: `contents: write` only to commit two files, `id-token: write` for WIF. Actions pinned as in existing workflows. The WIF provider already restricts to this repository. Preferred (not required): impersonate a service account with BigQuery read-only plus job user for this workflow. No secret is printed; logs contain counts and bytes only.
- **SQL.** Parameterized queries only (`@param`, `UNNEST(@tickers)`); no string-built SQL from data. `maximum_bytes_billed` set on every job.
- **Supply chain.** Pinned Python dependencies with hashes if practical; Dependabot already covers.
- **Service.** Same SSRF controls as C-32 (fixed URL, no redirects, size cap, content type, schema check). Files contain public derived aggregates only.
- **Rendering.** Text from JSON is data: `textContent`, no HTML, no links taken from the file.
- **Integrity.** `code_version`, `data_asof`, deterministic seed, and `coverage` allow reproduction.

### 11.3 Compliance notes

- New controls: advice guardrail for Insights and strategies (V13, V22, lint), weekly job least-privilege, pi-insights fetch guard, BigQuery spend guard. Evidence: PR, pytest output, one dry-run artifact, scan results.
- **Data licensing.** The Senate source is already a known risk (R-06, scraped efdsearch). Publishing derived statistics extends exposure to that source. Mitigation: publish aggregates and statistics, never raw rows; `data_license` caveat on the page; member names only per open question 2. Add a risk entry for republishing derived results and Yahoo-derived index curves (monthly growth-of-100 only, no price series). Owner may want legal review of the source terms before the Insights page goes live.
- **Hypothetical performance.** Not a registered adviser, but the disclosure practice follows the usual rules for hypothetical results: net of stated costs, period and benchmark stated, limitations beside the numbers, all strategies tried disclosed, no cherry-picking.
- Update `RISK_REGISTER.md` (risks in section 13) and ROADMAP status.

## 12. Budget (BigQuery free tier: 1 TB scan a month, 10 GB storage, 30 GiB/day cap)

Estimated `prices` row about 20 bytes over the three columns read (ticker, d, adj_close/close),
so one full scan about 55 to 80 MB. A table referenced N times in a query is billed N times.

| Query | Scans of prices | Approx bytes |
|---|---|---|
| 00_coverage | 1 | 80 MB |
| 10_events (3 horizons: entry, 3 exits, SPY legs) | 6 | 480 MB |
| 20_news (price_ref, +1, +5, +20, SPY) | 5 | 400 MB |
| 30_panel | 1 | 80 MB |
| trades, news_verdicts reads | n/a | under 10 MB |
| **Total per run** | | **about 1.1 GB** |

- Monthly: about 4.4 runs gives about 5 GB, which is about 0.5 percent of 1 TB. Daily peak is far under the 30 GiB cap.
- Runner guards: dry run each query first; per-query `maximum_bytes_billed` 2 GB; run total hard stop 5 GB; on breach no publish and a failed run that SOC monitor already sees.
- Storage: no new BigQuery tables in v1. Prices gains one FLOAT64 column (about 21 MB more). Repo growth: `insights.json` under 400 KB, `strategies.json` under 200 KB (monthly curves), about 30 MB a year of git history worst case.
- Other: Actions about 10 minutes weekly (about 45 minutes a month; if the repo is private, within the 2,000 free minutes). pi-insights adds a few requests a day on the Workers free plan. One Pages build a week. Groq: zero. **No new cost.** If `--prices max` makes `prices` grow past the 9 GB write guard, the existing guard in `history_load.py` stops writes; at 2,555 tickers this is far from the limit.

## 13. Risks and rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| Users read history as advice | Labels, templates, lint, V4/V13/V22, neutral colors, no member ranking list | Hide the Insights page with a front-end flag; disable the data agent in `registry.js` |
| False findings from many looks | FDR control, hold-out, placebo, minimum samples, tests_run disclosed, null-world tests | Raise thresholds in `config.py` and bump `method_version` |
| Low power: nothing ever passes | Honest empty state; progress for news gate; longer history after backfill | None needed |
| Survivorship and universe bias flatter copy strategies | Caveats beside numbers, placebo, ETF-based strategies as clean baselines | None needed |
| Yahoo `adjclose` gaps or splits wrong | Coverage preflight; price basis published; failing preflight blocks publish | Fall back to `close` and flag |
| Source license or defamation concern on member-level results | Aggregates by default, neutral wording, replicated only | Remove member findings (config switch) |
| Schema change breaks daily load | Strip `adj_close` for Supabase; PR 1 tested with a dry run | Revert PR 1; column is nullable and harmless |
| Bot commits to `main` by the job | Same precedent as private-markets; only the two JSON files; paths fixed in the workflow | Disable workflow; delete files |
| Bytes overrun | Dry-run guard, caps | Disable cron |
| Stale files served | `stale` flag after 10 days, F4 turns facts unknown | None needed |

Overall rollback: revert the PRs (3 then 2 then 1). The `adj_close` column and the extra tickers are
additive and can stay.

## 14. Open questions for the owner

1. **Committees.** Add member-to-committee analysis in v1.1 using the public-domain `congress-legislators` committee data (a reference CSV in `analytics/ref/`, refreshed manually)? Recommendation: yes, as a follow-up PR after v1 runs cleanly. v1 does not include it.
2. **Naming members.** May published findings name individual members (only when a finding replicated on the hold-out, with the "no wrongdoing shown" line)? Recommendation: no names in v1, aggregates only (chamber, sector, size, delay). Member scan (A4) still runs and feeds S2 (members shown as "Member 1" to "Member 5", unnamed), but A4 results are published as counts. Say yes to turn names on later; it is a config switch.

## Owner decisions (2026-10-30)

1. Committee analysis: yes, as a follow-up after v1 runs cleanly, using public committee data.
2. Published findings use aggregates only. No individual members are named.

## Contract

This is what the weekly job actually writes (`scripts/analytics/run.py`), and what the Insights page reads.
It follows sections 7.1 and 7.2 with the differences listed here. The code lives in `scripts/analytics/`
(not `analytics/` as in section 3.1); `python3 -m unittest discover -s scripts/analytics/tests -t .` runs the tests.

Sources, both with identical shape:

- Gateway: `GET /api/insights` and `GET /api/insights/strategies`. The service adds two top-level keys, `served_asof` (ISO time) and `stale` (bool, older than 10 days). Render returns `503 {"error":"Insights unavailable"}`.
- Static fallback, same origin: `/insights.json` and `/strategies.json` (no `served_asof`, no `stale`; compute staleness from `generated`).

Rules for reading both files:

- All text fields (`label`, `title`, `summary`, `description`, `name`, caveat `text`) are rendered with `textContent`. They are plain sentences with no markup. Never build links from the files.
- All percent values are plain numbers in percent units, rounded to 2 decimals (`4.1` means 4.1 percent or 4.1 percentage points). `null` means not available: show a dash, never zero.
- `label` is always shown. In `strategies.json`, `label` and the word "Simulated" are not hideable.
- Empty arrays are valid (`findings: []`, `runs: []`). The files ship as empty placeholders until the first weekly run. Empty `findings` shows "No result passed all tests this week. N tests were run." where N is `tests_run.confirmatory + tests_run.exploratory`.

### insights.json (`pi/insights/v1`)

```
schema, method_version ("ds-1"), generated, code_version, label
data_asof: {trades, prices, news_verdicts}            // dates or null
params:    {fdr_q, split_date, primary_horizon_days, cost_bps_roundtrip, resamples, seed, price_basis}
coverage:  {trades_total, events_used, tickers_priced, dropped: {no_ticker, bad_dates, no_price, too_recent}}
tests_run: {confirmatory, exploratory}
findings[]: {
  id, analysis ("A1","A2","A3","A5","A6"), family ("confirmatory"|"exploratory"), title, summary,
  statistic: "mean_excess" | "mean_difference" | "slope_span",
  subject: {chamber|null, tx_type, member (always null), sector|null, bucket|null},
  horizon_days, entry ("filing_next_close"),
  n_events, n_months, n_tickers,
  mean_excess_pct,                 // the statistic in percentage points
  ci95_pct: [lo, hi],              // plain 95 percent interval
  ci_adj_pct: [lo, hi], ci_adj_level,   // interval at the family-adjusted level used for the decision
  net_mean_excess_pct,             // after the 50 bps round-trip cost
  p_adj,                           // Benjamini-Hochberg adjusted
  placebo_pct|null,                // A1 only: 95th percentile of random-pick cohort means
  holdout: {n_events, mean_excess_pct, p_one_sided, replicates (always true in a finding)},
  not_achievable_trade_date_pct|null,   // A1 and A2 only; label it "not achievable" if shown
  caveats[]                        // ids found in the top-level caveats list
}
tested[]: {id, analysis, horizon_days, status ("no_evidence"|"unstable"|"insufficient_data"|"finding"),
           n_events, mean_excess_pct|null, ci95_pct|null, reason}      // confirmatory family only
scan_summary: {members: {eligible, tested, findings}, sectors: {eligible, tested, findings}}   // counts only, no names
descriptive: {filing_delay_buckets: [{bucket, n, trade_to_filing_excess_pct|null}],
              size_buckets: [{bucket, n, mean_excess_pct_90d|null}]}     // label as descriptive; null when n < 100
news_stance: {status ("gated"|"open_not_analysed"), scored, needed, distinct_days, days_needed}   // show progress bar scored/needed
caveats[]: {id, text}
```

`statistic` tells the page how to word the number: `mean_excess` is the average return above SPY; `mean_difference` (A3, fast filers minus slow filers) is a difference of two averages; `slope_span` (A6) is the change in excess return from the smallest to the largest disclosed size range. `findings` is sorted by `id`.

### strategies.json (`pi/strategies/v1`)

```
schema, method_version ("st-1"), generated, label, benchmark ("SPY")
data_asof: {prices, trades}
assumptions: {entry, cost_bps_per_side: {stock, etf}, cash_return, taxes, price_basis, filing_delay, common_window_start}
strategies_tried (6)
runs[]: {                                   // nine runs
  id, name (ends with "(simulated)"), family ("copy"|"etf"), rules (["simulated"]), description (starts "Simulated."),
  params: {...},                            // free-form key/value, show as text
  period: {start, end},
  metrics: {full: {cagr_pct, vol_pct, max_dd_pct, sharpe|null, turnover_x, avg_invested_pct, trades},
            common: {cagr_pct, vol_pct, max_dd_pct, sharpe|null}},
  benchmark_metrics: {full: {cagr_pct, vol_pct, max_dd_pct, sharpe|null}, common: {...}},
  relative: {excess_cagr_pct, excess_cagr_ci95_pct: [lo, hi], beta|null, alpha_ann_pct|null, info_ratio|null},
  sensitivity: {cost_x2_cagr_pct, trade_date_hypothetical_cagr_pct|null},   // the second is "not achievable"; null for ETF runs
  holdout: {start, excess_cagr_pct, same_sign}|null,
  evidence: "ahead" | "behind" | "not_distinguishable",
  curve: {dates[], strategy[], benchmark[]},   // month-end growth of 100, equal lengths
  caveats[],
  reference_in_sample?: {cagr_pct, label}      // copy-top-members only: show with its label, "reference, not evidence"
}
caveats[]: {id, text}
```

Run ids: `copy-senate-buys`, `copy-house-buys`, `copy-top-members` (members are never named), `momentum-sectors`,
`dividend-basket`, `tbill-proxy`, `balanced-annual`, `balanced-never`, `balanced-band`.
Evidence wording for the page (words, no green or red): `ahead` is "ahead of SPY over this period and in the hold-out period",
`behind` is the mirror, `not_distinguishable` is "not statistically distinguishable from SPY".

### Ask integration facts (for reference)

Evidence keys the data agent emits: `insight:<id>:mean_excess_pct|ci_low|ci_high|n_events|holdout_mean` (rules `historical`),
`strategy:<id>:cagr|vol|max_dd|sharpe|benchmark_cagr|excess_cagr|evidence|period` (rules `simulated`), `insights:tests_run`,
`insights:findings_count`, `insights:label`, `strategy:label`, `caveat:<id>`. The benchmark keys are namespaced per run
(`strategy:<id>:benchmark_cagr`) because each run has its own dates, so one `benchmark:SPY:cagr` key would conflict across runs.

### Deviations from sections 5 and 6 decided while building (for architect and owner review)

1. Python lives in `scripts/analytics/`; prices and trades are joined in pandas (two BigQuery reads, about 100 MB), not in SQL, so every step is testable offline. Bytes per run are lower than the section 12 estimate.
2. Hold-out replication also requires the hold-out effect, net of cost, to reach half the practical floor. Without it, a pre-2024-only effect passed on a 0.5 point hold-out mean (test T6).
3. A7 (news stance vs returns) publishes the gate and progress only. The test itself is not built because the hold-out sample cannot exist yet. `news_stance.status` becomes `open_not_analysed` when the gate opens.
4. Null-world test: 100 seeds measured 0 confirmatory and 3 exploratory false findings (3 percent, within the 10 percent FDR target). The unit test runs 40 seeds by default (`PI_NULL_SEEDS=200` for the full set) and asserts zero confirmatory findings in the fixed seeds 100 to 119 and at most 10 percent of seeds with any finding. It does not assert zero exploratory findings in every fixed seed, because the method allows about 10 percent by design.
