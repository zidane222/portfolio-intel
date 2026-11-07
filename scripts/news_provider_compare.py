#!/usr/bin/env python3
"""News provider trial comparison (docs/plans/phase5-news-dual-provider.md sections 5 and 6).

Reads news_verdicts from Supabase PostgREST for the trial window (first day with a shadow row,
or --start / NEWS_TRIAL_START, through yesterday UTC), pairs 'batch' and 'shadow' rows by ticker,
and writes news_provider_compare.json at the repo root.

Per provider (the row's provider column; null on old rows = groq): verdicts, PASS count and rate,
fallback, thin, error/skipped, average groq_calls and tokens, validator flags (record.flags).
Per day and overall: stance agreement between batch and shadow where both are PASS.

Stdlib + requests only. Secrets only from env: SUPABASE_URL, SUPABASE_SERVICE_KEY.
Prints aggregate numbers only. If Supabase is unreachable, writes nothing, warns, exits 0.
"""
import argparse
import datetime as dt
import json
import os
import re
import sys

import requests

TIMEOUT = 20
PAGE = 1000
MIN_DAYS = 7
OUT_FILE = "news_provider_compare.json"
PROVIDERS = ("groq", "gemini")
# Flags that mean the provider call itself failed (used for the quota rule), not a validator rule.
OPERATIONAL_FLAGS = {"budget", "groq_error", "timeout", "quota"}


class Unreachable(Exception):
    pass


def _headers(key):
    return {"apikey": key, "Authorization": f"Bearer {key}"}


def _get(url, key, params, extra=None):
    h = _headers(key)
    h.update(extra or {})
    try:
        r = requests.get(url, params=params, headers=h, timeout=TIMEOUT)
    except Exception as exc:
        raise Unreachable(type(exc).__name__)
    if r.status_code >= 400:
        raise Unreachable(f"HTTP {r.status_code}")
    try:
        data = r.json()
    except ValueError:
        raise Unreachable("non-JSON")
    if not isinstance(data, list):
        raise Unreachable("unexpected shape")
    return data


def first_shadow_date(base, key):
    rows = _get(base, key, {"select": "run_date", "origin": "eq.shadow", "order": "run_date.asc", "limit": "1"})
    return rows[0].get("run_date") if rows else None


def fetch_rows(base, key, start, end):
    out, offset = [], 0
    while True:
        params = {
            "select": "run_date,ticker,origin,status,stance,groq_calls,tokens,provider,flags:record->flags",
            "and": f"(run_date.gte.{start},run_date.lte.{end})",
            "order": "run_date.asc,ticker.asc,origin.asc",
            "limit": str(PAGE), "offset": str(offset),
        }
        page = _get(base, key, params)
        out.extend(page)
        if len(page) < PAGE:
            return out
        offset += PAGE


def _provider(row):
    p = row.get("provider")
    return p if p in PROVIDERS else "groq"


def _flags(row):
    f = row.get("flags")
    return [x for x in f if isinstance(x, str)] if isinstance(f, list) else []


def provider_stats(rows):
    """Aggregate a list of rows (already one provider) into the report dict."""
    n = len(rows)
    st = lambda s: sum(1 for r in rows if r.get("status") == s)
    passed = st("PASS")
    flags = [f for r in rows for f in _flags(r)]
    quota = sum(1 for r in rows if r.get("status") == "error"
                or (r.get("status") == "fallback" and OPERATIONAL_FLAGS & set(_flags(r))))
    return {
        "verdicts": n,
        "pass": passed,
        "pass_rate": round(passed / n, 4) if n else None,
        "fallback": st("fallback"),
        "thin": st("thin"),
        "error_skipped": st("error") + st("skipped"),
        "avg_groq_calls": round(sum(int(r.get("groq_calls") or 0) for r in rows) / n, 2) if n else None,
        "avg_tokens": round(sum(int(r.get("tokens") or 0) for r in rows) / n, 1) if n else None,
        "flags": len(flags),
        "flags_per_verdict": round(len(flags) / n, 3) if n else None,
        "quota_errors": quota,
    }


