"""Offline tests for scripts/house_ptr.py. Run: python3 -m unittest scripts/test_house_ptr.py"""
import os, sys, unittest
from unittest import mock
import requests
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import house_ptr as h  # noqa: E402


class CheckDate(unittest.TestCase):
    def test_year_typo_is_corrected_and_original_kept(self):
        t = h.check_date({'date': '2026-12-26', 'filed': '2026-02-09'})
        self.assertEqual((t['date'], t['date_as_filed']), ('2025-12-26', '2026-12-26'))
        self.assertNotIn('date_suspect', t)

    def test_normal_trade_untouched(self):
        t = h.check_date({'date': '2026-10-02', 'filed': '2026-10-27'})
        self.assertEqual(t, {'date': '2026-10-02', 'filed': '2026-10-27'})

    def test_unexplained_future_date_is_flagged_not_changed(self):
        t = h.check_date({'date': '2026-10-20', 'filed': '2026-10-02'})
        self.assertEqual((t['date'], t.get('date_suspect')), ('2026-10-20', True))

    def test_missing_dates_ignored(self):
        self.assertEqual(h.check_date({'date': '', 'filed': '2026-10-02'}), {'date': '', 'filed': '2026-10-02'})

    def test_leap_day_prior_year_does_not_exist_is_flagged(self):
        t = h.check_date({'date': '2028-02-29', 'filed': '2028-02-10'})
        self.assertEqual((t['date'], t.get('date_suspect')), ('2028-02-29', True))
        self.assertNotIn('date_as_filed', t)

    def test_leap_year_correction_across_new_year(self):
        t = h.check_date({'date': '2025-02-28', 'filed': '2024-04-01'})
        self.assertEqual(t['date'], '2024-02-28')

    def test_gap_boundary(self):
        self.assertIn('date_as_filed', h.check_date({'date': '2026-11-01', 'filed': '2026-03-01'}))  # 120 days
        self.assertIn('date_suspect', h.check_date({'date': '2026-10-31', 'filed': '2026-03-01'}))  # 121 days

    def test_same_day_untouched(self):
        self.assertEqual(h.check_date({'date': '2026-10-02', 'filed': '2026-10-02'}), {'date': '2026-10-02', 'filed': '2026-10-02'})


class _Resp:
    def __init__(self, status=200, text='', content=b''):
        self.status_code, self.text, self.content = status, text, content


SEARCH = """<table><tr><th>h</th></tr>
<tr><td>Hon.. Sessions, Pete</td><td>TX</td><td>2026</td><td><a href="public_disc/ptr-pdfs/2026/1.pdf">PTR</a></td></tr>
<tr><td>Hon.. McCaul, Michael T.</td><td>TX</td><td>2026</td><td><a href="public_disc/ptr-pdfs/2026/2.pdf">PTR</a></td></tr>
<tr><td>Hon.. Paper, Filer</td><td>CA</td><td>2026</td><td>no link</td></tr>
<tr><td>Hon.. Down, Server</td><td>CA</td><td>2026</td><td><a href="public_disc/ptr-pdfs/2026/3.pdf">PTR</a></td></tr>
</table>"""


class _Page:
    def __init__(self, text, tables):
        self._t, self._tb = text, tables
    def extract_text(self): return self._t
    def extract_tables(self): return self._tb


class _Pdf:
    def __init__(self, pages): self.pages = pages
    def __enter__(self): return self
    def __exit__(self, *a): return False


PDFS = {
    b'1': [_Page('Digitally Signed: Pete Sessions , 02/09/2026',
                 [[['SP', '', 'Verizon (VZ) [ST]', 'S', '12/26/2026', '01/05/2026', '$1,001 - $15,000']]])],
    b'2': [_Page('', [])],  # scanned paper filing
}


class _Session:
    def __init__(self): self.calls = {}
    def get(self, url, **kw):
        self.calls[url] = self.calls.get(url, 0) + 1
        if url.endswith('ViewSearch'):
            return _Resp(text='<input name="__RequestVerificationToken" value="x">')
        if url.endswith('3.pdf'):
            raise requests.Timeout()
        return _Resp(content=url[-5:-4].encode())
    def post(self, url, **kw):
        return _Resp(text=SEARCH)


class ScrapeReport(unittest.TestCase):
    def test_returns_trades_and_report_and_warns(self):
        sess, logs = _Session(), []
        with mock.patch.object(h.requests, 'Session', return_value=sess), \
             mock.patch.object(h.pdfplumber, 'open', side_effect=lambda b: _Pdf(PDFS[b.getvalue()])), \
             mock.patch.object(h.time, 'sleep'):
            trades, report = h.scrape(2026, log=logs.append)
        self.assertEqual(len(trades), 1)
        t = trades[0]
        self.assertEqual((t['ticker'], t['date'], t['date_as_filed'], t['filed']), ('VZ', '2025-12-26', '2026-12-26', '2026-02-09'))
        self.assertEqual(report['filings'], 3)
        self.assertEqual(report['date_corrected'], 1)
        reasons = {e['name']: e['reason'] for e in report['empty']}
        self.assertEqual(set(reasons), {'McCaul, Michael T.', 'Paper, Filer', 'Down, Server'})
        self.assertIn('no text layer', reasons['McCaul, Michael T.'])
        self.assertEqual(reasons['Down, Server'], 'download failed (Timeout)')
        self.assertEqual(sess.calls[h.BASE + '/public_disc/ptr-pdfs/2026/3.pdf'], 2)  # one retry
        self.assertEqual(sum(1 for l in logs if l.startswith('::warning::No trades from')), 2)
        import json; json.dumps(report)  # serializable into trades.json


if __name__ == '__main__':
    unittest.main()
