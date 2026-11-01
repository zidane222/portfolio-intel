#!/usr/bin/env python3
"""Meta supervisor: daily, rule-based check that the AI supervisors still work.

Checks:
  A. Validator canary  - runs lineSafe() via Node and verifies known-bad and known-safe lines.
  B. News judge health - reads yesterday's news_verdicts from Supabase PostgREST.
  C. Insights files    - verifies labels, SIMULATED tag and freshness of insights.json and strategies.json.
  D. Source reconciliation - judges the daily cross-check between official House and Senate records
     and FMP, from trades.json on main. The trades job computes it; this check owns the verdict.
  E. Ask pipeline health - the gateway's per-case log lines from the last 24 h (Cloudflare telemetry):
     fallback rate, the rules that failed most, and any intent that keeps falling back.
  F. Peer heartbeat - the SOC monitor ran in the last 26 h (the SOC monitor checks this job the same way).

Stdlib + requests only. No AI. No LLM calls.
Secrets only from env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, GITHUB_TOKEN, GITHUB_REPOSITORY, cfk, cfkd.
Exit 0 always (alerts go through a GitHub issue). Exit 1 only on a crash.
"""
import datetime as dt
import json
from collections import Counter
import os
import re
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

    # news_verdicts.status is PASS, fallback, thin, skipped or error (supabase/news.sql).
    # PASS, thin (too few headlines) and skipped are healthy outcomes; fallback and error mean the judge failed.
    not_ok = sum(1 for row in rows if row.get("status") in ("fallback", "error"))
    pct = not_ok * 100 // len(rows)
    if pct > 20:
        return [(WARN, f"news judge: {not_ok}/{len(rows)} verdicts ({pct}%) failed (fallback or error) for {yesterday}")]

    return [(OK, f"news judge: {len(rows)} verdicts for {yesterday}, {not_ok} failed ({pct}%)")]


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


# ---------------------------------------------------------------- D: source reconciliation
FMP_ACCURACY_MIN = 0.95      # share of our official House trades FMP also has
HOUSE_COMPLETE_WARN = 0.95   # share of FMP's House trades our official scrape has
HOUSE_COMPLETE_ALERT = 0.80
SENATE_AGREE_MIN = 0.95
RECON_MAX_AGE_HOURS = 36
MIN_SAMPLE = 10


def _plain(text, n=60):
    """Names and reasons come from public filings; keep them to plain text in the issue body."""
    return re.sub(r"[^\w ,.'()/-]", "", str(text))[:n]


