"""Unit tests for the SOC monitor severity rules. No network. Run: python3 -m unittest scripts/test_soc_monitor.py"""
import copy
import datetime as dt
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import soc_monitor as m  # noqa: E402

NOW = dt.datetime(2026, 10, 30, 13, 15, tzinfo=dt.timezone.utc)
SCRIPT = {"requests": 100, "baseline_daily": 100, "s4xx": 1, "s5xx": 0, "s403": 0, "s429": 0,
          "s429_baseline_daily": 0, "exceptions": 0, "exceptions_baseline_daily": 0}
GOOD = {
    "cloudflare": {"scripts": {"pi-market": SCRIPT}, "cron": {"ticks": 40, "failures": 0, "failure_streak": 0}, "top_errors": []},
    "supabase": {"jobs": {"ok": 30}, "verdicts_today": 30,
                 "budget": {"calls": 10, "tokens": 1000, "calls_cap": 90, "tokens_cap": 180000}},
    "github": {"failed_runs": [], "data_jobs": {"Fetch Congress Trades": "success",
                                                 "Private markets (SEC Form D and Form C)": "success"}},
}


def variant(fn):
    d = copy.deepcopy(GOOD)
    fn(d)
    return m.evaluate(d, NOW)


class Rules(unittest.TestCase):
    def test_ok(self):
        self.assertEqual(m.evaluate(GOOD, NOW), (m.OK, []))

    def test_cron_streak_alert_at_5(self):
        self.assertEqual(variant(lambda d: d["cloudflare"]["cron"].update(failure_streak=5, failures=5))[0], m.ALERT)
        self.assertEqual(variant(lambda d: d["cloudflare"]["cron"].update(failure_streak=4, failures=4))[0], m.WARN)

    def test_5xx_alert_over_20(self):
        self.assertEqual(variant(lambda d: d["cloudflare"]["scripts"]["pi-market"].update(s5xx=21))[0], m.ALERT)
        self.assertEqual(variant(lambda d: d["cloudflare"]["scripts"]["pi-market"].update(s5xx=20))[0], m.WARN)
        self.assertEqual(variant(lambda d: d["cloudflare"]["scripts"]["pi-market"].update(s5xx=4))[0], m.OK)

    def test_5xx_summed_across_scripts(self):
        def f(d):
            d["cloudflare"]["scripts"]["pi-a"] = dict(SCRIPT, s5xx=11)
            d["cloudflare"]["scripts"]["pi-b"] = dict(SCRIPT, s5xx=10)
        self.assertEqual(variant(f)[0], m.ALERT)

    def test_zero_verdicts_after_window(self):
        self.assertEqual(variant(lambda d: d["supabase"].update(verdicts_today=0))[0], m.ALERT)
        early = copy.deepcopy(GOOD)
        early["supabase"]["verdicts_today"] = 0
        self.assertEqual(m.evaluate(early, NOW.replace(hour=5))[0], m.OK)

    def test_failed_data_job_alert(self):
        self.assertEqual(variant(lambda d: d["github"]["data_jobs"].update({"Fetch Congress Trades": "failure"}))[0], m.ALERT)

    def test_missing_data_job_warns_only_after_its_hour(self):
        d = copy.deepcopy(GOOD)
        d["github"]["data_jobs"]["Private markets (SEC Form D and Form C)"] = "missing"
        self.assertEqual(m.evaluate(d, NOW)[0], m.WARN)
        self.assertEqual(m.evaluate(d, NOW.replace(hour=10))[0], m.OK)

    def test_unreadable_data_jobs_skip(self):
        self.assertEqual(variant(lambda d: d["github"].update(data_jobs={}))[0], m.OK)

    def test_budget_80_percent(self):
        self.assertEqual(variant(lambda d: d["supabase"]["budget"].update(calls=72))[0], m.WARN)
        self.assertEqual(variant(lambda d: d["supabase"]["budget"].update(calls=71))[0], m.OK)
        self.assertEqual(variant(lambda d: d["supabase"]["budget"].update(tokens=144000))[0], m.WARN)

    def test_request_spike(self):
        self.assertEqual(variant(lambda d: d["cloudflare"]["scripts"]["pi-market"].update(requests=301))[0], m.WARN)
        self.assertEqual(variant(lambda d: d["cloudflare"]["scripts"]["pi-market"].update(requests=300))[0], m.OK)
        # over 3x but under 200 absolute is not a spike
        self.assertEqual(variant(lambda d: d["cloudflare"]["scripts"]["pi-market"].update(requests=150, baseline_daily=10))[0], m.OK)

    def test_exception_and_429_spikes(self):
        self.assertEqual(variant(lambda d: d["cloudflare"]["scripts"]["pi-market"].update(exceptions=10))[0], m.WARN)
        self.assertEqual(variant(lambda d: d["cloudflare"]["scripts"]["pi-market"].update(exceptions=9))[0], m.OK)
        self.assertEqual(variant(lambda d: d["cloudflare"]["scripts"]["pi-market"].update(s429=10))[0], m.WARN)
        self.assertEqual(variant(lambda d: d["cloudflare"]["scripts"]["pi-market"].update(s429=10, s429_baseline_daily=5))[0], m.OK)

    def test_jobs_and_workflows_warn(self):
        self.assertEqual(variant(lambda d: d["supabase"]["jobs"].update(error=1))[0], m.WARN)
        self.assertEqual(variant(lambda d: d["supabase"]["jobs"].update(pending=2))[0], m.WARN)
        self.assertEqual(variant(lambda d: d["github"].update(failed_runs=[{"name": "Security scans"}]))[0], m.WARN)
        self.assertEqual(variant(lambda d: d["github"].update(dependabot_open=1))[0], m.WARN)

    def test_alert_wins_over_warn(self):
        def f(d):
            d["supabase"]["jobs"]["error"] = 1
            d["supabase"]["verdicts_today"] = 0
        self.assertEqual(variant(f)[0], m.ALERT)