def agreement(rows):
    """Pair batch and shadow rows by (run_date, ticker); stance agreement where both are PASS."""
    by = {}
    for r in rows:
        by.setdefault((r.get("run_date"), r.get("ticker")), {})[r.get("origin")] = r
    pairs = both = agree = 0
    for d in by.values():
        if "batch" in d and "shadow" in d:
            pairs += 1
            if d["batch"].get("status") == "PASS" and d["shadow"].get("status") == "PASS":
                both += 1
                if d["batch"].get("stance") == d["shadow"].get("stance"):
                    agree += 1
    return {"pairs": pairs, "both_pass": both, "agree": agree,
            "agreement_rate": round(agree / both, 4) if both else None}


def summarize(rows):
    out = {"providers": {}}
    for p in PROVIDERS:
        sub = [r for r in rows if _provider(r) == p]
        if sub:
            out["providers"][p] = provider_stats(sub)
    out.update(agreement(rows))
    return out


def decide(overall, days, trial_days):
    """Plan section 6 decision rule. Returns (recommendation, reasons)."""
    if trial_days < MIN_DAYS:
        return "pending", [f"{trial_days} of {MIN_DAYS} trial days"]
    g, q = overall["providers"].get("gemini"), overall["providers"].get("groq")
    if not g or not q:
        return "pending", ["a provider has no verdicts yet"]
    reasons = []
    if g["pass_rate"] < q["pass_rate"]:
        reasons.append("gemini PASS rate below groq")
    if g["pass_rate"] < 0.9:
        reasons.append("gemini PASS rate under 90%")
    bad = [d["date"] for d in days if d["providers"].get("gemini", {}).get("quota_errors", 0) > 2]
    if bad:
        reasons.append(f"gemini quota errors on more than 2 tickers on {len(bad)} day(s)")
    if g["flags_per_verdict"] > q["flags_per_verdict"]:
        reasons.append("gemini validator flags higher than groq")
    return ("keep_groq_primary", reasons) if reasons else ("gemini_primary", ["all three conditions met"])


def build(rows, start, end, now):
    dates = sorted({r["run_date"] for r in rows if r.get("run_date")})
    days = []
    for d in dates:
        s = summarize([r for r in rows if r.get("run_date") == d])
        days.append({"date": d, **s})
    shadow_days = {r["run_date"] for r in rows if r.get("origin") == "shadow"}
    overall = summarize(rows)
    rec, reasons = decide(overall, days, len(shadow_days))
    return {
        "generated": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "trial_start": start, "through": end, "trial_days": len(shadow_days),
        "recommendation": rec, "reasons": reasons,
        "overall": overall, "days": days,
    }


def keep_generated(result, path):
    """Keep the previous "generated" value when nothing else changed, so the commit step sees no diff."""
    try:
        with open(path) as f:
            old = json.load(f)
    except (OSError, ValueError):
        return result
    if isinstance(old, dict) and old.get("generated") and \
            {k: v for k, v in old.items() if k != "generated"} == {k: v for k, v in result.items() if k != "generated"}:
        result = dict(result, generated=old["generated"])
    return result


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default=os.environ.get("NEWS_TRIAL_START", "").strip())
    ap.add_argument("--out", default=OUT_FILE)
    args = ap.parse_args(argv)
    now = dt.datetime.now(dt.timezone.utc)
    end = (now - dt.timedelta(days=1)).strftime("%Y-%m-%d")
    url = re.sub(r"(/rest/v1)?/*$", "", os.environ.get("SUPABASE_URL", "").strip().strip('"').strip("'"))
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip().strip('"').strip("'")
    if not url or not key:
        print("::warning::news provider compare: SUPABASE_URL or SUPABASE_SERVICE_KEY not set")
        return 0
    base = f"{url}/rest/v1/news_verdicts"
    try:
        start = args.start or first_shadow_date(base, key)
        if not start or start > end:
            result = {"generated": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "trial_start": None, "through": end,
                      "trial_days": 0, "recommendation": "pending", "reasons": ["no shadow rows"],
                      "overall": {"providers": {}, "pairs": 0, "both_pass": 0, "agree": 0, "agreement_rate": None},
                      "days": []}
        else:
            result = build(fetch_rows(base, key, start, end), start, end, now)
    except Unreachable as exc:
        print(f"::warning::news provider compare: Supabase unreachable ({exc}); nothing written")
        return 0
    result = keep_generated(result, args.out)
    with open(args.out, "w") as f:
        json.dump(result, f, indent=2, sort_keys=True)
        f.write("\n")
    print(f"news provider compare: {result['trial_days']} trial days, recommendation {result['recommendation']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
