#!/usr/bin/env python3
"""Meta supervisor: daily, rule-based check that the AI supervisors still work.

Checks:
  A. Validator canary  - runs lineSafe() via Node and verifies known-bad and known-safe lines.
  B. News judge health - reads yesterday's news_verdicts from Supabase PostgREST.
  C. Insights files    - verifies labels, SIMULATED tag and freshness of insights.json and strategies.json.

Stdlib + requests only. No AI. No LLM calls.
Secrets only from env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, GITHUB_TOKEN, GITHUB_REPOSITORY.
Exit 0 always (alerts go through a GitHub issue). Exit 1 only on a crash.
"""
import datetime as dt
import json
import os
import subprocess
import sys

import requests

OK, WARN, ALERT = "OK", "WARN", "ALERT"
RANK = {OK: 0, WARN: 1, ALERT: 2}
LABEL = "meta-supervisor"
TIMEOUT = 20
STALE_DAYS = 10

# Node one-liner that reads a JSON array of strings on stdin and returns a JSON array of booleans.
# Each boolean is the result of lineSafe(string) from validator.js.
# Uses ESM-compatible fs import (no require in --input-type=module context).
_NODE_EVAL = (
    "import {readFileSync} from 'fs';"
    "import('./worker/src/agents/validator.js')"
    ".then(m=>{"
    "const t=readFileSync(0,'utf8');"
    "process.stdout.write(JSON.stringify(JSON.parse(t).map(s=>m.lineSafe(s))))"
    "})"
)

# Lines that MUST be flagged by lineSafe() (returns false).
# Each line is matched against the patterns in validator.js: ADVICE, GUARANTEE, PII, ORDER, ECHO, V10, V11.
BAD_LINES = [
    # ADVICE - V4
    "You should buy NVDA now",
    "You should sell your position immediately",
    "You should short the market this week",
    "I recommend buying Apple shares",
    "I suggest selling before the earnings",
    "Buy MSFT now before the rally ends",
    "Sell AMZN now while it is high",
    "This is the best stock for you",
    "Allocate 25% to tech stocks",
    "This fund is expected to outperform the market",
    "This strategy is likely to beat the index",
    "NVDA is likely to outperform the S&P 500",
    "This position is worth copying",
    "You could copy this trade",
    "Consider following this senator's trades",
    # GUARANTEE - V5
    "This is a guaranteed return",
    "This investment is risk-free return",
    # PII - V6
    "123-45-6789",
    "Account number 123456789012",
    "Call 555-867-5309 for details",
    # V10 - em or en dash
    "Strong performance \u2013 worth watching",
]

# Lines that MUST pass lineSafe() (returns true).
SAFE_LINES = [
    "Members filed 40 trades last month.",
    "The fund tracked the index closely over the past year.",
    "Historical data shows no statistically significant edge.",
    "Congress filings are public record.",
    "The analysis covers data from 2021 to 2024.",
    "Senate purchases were reviewed using public disclosures.",
    "Past results do not predict future results.",
    "Three ETFs appear in the top holdings list.",
    "The backtest period starts in 2021.",
    "No actionable recommendation is made here.",
]


# ---------------------------------------------------------------- check A: validator canary
def check_canary():
    """Run lineSafe() via Node for each test line. Returns list of (severity, text)."""
    findings = []
    all_lines = BAD_LINES + SAFE_LINES
    payload = json.dumps(all_lines).encode()
    try:
        result = subprocess.run(
            ["node", "--input-type=module", "-e", _NODE_EVAL],
            input=payload,
            capture_output=True,
            timeout=60,
        )
    except FileNotFoundError:
        findings.append((WARN, "node not found; skipping canary check"))
        return findings
    except subprocess.TimeoutExpired:
        findings.append((WARN, "canary timed out after 60 s"))
        return findings
    except Exception as exc:
        findings.append((WARN, f"canary subprocess failed ({type(exc).__name__})"))
        return findings

    stderr = result.stderr.decode("utf-8", errors="replace").strip()
    if result.returncode != 0:
        short = stderr[:200] if stderr else "(no stderr)"
        findings.append((WARN, f"canary node exited {result.returncode}: {short}"))
        return findings

    try:
        flags = json.loads(result.stdout)
    except (ValueError, UnicodeDecodeError):
        findings.append((WARN, "canary returned non-JSON"))
        return findings

    if not isinstance(flags, list) or len(flags) != len(all_lines):
        findings.append((WARN, f"canary returned {len(flags) if isinstance(flags, list) else '?'} results, expected {len(all_lines)}"))
        return findings

    for i, line in enumerate(BAD_LINES):
        safe = flags[i]
        if safe is not False:
            findings.append((ALERT, f"canary miss: bad line not flagged: {line[:80]}"))

    offset = len(BAD_LINES)
    for j, line in enumerate(SAFE_LINES):
        safe = flags[offset + j]
        if safe is not True:
            findings.append((ALERT, f"canary miss: safe line was flagged: {line[:80]}"))

    if not findings:
        findings.append((OK, f"canary passed ({len(BAD_LINES)} bad + {len(SAFE_LINES)} safe lines)"))

    return findings


