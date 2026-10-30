"""Unit tests for meta_supervisor. Fully offline (mocks subprocess, requests, clock).

Run: python3 -m unittest scripts/test_meta_supervisor.py
"""
import copy
import datetime as dt
import json
import os
import sys
import types
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import meta_supervisor as m  # noqa: E402

NOW = dt.datetime(2026, 10, 30, 14, 10, tzinfo=dt.timezone.utc)
YESTERDAY = "2026-10-29"

# Minimal valid rows for news_verdicts
_GOOD_VERDICTS = [{"id": i, "ticker": "AAPL", "run_date": YESTERDAY, "status": "PASS"} for i in range(25)]

# Minimal valid insights/strategies data
_GOOD_INSIGHTS = {
    "label": "Historical analysis of public disclosures. Not investment advice.",
    "generated": "2026-10-28T12:00:00Z",
}
_GOOD_STRATEGIES = {
    "label": "SIMULATED. Hypothetical backtests. Not investment advice.",
    "generated": "2026-10-28T12:00:00Z",
}


def _fake_node_ok(cmd, *args, **kwargs):
    """Simulate Node returning the correct booleans: False for bad lines, True for safe lines."""
    payload = kwargs.get("input", b"[]")
    lines = json.loads(payload.decode())
    result = [line in m.SAFE_LINES for line in lines]
    proc = MagicMock()
    proc.returncode = 0
    proc.stdout = json.dumps(result).encode()
    proc.stderr = b""
    return proc


def _fake_node_miss_bad(cmd, *args, **kwargs):
    """Simulate Node failing to flag one bad line (all return True)."""
    payload = kwargs.get("input", b"[]")
    lines = json.loads(payload.decode())
    proc = MagicMock()
    proc.returncode = 0
    proc.stdout = json.dumps([True] * len(lines)).encode()
    proc.stderr = b""
    return proc


def _fake_node_flag_safe(cmd, *args, **kwargs):
    """Simulate Node flagging every line (all return False)."""
    payload = kwargs.get("input", b"[]")
    lines = json.loads(payload.decode())
    proc = MagicMock()
    proc.returncode = 0
    proc.stdout = json.dumps([False] * len(lines)).encode()
    proc.stderr = b""
    return proc


def _fake_node_error(cmd, *args, **kwargs):
    proc = MagicMock()
    proc.returncode = 1
    proc.stdout = b""
    proc.stderr = b"Error: module not found"
    return proc


def _make_response(status_code=200, body=None):
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = body if body is not None else []
    return resp


class CanaryCheck(unittest.TestCase):
    def test_all_pass_returns_ok(self):
        with patch("subprocess.run", side_effect=_fake_node_ok):
            findings = m.check_canary()
        sevs = [s for s, _ in findings]
        self.assertIn(m.OK, sevs)
        self.assertNotIn(m.ALERT, sevs)

    def test_bad_line_not_flagged_returns_alert(self):
        with patch("subprocess.run", side_effect=_fake_node_miss_bad):
            findings = m.check_canary()
        sevs = [s for s, _ in findings]
        self.assertIn(m.ALERT, sevs)
        alert_texts = [t for s, t in findings if s == m.ALERT]
        self.assertTrue(any("canary miss" in t for t in alert_texts))

    def test_safe_line_flagged_returns_alert(self):
        with patch("subprocess.run", side_effect=_fake_node_flag_safe):
            findings = m.check_canary()
        sevs = [s for s, _ in findings]
        self.assertIn(m.ALERT, sevs)
        alert_texts = [t for s, t in findings if s == m.ALERT]
        self.assertTrue(any("safe line was flagged" in t for t in alert_texts))

    def test_node_error_returns_warn(self):
        with patch("subprocess.run", side_effect=_fake_node_error):
            findings = m.check_canary()
        sevs = [s for s, _ in findings]
        self.assertIn(m.WARN, sevs)
        self.assertNotIn(m.ALERT, sevs)

    def test_node_not_found_returns_warn(self):
        with patch("subprocess.run", side_effect=FileNotFoundError("no node")):
            findings = m.check_canary()
        self.assertTrue(any(s == m.WARN for s, _ in findings))

    def test_node_timeout_returns_warn(self):
        import subprocess as sp_mod
        with patch("subprocess.run", side_effect=sp_mod.TimeoutExpired("node", 60)):
            findings = m.check_canary()
        self.assertTrue(any(s == m.WARN for s, _ in findings))

    def test_non_json_stdout_returns_warn(self):
        proc = MagicMock()
        proc.returncode = 0
        proc.stdout = b"not json"
        proc.stderr = b""
        with patch("subprocess.run", return_value=proc):
            findings = m.check_canary()
        self.assertTrue(any(s == m.WARN for s, _ in findings))

    def test_canary_miss_names_the_line(self):
        """The ALERT message must name the offending line."""
        with patch("subprocess.run", side_effect=_fake_node_miss_bad):
            findings = m.check_canary()
        alert_texts = [t for s, t in findings if s == m.ALERT]
        self.assertTrue(len(alert_texts) > 0)
        # At least one alert should contain part of a known bad line
        self.assertTrue(any("You should buy" in t or "canary miss" in t for t in alert_texts))


