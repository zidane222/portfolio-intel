"""Data science analyses A1 to A7 and the finding rule (plan sections 5.1 to 5.4).
A result is a finding only if it survives: minimum samples, Benjamini-Hochberg over its family, an
interval that excludes zero at the family-adjusted level, a net practical floor, the placebo check (A1)
and replication on the fixed hold-out. Everything else gets a status."""
import math

import numpy as np
import pandas as pd

from . import config as C
from . import stats as S
from .events import net_of


def _half(m):
    return tuple(max(1, math.ceil(x / 2)) for x in m)


def _eligible(est, mins, h):
    n, mo, tk = mins
    return est['n_events'] >= n and est['n_months'] >= max(mo, 4 * S.block_len(h)) and est['n_tickers'] >= tk


# ---------------------------------------------------------------- estimators
def est_mean(df, h, tid, b, col='excess'):
    if len(df) == 0:
        return {'stat': 0.0, 'boot': np.array([]), 'n_events': 0, 'n_months': 0, 'n_tickers': 0}
    lo, hi = int(df['month'].min()), int(df['month'].max())
    m = hi - lo + 1
    off = df['month'].to_numpy() - lo
    x = df[col].to_numpy(float)
    arrs = {'s': np.bincount(off, weights=x, minlength=m), 'n': np.bincount(off, minlength=m).astype(float)}
    obs, boot = S.block_bootstrap(arrs, lambda t: t['s'] / t['n'], S.block_len(h), b, S.rng_for(tid, C.SEED))
    return {'stat': obs, 'boot': boot, 'n_events': len(df), 'n_months': int((arrs['n'] > 0).sum()), 'n_tickers': int(df['ticker'].nunique())}


def est_diff(df, h, tid, b):
    """df has column g (1 = group a, 0 = group b). Statistic: mean(a) - mean(b)."""
    lo, hi = int(df['month'].min()), int(df['month'].max())
    m = hi - lo + 1
    off = df['month'].to_numpy() - lo
    x = df['excess'].to_numpy(float)
    g = df['g'].to_numpy()
    arrs = {k: np.bincount(off[g == v], weights=(x[g == v] if k[0] == 's' else None), minlength=m).astype(float)
            for k, v in (('sa', 1), ('na', 1), ('sb', 0), ('nb', 0))}
    obs, boot = S.block_bootstrap(arrs, lambda t: t['sa'] / t['na'] - t['sb'] / t['nb'], S.block_len(h), b, S.rng_for(tid, C.SEED))
    return {'stat': obs, 'boot': boot, 'n_events': len(df), 'n_months': int(len(np.unique(off))), 'n_tickers': int(df['ticker'].nunique())}


def est_slope(df, h, tid, b):
    """Slope of excess on log2(amount_low), month-clustered."""
    d = df[df['amount_low'] > 0]
    lo, hi = int(d['month'].min()), int(d['month'].max())
    m = hi - lo + 1
    off = d['month'].to_numpy() - lo
    x = np.log2(d['amount_low'].to_numpy(float))
    y = d['excess'].to_numpy(float)
    arrs = {'n': np.bincount(off, minlength=m).astype(float), 'sx': np.bincount(off, weights=x, minlength=m),
            'sy': np.bincount(off, weights=y, minlength=m), 'sxx': np.bincount(off, weights=x * x, minlength=m),
            'sxy': np.bincount(off, weights=x * y, minlength=m)}

    def fn(t):
        return (t['sxy'] - t['sx'] * t['sy'] / t['n']) / (t['sxx'] - t['sx'] ** 2 / t['n'])

    obs, boot = S.block_bootstrap(arrs, fn, S.block_len(h), b, S.rng_for(tid, C.SEED))
    return {'stat': obs, 'boot': boot, 'n_events': len(d), 'n_months': int((arrs['n'] > 0).sum()), 'n_tickers': int(d['ticker'].nunique())}


