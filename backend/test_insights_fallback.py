# Render fallback for the insights routes. Run: python3 backend/test_insights_fallback.py
import unittest, os, sys
sys.path.insert(0, os.path.dirname(__file__))
import main

OK = {'Origin': 'https://portfolio-intel-279.pages.dev'}

class InsightsFallback(unittest.TestCase):
    def setUp(self):
        main.app.testing = True
        self.c = main.app.test_client()

    def test_unavailable_with_good_origin(self):
        for p in ('/api/insights', '/api/insights/strategies'):
            r = self.c.get(p, headers=OK)
            self.assertEqual(r.status_code, 503)
            self.assertEqual(r.get_json(), {'error': 'Insights unavailable'})

    def test_bad_or_missing_origin_is_forbidden(self):
        self.assertEqual(self.c.get('/api/insights', headers={'Origin': 'https://evil.example'}).status_code, 403)
        self.assertEqual(self.c.get('/api/insights/strategies').status_code, 403)

if __name__ == '__main__':
    unittest.main()
