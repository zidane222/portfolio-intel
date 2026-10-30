"""Known-answer and null-world tests for the data science analyses (plan T1 to T10). Resamples are
reduced for speed; thresholds and rules are the production ones."""
import os
import unittest
from functools import lru_cache

import pandas as pd

from scripts.analytics import analyses, config as C
from scripts.analytics.events import Market, build_events, clean_trades
from scripts.analytics.tests.synth import make_world

B = 2000


@lru_cache(maxsize=None)
def world(seed, key=(), **kw):
    w = make_world(seed, effects=dict(key), **kw)
    mkt = Market(w['wide'])
    ev, cov = build_events(w['trades'], mkt, w['sectors'])
    return w, mkt, ev, cov


@lru_cache(maxsize=None)
def result(seed, key=(), **kw):
    w, mkt, ev, cov = world(seed, key, **kw)
    return analyses.run_ds(ev, mkt, B)


def ids(r, status=None):
    return {f['id'] for f in r['findings']}


class KnownEffects(unittest.TestCase):
    def test_T1_senate_headline_found_house_not(self):
        r = result(11, (('senate', 4.0),))
        f = {x['id']: x for x in r['findings']}
        self.assertIn('a1-senate-purchases-90', f)
        x = f['a1-senate-purchases-90']
        self.assertTrue(x['ci95_pct'][0] < 4.0 < x['ci95_pct'][1] or abs(x['mean_excess_pct'] - 4.0) < 1.0, x)
        self.assertTrue(x['holdout']['replicates'])
        self.assertFalse([i for i in f if i.startswith('a1-house')])

    def test_T2_one_member_found_after_shrinkage_and_holdout(self):
        r = result(12, (('member', ('Zed Target', 6.0, 70)),))
        self.assertEqual(r['replicated_members'], ['Zed Target'])
        self.assertEqual(r['scan_summary']['members']['findings'], 1)
        # members are never named in the published pieces
        self.assertNotIn('Zed Target', str(r['findings']) + str(r['tested']) + str(r['scan_summary']))

    def test_T3_sector_and_size_slope(self):
        r = result(13, (('sector', ('Energy', 5.0)),))
        self.assertIn('a5-sector-energy-90', ids(r))
        others = [i for i in ids(r) if i.startswith('a5-') and i != 'a5-sector-energy-90']
        self.assertEqual(others, [])
        r2 = result(18, (('size_slope', 0.8),))
        self.assertIn('a6-size-slope-90', ids(r2))
        self.assertTrue(all(f['mean_excess_pct'] > 0 for f in r2['findings'] if f['id'].startswith('a6-')))

    def test_T6_effect_only_before_2024_is_unstable(self):
        r = result(14, (('pre2024_only', True), ('senate', 8.0)))
        st = {t['id']: t['status'] for t in r['tested']}
        self.assertIn('unstable', set(st.values()), st)
        self.assertFalse([i for i in ids(r) if i.startswith('a1-senate')])

    def test_T7_member_with_29_events_is_insufficient_not_counted(self):
        w, mkt, ev, cov = world(15, (('member', ('Small Big', 40.0, 29)),))
        specs = analyses.build_specs(ev, mkt, B)[1]
        mine = [s for s in specs if s['subject'].get('member') == 'Small Big']
        self.assertEqual(len(mine), 1)
        res = analyses.evaluate(mine, B)
        self.assertEqual(res[0]['status'], 'insufficient_data')
        r = result(15, (('member', ('Small Big', 40.0, 29)),))
        self.assertEqual(r['replicated_members'], [])
        full = analyses.evaluate(specs, B)
        self.assertEqual(sum(x['status'] != 'insufficient_data' for x in full), r['tests_run']['exploratory'])
        self.assertLess(r['tests_run']['exploratory'], len(specs))

    def test_T8_many_members_no_effect_zero_findings(self):
        for seed in (21, 22, 23):
            r = result(seed, (), n_members=80, n_senate=6000, n_house=6000)
            self.assertGreaterEqual(r['scan_summary']['members']['tested'], 60)
            self.assertEqual(r['scan_summary']['members']['findings'], 0, seed)

    def test_T9_universe_drift_is_not_a_purchase_finding(self):
        r = result(16, (('drift', 0.0004),))
        self.assertFalse([i for i in ids(r) if i.startswith('a1-')])
        reasons = {t['reason'] for t in r['tested'] if t['analysis'] == 'A1'}
        self.assertIn('placebo_not_exceeded', reasons)

    def test_T10_effect_between_trade_and_filing_is_not_a_filing_entry_finding(self):
        r = result(17, (('delay_only', 10.0),), n_stocks=1500)
        self.assertFalse([i for i in ids(r) if i.startswith('a1-senate')])
        w, mkt, ev, cov = world(17, (('delay_only', 10.0),), n_stocks=1500)
        s = ev[(ev.chamber == 'senate') & (ev.tx == 'purchase') & (ev.h == 90)]
        self.assertGreater(s['excess_td'].mean(), 3.0)       # visible when entering on the trade date
        self.assertLess(s['excess'].mean(), 2.0)             # not what a follower can get


class NullWorld(unittest.TestCase):
    def test_T5_null_worlds(self):
        n = int(os.environ.get('PI_NULL_SEEDS', '40'))
        with_conf = 0
        fixed_conf, share_any = [], 0
        for seed in range(100, 100 + n):
            w = make_world(seed, effects={}, n_stocks=300, n_senate=1200, n_house=1200, n_sales=600)
            mkt = Market(w['wide'])
            ev, _ = build_events(w['trades'], mkt, w['sectors'])
            r = analyses.run_ds(ev, mkt, 1000)
            conf = [f for f in r['findings'] if f['family'] == 'confirmatory']
            with_conf += bool(conf)
            share_any += bool(r['findings'])
            if seed < 120 and conf:
                fixed_conf.append((seed, [f['id'] for f in conf]))
        # confirmatory family: zero in the fixed 20 seeds. Any finding at all (exploratory included) stays within the 10 percent FDR target.
        self.assertEqual(fixed_conf, [])
        self.assertLessEqual(with_conf / n, 0.10)
        self.assertLessEqual(share_any / n, 0.10)


class Helpers(unittest.TestCase):
    def test_entry_is_next_trading_close_after_filing_and_counts_drops(self):
        w, mkt, ev, cov = world(11, (('senate', 4.0),))
        row = ev.iloc[0]
        self.assertGreater(mkt.days[int(row['ei'])], pd.Timestamp(row['filed']).to_datetime64())
        self.assertLessEqual(mkt.days[int(row['ei']) - 1], pd.Timestamp(row['filed']).to_datetime64())
        bad = w['trades'].head(3).copy()
        bad.loc[bad.index[0], 'ticker'] = 'bonds 2030'
        bad.loc[bad.index[1], 'filed'] = '2019-01-01'
        clean, dropped = clean_trades(bad)
        self.assertEqual(dropped['no_ticker'], 1)
        self.assertEqual(dropped['bad_dates'], 1)
        self.assertEqual(len(clean), 1)

    def test_news_gate_shows_progress_below_threshold(self):
        v = pd.DataFrame({'run_date': ['2026-10-01'] * 3, 'ticker': ['A', 'B', 'C'], 'stance': ['positive', 'negative', 'neutral'], 'status': ['PASS'] * 3})
        g = analyses.news_gate(v)
        self.assertEqual((g['status'], g['scored'], g['needed']), ('gated', 2, 200))
        self.assertEqual(analyses.news_gate(None)['scored'], 0)


if __name__ == '__main__':
    unittest.main()
