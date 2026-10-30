"""Offline tests for history_load prices (adj_close, benchmarks). No network.
Run: python3 -m unittest scripts/test_history_load.py"""
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import history_load as h  # noqa: E402


class FakeResp:
    status_code = 200

    def __init__(self, body):
        self.body = body

    def json(self):
        return self.body


def chart(closes, adj):
    ind = {'quote': [{'close': closes}]}
    if adj is not None:
        ind['adjclose'] = [{'adjclose': adj}]
    return {'chart': {'result': [{'timestamp': [1735689600 + 86400 * i for i in range(len(closes))], 'indicators': ind}]}}


class FakeJob:
    def result(self):
        return [mock.Mock(n=1, u=1, c=1)]


class FakeBQ:
    def __init__(self, dupes=False):
        self.queries, self.loads, self.dupes = [], [], dupes

    def load_table_from_json(self, rows, stage, job_config=None):
        self.loads.append((stage, rows, [f.name for f in job_config.schema]))
        return FakeJob()

    def query(self, sql):
        self.queries.append(sql)
        job = FakeJob()
        if 'COUNT(DISTINCT' in sql:
            job.result = lambda: [mock.Mock(n=3 if self.dupes else 1, u=1)]
        elif 'COUNT(*) AS c' in sql:
            job.result = lambda: [mock.Mock(c=5)]
        return job

    def delete_table(self, *a, **k):
        pass

    def get_table(self, ref):
        return mock.Mock(num_bytes=1000)


def fake_table(name):
    return mock.Mock(reference=name)


