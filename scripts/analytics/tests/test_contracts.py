"""Output contracts, lint gate, budget guard, determinism (plan T13 to T15)."""
import copy
import json
import re
import tempfile
import unittest
from functools import lru_cache
from pathlib import Path
from unittest import mock

from scripts.analytics import config as C, lint as L, run as R
from scripts.analytics.tests.synth import make_world


@lru_cache(maxsize=None)
def docs():
    w = make_world(31, effects={'senate': 5.0}, n_stocks=300, n_senate=1200, n_house=1200, n_sales=300)
    return R.build_outputs(w['trades'], w['wide'], 'adj_close', None, b=500, code_version='test', generated='2026-11-01T07:41:00Z', sectors=w['sectors'])


class Contracts(unittest.TestCase):
    def test_T13_real_outputs_pass_lint_and_carry_labels(self):
        ins, st = docs()
        self.assertEqual(L.lint(ins, st), [])
        self.assertEqual(ins['label'], C.LABEL_INSIGHTS)
        self.assertEqual(st['label'], C.LABEL_STRATEGIES)
        self.assertTrue(ins['findings'])
        for r in st['runs']:
            self.assertEqual(r['rules'], ['simulated'])
            self.assertTrue(r['description'].startswith('Simulated.'))
            self.assertIn('(simulated)', r['name'])
        self.assertEqual(st['strategies_tried'], 6)
        for f in ins['findings']:
            self.assertIsNone(f['subject']['member'])
            self.assertTrue(f['holdout']['replicates'])
        blob = json.dumps(ins) + json.dumps(st)
        self.assertNotRegex(blob, '[\u2013\u2014]')

    def test_summary_numbers_come_from_fields(self):
        ins, st = docs()
        f = copy.deepcopy(ins['findings'][0])
        f['summary'] = f['summary'].replace(f"{abs(f['n_events'])} trades", '1234567 trades')
        self.assertTrue(L.number_problems(f['summary'], f))
        self.assertEqual(L.number_problems(ins['findings'][0]['summary'], ins['findings'][0]), [])

    def test_lint_blocks_bad_output(self):
        ins, st = docs()
        cases = []
        a = copy.deepcopy(ins); a['findings'][0]['summary'] += ' You should buy this.'; cases.append(a)
        b = copy.deepcopy(ins); b['findings'][0]['title'] = 'Senate \u2014 purchases'; cases.append(b)
        c = copy.deepcopy(ins); c['label'] = 'Historical analysis.'; cases.append(c)
        d = copy.deepcopy(ins); d['findings'][0]['mean_excess_pct'] = float('nan'); cases.append(d)
        e = copy.deepcopy(ins); e['findings'][0]['holdout']['replicates'] = False; cases.append(e)
        g = copy.deepcopy(ins); g['findings'][0]['summary'] += ' This will beat the market.'; cases.append(g)
        for doc in cases:
            self.assertTrue(L.lint(doc, st), doc['findings'][0]['summary'][-30:])
        s1 = copy.deepcopy(st); s1['runs'][0]['rules'] = []
        s2 = copy.deepcopy(st); s2['label'] = 'Backtests.'
        s3 = copy.deepcopy(st); s3['runs'][0]['description'] = 'Simulated. The best strategy ever.'
        for s in (s1, s2, s3):
            self.assertTrue(L.lint(ins, s))

    def test_lint_failure_writes_nothing(self):
        ins, st = docs()
        bad = copy.deepcopy(st)
        bad['label'] = 'x'
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(SystemExit):
                R.write_docs(ins, bad, d)
            self.assertEqual(list(Path(d).iterdir()), [])
            R.write_docs(ins, st, d)
            self.assertEqual(sorted(p.name for p in Path(d).iterdir()), ['insights.json', 'strategies.json'])
            self.assertLess((Path(d) / 'insights.json').stat().st_size, 400_000)
            self.assertLess((Path(d) / 'strategies.json').stat().st_size, 200_000)

    def test_placeholder_files_are_valid_and_empty(self):
        ins, st = R.placeholder_docs()
        self.assertEqual(L.lint(ins, st), [])
        self.assertEqual((ins['findings'], st['runs']), ([], []))

    def test_committed_placeholders_match_contract(self):
        root = Path(__file__).resolve().parents[3]
        for name, schema in (('insights.json', 'pi/insights/v1'), ('strategies.json', 'pi/strategies/v1')):
            p = root / name
            if p.exists():
                self.assertEqual(json.loads(p.read_text())['schema'], schema)

    def test_T15_deterministic(self):
        w = make_world(32, effects={'senate': 5.0}, n_stocks=200, n_senate=800, n_house=800, n_sales=200)
        args = (w['trades'], w['wide'], 'adj_close', None)
        kw = dict(b=300, code_version='x', generated='2026-11-01T00:00:00Z', sectors=w['sectors'])
        a = R.build_outputs(*args, **kw)
        b = R.build_outputs(*args, **kw)
        self.assertEqual(R.dumps(a[0]), R.dumps(b[0]))
        self.assertEqual(R.dumps(a[1]), R.dumps(b[1]))

    def test_main_synthetic_smoke(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(R.main(['--synthetic', '--out', d, '--resamples', '200']), 0)
            self.assertEqual(json.loads((Path(d) / 'strategies.json').read_text())['schema'], 'pi/strategies/v1')


class FakeJob:
    def __init__(self, nbytes):
        self.total_bytes_processed = nbytes

    def result(self):
        class Res:
            def to_dataframe(self_inner):
                import pandas as pd
                return pd.DataFrame({'a': [1]})
        return Res()


class FakeClient:
    def __init__(self, nbytes):
        self.nbytes, self.calls = nbytes, []

    def query(self, sql, job_config=None):
        self.calls.append(job_config)
        return FakeJob(self.nbytes)


class BudgetGuard(unittest.TestCase):
    cfg = staticmethod(lambda dry, mx, params: ('dry' if dry else 'run', mx, params))

    def test_T14_over_budget_query_aborts_before_running(self):
        cl = FakeClient(3 * 1024 ** 3)
        bq = R.BQ(cl, self.cfg)
        with self.assertRaises(R.BudgetExceeded):
            bq.frame('10_trades.sql')
        self.assertEqual([c[0] for c in cl.calls], ['dry'])      # only the dry run happened

    def test_run_total_is_capped(self):
        cl = FakeClient(1500 * 1024 ** 2)
        bq = R.BQ(cl, self.cfg, max_query=2 * 1024 ** 3, max_run=3 * 1024 ** 3)
        bq.frame('10_trades.sql')
        bq.frame('10_trades.sql')
        with self.assertRaises(R.BudgetExceeded):
            bq.frame('10_trades.sql')

    def test_real_query_sets_a_byte_cap_and_sql_is_parameterized(self):
        cl = FakeClient(10)
        R.BQ(cl, self.cfg).frame('20_prices.sql', {'start': ('DATE', None)})
        self.assertEqual(cl.calls[1][1], C.MAX_BYTES_PER_QUERY)
        for p in (Path(R.SQL_DIR)).glob('*.sql'):
            sql = p.read_text()
            self.assertNotRegex(sql, r'\{|%s|\bformat\b')       # no string-built SQL
            self.assertIn('portfolio-intel-512216.portfolio_intel.', sql)


class Preflight(unittest.TestCase):
    def test_required_tickers_and_stale_spy_stop_the_run(self):
        w = make_world(33, n_stocks=5, n_senate=10, n_house=10, n_sales=5)
        wide = w['wide']
        import datetime as dt
        R.preflight(wide, wide.index[-1].date())
        with self.assertRaises(R.Preflight):
            R.preflight(wide.drop(columns=['XLK']), wide.index[-1].date())
        with self.assertRaises(R.Preflight):
            R.preflight(wide, wide.index[-1].date() + dt.timedelta(days=30))
        holey = wide.copy()
        holey.loc[holey.index[200:900], 'SHV'] = float('nan')
        with self.assertRaises(R.Preflight):
            R.preflight(holey, wide.index[-1].date())

    def test_price_basis_prefers_adj_close_and_falls_back(self):
        import pandas as pd
        d = pd.date_range('2025-01-01', periods=10)
        rows = []
        for t in ('SPY', 'AAA'):
            for i, x in enumerate(d):
                rows.append({'ticker': t, 'd': x, 'close': 100 + i, 'adj_close': (90 + i) if t == 'SPY' else None})
        wide, basis = R.to_wide(pd.DataFrame(rows))
        self.assertEqual(basis, 'adj_close')
        self.assertEqual(wide['SPY'].iloc[0], 90)
        self.assertEqual(wide['AAA'].iloc[0], 100)         # no adjusted close: close is used for that ticker


if __name__ == '__main__':
    unittest.main()
