"""Weekly runner: BigQuery to two JSON files. Run from the repo root:
    python3 -m scripts.analytics.run --out out            (needs BigQuery credentials)
    python3 -m scripts.analytics.run --synthetic --out out (offline smoke run on made-up data)
    python3 -m scripts.analytics.run --placeholder --out .  (writes the empty starter files)
Never logs rows, only counts and bytes. No Groq, no network except BigQuery."""
import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from . import analyses, config as C, lint as L, narrate
from .events import Market, build_events, clean_trades
from .strategies import Ctx, run_all

ROOT = Path(__file__).resolve().parents[2]
SQL_DIR = Path(__file__).parent / 'sql'


class Preflight(Exception):
    pass


class BudgetExceeded(Exception):
    pass


# ---------------------------------------------------------------- BigQuery with a spend guard
def default_config(dry_run, max_bytes, params):
    from google.cloud import bigquery
    qp = [bigquery.ScalarQueryParameter(k, t, v) for k, (t, v) in params.items()]
    cfg = bigquery.QueryJobConfig(query_parameters=qp, dry_run=dry_run, use_query_cache=not dry_run)
    if not dry_run:  # setting it to None sends the string "None", which BigQuery rejects
        cfg.maximum_bytes_billed = int(max_bytes)
    return cfg


class BQ:
    """Dry-runs every query first and refuses to run one that would exceed the per-query or per-run budget."""

    def __init__(self, client, cfg_factory=default_config, max_query=C.MAX_BYTES_PER_QUERY, max_run=C.MAX_BYTES_PER_RUN):
        self.client, self.cfg, self.max_query, self.max_run, self.spent = client, cfg_factory, max_query, max_run, 0

    def frame(self, name, params=None):
        params = params or {}
        sql = (SQL_DIR / name).read_text()
        est = int(self.client.query(sql, job_config=self.cfg(True, None, params)).total_bytes_processed)
        if est > self.max_query or self.spent + est > self.max_run:
            raise BudgetExceeded(f'{name}: {est} bytes would exceed the budget')
        self.spent += est
        df = self.client.query(sql, job_config=self.cfg(False, self.max_query, params)).result().to_dataframe()
        print(f'query {name}: rows={len(df)} bytes_est={est}')
        return df


# ---------------------------------------------------------------- prices
def to_wide(prices):
    """prices: ticker, d, close, adj_close. Chooses adjusted close per ticker when it is at least 95 percent filled,
    otherwise close. Returns (wide frame, price_basis)."""
    p = prices.copy()
    p['d'] = pd.to_datetime(p['d'])
    cov = p.groupby('ticker')['adj_close'].apply(lambda s: s.notna().mean())
    use_adj = set(cov[cov >= C.MIN_TICKER_COVERAGE].index)
    p['px'] = np.where(p['ticker'].isin(use_adj), p['adj_close'], p['close'])
    basis = 'adj_close' if 'SPY' in use_adj else 'close'
    return p.pivot_table(index='d', columns='ticker', values='px', aggfunc='last').sort_index(), basis


def preflight(wide, today):
    missing = [t for t in C.REQUIRED_TICKERS if t not in wide.columns]
    if missing:
        raise Preflight(f'required tickers missing: {missing}')
    spy_days = wide['SPY'].dropna().index
    if (today - spy_days[-1].date()).days > C.MAX_SPY_AGE_DAYS:
        raise Preflight('SPY prices are stale')
    for t in C.REQUIRED_TICKERS:
        s = wide[t].dropna()
        days = spy_days[spy_days >= s.index[0]]
        if len(days) and len(s.reindex(days).dropna()) / len(days) < C.MIN_TICKER_COVERAGE:
            raise Preflight(f'{t} has under {int(C.MIN_TICKER_COVERAGE * 100)} percent of trading days')


