"""Publish gate. A failure means nothing is written (plan 11.2). Checks wording, labels, dashes, schema
shape and that every number in a text field comes from a field of the same object."""
import json
import math
import re

from . import config as C

ADVICE = re.compile(r"\b(you should|we recommend|i recommend|recommended|should (?:buy|sell|copy|invest)|buy now|sell now|will beat|will outperform|"
                    r"expected to outperform|best strategy|guarantee[ds]?|can'?t lose|risk[- ]free return|sure thing|beat the market)\b", re.I)
DASH = re.compile('[–—]')
NUM = re.compile(r'\d+(?:\.\d+)?')
CONSTANTS = {95.0, 2024.0, 15.0, 30.0, 0.0, 12.0, 1.0, 40.0, 60.0, 5.0, 100.0}  # fixed words in templates: 95 percent, 2024, 15 days, 60/40, ...
EVIDENCE = {'ahead', 'behind', 'not_distinguishable'}
INSIGHT_KEYS = {'schema', 'method_version', 'generated', 'code_version', 'data_asof', 'label', 'params', 'coverage', 'tests_run',
                'findings', 'tested', 'scan_summary', 'descriptive', 'news_stance', 'caveats'}
STRAT_KEYS = {'schema', 'method_version', 'generated', 'data_asof', 'label', 'benchmark', 'assumptions', 'strategies_tried', 'runs', 'caveats'}
RUN_KEYS = {'id', 'name', 'family', 'rules', 'description', 'params', 'period', 'metrics', 'benchmark_metrics', 'relative', 'sensitivity',
            'holdout', 'evidence', 'curve', 'caveats'}
FINDING_KEYS = {'id', 'analysis', 'family', 'title', 'summary', 'subject', 'horizon_days', 'entry', 'n_events', 'n_months', 'n_tickers',
                'mean_excess_pct', 'ci95_pct', 'net_mean_excess_pct', 'p_adj', 'placebo_pct', 'holdout', 'caveats'}
MAX_BYTES = {'insights': 400_000, 'strategies': 200_000}


def numbers_in(obj, out=None):
    out = set() if out is None else out
    if isinstance(obj, bool):
        return out
    if isinstance(obj, (int, float)):
        out.add(abs(float(obj)))
    elif isinstance(obj, dict):
        for v in obj.values():
            numbers_in(v, out)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            numbers_in(v, out)
    elif isinstance(obj, str):
        for t in NUM.findall(obj):
            out.add(float(t))
    return out


def strings_in(obj):
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from strings_in(v)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            yield from strings_in(v)


def number_problems(text, obj):
    allowed = numbers_in({k: v for k, v in obj.items() if k not in ('summary', 'description')}) | CONSTANTS
    bad = []
    for t in NUM.findall(re.sub(r'\d{4}-\d{2}-\d{2}', '', text)):
        x = float(t)
        if not any(math.isclose(x, a, abs_tol=1e-9) for a in allowed):
            bad.append(t)
    return bad


def lint(insights, strategies):
    """Returns a list of problem strings (empty means publishable)."""
    p = []
    if set(insights) != INSIGHT_KEYS:
        p.append('insights keys differ from contract')
    if set(strategies) != STRAT_KEYS:
        p.append('strategies keys differ from contract')
    if insights.get('schema') != 'pi/insights/v1':
        p.append('insights schema id')
    if strategies.get('schema') != 'pi/strategies/v1':
        p.append('strategies schema id')
    if insights.get('label') != C.LABEL_INSIGHTS:
        p.append('insights label missing or changed')
    if strategies.get('label') != C.LABEL_STRATEGIES:
        p.append('strategies label missing or changed')
    for name, doc in (('insights', insights), ('strategies', strategies)):
        try:
            blob = json.dumps(doc, allow_nan=False)
        except ValueError:
            p.append(f'{name}: NaN or infinity in output')
            continue
        if len(blob.encode()) > MAX_BYTES[name]:
            p.append(f'{name}: file over size budget')
        for s in strings_in(doc):
            if DASH.search(s):
                p.append(f'{name}: em or en dash')
            if ADVICE.search(s):
                p.append(f'{name}: advice or forward-looking wording: {ADVICE.search(s).group(0)}')
    for f in insights.get('findings', []):
        if not FINDING_KEYS <= set(f):
            p.append(f"finding {f.get('id')}: missing keys")
            continue
        if f['holdout'].get('replicates') is not True:
            p.append(f"finding {f['id']}: not replicated on hold-out")
        if f['family'] not in ('confirmatory', 'exploratory'):
            p.append(f"finding {f['id']}: family")
        if f['subject'].get('member'):
            p.append(f"finding {f['id']}: names a member")
        bad = number_problems(f['summary'], f)
        if bad:
            p.append(f"finding {f['id']}: summary numbers not in fields: {bad}")
    ns = insights.get('news_stance') or {}
    if ns.get('status') not in ('gated', 'open_not_analysed'):
        p.append('news_stance status')
    ids = set()
    for r in strategies.get('runs', []):
        if not RUN_KEYS <= set(r):
            p.append(f"run {r.get('id')}: missing keys")
            continue
        ids.add(r['id'])
        if 'simulated' not in r['rules'] or '(simulated)' not in r['name'] or not r['description'].startswith('Simulated.'):
            p.append(f"run {r['id']}: not labeled simulated")
        if r['evidence'] not in EVIDENCE:
            p.append(f"run {r['id']}: evidence tag")
        bad = number_problems(r['description'], r)
        if bad:
            p.append(f"run {r['id']}: description numbers not in fields: {bad}")
        c = r['curve']
        if not (len(c['dates']) == len(c['strategy']) == len(c['benchmark'])):
            p.append(f"run {r['id']}: curve lengths")
    if len(ids) != len(strategies.get('runs', [])):
        p.append('duplicate run ids')
    return p