def check_reconciliation(now, path="trades.json"):
    """Official records vs FMP, both chambers. Returns list of (severity, text)."""
    try:
        with open(path, encoding="utf-8") as fh:
            d = json.load(fh)
    except FileNotFoundError:
        return [(ALERT, "reconciliation: trades.json not found")]
    except ValueError:
        return [(ALERT, "reconciliation: trades.json is not valid JSON")]
    findings = []

    try:
        ts = dt.datetime.fromisoformat(str(d.get("updated") or "").replace("Z", "+00:00"))
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=dt.timezone.utc)
        age_h = (now - ts).total_seconds() / 3600
        if age_h > RECON_MAX_AGE_HOURS:
            findings.append((WARN, f"reconciliation: trades data is {age_h:.0f} hours old, the daily trades job may not have run"))
    except (ValueError, TypeError):
        findings.append((WARN, "reconciliation: trades.json has no readable updated time"))

    # House: both directions
    hc = d.get("fmp_house_check")
    if not hc:
        findings.append((WARN, "reconciliation: no House cross-check in trades.json (the FMP step failed or was skipped)"))
    else:
        oc, of = hc.get("ours_checked") or 0, hc.get("ours_found_in_fmp") or 0
        if oc >= MIN_SAMPLE:
            sev = WARN if of / oc < FMP_ACCURACY_MIN else OK
            findings.append((sev, f"House, FMP accuracy: FMP has {of} of {oc} recent official House trades ({100 * of / oc:.0f}%)"))
        checked, matched = hc.get("checked") or 0, hc.get("matched") or 0
        if checked >= MIN_SAMPLE:
            filled = hc.get("filled_from_fmp") or 0
            rate = (matched + filled) / checked  # official reads first, FMP only for filings we cannot read
            sev = ALERT if rate < HOUSE_COMPLETE_ALERT else WARN if rate < HOUSE_COMPLETE_WARN else OK
            other = hc.get("matched_other_symbol") or 0
            parts = [f"{matched} read from official filings" + (f" ({other} under a different symbol)" if other else "")]
            if filled:
                parts.append(f"{filled} from FMP for scanned paper filings we cannot read")
            findings.append((sev, f"House, our completeness: we have {matched + filled} of {checked} recent House trades FMP lists ({100 * rate:.0f}%): " + ", ".join(parts)))
        causes = hc.get("miss_causes") or {}
        if causes:
            findings.append((OK, "House misses by cause: " + ", ".join(f"{_plain(k).replace('_', ' ')} {_plain(v, 6)}" for k, v in sorted(causes.items()))))
        # Members FMP shows trading who have no trades at all in our data
        missing = {}
        for mi in hc.get("misses") or []:
            if str(mi.get("cause", "")).startswith("member_has_no_trades"):
                name = _plain((mi.get("fmp") or ["?"])[0], 30)
                missing.setdefault(name, [0, False])
                missing[name][0] += 1
                missing[name][1] |= mi["cause"].endswith("filing_unreadable")
        for name, (n, unreadable) in sorted(missing.items()):
            # Unknown cause with several trades is an alert; a filing we know we cannot read yet is a warning
            sev = WARN if unreadable or n < 2 else ALERT
            why = ", our scraper could not read the filing" if unreadable else ""
            findings.append((sev, f"House member {name}: {n} trade(s) on FMP, none in our data{why}"))

    # House: filings the scraper could not read, and bad dates
    pr = d.get("house_parse_report") or {}
    empty = pr.get("empty") or []
    scanned = [e for e in empty if "scanned" in str(e.get("reason", ""))]
    failed = [e for e in empty if e not in scanned and str(e.get("reason", "")).startswith(("download failed", "parse error"))]
    # The parse report covers the whole year, so known gaps are noted, not warned on every day
    if scanned:
        names = ", ".join(sorted({_plain(e.get("name"), 30) for e in scanned})[:5])
        findings.append((OK, f"House: {len(scanned)} scanned paper filing(s) this year not read, needs OCR ({names})"))
    if failed:
        names = ", ".join(sorted({_plain(e.get("name"), 30) for e in failed})[:5])
        findings.append((WARN, f"House: {len(failed)} filing(s) failed to download or parse ({names})"))
    if pr.get("date_suspect"):
        findings.append((OK, f"House: {_plain(pr['date_suspect'], 6)} trade(s) this year dated after their filing date"))

    # Senate: the official site only answers on some days; FMP is the fallback
    oc, of = d.get("senate_official_count") or 0, d.get("senate_official_in_fmp") or 0
    # Senate staleness is alerted by the SOC monitor; not repeated here
    if oc >= MIN_SAMPLE:
        sev = WARN if of / oc < SENATE_AGREE_MIN else OK
        findings.append((sev, f"Senate, FMP accuracy: FMP has {of} of {oc} trades from the official Senate site ({100 * of / oc:.0f}%)"))
    elif oc:
        findings.append((OK, f"Senate: official site returned {oc} trade(s), too few to compare"))
    else:
        findings.append((OK, "Senate: official site not checked today (blocked or down), Senate data is FMP only and unverified"))
    return findings


# ---------------------------------------------------------------- E: Ask pipeline health
ASK_MIN_CASES = 5           # fewer cases in 24 h: report only, no verdict
ASK_FALLBACK_WARN = 0.25    # share of cases shown as "sources only"
ASK_FALLBACK_ALERT = 0.50
ASK_INTENT_MIN = 3          # an intent with this many cases ...
ASK_INTENT_WARN = 0.66      # ... and this share falling back is named
GATEWAY = "portfolio-intel-api"


def ask_cases(events):
    """Parse the gateway's {"ask":1,...} log lines (supervisor.js finish()). Ignores anything else."""
    out = []
    for e in events or []:
        m = (e.get("$metadata") or {}).get("message") or ""
        if not isinstance(m, str) or not re.search(r'"ask"\s*:\s*1\b', m):
            continue
        try:
            d = json.loads(m[m.index("{"):])
        except (ValueError, TypeError):
            continue
        if d.get("ask") == 1:
            out.append({"status": str(d.get("status") or ""), "intent": _plain(d.get("intent") or "general", 20),
                        "flags": [_plain(x, 6) for x in (d.get("flags") or []) if isinstance(x, str)]})
    return out