class NewsJudgeCheck(unittest.TestCase):
    def test_good_verdicts_returns_ok(self):
        with patch("requests.get", return_value=_make_response(200, _GOOD_VERDICTS)):
            findings = m.check_news_judge("https://x.supabase.co", "key", YESTERDAY)
        self.assertTrue(any(s == m.OK for s, _ in findings))

    def test_zero_verdicts_returns_warn(self):
        with patch("requests.get", return_value=_make_response(200, [])):
            findings = m.check_news_judge("https://x.supabase.co", "key", YESTERDAY)
        self.assertTrue(any(s == m.WARN for s, _ in findings))

    def test_over_20pct_not_ok_returns_warn(self):
        rows = [{"id": i, "status": "PASS"} for i in range(8)]
        rows += [{"id": i + 8, "status": "error"} for i in range(3)]  # 3/11 = 27% > 20%
        with patch("requests.get", return_value=_make_response(200, rows)):
            findings = m.check_news_judge("https://x.supabase.co", "key", YESTERDAY)
        self.assertTrue(any(s == m.WARN for s, _ in findings))

    def test_exactly_20pct_not_ok_is_ok(self):
        rows = [{"id": i, "status": "PASS"} for i in range(8)]
        rows += [{"id": i + 8, "status": "error"} for i in range(2)]  # 2/10 = 20%, not > 20%
        with patch("requests.get", return_value=_make_response(200, rows)):
            findings = m.check_news_judge("https://x.supabase.co", "key", YESTERDAY)
        self.assertFalse(any(s == m.WARN for s, _ in findings))

    def test_http_error_returns_warn(self):
        with patch("requests.get", return_value=_make_response(500)):
            findings = m.check_news_judge("https://x.supabase.co", "key", YESTERDAY)
        self.assertTrue(any(s == m.WARN for s, _ in findings))

    def test_network_error_returns_warn(self):
        import requests as rmod
        with patch("requests.get", side_effect=rmod.ConnectionError("fail")):
            findings = m.check_news_judge("https://x.supabase.co", "key", YESTERDAY)
        self.assertTrue(any(s == m.WARN for s, _ in findings))

    def test_non_json_returns_warn(self):
        resp = MagicMock()
        resp.status_code = 200
        resp.json.side_effect = ValueError("not json")
        with patch("requests.get", return_value=resp):
            findings = m.check_news_judge("https://x.supabase.co", "key", YESTERDAY)
        self.assertTrue(any(s == m.WARN for s, _ in findings))


