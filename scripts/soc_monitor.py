#!/usr/bin/env python3
"""SOC monitor: daily, rule-based, read-only checks over Cloudflare telemetry, Supabase and GitHub.

Stdlib + requests only. No AI. Never prints or stores secrets, IPs, emails, request bodies or
user-linked tickers. Exit 0 for OK, WARN and ALERT (alerts go through a GitHub issue).
Exit 1 only when a required source (Cloudflare or Supabase) cannot be reached.

Env: SP, SR (Supabase URL and service role key), cfk, cfkd (Cloudflare token, account id),
GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_STEP_SUMMARY (optional).
Dry run: soc_monitor.py --fixtures path.json   (no network, prints the report, no issue changes)
"""
import datetime as dt
import json
import os
import re
import sys
from collections import Counter

OK, WARN, ALERT = "OK", "WARN", "ALERT"
RANK = {OK: 0, WARN: 1, ALERT: 2}

# Rule thresholds, all in one place.
CRON_STREAK_ALERT = 5
FIVEXX_ALERT = 20          # more than this
FIVEXX_WARN = 5
BUDGET_WARN_PCT = 80
SPIKE_FACTOR = 3
SPIKE_MIN_REQUESTS = 200
ERROR_SPIKE_MIN = 10
SPIKE_429_MIN = 10
WARN_403_MIN = 50
SENATE_MAX_AGE_DAYS = 3
BATCH_END_HOUR_UTC = 6     # verdicts expected once this hour has passed
DATA_JOBS = {"Fetch Congress Trades": 13, "Private markets (SEC Form D and Form C)": 13}  # name: UTC hour by which a run is expected (GitHub starts scheduled runs late, often near 12:00)
CF_BASE = "https://api.cloudflare.com/client/v4/accounts/{a}/workers/observability/telemetry/query"
CF_SCRIPTS = ["pi-market", "pi-news", "pi-rates", "pi-ai", "pi-broker", "pi-disclosures",
              "pi-private", "pi-newsdesk", "portfolio-intel-api"]
LABEL = "soc-monitor"


class SourceError(Exception):
    pass