# ---------------------------------------------------------------- outputs
def build_outputs(trades, wide, price_basis, verdicts=None, b=C.RESAMPLES, code_version='dev', generated=None, sectors=None):
    """Pure function: frames in, two documents out. No network."""
    sectors = sectors if sectors is not None else load_sectors()
    mkt = Market(wide)
    ev, cov = build_events(trades, mkt, sectors)
    ds = analyses.run_ds(ev, mkt, b, verdicts)
    ctx = Ctx(wide, price_basis)
    runs = run_all(ctx, trades, ev, b)
    for f in ds['findings']:
        f['summary'] = narrate.finding_summary(f)
    for r in runs:
        r['description'] = narrate.run_description(r)
    tc, _ = clean_trades(trades)
    asof_prices = str(pd.Timestamp(mkt.days[-1]).date())
    asof_trades = str(tc['filed'].max().date()) if len(tc) else None
    news_asof = None
    if verdicts is not None and len(verdicts):
        news_asof = str(pd.to_datetime(verdicts['run_date']).max().date())
    generated = generated or dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    used = sorted({c for f in ds['findings'] for c in f['caveats']} | {c for r in runs for c in r['caveats']}
                  | {'amount_ranges', 'filing_delay', 'missing_tickers', 'survivorship', 'universe_bias', 'short_history', 'price_basis', 'owner_unknown', 'no_wrongdoing', 'costs', 'data_license'})
    cav = [{'id': c, 'text': C.CAVEATS[c]} for c in used]
    insights = {
        'schema': 'pi/insights/v1', 'method_version': C.METHOD_VERSION_DS, 'generated': generated, 'code_version': code_version,
        'data_asof': {'trades': asof_trades, 'prices': asof_prices, 'news_verdicts': news_asof}, 'label': C.LABEL_INSIGHTS,
        'params': {'fdr_q': C.FDR_Q, 'split_date': C.SPLIT_DATE, 'primary_horizon_days': C.PRIMARY_HORIZON, 'cost_bps_roundtrip': C.COST_BPS_ROUNDTRIP,
                   'resamples': b, 'seed': C.SEED, 'price_basis': price_basis},
        'coverage': cov, 'tests_run': ds['tests_run'], 'findings': sorted(ds['findings'], key=lambda f: f['id']),
        'tested': ds['tested'], 'scan_summary': ds['scan_summary'], 'descriptive': ds['descriptive'], 'news_stance': ds['news_stance'], 'caveats': cav}
    strategies = {
        'schema': 'pi/strategies/v1', 'method_version': C.METHOD_VERSION_ST, 'generated': generated,
        'data_asof': {'prices': asof_prices, 'trades': asof_trades}, 'label': C.LABEL_STRATEGIES, 'benchmark': 'SPY',
        'assumptions': {'entry': 'next close after signal', 'cost_bps_per_side': {'stock': C.COST_BPS_STOCK, 'etf': C.COST_BPS_ETF},
                        'cash_return': '0 unless SHV held', 'taxes': 'none', 'price_basis': price_basis,
                        'filing_delay': 'copy runs enter after the filing date', 'common_window_start': C.COMMON_WINDOW_START},
        'strategies_tried': 6, 'runs': runs, 'caveats': cav}
    return insights, strategies