# ---------------------------------------------------------------- check B: news judge health
def check_news_judge(supabase_url, supabase_key, yesterday):
    """Query news_verdicts for yesterday. Returns list of (severity, text)."""
    url = f"{supabase_url}/rest/v1/news_verdicts"
    params = {"select": "id,ticker,run_date,status", "run_date": f"eq.{yesterday}"}
    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
    }
    try:
        r = requests.get(url, params=params, headers=headers, timeout=TIMEOUT)
    except Exception as exc:
        return [(WARN, f"news judge: Supabase unreachable ({type(exc).__name__})")]

    if r.status_code >= 400:
        return [(WARN, f"news judge: Supabase returned HTTP {r.status_code}")]

    try:
        rows = r.json()
    except ValueError:
        return [(WARN, "news judge: Supabase returned non-JSON")]

    if not isinstance(rows, list):
        return [(WARN, "news judge: unexpected response shape")]

    if len(rows) == 0:
        return [(WARN, f"news judge: 0 verdicts for {yesterday}")]

    not_ok = sum(1 for row in rows if row.get("status") != "ok")
    pct = not_ok * 100 // len(rows)
    if pct > 20:
        return [(WARN, f"news judge: {not_ok}/{len(rows)} verdicts ({pct}%) have status other than ok for {yesterday}")]

    return [(OK, f"news judge: {len(rows)} verdicts for {yesterday}, {not_ok} not-ok ({pct}%)")]


# ---------------------------------------------------------------- check C: insights files
def check_insights_files(now):
    """Verify insights.json and strategies.json. Returns list of (severity, text)."""
    findings = []

    for fname, must_contain_simulated in [("insights.json", False), ("strategies.json", True)]:
        try:
            with open(fname, encoding="utf-8") as fh:
                data = json.load(fh)
        except FileNotFoundError:
            findings.append((ALERT, f"{fname}: file not found"))
            continue
        except ValueError:
            findings.append((ALERT, f"{fname}: invalid JSON"))
            continue

        label = data.get("label")
        if not label:
            findings.append((ALERT, f"{fname}: missing label"))
        elif must_contain_simulated and "SIMULATED" not in label:
            findings.append((ALERT, f"{fname}: label does not contain SIMULATED"))

        generated = data.get("generated", "")
        if not generated:
            findings.append((WARN, f"{fname}: missing generated timestamp"))
        elif generated.startswith("1970"):
            findings.append((OK, f"{fname}: generated is placeholder (pending)"))
        else:
            try:
                gen_dt = dt.datetime.fromisoformat(generated.replace("Z", "+00:00"))
                age = (now - gen_dt).days
                if age >= STALE_DAYS:
                    findings.append((WARN, f"{fname}: generated is {age} days old (stale)"))
                else:
                    findings.append((OK, f"{fname}: generated {age} day(s) ago, label present"))
            except ValueError:
                findings.append((WARN, f"{fname}: cannot parse generated timestamp"))

    return findings


# ---------------------------------------------------------------- report
def render(now, findings, overall):
    yesterday = (now - dt.timedelta(days=1)).strftime("%Y-%m-%d")
    lines = [
        f"# Meta supervisor: {now:%Y-%m-%d} {overall}",
        "",
        f"Run: {now:%Y-%m-%d %H:%M} UTC. Checks: validator canary, news judge ({yesterday}), insights files.",
        "",
        "## Findings",
    ]
    sorted_f = sorted(findings, key=lambda x: -RANK[x[0]])
    for sev, text in sorted_f:
        lines.append(f"- {sev}: {text}")
    if not sorted_f:
        lines.append("- None")
    lines.append("")
    lines.append("## Summary")
    counts = {OK: 0, WARN: 0, ALERT: 0}
    for sev, _ in findings:
        counts[sev] = counts.get(sev, 0) + 1
    lines.append(f"ALERT: {counts[ALERT]}  WARN: {counts[WARN]}  OK: {counts[OK]}")
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------- GitHub issue
def _gh(token, method, path, **kw):
    return requests.request(
        method,
        f"https://api.github.com{path}",
        timeout=TIMEOUT,
        **kw,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )


def sync_issue(token, repo, now, overall, report):
    def h(method, path, **kw):
        return _gh(token, method, f"/repos/{repo}{path}", **kw)

    r = h("GET", f"/issues?labels={LABEL}&state=open&per_page=20")
    open_issues = [i for i in (r.json() if r.status_code == 200 else []) if "pull_request" not in i]

    title = f"Meta supervisor: {now:%Y-%m-%d} {overall}"

    if h("GET", f"/labels/{LABEL}").status_code == 404:
        h("POST", "/labels", json={"name": LABEL, "color": "e4e669", "description": "Daily meta-supervisor findings"})

    if open_issues:
        n = open_issues[0]["number"]
        h("PATCH", f"/issues/{n}", json={"title": title, "body": report})
        h("POST", f"/issues/{n}/comments", json={"body": f"Updated {now:%Y-%m-%d %H:%M} UTC: {overall}."})
    else:
        h("POST", "/issues", json={"title": title, "body": report, "labels": [LABEL]})


# ---------------------------------------------------------------- main
def main():
    now = dt.datetime.now(dt.timezone.utc)
    yesterday = (now - dt.timedelta(days=1)).strftime("%Y-%m-%d")

    supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    github_token = os.environ.get("GITHUB_TOKEN", "")
    github_repo = os.environ.get("GITHUB_REPOSITORY", "")

    all_findings = []

    # A: validator canary
    all_findings.extend(check_canary())

    # B: news judge health
    if supabase_url and supabase_key:
        all_findings.extend(check_news_judge(supabase_url, supabase_key, yesterday))
    else:
        all_findings.append((WARN, "news judge: SUPABASE_URL or SUPABASE_SERVICE_KEY not set"))

    # C: insights files
    all_findings.extend(check_insights_files(now))

    overall = max((s for s, _ in all_findings), key=lambda s: RANK[s], default=OK)
    report = render(now, all_findings, overall)

    print(f"::notice::meta-supervisor {now:%Y-%m-%d} {overall}")

    if github_token and github_repo:
        try:
            sync_issue(github_token, github_repo, now, overall, report)
        except Exception as exc:
            print(f"::warning::issue sync failed ({type(exc).__name__})")

    print(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
