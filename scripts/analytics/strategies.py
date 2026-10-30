"""Strategy backtests: a daily simulator and six fixed strategy definitions (nine runs). SIMULATED only.
A signal known at the close of day t trades at the close of the next trading day. No lookahead, no
leverage, no shorting, no parameter search (the parameters below are fixed in advance)."""
import math

import numpy as np
import pandas as pd

from . import config as C
from . import stats as S
from .events import Market, clean_trades

YEAR = 252


# ---------------------------------------------------------------- simulator
def simulate(R, decide, bps, start):
    """R: (T, k) simple returns (NaN already 0). decide(i, g) -> weights held after the close of day i,
    where g are the drifted weights before trading. Costs are bps per side on notional traded.
    Day i's return uses the weights held after the close of day i-1."""
    T, k = R.shape
    h = np.zeros(k)
    ret = np.zeros(T)
    turn = np.zeros(T)
    inv = np.zeros(T)
    trades = 0
    for i in range(start, T):
        if i > start:
            gross = float(h @ R[i])
            den = 1.0 + gross
            g = h * (1.0 + R[i]) / den if den > 1e-9 else h.copy()
        else:
            gross, g = 0.0, np.zeros(k)
        new = np.asarray(decide(i, g), float)
        tr = np.abs(new - g)
        ret[i] = gross - float(tr @ bps) / 1e4
        turn[i] = tr.sum()
        inv[i] = new.sum()
        trades += int((tr > 1e-9).sum())
        h = new
    return {'ret': ret[start:], 'start': start, 'turnover': float(turn[start:].sum()), 'invested': float(inv[start:].mean()) if T > start else 0.0, 'trades': trades}


# ---------------------------------------------------------------- metrics
def _clean(x):
    return None if x is None or not np.isfinite(x) else float(x)


def cagr(r):
    r = np.asarray(r, float)
    if len(r) == 0:
        return None
    return _clean(np.exp(np.log1p(r).sum() * YEAR / len(r)) - 1)


def metrics(r, rf=None):
    """r: daily returns array. rf: aligned daily risk-free returns or None (zero)."""
    r = np.asarray(r, float)
    if len(r) < 2:
        return {'cagr_pct': None, 'vol_pct': None, 'max_dd_pct': None, 'sharpe': None}
    ex = r - (np.zeros_like(r) if rf is None else np.asarray(rf, float))
    vol = r.std(ddof=1)
    curve = np.cumprod(1 + r)
    dd = (curve / np.maximum.accumulate(np.maximum(curve, 1.0)) - 1).min()
    sd = ex.std(ddof=1)
    sharpe = None if sd < 1e-12 else ex.mean() / sd * math.sqrt(YEAR)
    c = cagr(r)
    return {'cagr_pct': None if c is None else round(c * 100, 2), 'vol_pct': round(float(vol) * math.sqrt(YEAR) * 100, 2),
            'max_dd_pct': round(float(dd) * 100, 2), 'sharpe': None if sharpe is None else round(float(sharpe), 2)}


def bootstrap_excess_cagr(rs, rb, b, seed, mean_block=20):
    """Stationary bootstrap of the CAGR difference (strategy minus benchmark). Returns (lo, hi) in percent."""
    ls, lb = np.log1p(np.asarray(rs, float)), np.log1p(np.asarray(rb, float))
    t = len(ls)
    rng = S.rng_for('excess-cagr', seed)
    acc_s, acc_b = np.zeros(b), np.zeros(b)
    for idx in S.stationary_indices(t, b, mean_block, rng):
        acc_s += ls[idx]
        acc_b += lb[idx]
    diff = (np.exp(acc_s * YEAR / t) - np.exp(acc_b * YEAR / t)) * 100
    lo, hi = np.percentile(diff, [2.5, 97.5])
    return float(lo), float(hi)


def relative(rs, rb, rf, b, seed):
    rs, rb, rf = (np.asarray(x, float) for x in (rs, rb, rf))
    ex_cagr = (cagr(rs) - cagr(rb)) * 100
    lo, hi = bootstrap_excess_cagr(rs, rb, b, seed)
    vb = np.var(rb, ddof=1)
    beta = float(np.cov(rs, rb, ddof=1)[0, 1] / vb) if vb > 1e-14 else None
    alpha = None if beta is None else float(((rs - rf).mean() - beta * (rb - rf).mean()) * YEAR * 100)
    d = rs - rb
    ir = None if d.std(ddof=1) < 1e-12 else float(d.mean() / d.std(ddof=1) * math.sqrt(YEAR))
    r2 = lambda x: None if x is None else round(float(x), 2)
    return {'excess_cagr_pct': round(ex_cagr, 2), 'excess_cagr_ci95_pct': [round(lo, 2), round(hi, 2)], 'beta': r2(beta), 'alpha_ann_pct': r2(alpha), 'info_ratio': r2(ir)}