class Scrub(unittest.TestCase):
    def test_scrub(self):
        s = m.scrub('Boom ticker=NVDA ip 10.1.2.3 a@b.com Bearer abc.def body={"x":1} $AAPL ' + "k" * 40)
        for bad in ("NVDA", "10.1.2.3", "a@b.com", "abc.def", "AAPL", "k" * 40):
            self.assertNotIn(bad, s)

    def test_adversarial(self):
        jwt = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.abc123DEF456"
        s = m.scrub("GET https://abcd.supabase.co/rest/v1/x?apikey=SECRETKEY123 auth " + jwt
                    + " v6 2001:db8::1 path /api/quote/NVDA/history sb_secret_abc123 ghp_abc123", 400)
        for bad in ("SECRETKEY123", "supabase.co", jwt, "eyJ", "2001:db8", "NVDA", "sb_secret", "ghp_"):
            self.assertNotIn(bad, s)

    def test_injection_neutralised(self):
        s = m.scrub("ping @octocat <img src=x> ![a](http://e.co/x.png) [c](u) `x` ::add-mask::foo\n::set-output name=a::b | c", 400)
        for bad in ("@", "<", ">", "[", "]", "!", "`", "|", "::"):
            self.assertNotIn(bad, s)

    def test_truncates(self):
        self.assertEqual(len(m.scrub("x " * 500, 50)), 50)

    def test_report_has_no_em_dash_or_leaks(self):
        with open(os.path.join(os.path.dirname(__file__), "fixtures", "soc_alert.json")) as fh:
            fx = json.load(fh)
        sev, f = m.evaluate(fx["data"], NOW)
        self.assertEqual(sev, m.ALERT)
        r = m.render(fx["data"], sev, f, NOW)
        self.assertNotIn(chr(0x2014), r)
        for bad in ("NVDA", "10.1.2.3", "a@b.com"):
            self.assertNotIn(bad, r)


if __name__ == "__main__":
    unittest.main()
