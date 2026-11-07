"""Offline tests for scripts/flags.py. Run: python3 -m unittest scripts/test_flags.py"""
import io
import json
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import flags as f  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))


class Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def opener_ok(body):
    calls = []

    def o(req, timeout):
        calls.append(timeout)
        return Resp(json.dumps(body).encode())
    o.calls = calls
    return o


def opener_fail():
    calls = []

    def o(req, timeout):
        calls.append(timeout)
        raise OSError('down')
    o.calls = calls
    return o


class Flags(unittest.TestCase):
    def test_reads_live(self):
        o = opener_ok({'v': 2, 'updated': 'x', 'flags': {'house_scrape': False, 'fmp_fill': True}})
        live = f.fetch('https://x/api/flags', opener=o, sleep=lambda s: None)
        self.assertEqual(f.values(['house_scrape', 'fmp_fill', 'recon_v2'], live), {'house_scrape': False, 'fmp_fill': True, 'recon_v2': False})
        self.assertEqual(o.calls, [5])

    def test_unreachable_two_tries_then_defaults(self):
        o = opener_fail()
        live = f.fetch('https://x/api/flags', opener=o, sleep=lambda s: None)
        self.assertIsNone(live)
        self.assertEqual(len(o.calls), 2)
        self.assertEqual(f.values(['house_scrape', 'recon_v2'], live), {'house_scrape': True, 'recon_v2': False})

    def test_non_bool_ignored(self):
        live = f.fetch('https://x', opener=opener_ok({'flags': {'house_scrape': 'no'}}), sleep=lambda s: None)
        self.assertEqual(f.values(['house_scrape'], live), {'house_scrape': True})

    def test_unknown_flag(self):
        with self.assertRaises(SystemExit):
            f.values(['nope'], {})

    def test_registry_matches_worker(self):
        reg = f.registry()
        src = open(os.path.join(HERE, '..', 'worker', 'src', 'lib', 'flags.js'), encoding='utf-8').read()
        rx = r"^\s+(\w+):\s+\{default: (true|false),\s+fail: '(\w+)',\s+kind: '(\w+)'"
        js = {n: {'default': d == 'true', 'fail': fl, 'kind': k} for n, d, fl, k in re.findall(rx, src, re.M)}
        self.assertEqual(js, reg)
        self.assertEqual(list(js), list(reg))


if __name__ == '__main__':
    unittest.main()