def evidence_tag(ci, hold_excess):
    """ahead / behind only if the interval excludes zero and the hold-out agrees in sign."""
    if hold_excess is None:
        return 'not_distinguishable'
    if ci[0] > 0 and hold_excess > 0:
        return 'ahead'
    if ci[1] < 0 and hold_excess < 0:
        return 'behind'
    return 'not_distinguishable'


# ---------------------------------------------------------------- context
class Ctx:
    """Prices, returns and benchmark on SPY trading days."""

    def __init__(self, wide, price_basis='adj_close'):
        self.mkt = Market(wide)
        df = pd.DataFrame(self.mkt.P, index=self.mkt.days, columns=list(wide.columns)).ffill(limit=5)
        self.px = df
        self.R = df.pct_change(fill_method=None).fillna(0.0).to_numpy()
        self.cols = self.mkt.cols
        self.days = pd.DatetimeIndex(self.mkt.days)
        self.price_basis = price_basis

    def has(self, tickers):
        return all(t in self.cols and self.px[t].notna().any() for t in tickers)

    def bps(self, tickers, kind):
        return np.full(len(tickers), C.COST_BPS_STOCK if kind == 'stock' else C.COST_BPS_ETF, float)

    def sub(self, tickers):
        return self.R[:, [self.cols[t] for t in tickers]]


# ---------------------------------------------------------------- strategy builders: each returns f(cost_mult) -> sim
def copy_signals(ctx, trades_clean, chamber=None, members=None, entry='filed', since=None, until=None, hold=C.COPY_HOLD_DAYS):
    t = trades_clean[trades_clean['tx'] == 'purchase']
    if chamber:
        t = t[t['chamber'] == chamber]
    if members is not None:
        t = t[t['member'].isin(set(members))]
    if since is not None:
        t = t[t['filed'] >= pd.Timestamp(since)]
    if until is not None:
        t = t[t['filed'] < pd.Timestamp(until)]
    mkt = ctx.mkt
    tickers = sorted({x for x in t['ticker'] if x in ctx.cols})
    idx = {x: j for j, x in enumerate(tickers)}
    U = np.zeros((mkt.n, max(1, len(tickers))))
    first = None
    for r in t.itertuples(index=False):
        if r.ticker not in idx:
            continue
        ei = mkt.after((r.filed if entry == 'filed' else r.traded).to_datetime64())
        if ei >= mkt.n or np.isnan(mkt.P[ei, ctx.cols[r.ticker]]):  # price on the entry day only: no peeking ahead
            continue
        xi = min(mkt.n, mkt.after(mkt.days[ei] + np.timedelta64(hold, 'D'), strict=False))
        a = max(ei - 1, 0)           # the signal is known at the close of the day before entry
        U[a:max(a, xi - 1), idx[r.ticker]] += 1
        first = ei if first is None else min(first, ei)
    return tickers, U, first


def copy_runner(ctx, tickers, U, first):
    tot = U.sum(axis=1, keepdims=True)
    W = np.divide(U, tot, out=np.zeros_like(U), where=tot > 0)
    R = ctx.sub(tickers) if tickers else np.zeros((ctx.mkt.n, 1))
    bps = ctx.bps(tickers or ['x'], 'stock')

    def run(mult=1.0):
        return simulate(R, lambda i, g: W[i - 1] if i >= 1 else np.zeros(W.shape[1]), bps * mult, first)
    return run