class InsightsCheck(unittest.TestCase):
    def _run(self, insights_data, strategies_data, now=NOW):
        files = {
            "insights.json": insights_data,
            "strategies.json": strategies_data,
        }

        def fake_open(fname, *args, **kwargs):
            import io
            if fname in files:
                data = files[fname]
                if data is None:
                    raise FileNotFoundError(fname)
                return io.StringIO(json.dumps(data))
            raise FileNotFoundError(fname)

        with patch("builtins.open", side_effect=fake_open):
            return m.check_insights_files(now)

    def test_good_files_returns_ok(self):
        findings = self._run(_GOOD_INSIGHTS, _GOOD_STRATEGIES)
        self.assertFalse(any(s == m.ALERT for s, _ in findings))

    def test_missing_label_in_insights_returns_alert(self):
        bad = copy.deepcopy(_GOOD_INSIGHTS)
        del bad["label"]
        findings = self._run(bad, _GOOD_STRATEGIES)
        self.assertTrue(any(s == m.ALERT and "insights.json" in t for s, t in findings))

    def test_missing_label_in_strategies_returns_alert(self):
        bad = copy.deepcopy(_GOOD_STRATEGIES)
        del bad["label"]
        findings = self._run(_GOOD_INSIGHTS, bad)
        self.assertTrue(any(s == m.ALERT and "strategies.json" in t for s, t in findings))

    def test_strategies_label_without_simulated_returns_alert(self):
        bad = copy.deepcopy(_GOOD_STRATEGIES)
        bad["label"] = "Just a label without the keyword"
        findings = self._run(_GOOD_INSIGHTS, bad)
        self.assertTrue(any(s == m.ALERT and "SIMULATED" in t for s, t in findings))

    def test_placeholder_generated_reports_pending(self):
        placeholder = copy.deepcopy(_GOOD_INSIGHTS)
        placeholder["generated"] = "1970-01-01T00:00:00Z"
        findings = self._run(placeholder, _GOOD_STRATEGIES)
        self.assertTrue(any("pending" in t for _, t in findings))
        # pending is informational, not ALERT/WARN
        self.assertFalse(any(s in (m.ALERT, m.WARN) and "insights.json" in t and "pending" in t for s, t in findings))

    def test_stale_generated_returns_warn(self):
        stale = copy.deepcopy(_GOOD_INSIGHTS)
        stale["generated"] = "2026-10-01T00:00:00Z"  # 29 days before NOW (2026-10-30)
        findings = self._run(stale, _GOOD_STRATEGIES)
        self.assertTrue(any(s == m.WARN and "stale" in t for s, t in findings))

    def test_fresh_file_ok(self):
        fresh = copy.deepcopy(_GOOD_INSIGHTS)
        fresh["generated"] = "2026-10-29T00:00:00Z"  # 1 day before NOW
        findings = self._run(fresh, _GOOD_STRATEGIES)
        self.assertFalse(any(s == m.WARN and "insights.json" in t for s, t in findings))

    def test_missing_file_returns_alert(self):
        findings = self._run(None, _GOOD_STRATEGIES)
        self.assertTrue(any(s == m.ALERT and "insights.json" in t for s, t in findings))

    def test_invalid_json_returns_alert(self):
        import io

        def fake_open(fname, *args, **kwargs):
            if fname == "insights.json":
                return io.StringIO("not json {{{")
            if fname == "strategies.json":
                return io.StringIO(json.dumps(_GOOD_STRATEGIES))
            raise FileNotFoundError(fname)

        with patch("builtins.open", side_effect=fake_open):
            findings = m.check_insights_files(NOW)
        self.assertTrue(any(s == m.ALERT and "insights.json" in t for s, t in findings))