# ---------------------------------------------------------------- placebo
def placebo_p95(df, mkt, h, b=C.PLACEBO_DRAWS, per=C.PLACEBO_PER_EVENT):
    """95th percentile of cohort means when each event's stock is replaced by a random priced ticker on
    the same entry and exit days. Returns None when it cannot be computed."""
    rng = S.rng_for(f'placebo-{h}-{len(df)}', C.SEED)
    ei, xi = df['ei'].to_numpy(), df['xi'].to_numpy()
    n = len(df)
    mat = np.full((n, per), np.nan)
    for k in range(n):
        p0, p1 = mkt.P[ei[k]], mkt.P[xi[k]]
        ok = np.flatnonzero((p0 > 0) & (p1 > 0))
        if len(ok) == 0:
            continue
        pick = rng.choice(ok, size=per, replace=True)
        mat[k] = ((p1[pick] / p0[pick] - 1) - (mkt.spy[xi[k]] / mkt.spy[ei[k]] - 1)) * 100
    cols = rng.integers(0, per, size=(b, n))
    vals = mat[np.arange(n), cols]
    means = np.nanmean(vals, axis=1)
    means = means[np.isfinite(means)]
    return float(np.percentile(means, 95)) if len(means) else None


# ---------------------------------------------------------------- finding rule
def _spec(id_, analysis, family, title, subject, h, df, est, mins, floor, hold_df=None, placebo=None, scale=1.0):
    return dict(id=id_, analysis=analysis, family=family, title=title, subject=subject, h=h, df=df, est=est, mins=mins,
                floor=floor, hold_df=hold_df, placebo=placebo, scale=scale)


def evaluate(specs, b, q=C.FDR_Q):
    """Run every spec through the finding rule. Returns a list of result dicts (no bootstrap arrays)."""
    res = []
    for s in specs:
        est = s['est'](s['df'], s['h'], s['id'], b) if len(s['df']) else None
        r = {'spec': s, 'est': est}
        if est is None or not _eligible(est, s['mins'], s['h']) or len(est['boot']) == 0:
            r['status'] = 'insufficient_data'
        else:
            r['status'] = 'tested'
            r['p'] = S.p_two_sided(est['boot'])
        res.append(r)
    tested = [r for r in res if r['status'] == 'tested']
    padj = S.bh_adjust([r['p'] for r in tested])
    for r, pa in zip(tested, padj):
        r['p_adj'] = pa
    a4 = [r for r in tested if r['spec']['analysis'] == 'A4']
    if a4:  # member means are reported shrunk toward the grand mean (empirical Bayes)
        shr, _, _ = S.shrink([r['est']['stat'] for r in a4], [float(r['est']['boot'].std()) for r in a4])
        for r, v in zip(a4, shr):
            r['shrunk'] = v
    sel = [r for r in tested if r['p_adj'] <= q]
    sel_ids = {id(r) for r in sel}
    level = S.by_level(len(sel), len(tested), q)
    for r in tested:
        s, est = r['spec'], r['est']
        lo95, hi95 = S.ci(est['boot'], 0.95)
        lo_a, hi_a = S.ci(est['boot'], level) if id(r) in sel_ids else (lo95, hi95)
        r.update(ci95=(lo95, hi95), ci_adj=(lo_a, hi_a), level=level if id(r) in sel_ids else 0.95)
        stat = r.get('shrunk', est['stat'] * s['scale'])
        r['value'] = stat
        r['net'] = net_of(stat)
        r['holdout'] = None
        r['placebo_p95'] = None
        if r['p_adj'] > q or not (lo_a > 0 or hi_a < 0):
            r['status'], r['reason'] = 'no_evidence', 'ci_includes_zero'
        elif abs(r['net']) < s['floor']:
            r['status'], r['reason'] = 'no_evidence', 'below_practical_floor'
        else:
            ok = True
            if s['placebo']:
                p95 = s['placebo'](s['df'])
                r['placebo_p95'] = p95
                if p95 is None or not stat > p95:
                    r['status'], r['reason'], ok = 'no_evidence', 'placebo_not_exceeded', False
            if ok:
                hd = s['hold_df']
                hest = s['est'](hd, s['h'], s['id'] + '-holdout', b) if hd is not None and len(hd) else None
                if hest is None or not _eligible(hest, _half(s['mins']), s['h']) or len(hest['boot']) == 0:
                    r['status'], r['reason'] = 'no_evidence', 'holdout_sample_too_small'
                else:
                    sign = 1.0 if stat > 0 else -1.0
                    hstat = hest['stat'] * s['scale']
                    p1 = S.p_one_sided(hest['boot'], sign)
                    rep = bool((np.sign(hstat) == sign) and p1 <= q and abs(net_of(hstat)) >= s['floor'] / 2)  # half the practical floor: a hold-out effect near zero is not a replication
                    r['holdout'] = {'n_events': hest['n_events'], 'mean_excess_pct': hstat, 'p_one_sided': p1, 'replicates': bool(rep)}
                    r['status'], r['reason'] = ('finding', None) if rep else ('unstable', 'holdout_disagrees')
    return res