class AdjClose(unittest.TestCase):
    def test_parse(self):
        with mock.patch.object(h.requests, 'get', return_value=FakeResp(chart([10.0, 11.0], [9.5, 10.5]))):
            rows = h.fetch_prices('SPY', '1mo')
        self.assertEqual([r['adj_close'] for r in rows], [9.5, 10.5])
        self.assertEqual([r['close'] for r in rows], [10.0, 11.0])

    def test_missing_adjclose_is_null(self):
        with mock.patch.object(h.requests, 'get', return_value=FakeResp(chart([10.0, 11.0], None))):
            rows = h.fetch_prices('SPY', '1mo')
        self.assertEqual([r['adj_close'] for r in rows], [None, None])
        with mock.patch.object(h.requests, 'get', return_value=FakeResp(chart([10.0, 11.0], [9.5, None]))):
            self.assertEqual([r['adj_close'] for r in h.fetch_prices('SPY', '1mo')], [9.5, None])

    def test_supabase_rows_have_no_adj_close(self):
        sent = {}
        sb = mock.Mock()
        sb.size.return_value = 0
        sb.upsert.side_effect = lambda table, rows, conflict: sent.__setitem__(table, rows)
        prices = [{'ticker': 'SPY', 'd': '2099-01-01', 'close': 1.0, 'adj_close': 0.9}]
        env = {'SUPABASE_URL': 'https://x.supabase.co', 'SUPABASE_SERVICE_KEY': 'k'}
        with mock.patch.dict(os.environ, env), mock.patch.object(h, 'Supabase', return_value=sb):
            h.to_supabase([], prices)
        self.assertEqual(sent['hist_prices'], [{'ticker': 'SPY', 'd': '2099-01-01', 'close': 1.0}])
        self.assertIn('adj_close', prices[0])  # BigQuery input is not mutated

    def run_bq(self, prices, dupes=False):
        bq = FakeBQ(dupes)
        with mock.patch.object(h, 'bq_dataset', return_value=(bq, 'p.ds')), \
                mock.patch.object(h, 'bq_ensure', side_effect=lambda c, d, n, s, f: fake_table(n)):
            h.to_bigquery([], prices)
        return bq

    def test_bigquery_alter_once_and_adj_close_loaded(self):
        prices = [{'ticker': 'SPY', 'd': '2026-10-01', 'close': 1.0, 'adj_close': 0.9}]
        bq = self.run_bq(prices)
        alters = [q for q in bq.queries if 'ALTER TABLE' in q]
        self.assertEqual(len(alters), 1)
        self.assertIn('ADD COLUMN IF NOT EXISTS adj_close FLOAT64', alters[0])
        stage, rows, cols = bq.loads[0]
        self.assertIn('adj_close', cols)
        self.assertEqual(rows[0]['adj_close'], 0.9)
        merge = next(q for q in bq.queries if q.startswith('MERGE'))
        self.assertIn('adj_close = S.adj_close', merge)
        self.assertIn('INSERT (ticker, d, close, adj_close)', merge)

    def test_dedupe_keeps_adj_close(self):
        bq = self.run_bq([{'ticker': 'SPY', 'd': '2026-10-01', 'close': 1.0, 'adj_close': 0.9}], dupes=True)
        ddl = [q for q in bq.queries if 'CREATE OR REPLACE TABLE `p.ds.prices`' in q]
        self.assertEqual(len(ddl), 1)
        self.assertIn('SELECT *', ddl[0])  # every column, including adj_close
        self.assertNotIn('EXCEPT', ddl[0])
        self.assertIn(('adj_close', 'FLOAT64', 'NULLABLE'), h.PRICE_SCHEMA)

    def test_benchmarks_always_loaded(self):
        self.assertEqual(len(h.BENCHMARKS), 20)
        seen = []
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, 't.json')
            json.dump({'trades': [{'representative': 'A', 'date': '2026-01-02', 'ticker': 'AAPL', 'type': 'purchase'}]}, open(p, 'w'))
            with mock.patch.object(h, 'load_prices', side_effect=lambda t, r: seen.append(set(t)) or []), \
                    mock.patch.object(h, 'to_supabase'), mock.patch.object(h, 'to_bigquery'), \
                    mock.patch.object(h, 'to_bigquery_news'), \
                    mock.patch.object(sys, 'argv', ['x', '--trades', p, '--prices', 'max']):
                with self.assertRaises(SystemExit):
                    h.main()
            # also with no trades at all
            json.dump([], open(p, 'w'))
            with mock.patch.object(h, 'load_prices', side_effect=lambda t, r: seen.append(set(t)) or []), \
                    mock.patch.object(h, 'to_supabase'), mock.patch.object(h, 'to_bigquery'), \
                    mock.patch.object(h, 'to_bigquery_news'), \
                    mock.patch.object(sys, 'argv', ['x', '--trades', p, '--prices', 'recent']):
                with self.assertRaises(SystemExit):
                    h.main()
        self.assertTrue(set(h.BENCHMARKS) | {'AAPL'} == seen[0])
        self.assertEqual(seen[1], set(h.BENCHMARKS))


if __name__ == '__main__':
    unittest.main()


class MaxRangeDaily(unittest.TestCase):
    def test_max_uses_period_and_daily_only(self):
        import scripts.history_load as hl
        seen = []
        class R:
            status_code = 200
            def __init__(self, gran): self.gran = gran
            def json(self):
                return {'chart': {'result': [{'meta': {'dataGranularity': self.gran}, 'timestamp': [86400, 86400, 172800],
                        'indicators': {'quote': [{'close': [1.0, 1.0, 2.0]}], 'adjclose': [{'adjclose': [1.0, 1.0, 2.0]}]}}]}}
        def get(url, **k):
            seen.append(url); return R('1d' if 'GOOD' in url else '1mo')
        orig = hl.requests.get; hl.requests.get = get
        try:
            rows = hl.load_prices({'GOOD', 'MONTHLY'}, 'max')
        finally:
            hl.requests.get = orig
        self.assertTrue(all('period1=0' in u and 'range=' not in u for u in seen))
        self.assertEqual(sorted((r['ticker'], r['d']) for r in rows), [('GOOD', '1970-01-02'), ('GOOD', '1970-01-03')])