class ReconciliationCheck(unittest.TestCase):
    BASE = {"updated": "2026-10-30T06:20:00+00:00", "senate_official_count": 0, "senate_official_in_fmp": 0,
            "senate_stale": False, "senate_as_of": "2026-10-30",
            "fmp_house_check": {"ours_checked": 45, "ours_found_in_fmp": 44, "checked": 90, "matched": 88,
                                "matched_other_symbol": 3, "miss_causes": {}, "misses": []},
            "house_parse_report": {"filings": 455, "empty": [], "date_suspect": 0}}

    def run_check(self, mutate=None):
        d = copy.deepcopy(self.BASE)
        if mutate:
            mutate(d)
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tf:
            json.dump(d, tf)
        try:
            return m.check_reconciliation(NOW, tf.name)
        finally:
            os.unlink(tf.name)

    def worst(self, findings):
        return max((s for s, _ in findings), key=lambda s: m.RANK[s])

    def test_healthy_is_ok(self):
        f = self.run_check()
        self.assertEqual(self.worst(f), m.OK)
        self.assertTrue(any("3 under a different symbol" in t for _, t in f))
        self.assertTrue(any("Senate data is FMP only" in t for _, t in f))

    def test_low_completeness_alerts_and_mid_warns(self):
        self.assertEqual(self.worst(self.run_check(lambda d: d["fmp_house_check"].update(matched=48))), m.ALERT)
        self.assertEqual(self.worst(self.run_check(lambda d: d["fmp_house_check"].update(matched=80))), m.WARN)

    def test_low_fmp_accuracy_warns(self):
        self.assertEqual(self.worst(self.run_check(lambda d: d["fmp_house_check"].update(ours_found_in_fmp=41))), m.WARN)

    def test_small_sample_not_judged(self):
        f = self.run_check(lambda d: d["fmp_house_check"].update(checked=5, matched=1, ours_checked=3, ours_found_in_fmp=0))
        self.assertEqual(self.worst(f), m.OK)

    def test_member_with_no_trades_alerts_with_name(self):
        miss = lambda c: {"fmp": ["mccaul", "VVV", "2026-08-19", "Purc"], "cause": c}
        f = self.run_check(lambda d: d["fmp_house_check"].update(misses=[miss("member_has_no_trades_in_our_data")] * 3))
        self.assertTrue(any(s == m.ALERT and "mccaul: 3 trade(s)" in t for s, t in f))
        one = self.run_check(lambda d: d["fmp_house_check"].update(misses=[miss("member_has_no_trades_in_our_data")]))
        self.assertTrue(any(s == m.WARN and "mccaul: 1" in t for s, t in one))
        unread = self.run_check(lambda d: d["fmp_house_check"].update(misses=[miss("member_has_no_trades_in_our_data_filing_unreadable")]))
        self.assertTrue(any(s == m.WARN and "could not read" in t for s, t in unread))

    def test_unreadable_filings_and_dates_warn(self):
        def mut(d):
            d["house_parse_report"].update(date_suspect=2, empty=[
                {"name": "McCaul, Michael T.", "reason": "no text layer, likely a scanned paper filing (12 pages)"},
                {"name": "Doe, Jane", "reason": "download failed (ReadTimeout)"},
                {"name": "Roe, Rick", "reason": "no transaction rows recognized"}])
        f = self.run_check(mut)
        warn = [t for s, t in f if s == m.WARN]
        ok = [t for s, t in f if s == m.OK]
        # Year-long known gaps are notes, not daily warnings; transient download or parse failures warn
        self.assertTrue(any("1 scanned paper filing(s) this year not read, needs OCR (McCaul, Michael T.)" in t for t in ok))
        self.assertTrue(any("1 filing(s) failed to download or parse (Doe, Jane)" in t for t in warn))
        self.assertTrue(any("2 trade(s) this year dated after" in t for t in ok))

    def test_names_are_plain_text(self):
        def mut(d):
            d["house_parse_report"]["empty"] = [{"name": "<img src=x>[link](http://e)", "reason": "parse error (X)"}]
        t = " ".join(t for _, t in self.run_check(mut))
        self.assertNotIn("<", t); self.assertNotIn("[", t)

    def test_senate_official_compared_when_available(self):
        f = self.run_check(lambda d: d.update(senate_official_count=40, senate_official_in_fmp=30))
        self.assertTrue(any(s == m.WARN and "30 of 40" in t for s, t in f))
        self.assertEqual(self.worst(self.run_check(lambda d: d.update(senate_official_count=40, senate_official_in_fmp=39))), m.OK)

    def test_senate_stale_left_to_soc_monitor(self):
        self.assertEqual(self.worst(self.run_check(lambda d: d.update(senate_stale=True))), m.OK)

    def test_old_data_and_missing_check_warn(self):
        self.assertEqual(self.worst(self.run_check(lambda d: d.update(updated="2026-10-28T06:00:00+00:00"))), m.WARN)
        self.assertEqual(self.worst(self.run_check(lambda d: d.pop("fmp_house_check"))), m.WARN)

    def test_missing_file_alerts(self):
        self.assertEqual(m.check_reconciliation(NOW, "/nonexistent/trades.json")[0][0], m.ALERT)

    def test_producer_reason_strings(self):
        # Exact strings house_ptr.py writes; partial parse errors count as failed, empty-row reasons are not flagged
        def mut(d):
            d["house_parse_report"]["empty"] = [
                {"name": "A, B", "reason": "parse error (KeyError) after 3 rows", "partial": True},
                {"name": "C, D", "reason": "download failed (HTTPError 503)", "partial": False},
                {"name": "E, F", "reason": "no text layer, likely a scanned paper filing (2 pages)", "partial": False},
                {"name": "G, H", "reason": "no transaction rows recognized", "partial": False},
                {"name": "I, J", "reason": "no PDF link in search results"}]
        f = self.run_check(mut)
        texts = [t for s, t in f if s == m.WARN]
        self.assertTrue(any("2 filing(s) failed to download or parse (A, B, C, D)" in t for t in texts))
        self.assertTrue(any(s == m.OK and "1 scanned" in t for s, t in f))
        self.assertFalse(any("G, H" in t or "I, J" in t for t in texts))

    def test_updated_in_house_ptr_format_is_fresh(self):
        import datetime as _d
        stamp = (NOW - _d.timedelta(hours=8)).isoformat()  # house_ptr: datetime.now(timezone.utc).isoformat()
        f = self.run_check(lambda d: d.update(updated=stamp))
        self.assertFalse(any("hours old" in t or "no readable" in t for _, t in f))

    def test_naive_or_bad_updated_does_not_crash(self):
        # A time with no zone is read as UTC; anything unreadable warns. Neither may crash.
        f = self.run_check(lambda d: d.update(updated="2026-10-30T06:20:00"))
        self.assertFalse(any("hours old" in t or "no readable" in t for _, t in f))
        for bad in (12345, None, "garbage"):
            f = self.run_check(lambda d: d.update(updated=bad))
            self.assertTrue(any(s == m.WARN and "no readable" in t for s, t in f), bad)

    def test_senate_blocked_every_day_is_not_noisy(self):
        # Official site blocked since 2026-10-23: workflow writes count 0, stale False
        f = self.run_check(lambda d: d.update(senate_official_count=0, senate_official_in_fmp=0, senate_stale=False))
        self.assertTrue(all(s == m.OK for s, t in f if t.startswith("Senate")))

    def test_contract_with_senate_fmp_house_check(self):
        # Feed the real producer's output into check D
        import senate_fmp as sf
        import tempfile
        ours = [{"representative": "Sessions, Pete", "ticker": "VZ", "date": "2026-10-02", "type": "Sale",
                 "filed": "2026-10-27", "source": "house"}]
        fmp = [{"symbol": "BXPE", "transactionDate": "2026-08-20", "lastName": "McCaul", "type": "Purchase", "disclosureDate": "2026-10-16"},
               {"symbol": "XOM", "transactionDate": "2026-08-21", "lastName": "McCaul", "type": "Purchase", "disclosureDate": "2026-10-16"}]
        src = {"trades": ours, "house_parse_report": {"empty": [{"name": "McCaul, Michael T.", "reason": "no text layer, likely a scanned paper filing (4 pages)"}]}}
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tf:
            json.dump(src, tf)
        try:
            with patch.object(sf, "fetch_latest", return_value=fmp):
                hc = json.loads(json.dumps(sf.house_check(tf.name, "k")))
        finally:
            os.unlink(tf.name)
        f = self.run_check(lambda d: d.update(fmp_house_check=hc))
        self.assertTrue(any(s == m.WARN and "mccaul: 2 trade(s)" in t and "could not read" in t for s, t in f))
        self.assertTrue(any("member has no trades in our data filing unreadable 2" in t for _, t in f))


