"""Offline tests for scripts/senate_fmp.py. Run: python3 -m unittest scripts/test_senate_fmp.py"""
import json, os, sys, tempfile, unittest
from unittest import mock
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import senate_fmp as f  # noqa: E402

ROW = {"symbol": "GS", "disclosureDate": "2026-10-29", "transactionDate": "2026-10-07", "firstName": "Dave",
       "lastName": "McCormick", "assetDescription": "The Goldman Sachs Group Inc", "assetType": "Stock",
       "type": "Sale (Full)", "amount": "$250,001 -  $500,000", "link": "https://efdsearch.senate.gov/search/view/ptr/x/"}


class ToTrade(unittest.TestCase):
    def test_shape(self):
        t = f.to_trade(ROW)
        self.assertEqual((t['ticker'], t['type'], t['amount'], t['source']), ('GS', 'Sale', '$250,001 - $500,000', 'senate'))
        self.assertTrue(t['link'].startswith('https://efdsearch.senate.gov/'))

    def test_non_stock_is_private(self):
        t = f.to_trade({**ROW, "assetType": "Corporate Bond"})
        self.assertEqual((t['ticker'], t['private']), ('', True))

    def test_bad_link_dropped_and_bad_date_skipped(self):
        self.assertNotIn('link', f.to_trade({**ROW, "link": "https://evil.example/x"}))
        self.assertIsNone(f.to_trade({**ROW, "transactionDate": ""}))


class Names(unittest.TestCase):
    def test_existing_spelling_wins(self):
        with mock.patch.object(f, 'fetch_latest', return_value=[ROW]):
            t = f.senate('2026-01-01', 'k', known=['McCormick, David H', 'Boozman, John'])
        self.assertEqual(t[0]['representative'], 'McCormick, David H')


class HouseCheck(unittest.TestCase):
    def test_match_rate(self):
        ours = {'trades': [{'representative': 'Hern, Kevin', 'ticker': 'ASML', 'date': '2026-10-23', 'type': 'Sale', 'source': 'house'}]}
        fmp = [{"symbol": "ASML", "transactionDate": "2026-10-23", "lastName": "Hern", "type": "Sale"},
               {"symbol": "NVDA", "transactionDate": "2026-10-20", "lastName": "Pelosi", "type": "Purchase"}]
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as tf:
            json.dump(ours, tf)
        with mock.patch.object(f, 'fetch_latest', return_value=fmp):
            r = f.house_check(tf.name, 'k')
        os.unlink(tf.name)
        self.assertEqual((r['checked'], r['matched'], r['rate']), (2, 1, 0.5))


class KeyNeverInErrors(unittest.TestCase):
    def test_error_message_has_no_key(self):
        class R:
            status_code = 402
        with mock.patch.object(f.requests, 'get', return_value=R()):
            with self.assertRaises(RuntimeError) as e:
                f.get('senate-latest', {}, 'SECRETKEY')
        self.assertNotIn('SECRETKEY', str(e.exception))


if __name__ == '__main__':
    unittest.main()
