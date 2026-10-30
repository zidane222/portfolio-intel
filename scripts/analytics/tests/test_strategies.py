"""Backtest known answers, no lookahead, strategy runs (plan T4, T11, T12)."""
import math
import unittest
from functools import lru_cache

import numpy as np
import pandas as pd

from scripts.analytics import config as C, strategies as ST
from scripts.analytics.events import clean_trades
from scripts.analytics.tests.synth import make_world


def buy_hold(R, bps=0.0):
    k = R.shape[1]
    tgt = np.full(k, 1.0 / k)
    return ST.simulate(R, lambda i, g: tgt if i == 0 else g, np.full(k, bps), 0)


class KnownAnswers(unittest.TestCase):
    def test_constant_growth_gives_exact_cagr(self):
        R = np.full((505, 1), 0.0004)
        sim = buy_hold(R)
        r = sim['ret']
        self.assertEqual(r[0], 0.0)
        exact = (1.0004 ** (len(r) - 1)) ** (252 / len(r)) - 1
        self.assertAlmostEqual(ST.cagr(r), exact, places=12)
        self.assertAlmostEqual(ST.metrics(r)['cagr_pct'], round(exact * 100, 2))

    def test_hand_built_drawdown(self):
        m = ST.metrics([0.10, -0.20, 0.05])
        self.assertEqual(m['max_dd_pct'], -20.0)
        m2 = ST.metrics([-0.10, 0.02, 0.02])      # drawdown from the starting value counts
        self.assertEqual(m2['max_dd_pct'], -10.0)

    def test_costs_equal_traded_notional_times_bps(self):
        R = np.zeros((6, 2))
        w = {0: np.array([1.0, 0.0]), 3: np.array([0.0, 1.0])}
        sim = ST.simulate(R, lambda i, g: w.get(i, g), np.array([25.0, 25.0]), 0)
        self.assertAlmostEqual(sim['ret'][0], -0.0025)          # buy 100 percent
        self.assertAlmostEqual(sim['ret'][3], -0.0050)          # sell 100 and buy 100: 2.0 of notional
        self.assertAlmostEqual(sim['turnover'], 3.0)
        self.assertEqual(sim['trades'], 3)

    def test_sharpe_on_flat_returns_is_undefined_not_an_error(self):
        self.assertIsNone(ST.metrics([0.001] * 50)['sharpe'])

    def test_evidence_tag_needs_interval_and_holdout(self):
        self.assertEqual(ST.evidence_tag([1.0, 3.0], 2.0), 'ahead')
        self.assertEqual(ST.evidence_tag([1.0, 3.0], -0.5), 'not_distinguishable')
        self.assertEqual(ST.evidence_tag([-1.0, 3.0], 2.0), 'not_distinguishable')
        self.assertEqual(ST.evidence_tag([-3.0, -1.0], -2.0), 'behind')
        self.assertEqual(ST.evidence_tag([1.0, 3.0], None), 'not_distinguishable')

    def test_bootstrap_interval_contains_true_difference(self):
        rng = np.random.default_rng(0)
        rb = rng.normal(0.0004, 0.01, 1000)
        rs = rb + 0.0004 + rng.normal(0, 0.002, 1000)
        lo, hi = ST.bootstrap_excess_cagr(rs, rb, 1000, 42)
        true = (ST.cagr(rs) - ST.cagr(rb)) * 100
        self.assertTrue(lo < true < hi)
        self.assertGreater(lo, 0)


@lru_cache(maxsize=None)
def ctx_for(seed=3, key=()):
    w = make_world(seed, effects=dict(key), n_stocks=200, n_senate=600, n_house=600, n_sales=100)
    return w, ST.Ctx(w['wide'])