def momentum_runner(ctx):
    etfs = list(C.SECTOR_ETFS)
    P = ctx.px[etfs].to_numpy()
    n = ctx.mkt.n
    W = np.zeros((n, len(etfs)))
    month = ctx.days.year * 12 + ctx.days.month
    ends = [i for i in range(n - 1) if month[i + 1] != month[i]]
    cur, first, sig = None, None, {}
    for i in ends:
        if i < 252 + 21 or np.isnan(P[i - 21]).any() or np.isnan(P[i - 252]).any():
            continue
        mom = P[i - 21] / P[i - 252] - 1
        top = np.argsort(-mom, kind='stable')[:3]
        w = np.zeros(len(etfs))
        w[top] = 1 / 3
        sig[i] = w
        first = i if first is None else first
    if first is None:
        return None, None
    for i in range(first, n):
        cur = sig.get(i, cur)
        W[i] = cur
    R = ctx.sub(etfs)

    def run(mult=1.0):
        return simulate(R, lambda i, g: W[i - 1], ctx.bps(etfs, 'etf') * mult, first + 1)
    return run, first + 1


def rebalance_runner(ctx, tickers, target, rule):
    """rule: 'annual' (first trading day of each January), 'never', or 'band' (drift over BAND_POINTS)."""
    if not ctx.has(tickers):
        return None, None
    start = max(int(ctx.days.get_loc(ctx.px[t].first_valid_index())) for t in tickers)
    tgt = np.asarray(target, float)
    R = ctx.sub(tickers)
    yrs = ctx.days.year

    def decide(i, g):
        if i == start:
            return tgt
        if rule == 'annual' and yrs[i] != yrs[i - 1]:
            return tgt
        if rule == 'band' and (np.abs(g - tgt) * 100 > C.BAND_POINTS).any():
            return tgt
        return g

    def run(mult=1.0):
        return simulate(R, decide, ctx.bps(tickers, 'etf') * mult, start)
    return run, start


# ---------------------------------------------------------------- assembling a run
def assemble(ctx, run_id, name, family, params, runner, start, caveats, b, extras=None, split=C.SPLIT_DATE):
    sim = runner(1.0)
    idx = ctx.days[sim['start']:]
    rs = sim['ret']
    rb = ctx.R[sim['start']:, ctx.cols['SPY']]
    rf = ctx.R[sim['start']:, ctx.cols['SHV']] if 'SHV' in ctx.cols else np.zeros(len(rs))
    years = len(rs) / YEAR
    cm = idx >= pd.Timestamp(C.COMMON_WINDOW_START)
    full = metrics(rs, rf)
    full.update({'turnover_x': round(sim['turnover'] / years, 2) if years > 0 else None, 'avg_invested_pct': round(sim['invested'] * 100, 2), 'trades': sim['trades']})
    bm_full = metrics(rb, rf)
    rel = relative(rs, rb, rf, b, C.SEED)
    ho = idx >= pd.Timestamp(split)
    hold = None
    if ho.sum() >= 60:
        hold_excess = (cagr(rs[ho]) - cagr(rb[ho])) * 100
        hold = {'start': split, 'excess_cagr_pct': round(hold_excess, 2), 'same_sign': bool(np.sign(hold_excess) == np.sign(rel['excess_cagr_pct']))}
    tag = evidence_tag(rel['excess_cagr_ci95_pct'], hold['excess_cagr_pct'] if hold else None)
    if hold and not hold['same_sign']:
        tag = 'not_distinguishable'
    sens = {'cost_x2_cagr_pct': round(cagr(runner(2.0)['ret']) * 100, 2)}
    sens['trade_date_hypothetical_cagr_pct'] = None
    if extras and extras.get('trade_date'):
        sens['trade_date_hypothetical_cagr_pct'] = round(cagr(extras['trade_date']()['ret']) * 100, 2)
    me = pd.Series(100 * np.cumprod(1 + rs), index=idx), pd.Series(100 * np.cumprod(1 + rb), index=idx)
    grp = [me[0].index.year * 12 + me[0].index.month]
    s_m, b_m = me[0].groupby(grp).last(), me[1].groupby(grp).last()
    d_m = me[0].index.to_series().groupby(grp).last()
    run = {'id': run_id, 'name': name, 'family': family, 'rules': ['simulated'], 'description': '', 'params': params,
           'period': {'start': str(idx[0].date()), 'end': str(idx[-1].date())},
           'metrics': {'full': full, 'common': metrics(rs[cm], rf[cm]) if cm.sum() > 1 else metrics(rs, rf)},
           'benchmark_metrics': {'full': bm_full, 'common': metrics(rb[cm], rf[cm]) if cm.sum() > 1 else bm_full},
           'relative': rel, 'sensitivity': sens, 'holdout': hold, 'evidence': tag,
           'curve': {'dates': [str(d.date()) for d in d_m], 'strategy': [round(float(x), 2) for x in s_m], 'benchmark': [round(float(x), 2) for x in b_m]},
           'caveats': caveats}
    if extras and extras.get('reference'):
        run['reference_in_sample'] = extras['reference']
    return run