# ---------------------------------------------------------------- the analyses
def _split(df, split):
    sp = pd.Timestamp(split)
    return df[df['filed'] < sp], df[df['filed'] >= sp]


def _cohort(ev, tx, h, **flt):
    d = ev[(ev['tx'] == tx) & (ev['h'] == h)]
    for k, v in flt.items():
        d = d[d[k] == v]
    return d


def build_specs(ev, mkt, b, split=C.SPLIT_DATE):
    """Confirmatory and exploratory specs. Returns (confirmatory, exploratory)."""
    conf, expl = [], []
    for ch in ('senate', 'house'):
        for h in C.HORIZONS:
            d = _cohort(ev, 'purchase', h, chamber=ch)
            conf.append(_spec(f'a1-{ch}-purchases-{h}', 'A1', 'confirmatory', f'{ch.capitalize()} disclosed purchases vs SPY, {h} days',
                              {'chamber': ch, 'tx_type': 'purchase', 'member': None, 'sector': None, 'bucket': None}, h, d, est_mean,
                              C.MIN_HEADLINE, C.FLOOR_PT[h], hold_df=_split(d, split)[1],
                              placebo=(lambda dd, h=h: placebo_p95(dd, mkt, h)) if mkt is not None else None))
    for h in C.HORIZONS:
        d = _cohort(ev, 'sale', h)
        conf.append(_spec(f'a2-sales-{h}', 'A2', 'confirmatory', f'Disclosed sales vs SPY, {h} days',
                          {'chamber': None, 'tx_type': 'sale', 'member': None, 'sector': None, 'bucket': None}, h, d, est_mean,
                          C.MIN_HEADLINE, C.FLOOR_PT[h], hold_df=_split(d, split)[1]))
    # A3b fast vs slow filers, purchases, 90 days
    d = _cohort(ev, 'purchase', 90)
    d = d[(d['delay'] <= 15) | (d['delay'] > 30)].copy()
    d['g'] = (d['delay'] <= 15).astype(int)
    big = all((d['g'] == v).sum() >= C.MIN_BUCKET for v in (0, 1))

    def est_a3(df, h, tid, b_, ):
        if len(df) == 0 or (df['g'] == 1).sum() == 0 or (df['g'] == 0).sum() == 0:
            return {'stat': 0.0, 'boot': np.array([]), 'n_events': 0, 'n_months': 0, 'n_tickers': 0}
        return est_diff(df, h, tid, b_)

    conf.append(_spec('a3b-fast-vs-slow-90', 'A3', 'confirmatory', 'Fast filers (up to 15 days) minus slow filers (over 30 days), 90 days',
                      {'chamber': None, 'tx_type': 'purchase', 'member': None, 'sector': None, 'bucket': 'delay'}, 90,
                      d if big else d.iloc[0:0], est_a3, C.MIN_HEADLINE, C.FLOOR_PT[90], hold_df=_split(d, split)[1]))
    # A6 size slope
    for h in C.HORIZONS:
        d = _cohort(ev, 'purchase', h)
        d = d[d['amount_low'] > 0]
        ok = all(((d['amount_low'] >= lo) & (d['amount_low'] < hi)).sum() >= C.MIN_BUCKET for _, lo, hi in C.SIZE_BUCKETS)
        conf.append(_spec(f'a6-size-slope-{h}', 'A6', 'confirmatory', f'Purchase size and excess return, {h} days',
                          {'chamber': None, 'tx_type': 'purchase', 'member': None, 'sector': None, 'bucket': 'size'}, h,
                          d if ok else d.iloc[0:0], est_slope, C.MIN_HEADLINE, C.FLOOR_PT[h], hold_df=_split(d, split)[1], scale=4.0))
    # exploratory: discovery selects, hold-out confirms
    p90 = _cohort(ev, 'purchase', C.PRIMARY_HORIZON)
    disc, hold = _split(p90, split)
    for sec, g in disc.groupby('sector'):
        if sec == 'Unknown':
            continue
        expl.append(_spec(f'a5-sector-{_slug(sec)}-90', 'A5', 'exploratory', f'{sec} disclosed purchases vs SPY, 90 days',
                          {'chamber': None, 'tx_type': 'purchase', 'member': None, 'sector': sec, 'bucket': None}, 90, g, est_mean,
                          C.MIN_SECTOR, C.FLOOR_PT[90], hold_df=hold[hold['sector'] == sec]))
    for mem, g in disc.groupby('member'):
        expl.append(_spec(f'a4-member-{_slug(mem)}', 'A4', 'exploratory', 'Member scan (not published by name)',
                          {'chamber': None, 'tx_type': 'purchase', 'member': mem, 'sector': None, 'bucket': None}, 90, g, est_mean,
                          C.MIN_MEMBER, C.FLOOR_PT[90], hold_df=hold[hold['member'] == mem]))
    return conf, expl