class NoLookahead(unittest.TestCase):
    def test_entry_is_next_close_after_filing_and_nothing_before(self):
        w, ctx = ctx_for()
        tr = w['trades']
        one = tr[(tr.chamber == 'senate') & (tr.tx_type == 'Purchase')].head(1)
        tc, _ = clean_trades(one)
        tk, U, first = ST.copy_signals(ctx, tc, chamber='senate')
        filed = tc['filed'].iloc[0].to_datetime64()
        self.assertGreater(ctx.mkt.days[first], filed)
        self.assertLessEqual(ctx.mkt.days[first - 1], filed)
        run = ST.copy_runner(ctx, tk, U, first)
        sim = run(1.0)
        col = ctx.cols[tk[0]]
        self.assertAlmostEqual(sim['ret'][0], -C.COST_BPS_STOCK / 1e4)          # bought at that close, pays cost
        self.assertAlmostEqual(sim['ret'][1], ctx.R[first + 1, col] - 0.0, places=12)  # first return is the day after

    def test_changing_later_prices_does_not_change_earlier_results(self):
        w, ctx = ctx_for()
        tc, _ = clean_trades(w['trades'])
        tk, U, first = ST.copy_signals(ctx, tc, chamber='house')
        base = ST.copy_runner(ctx, tk, U, first)(1.0)['ret']
        cut = first + 400
        R2 = ctx.R.copy()
        R2[cut + 1:] = np.random.default_rng(9).normal(0, 0.05, R2[cut + 1:].shape)
        ctx2 = ST.Ctx(w['wide'])
        ctx2.R = R2
        alt = ST.copy_runner(ctx2, tk, U, first)(1.0)['ret']
        self.assertTrue(np.allclose(base[:400], alt[:400]))       # days up to the cut are untouched
        self.assertFalse(np.allclose(base[401:], alt[401:]))

    def test_momentum_signal_uses_only_past_prices(self):
        w, ctx = ctx_for()
        run, start = ST.momentum_runner(ctx)
        base = run(1.0)['ret']
        R2 = ctx.R.copy()
        cut = start + 300
        R2[cut + 1:] = np.random.default_rng(1).normal(0, 0.05, R2[cut + 1:].shape)
        w2 = w['wide'].copy()
        ctx2 = ST.Ctx(w2)
        ctx2.R = R2
        px = ctx.px.copy()
        px.iloc[cut + 1:] = px.iloc[cut + 1:] * np.random.default_rng(2).uniform(0.5, 1.5, px.iloc[cut + 1:].shape)
        ctx2.px = px
        alt = ST.momentum_runner(ctx2)[0](1.0)['ret']
        self.assertTrue(np.allclose(base[:300], alt[:300]))


class Runs(unittest.TestCase):
    def test_T4_persistent_sector_gives_ahead_tag(self):
        w, ctx = ctx_for(4, (('persistent', 'XLK'),))
        runs = ST.run_all(ctx, w['trades'], pd.DataFrame(columns=['member']), b=600, ranking=[])
        mom = next(r for r in runs if r['id'] == 'momentum-sectors')
        self.assertEqual(mom['evidence'], 'ahead')
        self.assertGreater(mom['relative']['excess_cagr_ci95_pct'][0], 0)
        self.assertTrue(mom['holdout']['same_sign'])

    def test_all_runs_present_labeled_and_consistent(self):
        w, ctx = ctx_for(5)
        from scripts.analytics.analyses import member_ranking
        from scripts.analytics.events import build_events
        ev, _ = build_events(w['trades'], ctx.mkt, w['sectors'])
        runs = ST.run_all(ctx, w['trades'], ev, b=300)
        ids = [r['id'] for r in runs]
        self.assertEqual(sorted(ids), sorted(['copy-senate-buys', 'copy-house-buys', 'copy-top-members', 'momentum-sectors', 'dividend-basket',
                                              'tbill-proxy', 'balanced-annual', 'balanced-never', 'balanced-band']))
        for r in runs:
            self.assertEqual(r['rules'], ['simulated'])
            self.assertIn(r['evidence'], ('ahead', 'behind', 'not_distinguishable'))
            self.assertLessEqual(r['sensitivity']['cost_x2_cagr_pct'], r['metrics']['full']['cagr_pct'] + 1e-9)
            c = r['curve']
            self.assertEqual(c['strategy'][0] > 0, True)
            self.assertEqual(len(c['dates']), len(c['benchmark']))
        top = next(r for r in runs if r['id'] == 'copy-top-members')
        self.assertGreaterEqual(top['period']['start'], C.SPLIT_DATE)       # tested on the hold-out only
        self.assertIn('not evidence', top['reference_in_sample']['label'])
        never = next(r for r in runs if r['id'] == 'balanced-never')
        annual = next(r for r in runs if r['id'] == 'balanced-annual')
        self.assertLess(never['metrics']['full']['turnover_x'], annual['metrics']['full']['turnover_x'])
        tb = next(r for r in runs if r['id'] == 'tbill-proxy')
        self.assertLess(abs(tb['metrics']['full']['vol_pct']), 2.0)
        self.assertIsNotNone(next(r for r in runs if r['id'] == 'copy-senate-buys')['sensitivity']['trade_date_hypothetical_cagr_pct'])


if __name__ == '__main__':
    unittest.main()