COPY_CAV = ['survivorship', 'costs', 'filing_delay', 'short_history', 'price_basis', 'universe_bias']
ETF_CAV = ['costs', 'short_history', 'price_basis']


def run_all(ctx, trades, ev, b=C.RESAMPLES, split=C.SPLIT_DATE, ranking=None):
    """All nine runs. trades: raw trades frame. ev: event table (for the member ranking). Returns list of run dicts."""
    from .analyses import member_ranking
    tc, _ = clean_trades(trades)
    runs = []
    for ch in ('senate', 'house'):
        tk, U, first = copy_signals(ctx, tc, chamber=ch)
        if first is None:
            continue
        td = copy_signals(ctx, tc, chamber=ch, entry='traded')
        extras = {'trade_date': copy_runner(ctx, td[0], td[1], td[2]) if td[2] is not None else None}
        runs.append(assemble(ctx, f'copy-{ch}-buys', f'Copy {ch.capitalize()} purchases (simulated)', 'copy',
                             {'chamber': ch, 'hold_days': C.COPY_HOLD_DAYS, 'weighting': 'equal_active'}, copy_runner(ctx, tk, U, first), first, COPY_CAV, b, extras, split))
    top = ranking if ranking is not None else member_ranking(ev, split)
    if top:
        tk, U, first = copy_signals(ctx, tc, members=top, since=split)
        if first is not None:
            td = copy_signals(ctx, tc, members=top, entry='traded', since=split)
            tk2, U2, f2 = copy_signals(ctx, tc, members=top, until=split)
            ref = None
            if f2 is not None:
                rr = copy_runner(ctx, tk2, U2, f2)(1.0)['ret']
                ref = {'cagr_pct': round(cagr(rr) * 100, 2), 'label': 'Reference only, not evidence: members were chosen using this period.'}
            extras = {'trade_date': copy_runner(ctx, td[0], td[1], td[2]) if td[2] is not None else None, 'reference': ref}
            runs.append(assemble(ctx, 'copy-top-members', 'Copy five selected members (simulated)', 'copy',
                                 {'members': len(top), 'selection': 'discovery-window shrunk 90 day excess', 'hold_days': C.COPY_HOLD_DAYS,
                                  'tested_period': 'hold-out only'}, copy_runner(ctx, tk, U, first), first, COPY_CAV, b, extras, split))
    if ctx.has(C.SECTOR_ETFS):
        run, start = momentum_runner(ctx)
        if run:
            runs.append(assemble(ctx, 'momentum-sectors', 'Sector ETF momentum (simulated)', 'etf',
                                 {'universe': 'sector SPDR ETFs', 'lookback': '12-1 months', 'holdings': 3, 'rebalance': 'monthly'}, run, start, ETF_CAV, b, None, split))
    defs = [('dividend-basket', 'Dividend ETF basket (simulated)', list(C.DIVIDEND_ETFS), [0.25] * 4, 'annual', {'rebalance': 'each January'}),
            ('tbill-proxy', 'T-bill ETF proxy (simulated)', ['SHV'], [1.0], 'never', {'proxy': 'SHV 0-1 year Treasury ETF'}),
            ('balanced-annual', '60/40 SPY and IEF, annual rebalance (simulated)', ['SPY', 'IEF'], [0.6, 0.4], 'annual', {'rebalance': 'each January'}),
            ('balanced-never', '60/40 SPY and IEF, never rebalanced (simulated)', ['SPY', 'IEF'], [0.6, 0.4], 'never', {'rebalance': 'never'}),
            ('balanced-band', '60/40 SPY and IEF, 5 point band (simulated)', ['SPY', 'IEF'], [0.6, 0.4], 'band', {'rebalance': 'when a weight drifts over 5 points'})]
    for rid, name, tk, tgt, rule, params in defs:
        run, start = rebalance_runner(ctx, tk, tgt, rule)
        if run:
            runs.append(assemble(ctx, rid, name, 'etf', {'tickers': tk, **params}, run, start, ETF_CAV, b, None, split))
    return runs
