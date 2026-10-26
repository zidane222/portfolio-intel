# Render fallback routes for the news reads (no Groq, no storage). Run: python3 backend/test_newsdesk_fallback.py
import unittest, importlib.util, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import main

OK = {'Origin': 'https://portfolio-intel-279.pages.dev'}

class NewsdeskFallback(unittest.TestCase):
    def setUp(self):
        main.app.testing = True
        self.c = main.app.test_client()
        if hasattr(main, 'rate_buckets'): main.rate_buckets.clear()

    def test_reads_empty_for_valid_list(self):
        r = self.c.post('/api/newsdesk/reads', json={'tickers': ['nvda', 'BRK.B']}, headers=OK)
        self.assertEqual(r.status_code, 200)
        d = r.get_json(); self.assertEqual(d['reads'], {'NVDA': [], 'BRK.B': []}); self.assertEqual(d['window_days'], 7)

    def test_reads_limits(self):
        self.assertEqual(self.c.post('/api/newsdesk/reads', json={'tickers': ['A'] * 41}, headers=OK).status_code, 400)
        self.assertEqual(self.c.post('/api/newsdesk/reads', json={'tickers': []}, headers=OK).status_code, 400)
        self.assertEqual(self.c.post('/api/newsdesk/reads', json={'tickers': ['ab$']}, headers=OK).status_code, 400)
        self.assertEqual(self.c.post('/api/newsdesk/reads', json={'tickers': [5]}, headers=OK).status_code, 400)
        self.assertEqual(self.c.post('/api/newsdesk/reads', json={'tickers': ['A'], 'pad': 'x' * 3000}, headers=OK).status_code, 413)

    def test_read_is_paused(self):
        r = self.c.post('/api/newsdesk/read', json={'ticker': 'nvda'}, headers=OK)
        self.assertEqual(r.status_code, 503); self.assertEqual(r.get_json()['error'], 'News reads are paused.')
        self.assertEqual(self.c.post('/api/newsdesk/read', json={'ticker': 'bad!'}, headers=OK).status_code, 400)
        self.assertEqual(self.c.post('/api/newsdesk/read', json={'ticker': 'A', 'pad': 'x' * 2000}, headers=OK).status_code, 413)
        self.assertEqual(self.c.post('/api/newsdesk/read', data='nope', headers=OK).status_code, 400)

    def test_origin_and_method(self):
        self.assertEqual(self.c.post('/api/newsdesk/read', json={'ticker': 'A'}, headers={'Origin': 'https://evil.com'}).status_code, 403)
        self.assertEqual(self.c.post('/api/newsdesk/reads', json={'tickers': ['A']}).status_code, 403)
        self.assertEqual(self.c.get('/api/newsdesk/read', headers=OK).status_code, 405)

    def test_tickers_never_logged(self):
        import io, contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            self.c.post('/api/newsdesk/read', json={'ticker': 'ZQXV'}, headers=OK)
            self.c.post('/api/newsdesk/reads', json={'tickers': ['ZQXV']}, headers=OK)
        self.assertNotIn('ZQXV', buf.getvalue())

if __name__ == '__main__':
    unittest.main()