def judge_ask(cases):
    """Severity findings from parsed cases. Pure, for tests."""
    n = len(cases)
    if n == 0:
        return [(OK, "Ask: no checked questions in the last 24 h")]
    fb = [c for c in cases if c["status"] != "PASS"]
    rate = len(fb) / n
    flags = Counter(f for c in fb for f in c["flags"])
    top = ", ".join(f"{k} {v}" for k, v in flags.most_common(3)) or "none"
    if n < ASK_MIN_CASES:
        return [(OK, f"Ask: {n} question(s) in 24 h, {len(fb)} shown as sources only (too few to judge). Top rules: {top}")]
    sev = ALERT if rate >= ASK_FALLBACK_ALERT else WARN if rate >= ASK_FALLBACK_WARN else OK
    findings = [(sev, f"Ask: {len(fb)} of {n} answers in 24 h fell back to sources only ({100 * rate:.0f}%). Top rules: {top}")]
    by = {}
    for c in cases:
        by.setdefault(c["intent"], [0, 0])
        by[c["intent"]][0] += 1
        by[c["intent"]][1] += c["status"] != "PASS"
    for intent, (k, bad) in sorted(by.items()):
        if k >= ASK_INTENT_MIN and bad / k >= ASK_INTENT_WARN:
            findings.append((WARN, f"Ask intent {intent}: {bad} of {k} answers fell back to sources only"))
    return findings


def check_ask_health(token, acct, now):
    if not token or not acct:
        return [(WARN, "Ask health: Cloudflare token or account not set (cfk, cfkd)")]
    import soc_monitor as soc  # same Cloudflare telemetry helpers as the SOC monitor
    frm = now - dt.timedelta(hours=24)
    gw = soc._flt("$workers.scriptName", "eq", GATEWAY)
    try:
        try:
            events = soc.cf_events(token, acct, frm, now, [gw, soc._flt("$metadata.message", "includes", '"ask":1')], 1000)
        except soc.SourceError:
            events = soc.cf_events(token, acct, frm, now, [gw], 1000)  # filter not supported: parse locally
    except soc.SourceError as e:
        return [(WARN, f"Ask health: {_plain(e, 80)}")]
    findings = judge_ask(ask_cases(events))
    if len(events or []) >= 1000:
        findings.append((OK, "Ask: read the newest 1000 log lines only, so counts above may be low on a busy day"))
    return findings


# ---------------------------------------------------------------- F: peer heartbeat
PEER_MAX_HOURS = 26


def peer_status(runs, now, hours=PEER_MAX_HOURS):
    """Shared with the SOC monitor (one implementation)."""
    import soc_monitor as soc
    return soc.peer_status(runs, now, hours)


def check_peer(token, repo, now):
    if not token or not repo:
        return [(WARN, "SOC monitor heartbeat: GITHUB_TOKEN or GITHUB_REPOSITORY not set")]
    try:
        r = _gh(token, "GET", f"/repos/{repo}/actions/workflows/soc-monitor.yml/runs?per_page=10")
        runs = r.json().get("workflow_runs") if r.status_code == 200 else None
    except Exception as exc:
        return [(WARN, f"SOC monitor heartbeat: not readable ({type(exc).__name__})")]
    if runs is None:
        return [(WARN, f"SOC monitor heartbeat: not readable (HTTP {r.status_code})")]
    st = peer_status(runs, now)
    sev = {"success": OK, "running": OK, "failure": WARN, "missing": ALERT}[st]
    text = {"success": "SOC monitor ran in the last 26 h", "running": "SOC monitor is running now",
            "failure": "SOC monitor failed on its last run in the last 26 h", "missing": "SOC monitor has not run in the last 26 h"}[st]
    return [(sev, text)]


# ---------------------------------------------------------------- report
def render(now, findings, overall):
    yesterday = (now - dt.timedelta(days=1)).strftime("%Y-%m-%d")
    lines = [
        f"# Meta supervisor: {now:%Y-%m-%d} {overall}",
        "",
        f"Run: {now:%Y-%m-%d %H:%M} UTC. Checks: validator canary, news judge ({yesterday}), insights files, source reconciliation, Ask health, SOC monitor heartbeat.",
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

    # Same cleanup as soc_monitor: the secrets may carry quotes, spaces or a trailing /rest/v1
    supabase_url = re.sub(r"(/rest/v1)?/*$", "", os.environ.get("SUPABASE_URL", "").strip().strip('"').strip("'"))
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip().strip('"').strip("'")
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

    # D: source reconciliation (official records vs FMP). A malformed trades.json must not stop the run
    try:
        all_findings.extend(check_reconciliation(now))
    except Exception as exc:
        all_findings.append((ALERT, f"reconciliation: check failed on trades.json ({type(exc).__name__})"))

    # E: Ask pipeline health, F: SOC monitor heartbeat. Neither may stop the run.
    clean = lambda v: re.sub(r"\s+", "", v or "")
    for name, fn in (("Ask health", lambda: check_ask_health(clean(os.environ.get("cfk") or os.environ.get("cf")), clean(os.environ.get("cfkd")), now)),
                     ("SOC monitor heartbeat", lambda: check_peer(github_token, github_repo, now))):
        try:
            all_findings.extend(fn())
        except Exception as exc:
            all_findings.append((WARN, f"{name}: check failed ({type(exc).__name__})"))

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
