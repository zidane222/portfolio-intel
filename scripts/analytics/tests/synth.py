"""In-memory synthetic world for offline tests: random-walk prices for stocks and ETFs plus SPY, and made-up
disclosed trades with filing delays and amount ranges. No network, no BigQuery. Effects are injected
into price paths so the analyses can be checked against a known answer."""
import numpy as np
import pandas as pd

ETFS = ['SPY', 'QQQ', 'SHV', 'IEF', 'AGG', 'XLK', 'XLF', 'XLV', 'XLY', 'XLP', 'XLE', 'XLI', 'XLB', 'XLU', 'XLRE', 'XLC', 'SCHD', 'VYM', 'DGRO', 'VIG']
AMOUNTS = [1001, 15001, 50001, 100001, 250001, 500001, 1000001]
AMOUNT_P = [.30, .25, .20, .08, .09, .06, .02]
SECTORS = ['Technology', 'Healthcare', 'Energy', 'Financial Services', 'Utilities', 'Industrials', 'Consumer Cyclical', 'Basic Materials', 'Real Estate', 'Communication Services']
SPLIT = pd.Timestamp('2024-01-01')


def ramp(n, up=30, hold=70, down=30):
    f = np.zeros(n)
    k = np.arange(n)
    f[k < up] = k[k < up] / up
    f[(k >= up) & (k < up + hold)] = 1.0
    d = (k >= up + hold) & (k < up + hold + down)
    f[d] = 1 - (k[d] - up - hold) / down
    return f


def make_world(seed=1, n_stocks=500, n_senate=1500, n_house=1500, n_sales=800, n_members=40, effects=None, end='2026-09-30', with_etfs=True):
    """effects keys: senate (pts at 90d), house, member ((name, pts, n_events)), sector ((name, pts)), size_slope (pts per doubling),
    pre2024_only (bool), drift (daily extra return for every stock), delay_only (pts), persistent (ETF ticker), sales (pts)."""
    ef = effects or {}
    rng = np.random.default_rng(seed)
    days = pd.bdate_range('2020-01-02', end)
    n = len(days)
    spy_r = rng.normal(0.0004, 0.010, n)
    cols, rets = ['SPY'], [spy_r]
    stocks = [f'Z{chr(65 + i // 26)}{chr(65 + i % 26)}' for i in range(n_stocks)]
    sector_of = {t: SECTORS[i % len(SECTORS)] for i, t in enumerate(stocks)}
    drift = ef.get('drift', 0.0)
    for t in stocks:
        cols.append(t)
        rets.append(spy_r + rng.normal(-0.00007 + drift, 0.012, n))
    if with_etfs:
        for t in ETFS[1:]:
            mu, sd = {'SHV': (0.00008, 0.0004), 'IEF': (0.00012, 0.004), 'AGG': (0.00012, 0.003)}.get(t, (0.0003, 0.011))
            if t == ef.get('persistent'):
                mu = 0.0030
            cols.append(t)
            rets.append(0.9 * spy_r + rng.normal(mu - 0.00036, sd, n) if t not in ('SHV', 'IEF', 'AGG') else rng.normal(mu, sd, n))
    logp = np.cumsum(np.array(rets), axis=1)
    px = 100 * np.exp(logp)
    colix = {c: i for i, c in enumerate(cols)}

    members = [f'Member {i:03d}' for i in range(n_members)]
    cut = max(1, n_members * 3 // 8)
    rows = []
    idx = lambda ts: int(np.searchsorted(days.values, np.datetime64(ts), side='right'))
    start = pd.Timestamp('2021-03-01')
    span = (pd.Timestamp('2026-05-31') - start).days

    def add(chamber, tx, count, member_pool=None, fixed_member=None):
        for _ in range(count):
            traded = start + pd.Timedelta(days=int(rng.integers(0, span)))
            delay = int(min(60, 1 + rng.exponential(18)))
            filed = traded + pd.Timedelta(days=delay)
            amt = int(rng.choice(AMOUNTS, p=AMOUNT_P))
            rows.append(dict(id=f'{chamber}-{len(rows)}', chamber=chamber, member=fixed_member or str(rng.choice(member_pool)), ticker=str(rng.choice(stocks)),
                             asset='x', kind='Stock', tx_type='Purchase' if tx == 'purchase' else 'Sale (Full)', amount='x', amount_low=amt, amount_high=amt * 2,
                             traded=traded.date(), filed=filed.date()))

    add('senate', 'purchase', n_senate, members[:cut])
    add('house', 'purchase', n_house, members[cut:])
    add('house', 'sale', n_sales, members[cut:])
    if 'member' in ef:
        name, pts, cnt = ef['member']
        add('house', 'purchase', cnt, fixed_member=name)
    trades = pd.DataFrame(rows)

    # inject effects into the price paths (transient ramps so other events are not contaminated)
    for r in trades.itertuples():
        f = pd.Timestamp(r.filed)
        if ef.get('pre2024_only') and f >= SPLIT:
            continue
        x = 0.0
        if r.tx_type == 'Purchase':
            if r.chamber == 'senate':
                x += ef.get('senate', 0.0)
            elif r.chamber == 'house':
                x += ef.get('house', 0.0)
            if 'member' in ef and r.member == ef['member'][0]:
                x += ef['member'][1]
            if 'sector' in ef and sector_of[r.ticker] == ef['sector'][0]:
                x += ef['sector'][1]
            if ef.get('size_slope'):
                x += ef['size_slope'] * max(0.0, np.log2(r.amount_low) - 10)
        elif ef.get('sales'):
            x += ef['sales']
        if x:
            ei, c = idx(np.datetime64(f)), colix[r.ticker]
            m = min(n - ei, 160)
            if m > 0:
                px[c, ei:ei + m] *= 1 + (x / 100) * ramp(m)
        if ef.get('delay_only') and r.chamber == 'senate' and r.tx_type == 'Purchase':
            ti, ei, c = idx(np.datetime64(pd.Timestamp(r.traded))), idx(np.datetime64(f)), colix[r.ticker]
            if ei > ti and ei < n:
                px[c, ti:ei] *= 1 + (ef['delay_only'] / 100) * np.arange(ei - ti) / (ei - ti)
                px[c, ei:] *= 1 + ef['delay_only'] / 100
    wide = pd.DataFrame(px.T, index=days, columns=cols)
    return {'trades': trades, 'wide': wide, 'sectors': sector_of, 'members': members}