def _slug(s):
    return ''.join(c.lower() if c.isalnum() else '-' for c in str(s)).strip('-')[:40]


def _public(r):
    s, est = r['spec'], r['est']
    base = {'id': s['id'], 'analysis': s['analysis'], 'horizon_days': s['h']}
    if r['status'] == 'insufficient_data':
        return {**base, 'status': 'insufficient_data', 'n_events': int(est['n_events']) if est else 0, 'mean_excess_pct': None, 'ci95_pct': None, 'reason': 'minimum_sample_not_met'}
    return {**base, 'status': r['status'], 'n_events': int(est['n_events']), 'mean_excess_pct': round(r['value'], 2),
            'ci95_pct': [round(r['ci95'][0] * s['scale'], 2), round(r['ci95'][1] * s['scale'], 2)], 'reason': r.get('reason')}


def _finding(r):
    s, est = r['spec'], r['est']
    stat_kind = {'A3': 'mean_difference', 'A6': 'slope_span'}.get(s['analysis'], 'mean_excess')
    td = s['df']['excess_td'].dropna()
    f = {'id': s['id'], 'analysis': s['analysis'], 'family': s['family'], 'title': s['title'], 'summary': '',
         'statistic': stat_kind, 'subject': s['subject'], 'horizon_days': s['h'], 'entry': 'filing_next_close',
         'n_events': int(est['n_events']), 'n_months': int(est['n_months']), 'n_tickers': int(est['n_tickers']),
         'mean_excess_pct': round(r['value'], 2),
         'ci95_pct': [round(r['ci95'][0] * s['scale'], 2), round(r['ci95'][1] * s['scale'], 2)],
         'ci_adj_pct': [round(r['ci_adj'][0] * s['scale'], 2), round(r['ci_adj'][1] * s['scale'], 2)], 'ci_adj_level': round(r['level'], 4),
         'net_mean_excess_pct': round(r['net'], 2), 'p_adj': round(r['p_adj'], 4),
         'placebo_pct': None if r['placebo_p95'] is None else round(r['placebo_p95'], 2),
         'holdout': {**r['holdout'], 'mean_excess_pct': round(r['holdout']['mean_excess_pct'], 2), 'p_one_sided': round(r['holdout']['p_one_sided'], 4)},
         'not_achievable_trade_date_pct': round(float(td.mean()), 2) if len(td) and s['analysis'] in ('A1', 'A2') else None,
         'caveats': ['filing_delay', 'universe_bias', 'survivorship', 'short_history', 'price_basis']}
    return f


