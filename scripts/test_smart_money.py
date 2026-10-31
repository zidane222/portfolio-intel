"""Offline tests for the Form 4 insider parser in scripts/smart_money.py.
Run: python3 -m unittest scripts/test_smart_money.py"""
import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import smart_money as sm  # noqa: E402


def form4(rows, ticker='LONA', director='0', ten='1', title=''):
    tx = ''.join(f"""<nonDerivativeTransaction><transactionDate><value>{d}</value></transactionDate>
      <transactionCoding><transactionCode>{code}</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>{sh}</value></transactionShares>
      <transactionPricePerShare><value>{px}</value></transactionPricePerShare></transactionAmounts></nonDerivativeTransaction>"""
                 for d, code, sh, px in rows)
    return f"""<SEC-DOCUMENT><ownershipDocument><issuer><issuerName>LeonaBio, Inc.</issuerName><issuerTradingSymbol>{ticker}</issuerTradingSymbol></issuer>
      <reportingOwner><reportingOwnerId><rptOwnerName>Portman David J.</rptOwnerName></reportingOwnerId>
      <reportingOwnerRelationship><isDirector>{director}</isDirector><isTenPercentOwner>{ten}</isTenPercentOwner><officerTitle>{title}</officerTitle></reportingOwnerRelationship></reportingOwner>
      <nonDerivativeTable>{tx}</nonDerivativeTable></ownershipDocument></SEC-DOCUMENT>"""


class Form4(unittest.TestCase):
    def test_leonabio_price_equal_to_shares_over_1000_is_dropped(self):
        self.assertIsNone(sm.parse_form4(form4([('2026-10-26', 'P', 3149470, 3149.47)]), '2026-10-28'))

    def test_over_one_billion_is_dropped(self):
        self.assertIsNone(sm.parse_form4(form4([('2026-10-26', 'P', 2000000, 600)]), '2026-10-28'))
        self.assertIsNone(sm.parse_form4(form4([('2026-10-26', 'P', 'NaN', 5)]), '2026-10-28'))

    def test_bad_row_dropped_good_row_kept(self):
        b = sm.parse_form4(form4([('2026-10-26', 'P', 3149470, 3149.47), ('2026-10-27', 'P', 100000, 3.15)]), '2026-10-28')
        self.assertEqual((b['shares'], b['price'], b['value'], b['date']), (100000, 3.15, 315000, '2026-10-27'))

    def test_normal_buys_unchanged(self):
        b = sm.parse_form4(form4([('2026-10-21', 'P', 632922, 3.55)], ticker='RENT', director='1'), '2026-10-23')
        self.assertEqual((b['ticker'], b['value'], b['price'], b['role']), ('RENT', 2246873, 3.55, 'Director, 10% owner'))
        # A real high-priced share (Berkshire A) is not mistaken for the error pattern
        b = sm.parse_form4(form4([('2026-10-21', 'P', 10, 700000)], ticker='BRK.A'), '2026-10-23')
        self.assertEqual(b['value'], 7000000)

    def test_sales_and_tiny_buys_ignored(self):
        self.assertIsNone(sm.parse_form4(form4([('2026-10-21', 'S', 100000, 10)]), '2026-10-23'))
        self.assertIsNone(sm.parse_form4(form4([('2026-10-21', 'P', 100, 10)]), '2026-10-23'))

    def test_stored_bad_rows_are_cleared_on_the_next_run(self):
        import datetime, json, tempfile
        from unittest import mock
        today = datetime.date.today().isoformat()
        store = {'buys': [{'ticker': 'LONA', 'owner': 'x', 'date': today, 'filed': today, 'shares': 3149470, 'price': 3149.47, 'value': 9919161281},
                          {'ticker': 'LRN', 'owner': 'y', 'date': today, 'filed': today, 'shares': 154196, 'price': 79.0, 'value': 12181484}], 'seen': {}}
        d = tempfile.mkdtemp(); cwd = os.getcwd()
        try:
            os.chdir(d); json.dump(store, open('insiders.json', 'w'))
            with mock.patch.object(sm, 'sec_get', side_effect=Exception('offline')):
                out = sm.insiders()
        finally:
            os.chdir(cwd)
        self.assertEqual([b['ticker'] for b in out['buys']], ['LRN'])

    def test_implausible(self):
        self.assertTrue(sm.implausible(3149470, 3149.47))
        self.assertTrue(sm.implausible(0, 5)); self.assertTrue(sm.implausible(5, 0))
        self.assertFalse(sm.implausible(154196, 79.0))
        self.assertFalse(sm.implausible(5000, 5.0))
        self.assertFalse(sm.implausible(50000, 50.0))  # a real $2.5M buy that equals shares/1000 is kept
        self.assertTrue(sm.implausible(float('nan'), 5)); self.assertTrue(sm.implausible(5, float('inf'))); self.assertTrue(sm.implausible('x', 5))


if __name__ == '__main__':
    unittest.main()
