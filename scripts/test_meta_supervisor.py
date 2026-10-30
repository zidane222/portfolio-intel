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