def descriptive(ev):
    out = {'filing_delay_buckets': [], 'size_buckets': []}
    e30 = ev[ev['h'] == 30].drop_duplicates('id')
    for name, lo, hi in C.DELAY_BUCKETS:
        d = e30[(e30['delay'] >= lo) & (e30['delay'] <= hi)]
        out['filing_delay_buckets'].append({'bucket': name, 'n': int(len(d)),
                                            'trade_to_filing_excess_pct': round(float(d['tf_excess'].mean()), 2) if len(d) >= C.MIN_BUCKET else None})
    p = _cohort(ev, 'purchase', 90)
    for name, lo, hi in C.SIZE_BUCKETS:
        d = p[(p['amount_low'] >= lo) & (p['amount_low'] < hi)]
        out['size_buckets'].append({'bucket': name, 'n': int(len(d)),
                                    'mean_excess_pct_90d': round(float(d['excess'].mean()), 2) if len(d) >= C.MIN_BUCKET else None})
    return out


def news_gate(verdicts):
    """A7 gate. verdicts: DataFrame (run_date, ticker, stance, status) or None. Below the gate only progress is published."""
    if verdicts is None or len(verdicts) == 0:
        scored, days, per = 0, 0, {}
    else:
        v = verdicts[verdicts['status'] == 'PASS'].drop_duplicates(['ticker', 'run_date'])
        v = v[v['stance'].isin(['positive', 'negative'])]
        scored, days = int(len(v)), int(v['run_date'].nunique())
        per = v['stance'].value_counts().to_dict()
    open_ = scored >= C.NEWS_MIN_SCORED and days >= C.NEWS_MIN_DAYS and all(per.get(k, 0) >= C.NEWS_MIN_PER_STANCE for k in ('positive', 'negative'))
    return {'status': 'open_not_analysed' if open_ else 'gated', 'scored': scored, 'needed': C.NEWS_MIN_SCORED,
            'distinct_days': days, 'days_needed': C.NEWS_MIN_DAYS}


def run_ds(ev, mkt, b=C.RESAMPLES, verdicts=None):
    """All analyses. Returns dict with public pieces plus 'members' (internal, never published)."""
    conf_specs, expl_specs = build_specs(ev, mkt, b)
    conf = evaluate(conf_specs, b)
    expl = evaluate(expl_specs, b)
    findings = [_finding(r) for r in conf + expl if r['status'] == 'finding' and r['spec']['analysis'] in ('A1', 'A2', 'A3', 'A5', 'A6')]
    tested = [_public(r) for r in conf]
    scan = {}
    for key, an in (('members', 'A4'), ('sectors', 'A5')):
        rs = [r for r in expl if r['spec']['analysis'] == an]
        scan[key] = {'eligible': sum(r['status'] != 'insufficient_data' for r in rs), 'tested': sum(r['status'] != 'insufficient_data' for r in rs),
                     'findings': sum(r['status'] == 'finding' for r in rs)}
    tests_run = {'confirmatory': sum(r['status'] != 'insufficient_data' for r in conf),
                 'exploratory': sum(r['status'] != 'insufficient_data' for r in expl)}
    members = [r['spec']['subject']['member'] for r in expl if r['spec']['analysis'] == 'A4' and r['status'] == 'finding']
    return {'findings': findings, 'tested': tested, 'scan_summary': scan, 'tests_run': tests_run, 'descriptive': descriptive(ev),
            'news_stance': news_gate(verdicts), 'replicated_members': members}


def member_ranking(ev, split=C.SPLIT_DATE, k=C.TOP_MEMBERS, min_n=C.TOP_MEMBERS_MIN_PURCHASES):
    """Top members by shrunk discovery-window 90d excess (purchases). Uses data before the split only."""
    d = _cohort(ev, 'purchase', C.PRIMARY_HORIZON)
    d = d[d['filed'] < pd.Timestamp(split)]
    g = d.groupby('member')['excess'].agg(['mean', 'std', 'count'])
    g = g[g['count'] >= min_n]
    if g.empty:
        return []
    se = (g['std'].fillna(0) / np.sqrt(g['count'])).to_numpy()
    shr, _, _ = S.shrink(g['mean'].to_numpy(), se)
    g = g.assign(shrunk=shr).sort_values(['shrunk'], ascending=False)
    return list(g.index[:k])
