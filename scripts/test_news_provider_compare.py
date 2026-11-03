"""Unit tests for news_provider_compare. Fully offline.

Run: python3 -m unittest scripts/test_news_provider_compare.py
"""
import datetime as dt
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import news_provider_compare as c  # noqa: E402

NOW = dt.datetime(2026, 11, 10, 14, 10, tzinfo=dt.timezone.utc)


def row(day, tk, origin, status="PASS", stance="positive", provider=None, calls=3, tokens=1000, flags=None):
    return {"run_date": day, "ticker": tk, "origin": origin, "status": status, "stance": stance,
            "provider": provider, "groq_calls": calls, "tokens": tokens, "flags": flags}


class Stats(unittest.TestCase):
    def test_null_provider_is_groq(self):
        s = c.summarize([row("2026-11-01", "AAPL", "batch")])
        self.assertIn("groq", s["providers"])
        self.assertNotIn("gemini", s["providers"])

    def test_counts_and_averages(self):
        rows = [row("d", "A", "shadow", provider="gemini", calls=2, tokens=100),
                row("d", "B", "shadow", status="fallback", provider="gemini", calls=4, tokens=300, flags=["V4", "V5"]),
                row("d", "C", "shadow", status="thin", provider="gemini", calls=0, tokens=0),
                row("d", "D", "shadow", status="error", provider="gemini"),
                row("d", "E", "shadow", status="skipped", provider="gemini")]
        g = c.summarize(rows)["providers"]["gemini"]
        self.assertEqual((g["verdicts"], g["pass"], g["fallback"], g["thin"], g["error_skipped"]), (5, 1, 1, 1, 2))
        self.assertEqual(g["pass_rate"], 0.2)
        self.assertEqual(g["flags"], 2)
        self.assertEqual(g["quota_errors"], 1 + 0)  # error row only; fallback has no operational flag

    def test_agreement(self):
        rows = [row("d", "A", "batch", stance="positive"), row("d", "A", "shadow", stance="positive", provider="gemini"),
                row("d", "B", "batch", stance="positive"), row("d", "B", "shadow", stance="negative", provider="gemini"),
                row("d", "C", "batch", status="fallback"), row("d", "C", "shadow", provider="gemini"),
                row("d", "D", "batch")]
        a = c.agreement(rows)
        self.assertEqual((a["pairs"], a["both_pass"], a["agree"], a["agreement_rate"]), (3, 2, 1, 0.5))

    def test_agreement_none_when_no_pairs(self):
        self.assertIsNone(c.agreement([row("d", "A", "batch")])["agreement_rate"])


def trial(days, g_pass=10, g_total=10, q_pass=9, q_total=10, g_flags=None, q_flags=None, g_quota=0):
    rows = []
    for i in range(days):
        d = f"2026-11-{i + 1:02d}"
        for j in range(q_total):
            rows.append(row(d, f"Q{j}", "batch", status="PASS" if j < q_pass else "fallback", flags=q_flags))
        for j in range(g_total):
            st = "PASS" if j < g_pass else ("error" if j < g_pass + g_quota else "fallback")
            rows.append(row(d, f"Q{j}", "shadow", status=st, provider="gemini", flags=g_flags))
    return rows


class Decision(unittest.TestCase):
    def rec(self, rows):
        return c.build(rows, "2026-11-01", "2026-11-09", NOW)

    def test_pending_under_7_days(self):
        self.assertEqual(self.rec(trial(6))["recommendation"], "pending")

    def test_gemini_primary(self):
        r = self.rec(trial(7))
        self.assertEqual(r["recommendation"], "gemini_primary")
        self.assertEqual(r["trial_days"], 7)

    def test_keep_groq_when_gemini_below_90(self):
        self.assertEqual(self.rec(trial(7, g_pass=8, g_total=10))["recommendation"], "keep_groq_primary")

    def test_keep_groq_when_below_groq(self):
        self.assertEqual(self.rec(trial(7, q_pass=10, g_pass=9, g_total=10))["recommendation"], "keep_groq_primary")

    def test_keep_groq_on_quota_day(self):
        r = self.rec(trial(7, g_pass=7, g_total=10, g_quota=3, q_pass=7))
        self.assertEqual(r["recommendation"], "keep_groq_primary")
        self.assertTrue([x for x in r["reasons"] if "quota" in x])

    def test_keep_groq_when_more_flags(self):
        self.assertEqual(self.rec(trial(7, g_flags=["V4"]))["recommendation"], "keep_groq_primary")

    def test_flags_equal_ok(self):
        self.assertEqual(self.rec(trial(7, g_flags=["V4"], q_flags=["V4"]))["recommendation"], "gemini_primary")

    def test_json_serializable_no_em_dash(self):
        s = json.dumps(self.rec(trial(7)))
        self.assertNotIn("\u2014", s)


class FakeResp:
    def __init__(self, data, code=200):
        self.data, self.status_code = data, code

    def json(self):
        return self.data


class Main(unittest.TestCase):
    env = {"SUPABASE_URL": "https://x.supabase.co/rest/v1/", "SUPABASE_SERVICE_KEY": "secret-key-123"}

    def run_main(self, get):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "o.json")
            with patch.dict(os.environ, self.env), patch.object(c.requests, "get", get):
                rc = c.main(["--out", out, "--start", "2026-11-01"])
                data = json.load(open(out)) if os.path.exists(out) else None
            return rc, data

    def test_unreachable_writes_nothing(self):
        def boom(*a, **k):
            raise ConnectionError("secret-key-123")
        with patch("builtins.print") as pr:
            rc, data = self.run_main(boom)
        self.assertEqual(rc, 0)
        self.assertIsNone(data)
        printed = " ".join(str(x) for call in pr.call_args_list for x in call.args)
        self.assertIn("::warning::", printed)
        self.assertNotIn("secret-key-123", printed)

    def test_http_error_writes_nothing(self):
        rc, data = self.run_main(lambda *a, **k: FakeResp([], 500))
        self.assertEqual((rc, data), (0, None))

    def test_writes_file_and_never_prints_key(self):
        rows = trial(7)
        def get(url, params=None, headers=None, timeout=None):
            return FakeResp(rows if params.get("offset") == "0" else [])
        with patch("builtins.print") as pr:
            rc, data = self.run_main(get)
        self.assertEqual(rc, 0)
        self.assertEqual(data["recommendation"], "gemini_primary")
        self.assertIn("generated", data)
        printed = " ".join(str(x) for call in pr.call_args_list for x in call.args)
        self.assertNotIn("secret-key-123", printed)

    def test_generated_kept_when_nothing_else_changed(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "o.json")
            old = {"generated": "2026-11-01T14:10:00Z", "a": 1}
            with open(out, "w") as f:
                json.dump(old, f)
            self.assertEqual(c.keep_generated({"generated": "2026-11-02T14:10:00Z", "a": 1}, out)["generated"], old["generated"])
            self.assertEqual(c.keep_generated({"generated": "2026-11-02T14:10:00Z", "a": 2}, out)["generated"], "2026-11-02T14:10:00Z")
            self.assertEqual(c.keep_generated({"generated": "x", "a": 1}, os.path.join(d, "missing.json"))["generated"], "x")

    def test_no_shadow_rows_pending(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "o.json")
            with patch.dict(os.environ, self.env), patch.object(c.requests, "get", lambda *a, **k: FakeResp([])):
                c.main(["--out", out])
                data = json.load(open(out))
        self.assertIsNone(data["trial_start"])
        self.assertEqual(data["recommendation"], "pending")


if __name__ == "__main__":
    unittest.main()
