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


class HouseCheckMatching(unittest.TestCase):
    def run_check(self, ours, fmp, report=None):
        d = {'trades': ours}
        if report:
            d['house_parse_report'] = report
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as tf:
            json.dump(d, tf)
        try:
            with mock.patch.object(f, 'fetch_latest', return_value=fmp):
                return f.house_check(tf.name, 'k')
        finally:
            os.unlink(tf.name)

    def test_ticker_formats_and_share_classes_match(self):
        ours = [{'representative': 'Sessions, Pete', 'ticker': 'BRK.B', 'date': '2026-10-15', 'type': 'Sale', 'filed': '2026-10-27'},
                {'representative': 'Rulli, Michael', 'ticker': 'GOOG', 'date': '2026-10-16', 'type': 'Sale', 'filed': '2026-10-20'}]
        fmp = [{"symbol": "BRK-B", "transactionDate": "2026-10-15", "lastName": "Sessions", "type": "Sale", "disclosureDate": "2026-10-28"},
               {"symbol": "GOOGL", "transactionDate": "2026-10-16", "lastName": "Rulli", "type": "Sale", "disclosureDate": "2026-10-20"}]
        r = self.run_check(ours, fmp)
        self.assertEqual((r['checked'], r['matched'], r['rate']), (2, 2, 1.0))
        self.assertEqual(r['ours_found_in_fmp'], 2)

    def test_other_symbol_same_company_matches(self):
        ours = [{'representative': 'Lee, Laurel', 'ticker': 'NOKX', 'date': '2026-09-18', 'type': 'Purchase', 'description': 'NOKIA A SHS', 'filed': '2026-10-16'}]
        fmp = [{"symbol": "NOKQ", "transactionDate": "2026-09-18", "lastName": "Lee", "type": "Purchase", "assetDescription": "Nokia Oyj"}]
        r = self.run_check(ours, fmp)
        self.assertEqual((r['matched'], r['matched_other_symbol']), (1, 1))

    def test_different_company_same_day_is_a_miss(self):
        ours = [{'representative': 'Lee, Laurel', 'ticker': 'BAC', 'date': '2026-09-18', 'type': 'Purchase', 'description': 'Bank of America', 'filed': '2026-10-16'}]
        fmp = [{"symbol": "NOK", "transactionDate": "2026-09-18", "lastName": "Lee", "type": "Purchase", "assetDescription": "Nokia Oyj", "disclosureDate": "2026-10-16"}]
        r = self.run_check(ours, fmp)
        self.assertEqual(r['matched'], 0)
        self.assertEqual(r['misses'][0]['cause'], 'trade_missing_for_known_member')

    def test_miss_causes(self):
        ours = [{'representative': 'Sessions, Pete', 'ticker': 'VZ', 'date': '2026-10-02', 'type': 'Sale', 'filed': '2026-10-27'}]
        fmp = [{"symbol": "BXPE", "transactionDate": "2026-08-20", "lastName": "McCaul", "type": "Purchase", "disclosureDate": "2026-10-16"},
               {"symbol": "SBUX", "transactionDate": "2026-10-02", "lastName": "Sessions", "type": "Sale", "disclosureDate": "2026-11-05"},
               {"symbol": "KO", "transactionDate": "2026-10-01", "lastName": "Sessions", "type": "Sale", "disclosureDate": "2026-10-27"}]
        r = self.run_check(ours, fmp, report={'empty': [{'name': 'McCaul, Michael T.', 'reason': 'no text layer'}]})
        self.assertEqual(r['miss_causes'], {'member_has_no_trades_in_our_data_filing_unreadable': 1,
                                            'filed_after_our_last_scrape': 1, 'trade_missing_for_known_member': 1})
        self.assertEqual(len(r['misses']), 3)

    def test_norm_ticker(self):
        self.assertEqual(f.norm_ticker('brk-b'), f.norm_ticker('BRK.B'))
        self.assertEqual(f.norm_ticker('GOOGL'), f.norm_ticker('GOOG'))
        self.assertNotEqual(f.norm_ticker('GOOG'), f.norm_ticker('GOOD'))

    def test_shared_first_word_is_not_the_same_company(self):
        ours = [{'representative': 'Lee, Laurel', 'ticker': 'IVV', 'date': '2026-09-18', 'type': 'Purchase', 'description': 'iShares Core S&P 500 ETF', 'filed': '2026-10-16'},
                {'representative': 'Lee, Laurel', 'ticker': 'AXP', 'date': '2026-09-18', 'type': 'Sale', 'description': 'American Express Company', 'filed': '2026-10-16'}]
        fmp = [{"symbol": "IEFA", "transactionDate": "2026-09-18", "lastName": "Lee", "type": "Purchase", "assetDescription": "iShares Core MSCI EAFE ETF", "disclosureDate": "2026-10-16"},
               {"symbol": "AAL", "transactionDate": "2026-09-18", "lastName": "Lee", "type": "Sale", "assetDescription": "American Airlines Group Inc", "disclosureDate": "2026-10-16"}]
        r = self.run_check(ours, fmp)
        self.assertEqual(r['matched'], 0)

    def test_missing_trade_in_newest_filing_is_not_called_late(self):
        ours = [{'representative': 'Sessions, Pete', 'ticker': 'VZ', 'date': '2026-10-02', 'type': 'Sale', 'filed': '2026-10-27'}]
        fmp = [{"symbol": "SBUX", "transactionDate": "2026-10-02", "lastName": "Sessions", "type": "Sale", "disclosureDate": "2026-10-28"}]
        self.assertEqual(self.run_check(ours, fmp)['misses'][0]['cause'], 'trade_missing_for_known_member')

    def test_misses_capped_and_output_serializable(self):
        fmp = [{"symbol": f"T{i}", "transactionDate": "2026-10-01", "lastName": "Nobody", "type": "Purchase", "disclosureDate": "2026-10-02"} for i in range(150)]
        r = self.run_check([{'representative': 'Sessions, Pete', 'ticker': 'VZ', 'date': '2026-10-02', 'type': 'Sale', 'filed': '2026-10-27'}], fmp)
        self.assertEqual((r['checked'], len(r['misses']), r['miss_causes']), (150, 100, {'member_has_no_trades_in_our_data': 150}))
        json.dumps(r)

    def test_senate_rows_ignored(self):
        ours = [{'representative': 'Lee, Laurel', 'ticker': 'NOK', 'date': '2026-09-18', 'type': 'Purchase', 'source': 'senate', 'filed': '2026-10-16'}]
        fmp = [{"symbol": "NOK", "transactionDate": "2026-09-18", "lastName": "Lee", "type": "Purchase", "disclosureDate": "2026-10-16"}]
        r = self.run_check(ours, fmp)
        self.assertEqual((r['matched'], r['ours_checked']), (0, 0))

    def test_legacy_keys_still_present_for_consumers(self):
        r = self.run_check([], [])
        for k in ('ours_checked', 'ours_found_in_fmp', 'checked', 'matched', 'rate', 'misses'):
            self.assertIn(k, r)


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