def placeholder_docs(generated='1970-01-01T00:00:00Z'):
    cav = [{'id': k, 'text': v} for k, v in sorted(C.CAVEATS.items())]
    ins = {'schema': 'pi/insights/v1', 'method_version': C.METHOD_VERSION_DS, 'generated': generated, 'code_version': 'placeholder',
           'data_asof': {'trades': None, 'prices': None, 'news_verdicts': None}, 'label': C.LABEL_INSIGHTS,
           'params': {'fdr_q': C.FDR_Q, 'split_date': C.SPLIT_DATE, 'primary_horizon_days': C.PRIMARY_HORIZON, 'cost_bps_roundtrip': C.COST_BPS_ROUNDTRIP,
                      'resamples': C.RESAMPLES, 'seed': C.SEED, 'price_basis': 'close'},
           'coverage': {'trades_total': 0, 'events_used': 0, 'tickers_priced': 0, 'dropped': {'no_ticker': 0, 'bad_dates': 0, 'no_price': 0, 'too_recent': 0}},
           'tests_run': {'confirmatory': 0, 'exploratory': 0}, 'findings': [], 'tested': [],
           'scan_summary': {'members': {'eligible': 0, 'tested': 0, 'findings': 0}, 'sectors': {'eligible': 0, 'tested': 0, 'findings': 0}},
           'descriptive': {'filing_delay_buckets': [], 'size_buckets': []},
           'news_stance': {'status': 'gated', 'scored': 0, 'needed': C.NEWS_MIN_SCORED, 'distinct_days': 0, 'days_needed': C.NEWS_MIN_DAYS}, 'caveats': cav}
    st = {'schema': 'pi/strategies/v1', 'method_version': C.METHOD_VERSION_ST, 'generated': generated, 'data_asof': {'prices': None, 'trades': None},
          'label': C.LABEL_STRATEGIES, 'benchmark': 'SPY',
          'assumptions': {'entry': 'next close after signal', 'cost_bps_per_side': {'stock': C.COST_BPS_STOCK, 'etf': C.COST_BPS_ETF},
                          'cash_return': '0 unless SHV held', 'taxes': 'none', 'price_basis': 'close',
                          'filing_delay': 'copy runs enter after the filing date', 'common_window_start': C.COMMON_WINDOW_START},
          'strategies_tried': 6, 'runs': [], 'caveats': cav}
    return ins, st


def load_sectors():
    try:
        return json.loads((ROOT / 'sectors.json').read_text())
    except OSError:
        return {}


def dumps(doc):
    return json.dumps(doc, allow_nan=False, separators=(',', ':'), ensure_ascii=True)


def write_docs(insights, strategies, out):
    problems = L.lint(insights, strategies)
    if problems:
        raise SystemExit('lint failed, nothing written:\n' + '\n'.join(problems))
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    (out / 'insights.json').write_text(dumps(insights) + '\n')
    (out / 'strategies.json').write_text(dumps(strategies) + '\n')


def fetch(project):
    from google.cloud import bigquery
    bq = BQ(bigquery.Client(project=project))
    trades = bq.frame('10_trades.sql')
    prices = bq.frame('20_prices.sql', {'start': ('DATE', dt.date(2020, 1, 1))})
    try:
        verdicts = bq.frame('30_news.sql')
    except BudgetExceeded:
        raise
    except Exception:
        verdicts = None  # table not archived yet: the news gate shows zero progress
    return trades, prices, verdicts


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='out')
    ap.add_argument('--synthetic', action='store_true')
    ap.add_argument('--placeholder', action='store_true')
    ap.add_argument('--resamples', type=int, default=C.RESAMPLES)
    a = ap.parse_args(argv)
    if a.placeholder:
        write_docs(*placeholder_docs(), a.out)
        return 0
    if a.synthetic:
        from .tests.synth import make_world
        w = make_world()
        trades, wide, basis, verdicts = w['trades'], w['wide'], 'adj_close', None
    else:
        trades, prices, verdicts = fetch(os.environ.get('BQ_PROJECT') or C.PROJECT)
        wide, basis = to_wide(prices)
        preflight(wide, dt.datetime.now(dt.timezone.utc).date())
    ins, st = build_outputs(trades, wide, basis, verdicts, a.resamples, os.environ.get('GITHUB_SHA', 'dev')[:12])
    write_docs(ins, st, a.out)
    print(f"findings={len(ins['findings'])} tests={ins['tests_run']} runs={len(st['runs'])}")
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:  # one line for the Actions summary: type and message only, never rows
        print(f"::error::Insights run failed: {type(e).__name__}: {str(e)[:400]}")
        raise
