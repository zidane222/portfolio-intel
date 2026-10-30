"""Price calendar and the event table: one row per disclosed trade and horizon.
Entry is the first SPY trading day strictly after the filing date (decision D7)."""
import re

import numpy as np
import pandas as pd

from . import config as C

TICKER_RE = re.compile(r'^[A-Z][A-Z.\-]{0,5}$')


class Market:
    """Daily price matrix on SPY trading days. wide: DataFrame indexed by date, columns tickers (must hold SPY)."""

    def __init__(self, wide):
        spy = wide['SPY'].dropna()
        w = wide.reindex(spy.index).sort_index()
        self.days = w.index.values.astype('datetime64[D]')
        self.P = w.to_numpy(float)
        self.cols = {t: i for i, t in enumerate(w.columns)}
        self.spy = self.P[:, self.cols['SPY']]
        self.n = len(self.days)

    def after(self, date, strict=True):
        return int(np.searchsorted(self.days, np.datetime64(date, 'D'), side='right' if strict else 'left'))

    def px(self, col, i, gap=C.PRICE_GAP_DAYS):
        if i < 0 or i >= self.n:
            return np.nan
        seg = self.P[i:i + gap + 1, col]
        ok = np.flatnonzero(~np.isnan(seg))
        return float(seg[ok[0]]) if len(ok) else np.nan


def normalize_tx(v):
    s = str(v or '').strip().lower()
    if s.startswith('purch') or s == 'buy':
        return 'purchase'
    if s.startswith('sale') or s.startswith('sell'):
        return 'sale'
    return None


def clean_trades(trades):
    """Returns (clean frame, dropped counts). Rows without a usable ticker or sane dates are dropped and counted."""
    t = trades.copy()
    dropped = {'no_ticker': 0, 'bad_dates': 0, 'no_price': 0, 'too_recent': 0}
    t['tx'] = t['tx_type'].map(normalize_tx)
    t = t[t['tx'].notna()].copy()
    t['ticker'] = t['ticker'].astype(str).str.upper().str.strip()
    optionish = t['kind'].astype(str).str.lower().str.contains('option', na=False)
    bad_tk = ~t['ticker'].map(lambda s: bool(TICKER_RE.match(s))) | optionish
    dropped['no_ticker'] = int(bad_tk.sum())
    t = t[~bad_tk].copy()
    t['filed'] = pd.to_datetime(t['filed'], errors='coerce')
    t['traded'] = pd.to_datetime(t['traded'], errors='coerce')
    delay = (t['filed'] - t['traded']).dt.days
    bad = t['filed'].isna() | t['traded'].isna() | (delay < 0) | (delay > C.MAX_FILING_LAG_DAYS)
    dropped['bad_dates'] = int(bad.sum())
    t = t[~bad].copy()
    t['delay'] = (t['filed'] - t['traded']).dt.days
    t['amount_low'] = pd.to_numeric(t['amount_low'], errors='coerce')
    t['chamber'] = t['chamber'].astype(str).str.lower()
    return t.reset_index(drop=True), dropped


def build_events(trades, mkt, sectors, horizons=C.HORIZONS):
    """Long event table. Returns (frame, coverage dict)."""
    t, dropped = clean_trades(trades)
    spy = mkt.spy
    rows = []
    used = set()
    for r in t.itertuples(index=False):
        col = mkt.cols.get(r.ticker)
        if col is None:
            dropped['no_price'] += 1
            continue
        ei = mkt.after(r.filed.to_datetime64())
        ti = mkt.after(r.traded.to_datetime64())
        if ei >= mkt.n:
            dropped['too_recent'] += 1
            continue
        p_e = mkt.px(col, ei)
        p_t = mkt.px(col, ti)
        month = r.filed.year * 12 + r.filed.month
        tf = ((p_e / p_t - 1) - (spy[ei] / spy[ti] - 1)) * 100 if ti < mkt.n and p_t > 0 and p_e > 0 else np.nan
        ok_any = False
        for h in horizons:
            xi = mkt.after(mkt.days[ei] + np.timedelta64(h, 'D'), strict=False)
            if xi >= mkt.n:
                continue
            p_x = mkt.px(col, xi)
            if not (p_e > 0 and p_x > 0):
                continue
            ex = ((p_x / p_e - 1) - (spy[xi] / spy[ei] - 1)) * 100
            ex_td = np.nan
            if ti < mkt.n:
                xt = mkt.after(mkt.days[ti] + np.timedelta64(h, 'D'), strict=False)
                p_t0, p_tx = p_t, mkt.px(col, xt)
                if xt < mkt.n and p_t0 > 0 and p_tx > 0:
                    ex_td = ((p_tx / p_t0 - 1) - (spy[xt] / spy[ti] - 1)) * 100
            rows.append((r.id, r.chamber, r.member, r.ticker, r.tx, r.amount_low, r.filed, r.delay, h, ei, xi, month,
                         ex, ex_td, tf, sectors.get(r.ticker, 'Unknown')))
            ok_any = True
        if ok_any:
            used.add(r.id)
    cols = ['id', 'chamber', 'member', 'ticker', 'tx', 'amount_low', 'filed', 'delay', 'h', 'ei', 'xi', 'month',
            'excess', 'excess_td', 'tf_excess', 'sector']
    df = pd.DataFrame(rows, columns=cols)
    cov = {'trades_total': int(len(trades)), 'events_used': len(used),
           'tickers_priced': int(df['ticker'].nunique()) if len(df) else 0, 'dropped': dropped}
    return df, cov


def net_of(x, bps=C.COST_BPS_ROUNDTRIP):
    """Net figure: shrink the absolute effect by the round-trip cost (in percentage points)."""
    c = bps / 100.0
    return float(np.sign(x) * max(0.0, abs(x) - c))