class ReconciliationNeverStopsRun(unittest.TestCase):
    def test_crash_in_check_d_becomes_alert(self):
        with patch("meta_supervisor.check_canary", return_value=[]), \
             patch("meta_supervisor.check_insights_files", return_value=[]), \
             patch("meta_supervisor.check_reconciliation", side_effect=AttributeError("x")), \
             patch("meta_supervisor.sync_issue") as sync, \
             patch.dict(os.environ, {"GITHUB_TOKEN": "t", "GITHUB_REPOSITORY": "o/r"}, clear=True), \
             patch("sys.stdout", new=__import__("io").StringIO()):
            self.assertEqual(m.main(), 0)
        self.assertEqual(sync.call_args[0][3], m.ALERT)
        self.assertIn("reconciliation: check failed on trades.json (AttributeError)", sync.call_args[0][4])


class OverallSeverity(unittest.TestCase):
    def test_alert_beats_warn_and_ok(self):
        findings = [(m.OK, "a"), (m.WARN, "b"), (m.ALERT, "c")]
        overall = max((s for s, _ in findings), key=lambda s: m.RANK[s], default=m.OK)
        self.assertEqual(overall, m.ALERT)

    def test_warn_beats_ok(self):
        findings = [(m.OK, "a"), (m.WARN, "b")]
        overall = max((s for s, _ in findings), key=lambda s: m.RANK[s], default=m.OK)
        self.assertEqual(overall, m.WARN)

    def test_all_ok(self):
        findings = [(m.OK, "a"), (m.OK, "b")]
        overall = max((s for s, _ in findings), key=lambda s: m.RANK[s], default=m.OK)
        self.assertEqual(overall, m.OK)