# ---------------------------------------------------------------- scrubbing
_SCRUB = [
    (re.compile(r"(?i)\b[a-z][a-z0-9+.-]*://\S+"), "{url}"),
    (re.compile(r"\beyJ[\w-]*\.[\w-]*(?:\.[\w-]*)?"), "{token}"),
    (re.compile(r"\b(?:sb_secret|sb_publishable|sbp|ghp|gho|ghs|ghu|github_pat)_[\w-]+"), "{token}"),
    (re.compile(r"(?<![\w:])(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(?![\w:])"), "{ip}"),
    (re.compile(r"(?<=/)[A-Z]{1,5}(?=[/?#\s]|$)"), "{ticker}"),
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"), "{email}"),
    (re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b"), "{ip}"),
    (re.compile(r"\b(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}\b"), "{ip}"),
    (re.compile(r"(?i)bearer\s+[\w.~+/=-]+"), "{token}"),
    (re.compile(r"\b[A-Za-z0-9_\-]{32,}\b"), "{token}"),
    (re.compile(r"(?i)(ticker|symbol|tickers|symbols)(\"?\s*[:=]\s*)(\"?\[?[^,;&}\s]*)"), r"\1\2{redacted}"),
    (re.compile(r"(?i)(body|payload|authorization|apikey|api_key|token|password)(\"?\s*[:=]\s*)\S+"), r"\1\2{redacted}"),
    (re.compile(r"\$[A-Z]{1,5}\b"), "{ticker}"),
]


def scrub(text, n=140):
    s = str(text or "").replace("\n", " ").replace("\r", " ")
    for rx, rep in _SCRUB:
        s = rx.sub(rep, s)
    # Neutralise markdown/HTML, @mentions and workflow commands (output goes to issues and summaries).
    s = s.replace("::", ": :").replace("@", "(at)")
    s = s.translate({ord(c): " " for c in "<>`[]!|\\"})
    s = re.sub(r"\s+", " ", s).strip()
    return s[:n]


# ---------------------------------------------------------------- rules (pure)
def evaluate(d, now):
    """d: collected data dict. Returns (severity, findings list of (severity, text))."""
    f = []

    def add(sev, text):
        f.append((sev, text))

    # Senate disclosures are a core feed: missing or stale data is an ALERT
    sen = d.get("senate") or {}
    if sen:
        if not sen.get("count"):
            add(ALERT, "Senate trades missing from trades.json")
        elif sen.get("stale") or (sen.get("age_days") is not None and sen["age_days"] > SENATE_MAX_AGE_DAYS):
            add(ALERT, f"Senate trades are stale: last good data is {sen.get('age_days')} days old (scrape failing)")
        # Official vs FMP reconciliation is judged by the meta supervisor (check D), not here

    cf = d.get("cloudflare") or {}
    sb = d.get("supabase") or {}
    gh = d.get("github") or {}

    # 1. Cloudflare
    tot5 = 0
    for name, s in sorted((cf.get("scripts") or {}).items()):
        c5, c429, c403 = s.get("s5xx", 0), s.get("s429", 0), s.get("s403", 0)
        tot5 += c5
        req, base = s.get("requests", 0), s.get("baseline_daily", 0)
        exc, exc_base = s.get("exceptions", 0), s.get("exceptions_baseline_daily", 0)
        if req > SPIKE_MIN_REQUESTS and req > SPIKE_FACTOR * max(base, 1):
            add(WARN, f"{name}: request spike, {req} in 24h vs {base:.0f}/day baseline")
        if exc >= ERROR_SPIKE_MIN and exc > SPIKE_FACTOR * max(exc_base, 1):
            add(WARN, f"{name}: exception spike, {exc} in 24h vs {exc_base:.1f}/day baseline")
        if c429 >= SPIKE_429_MIN and c429 > SPIKE_FACTOR * max(s.get("s429_baseline_daily", 0), 1):
            add(WARN, f"{name}: 429 spike, {c429} in 24h")
        if c403 >= WARN_403_MIN:
            add(WARN, f"{name}: {c403} responses with 403 in 24h")
    if tot5 > FIVEXX_ALERT:
        add(ALERT, f"{tot5} 5xx responses in 24h (limit {FIVEXX_ALERT})")
    elif tot5 >= FIVEXX_WARN:
        add(WARN, f"{tot5} 5xx responses in 24h")
    cron = cf.get("cron") or {}
    streak = cron.get("failure_streak", 0)
    if streak >= CRON_STREAK_ALERT:
        add(ALERT, f"pi-newsdesk cron failure streak of {streak} (limit {CRON_STREAK_ALERT})")
    elif cron.get("failures", 0) > 0:
        add(WARN, f"pi-newsdesk cron: {cron['failures']} failed of {cron.get('ticks', 0)} ticks")

    # 2. Supabase
    jobs = sb.get("jobs") or {}
    after_window = now.hour >= BATCH_END_HOUR_UTC
    if after_window and sb.get("verdicts_today", 0) == 0:
        add(ALERT, "0 news verdicts for today after the batch window")
    if jobs.get("error", 0) > 0:
        add(WARN, f"news_jobs today: {jobs['error']} in error")
    if after_window and jobs.get("pending", 0) > 0:
        add(WARN, f"news_jobs today: {jobs['pending']} still pending after the batch window")
    bud = sb.get("budget") or {}
    for key in ("calls", "tokens"):
        cap, used = bud.get(key + "_cap"), bud.get(key, 0)
        if cap and used * 100 >= BUDGET_WARN_PCT * cap:
            add(WARN, f"news budget {key}: {used}/{cap} ({100 * used // cap}%)")

    # 3. GitHub
    for fr in gh.get("failed_runs") or []:
        if fr.get("name") not in DATA_JOBS:
            add(WARN, f"workflow failed in 24h: {scrub(fr.get('name'), 60)}")
    for k, label in (("dependabot_open", "Dependabot"), ("code_scanning_open", "code scanning")):
        if (gh.get(k) or 0) > 0:
            add(WARN, f"{gh[k]} open {label} alerts")

    # 4. Data jobs
    for name, hour in DATA_JOBS.items():
        j = (gh.get("data_jobs") or {}).get(name)
        if j is None:
            continue  # not readable
        if j == "failure":
            add(ALERT, f"data job failed today: {name}")
        elif j == "missing" and now.hour >= hour:
            add(WARN, f"data job has no run today: {name}")

    sev = max((s for s, _ in f), key=lambda s: RANK[s], default=OK)
    return sev, f


# ---------------------------------------------------------------- report (pure)
def render(d, sev, findings, now):
    cf, sb, gh = d.get("cloudflare") or {}, d.get("supabase") or {}, d.get("github") or {}
    L = [f"# SOC monitor {now:%Y-%m-%d} {sev}", "", f"Window: last 24 h to {now:%Y-%m-%d %H:%M} UTC. Baseline: previous 7 days.", ""]
    L.append("## Findings")
    L += [f"- {s}: {scrub(t, 300)}" for s, t in sorted(findings, key=lambda x: -RANK[x[0]])] or ["- None"]
    L += ["", "## Cloudflare (24h)", "", "| Script | Requests | Baseline/day | 4xx | 5xx | 403 | 429 | Exceptions |", "|---|---|---|---|---|---|---|---|"]
    for n, s in sorted((cf.get("scripts") or {}).items()):
        L.append(f"| {n} | {s.get('requests', 0)} | {s.get('baseline_daily', 0):.0f} | {s.get('s4xx', 0)} | {s.get('s5xx', 0)} | {s.get('s403', 0)} | {s.get('s429', 0)} | {s.get('exceptions', 0)} |")
    c = cf.get("cron") or {}
    L += ["", f"pi-newsdesk cron: {c.get('ticks', 0)} ticks, {c.get('failures', 0)} failed, current failure streak {c.get('failure_streak', 0)}."]
    top = cf.get("top_errors") or []
    if top:
        L += ["", "Top errors (messages truncated, scrubbed):"] + [f"- {n}x {scrub(m)}" for m, n in top[:5]]
    jobs = sb.get("jobs") or {}
    b = sb.get("budget") or {}
    L += ["", "## Supabase", "",
          "- news_jobs today: " + (", ".join(f"{k}={v}" for k, v in sorted(jobs.items())) or "none"),
          f"- news_verdicts today: {sb.get('verdicts_today', 0)}",
          f"- news_budget: calls {b.get('calls', 0)}/{b.get('calls_cap', '?')}, tokens {b.get('tokens', 0)}/{b.get('tokens_cap', '?')}"]
    L += ["", "## GitHub", "",
          f"- failed workflow runs (24h): {len(gh.get('failed_runs') or [])}",
          f"- Dependabot open alerts: {gh.get('dependabot_open', 'not readable')}",
          f"- code scanning open alerts: {gh.get('code_scanning_open', 'not readable')}"]
    for n, v in (gh.get("data_jobs") or {}).items():
        L.append(f"- {n}: {v}")
    return "\n".join(L) + "\n"


def notice_lines(d, sev, findings, now):
    cf, sb = d.get("cloudflare") or {}, d.get("supabase") or {}
    req = sum(s.get("requests", 0) for s in (cf.get("scripts") or {}).values())
    e5 = sum(s.get("s5xx", 0) for s in (cf.get("scripts") or {}).values())
    c = cf.get("cron") or {}
    return [f"::notice::SOC {now:%Y-%m-%d} {sev}: {len(findings)} findings",
            f"::notice::requests={req} 5xx={e5} cron_ticks={c.get('ticks', 0)} cron_failures={c.get('failures', 0)} streak={c.get('failure_streak', 0)}",
            f"::notice::verdicts_today={sb.get('verdicts_today', 0)} jobs={json.dumps({scrub(k, 30): v for k, v in (sb.get('jobs') or {}).items()}, sort_keys=True)} budget_calls={(sb.get('budget') or {}).get('calls', 0)}"]


# ---------------------------------------------------------------- collectors
def _req():
    import requests
    return requests


def _clean(v):
    return re.sub(r"\s+", "", v or "")


def cf_post(token, acct, body):
    try:
        r = _req().post(CF_BASE.format(a=acct), json=body, timeout=40,
                        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        d = r.json()
    except Exception as e:
        raise SourceError(f"cloudflare unreachable ({type(e).__name__})")
    if r.status_code >= 400 or not d.get("success"):
        raise SourceError(f"cloudflare query failed HTTP {r.status_code}")
    return d.get("result") or {}


def _tf(frm, to):
    return {"from": int(frm.timestamp() * 1000), "to": int(to.timestamp() * 1000)}


def cf_grouped(token, acct, frm, to, group_keys, filters=()):
    """Count events grouped by keys. Returns list of (dict key->value, count)."""
    body = {"queryId": "soc", "timeframe": _tf(frm, to), "view": "calculations", "limit": 200,
            "parameters": {"calculations": [{"operator": "count", "alias": "n"}],
                           "groupBys": [{"type": "string", "value": k} for k in group_keys],
                           "filters": list(filters)}}
    res = cf_post(token, acct, body)
    out = []
    for agg in ((res.get("calculations") or [{}])[0].get("aggregates") or []):
        groups = {g.get("key"): g.get("value") for g in agg.get("groups") or []}
        out.append((groups, int(agg.get("count") or agg.get("n") or 0)))
    return out


def cf_events(token, acct, frm, to, filters, limit=100):
    body = {"queryId": "soc-ev", "timeframe": _tf(frm, to), "view": "events", "limit": limit,
            "parameters": {"filters": list(filters)}}
    return ((cf_post(token, acct, body).get("events") or {}).get("events")) or []


def _flt(key, op, val, typ="string"):
    return {"key": key, "operation": op, "type": typ, "value": val}


def collect_cloudflare(token, acct, now):
    t24, t7 = now - dt.timedelta(hours=24), now - dt.timedelta(days=8)
    keys = ["$workers.scriptName", "$workers.event.response.status"]
    cur = cf_grouped(token, acct, t24, now, keys)
    base = cf_grouped(token, acct, t7, t24, keys)
    exc_f = [_flt("$workers.outcome", "eq", "exception")]
    exc_cur = cf_grouped(token, acct, t24, now, ["$workers.scriptName"], exc_f)
    exc_base = cf_grouped(token, acct, t7, t24, ["$workers.scriptName"], exc_f)
    scripts = {n: {"requests": 0, "baseline_daily": 0.0, "s4xx": 0, "s5xx": 0, "s403": 0, "s429": 0,
                   "s429_baseline_daily": 0.0, "exceptions": 0, "exceptions_baseline_daily": 0.0} for n in CF_SCRIPTS}
    for g, n in cur:
        s = scripts.get(g.get("$workers.scriptName"))
        if s is None:
            continue
        s["requests"] += n
        try:
            code = int(g.get("$workers.event.response.status"))
        except (TypeError, ValueError):
            continue
        s["s4xx"] += n if 400 <= code < 500 else 0
        s["s5xx"] += n if code >= 500 else 0
        s["s403"] += n if code == 403 else 0
        s["s429"] += n if code == 429 else 0
    for g, n in base:
        s = scripts.get(g.get("$workers.scriptName"))
        if s is None:
            continue
        s["baseline_daily"] += n / 7.0
        if str(g.get("$workers.event.response.status")) == "429":
            s["s429_baseline_daily"] += n / 7.0
    for g, n in exc_cur:
        if g.get("$workers.scriptName") in scripts:
            scripts[g["$workers.scriptName"]]["exceptions"] += n
    for g, n in exc_base:
        if g.get("$workers.scriptName") in scripts:
            scripts[g["$workers.scriptName"]]["exceptions_baseline_daily"] += n / 7.0
    # cron outcomes, newest first. A tick can end "ok" at the platform level after logging
    # "newsdesk tick failed" (the handler catches its own errors), so count those logs as failures.
    nd = _flt("$workers.scriptName", "eq", "pi-newsdesk")
    evs = cf_events(token, acct, t24, now, [nd, _flt("$workers.eventType", "eq", "scheduled")], 200)
    failed_ts = set()
    try:
        for e in cf_events(token, acct, t24, now, [nd], 500):
            m = e.get("$metadata") or {}
            if "tick failed" in str(m.get("message") or m.get("error") or ""):
                failed_ts.add(e.get("timestamp"))
    except SourceError:
        pass
    rows, seen_ts = [], set()
    for e in evs:
        w = e.get("$workers") or {}
        if not (w.get("outcome") or w.get("scheduledTime") or w.get("event")):
            continue  # log lines, not the tick itself
        ts = e.get("timestamp") or 0
        if ts in seen_ts:
            continue  # the tick and its log lines share a timestamp: count the tick once
        seen_ts.add(ts)
        bad = str(w.get("outcome") or "ok") not in ("ok",) or ts in failed_ts
        rows.append((ts, bad))
    rows.sort(reverse=True)
    streak = 0
    for _, bad in rows:
        if not bad:
            break
        streak += 1
    failures = sum(1 for _, bad in rows if bad)
    # error messages grouped, scrubbed, no bodies
    errs = Counter()
    try:
        for e in cf_events(token, acct, t24, now, [_flt("$metadata.level", "eq", "error")], 100):
            m = e.get("$metadata") or {}
            errs[scrub(m.get("message") or m.get("error") or "unknown", 120)] += 1
    except SourceError:
        pass
    return {"scripts": scripts, "cron": {"ticks": len(rows), "failures": failures, "failure_streak": streak},
            "top_errors": errs.most_common(5)}


def sb_get(base, key, path):
    try:
        r = _req().get(f"{base}/rest/v1/{path}", timeout=30,
                       headers={"apikey": key, "Authorization": f"Bearer {key}"})
    except Exception as e:
        raise SourceError(f"supabase unreachable ({type(e).__name__})")
    if r.status_code >= 400:
        raise SourceError(f"supabase query failed HTTP {r.status_code}")
    try:
        return r.json()
    except ValueError:
        raise SourceError("supabase returned non-JSON")


def collect_supabase(base, key, now, caps):
    today = f"{now:%Y-%m-%d}"
    jobs = Counter(scrub(r.get("status"), 30) for r in sb_get(base, key, f"news_jobs?select=status&run_date=eq.{today}&limit=1000"))
    ver = sb_get(base, key, f"news_verdicts?select=id&run_date=eq.{today}&limit=1000")
    bud = (sb_get(base, key, f"news_budget?select=calls,tokens,batch_calls&day=eq.{today}") or [{}])[0]
    return {"jobs": dict(jobs), "verdicts_today": len(ver),
            "budget": {"calls": bud.get("calls", 0), "tokens": bud.get("tokens", 0),
                       "calls_cap": caps[0], "tokens_cap": caps[1]}}


def gh_api(token, method, path, **kw):
    return _req().request(method, f"https://api.github.com{path}", timeout=30, **kw,
                          headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                                   "X-GitHub-Api-Version": "2022-11-28"})


def collect_github(token, repo, now):
    out = {"failed_runs": [], "data_jobs": {}}
    since = (now - dt.timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        r = gh_api(token, "GET", f"/repos/{repo}/actions/runs?per_page=100&created=>={since}")
        if r.status_code != 200:
            return out
        runs = r.json().get("workflow_runs") or []
    except Exception:
        return out
    for run in runs:
        if run.get("conclusion") == "failure" and run.get("name") != "SOC monitor":
            out["failed_runs"].append({"name": run.get("name")})
    today = f"{now:%Y-%m-%d}"
    for name in DATA_JOBS:
        mine = [x for x in runs if x.get("name") == name and (x.get("created_at") or "").startswith(today)
                and x.get("event") in ("schedule", "workflow_dispatch")]
        if not mine:
            out["data_jobs"][name] = "missing"
        elif any(x.get("conclusion") == "success" for x in mine):
            out["data_jobs"][name] = "success"
        elif any(x.get("status") != "completed" for x in mine):
            out["data_jobs"][name] = "running"
        else:
            out["data_jobs"][name] = "failure"
    for key, path in (("dependabot_open", "dependabot/alerts?state=open&per_page=100"),
                      ("code_scanning_open", "code-scanning/alerts?state=open&per_page=100")):
        try:
            r = gh_api(token, "GET", f"/repos/{repo}/{path}")
            if r.status_code == 200:
                out[key] = len(r.json())
        except Exception:
            pass
    return out


# ---------------------------------------------------------------- issues
def sync_issue(token, repo, now, sev, report):
    def h(m, p, **kw):
        return gh_api(token, m, f"/repos/{repo}{p}", **kw)

    r = h("GET", f"/issues?labels={LABEL}&state=open&per_page=20")
    open_issues = [i for i in (r.json() if r.status_code == 200 else []) if "pull_request" not in i]
    title = f"SOC monitor: {now:%Y-%m-%d} {sev}"
    if sev == OK:
        for i in open_issues:
            h("POST", f"/issues/{i['number']}/comments", json={"body": f"{now:%Y-%m-%d}: all checks OK. Closing."})
            h("PATCH", f"/issues/{i['number']}", json={"state": "closed", "state_reason": "completed"})
        return
    if h("GET", f"/labels/{LABEL}").status_code == 404:
        h("POST", "/labels", json={"name": LABEL, "color": "b60205", "description": "Daily SOC monitor findings"})
    if open_issues:
        n = open_issues[0]["number"]
        h("PATCH", f"/issues/{n}", json={"title": title, "body": report})
        h("POST", f"/issues/{n}/comments", json={"body": f"Updated {now:%Y-%m-%d %H:%M} UTC: {sev}."})
    else:
        h("POST", "/issues", json={"title": title, "body": report, "labels": [LABEL]})


# ---------------------------------------------------------------- main
def emit(d, now, write_summary=True):
    sev, findings = evaluate(d, now)
    report = render(d, sev, findings, now)
    for line in notice_lines(d, sev, findings, now):
        print(line)
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if write_summary and path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(report)
    return sev, findings, report


def collect_senate(now, path="trades.json"):
    """Senate feed health from the published trades.json in the checkout (counts and dates only)."""
    try:
        d = json.load(open(path))
    except (OSError, ValueError):
        return {}
    count = sum(1 for x in d.get("trades", []) if x.get("source") == "senate")
    asof = d.get("senate_as_of")
    age = None
    if asof:
        try:
            age = (now.date() - dt.date.fromisoformat(asof)).days
        except ValueError:
            age = None
    return {"count": count, "stale": bool(d.get("senate_stale")), "age_days": age, "house_check": d.get("fmp_house_check") or {}}


def main(argv):
    if len(argv) >= 3 and argv[1] == "--fixtures":
        with open(argv[2], encoding="utf-8") as fh:
            fx = json.load(fh)
        now = dt.datetime.fromisoformat(fx["now"]).replace(tzinfo=dt.timezone.utc)
        _, _, report = emit(fx["data"], now, write_summary=False)
        print(report)
        return 0
    now = dt.datetime.now(dt.timezone.utc)
    env = os.environ
    data, problems = {}, []
    try:
        data["cloudflare"] = collect_cloudflare(_clean(env.get("cfk") or env.get("cf")), _clean(env.get("cfkd")), now)
    except SourceError as e:
        problems.append(str(e))
    try:
        base = re.sub(r"(/rest/v1)?/*$", "", _clean(env.get("SP")))
        caps = (int(env.get("NEWS_CALLS_DAY", "90")), int(env.get("NEWS_TOKENS_DAY", "180000")))
        data["supabase"] = collect_supabase(base, _clean(env.get("SR")), now, caps)
    except SourceError as e:
        problems.append(str(e))
    gtoken, repo = env.get("GITHUB_TOKEN", ""), env.get("GITHUB_REPOSITORY", "")
    data["github"] = collect_github(gtoken, repo, now) if gtoken and repo else {}
    data["senate"] = collect_senate(now)
    if problems:
        for p in problems:
            print(f"::error::SOC monitor cannot reach a source: {p}")
        path = env.get("GITHUB_STEP_SUMMARY")
        if path:
            with open(path, "a", encoding="utf-8") as fh:
                fh.write("# SOC monitor could not reach its sources\n\n" + "\n".join(f"- {p}" for p in problems) + "\n")
        return 1
    sev, findings, report = emit(data, now)
    if gtoken and repo:
        try:
            sync_issue(gtoken, repo, now, sev, report)
        except Exception as e:
            print(f"::warning::issue sync failed ({type(e).__name__})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
