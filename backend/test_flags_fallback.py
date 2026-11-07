# Render fallback feature flags. Run: python3 backend/test_flags_fallback.py
import os, sys, unittest
os.environ['FLAGS_POLL'] = '0'
sys.path.insert(0, os.path.dirname(__file__))
import main

OK = {'Origin': 'https://portfolio-intel-279.pages.dev'}

class R:
    def __init__(self, code, body): self.status_code, self.body = code, body
    def json(self): return self.body

class FlagsFallback(unittest.TestCase):
    def setUp(self):
        main.app.testing = True
        self.c = main.app.test_client()
        main.FLAGS_STATE.update(flags=None, v=0, updated=None)
        main._hits.clear()

    def test_never_reached_closed_off(self):
        self.assertFalse(main.flag_on('broker'))
        self.assertFalse(main.flag_on('sync_writes'))
        self.assertTrue(main.flag_on('market'))
        r = self.c.get('/api/plaid/status', headers=OK)
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.get_json(), {'error': 'This feature is turned off for now. Try again later.', 'disabled': True, 'flag': 'broker'})
        self.assertEqual(r.headers['Retry-After'], '60')
        self.assertEqual(r.headers['X-PI-Flag'], 'off')
        d = self.c.get('/api/flags', headers=OK).get_json()
        self.assertEqual(d['flags']['broker'], False)
        self.assertEqual(d['flags']['maintenance'], False)

    def test_poll_and_route_flags(self):
        self.assertTrue(main.flags_poll_once(lambda *a, **k: R(200, {'v': 4, 'updated': 'x', 'flags': {'broker': True, 'news': False}})))
        self.assertEqual(self.c.get('/api/newsdesk/read', headers=OK).get_json()['flag'], 'news')
        self.assertEqual(self.c.get('/api/feeds', headers=OK).status_code, 503)
        self.assertTrue(main.flag_on('broker'))
        self.assertEqual(self.c.get('/api/flags').get_json()['v'], 4)

    def test_poll_failure_keeps_last(self):
        main.flags_poll_once(lambda *a, **k: R(200, {'v': 1, 'flags': {'broker': True}}))
        self.assertFalse(main.flags_poll_once(lambda *a, **k: R(500, None)))
        self.assertTrue(main.flag_on('broker'))

    def test_maintenance_blocks_all_but_flags_and_health(self):
        main.flags_poll_once(lambda *a, **k: R(200, {'v': 1, 'flags': {'maintenance': True}}))
        self.assertEqual(self.c.get('/api/top-rates', headers=OK).get_json()['flag'], 'maintenance')
        self.assertEqual(self.c.get('/api/flags', headers=OK).status_code, 200)
        self.assertEqual(self.c.get('/health').status_code, 200)

    def test_flags_bad_origin(self):
        self.assertEqual(self.c.get('/api/flags', headers={'Origin': 'https://evil.example'}).status_code, 403)

if __name__ == '__main__':
    unittest.main()