class SecretsNotLeaked(unittest.TestCase):
    """Secrets must not appear in the rendered report or notice lines."""

    def test_secrets_never_in_report(self):
        fake_token = "secret_supabase_key_ABCDEF123456"
        fake_url = "https://secret-project.supabase.co"

        findings = [
            (m.OK, "canary passed"),
            (m.WARN, "news judge: 0 verdicts"),
            (m.OK, "insights.json OK"),
        ]
        report = m.render(NOW, findings, m.WARN)

        self.assertNotIn(fake_token, report)
        self.assertNotIn(fake_url, report)
        self.assertNotIn("secret_supabase", report)

    def test_notice_line_contains_status_not_secrets(self):
        import io
        fake_token = "ghp_SECRETTOKEN1234567890"
        output = io.StringIO()

        def fake_sync(*args, **kwargs):
            pass

        env = {
            "SUPABASE_URL": "https://proj.supabase.co",
            "SUPABASE_SERVICE_KEY": fake_token,
            "GITHUB_TOKEN": "ghp_ANOTHERTOKEN",
            "GITHUB_REPOSITORY": "owner/repo",
        }

        with patch("subprocess.run", side_effect=_fake_node_ok), \
             patch("requests.get", return_value=_make_response(200, _GOOD_VERDICTS)), \
             patch("meta_supervisor.sync_issue", side_effect=fake_sync), \
             patch("meta_supervisor.check_insights_files", return_value=[(m.OK, "ok")]), \
             patch("meta_supervisor.check_reconciliation", return_value=[(m.OK, "ok")]), \
             patch.dict(os.environ, env, clear=True), \
             patch("sys.stdout", output), \
             patch("meta_supervisor.dt") as mock_dt:
            mock_dt.datetime.now.return_value = NOW
            mock_dt.timedelta = dt.timedelta
            m.main()

        out = output.getvalue()
        self.assertNotIn(fake_token, out)
        self.assertNotIn("ghp_ANOTHERTOKEN", out)
        self.assertNotIn("supabase.co", out)


class RenderCheck(unittest.TestCase):
    def test_no_em_dash_in_report(self):
        findings = [(m.ALERT, "something failed"), (m.OK, "other thing ok")]
        report = m.render(NOW, findings, m.ALERT)
        self.assertNotIn("\u2014", report)  # em dash
        self.assertNotIn("\u2013", report)  # en dash

    def test_report_contains_date_and_status(self):
        report = m.render(NOW, [(m.OK, "fine")], m.OK)
        self.assertIn("2026-10-30", report)
        self.assertIn(m.OK, report)

    def test_report_contains_findings(self):
        findings = [(m.WARN, "something is off")]
        report = m.render(NOW, findings, m.WARN)
        self.assertIn("something is off", report)
        self.assertIn(m.WARN, report)


if __name__ == "__main__":
    unittest.main()
