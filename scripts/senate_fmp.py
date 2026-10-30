"""Senate periodic transaction reports from Financial Modeling Prep (FMP), plus a House cross-check.

The Senate eFD site blocks automated requests since 2026-10-23, so Senate trades come from FMP's
senate-latest feed (free plan). Each row keeps FMP's link to the official Senate filing so any trade
can be checked against the source. Output rows use the same shape as scripts/senate_ptr.py.

The House cross-check compares FMP's latest House trades with our own scrape of the official House
Clerk site. The match rate is a running measure of how far FMP's data can be trusted.

Usage:
  python3 scripts/senate_fmp.py --since 2026-01-01 --out senate.json
  python3 scripts/senate_fmp.py --house-check trades.json
Needs FMP_API_KEY in the environment. The key is never printed.
"""
import argparse, datetime, json, os, re, sys, time
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from senate_ptr import classify_fund, tx_type  # noqa: E402

API = 'https://financialmodelingprep.com/stable/'
PAGE_LIMIT = 100
MAX_PAGES = 40  # about 4,000 filings; well under the free plan's 250 calls a day


def key():
    k = os.environ.get('FMP_API_KEY', '').strip()
    if not k:
        sys.exit('FMP_API_KEY is not set')
    return k


def get(path, params, k):
    for attempt in range(3):
        try:
            r = requests.get(API + path, params={**params, 'apikey': k}, timeout=30)
        except requests.RequestException:
            time.sleep(2 * (attempt + 1)); continue
        if r.status_code == 429:
            time.sleep(5 * (attempt + 1)); continue
        if r.status_code != 200:
            raise RuntimeError(f'FMP {path} returned {r.status_code}')  # message never includes the key
        d = r.json()
        return d if isinstance(d, list) else []
    raise RuntimeError(f'FMP {path} unreachable')


def fetch_latest(path, since, k):
    """Page through a *-latest feed (newest disclosures first) until filings are older than since."""
    rows = []
    for page in range(MAX_PAGES):
        batch = get(path, {'page': page, 'limit': PAGE_LIMIT}, k)
        if not batch:
            break
        rows.extend(batch)
        if min((r.get('disclosureDate') or '9999') for r in batch) < since:
            break
        time.sleep(0.3)
    return [r for r in rows if (r.get('disclosureDate') or '') >= since]


def to_trade(r):
    """FMP row to our trade shape (same fields as senate_ptr.parse_report)."""
    date, filed = (r.get('transactionDate') or '')[:10], (r.get('disclosureDate') or '')[:10]
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date or ''):
        return None
    sym = re.sub(r'[^A-Z.]', '', str(r.get('symbol') or '').upper())
    asset = re.sub(r'\s+', ' ', str(r.get('assetDescription') or '')).strip()
    kind = str(r.get('assetType') or '')
    k = kind.lower()
    fund = 'mutual fund' in k or ('fund' in k and 'etf' not in k)
    etf = 'etf' in k or 'exchange traded' in k
    tradable = bool(sym) and ('stock' in k or etf or fund or not kind)
    name = f"{str(r.get('lastName') or '').strip()}, {str(r.get('firstName') or '').strip()}".strip(', ')
    out = {'date': date, 'filed': filed, 'representative': name, 'ticker': sym if tradable else '',
           'type': tx_type(str(r.get('type') or '')), 'amount': re.sub(r'\s*-\s*', ' - ', str(r.get('amount') or '')).strip(),
           'description': asset[:60], 'private': not tradable,
           'kind': classify_fund(sym, asset, kind) if tradable else (kind or 'Other asset'), 'source': 'senate'}
    link = str(r.get('link') or '')
    if link.startswith('https://efdsearch.senate.gov/'):
        out['link'] = link
    return out


def tkey(t):
    return (t['representative'].lower(), t['date'], t['type'], t['ticker'] or t['description'].lower(), t['amount'])


def canon_names(known):
    """Map a senator's last name to the spelling already in our data ('McCormick, David H' rather than
    FMP's 'McCormick, Dave') so one senator never shows up as two people. Only unambiguous last names."""
    by_last = {}
    for n in known:
        by_last.setdefault(n.split(',')[0].strip().lower(), set()).add(n)
    return {k: next(iter(v)) for k, v in by_last.items() if len(v) == 1}


def senate(since, k, known=()):
    names = canon_names(known)
    trades, seen = [], set()
    for r in fetch_latest('senate-latest', since, k):
        t = to_trade(r)
        if t:
            t['representative'] = names.get(t['representative'].split(',')[0].strip().lower(), t['representative'])
        if t and tkey(t) not in seen:
            seen.add(tkey(t)); trades.append(t)
    trades.sort(key=lambda t: t['date'], reverse=True)
    return trades


def house_check(trades_path, k, days=21):
    """Share of FMP's recent House trades that also appear in our official House scrape."""
    since = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()
    fmp = fetch_latest('house-latest', since, k)
    ours = json.load(open(trades_path)).get('trades', [])
    def last(n): return str(n).split(',')[0].strip().lower()
    have = {(last(t.get('representative', '')), (t.get('ticker') or '').upper(), t.get('date'), (t.get('type') or '')[:4])
            for t in ours if t.get('source', 'house') == 'house'}
    checked = matched = 0
    for r in fmp:
        sym = str(r.get('symbol') or '').upper()
        date = (r.get('transactionDate') or '')[:10]
        if not sym or not date:
            continue
        checked += 1
        if (str(r.get('lastName') or '').strip().lower(), sym, date, tx_type(str(r.get('type') or ''))[:4]) in have:
            matched += 1
    return {'checked': checked, 'matched': matched, 'rate': round(matched / checked, 3) if checked else None, 'window_days': days}


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', default=f'{datetime.date.today().year}-01-01')
    ap.add_argument('--out', default='senate.json')
    ap.add_argument('--house-check', metavar='TRADES_JSON')
    ap.add_argument('--known', help='JSON file with earlier Senate trades, for consistent senator names')
    a = ap.parse_args()
    k = key()
    if a.house_check:
        res = house_check(a.house_check, k)
        print(json.dumps(res))
        print(f"::notice::FMP House cross-check: {res['matched']} of {res['checked']} recent FMP House trades match the official House scrape")
    else:
        known = []
        if a.known and os.path.exists(a.known):
            d = json.load(open(a.known))
            known = sorted({x['representative'] for x in (d.get('trades', d) if isinstance(d, dict) else d) if x.get('representative')})
        t = senate(a.since, k, known)
        json.dump(t, open(a.out, 'w'))
        print(f'::notice::FMP Senate: {len(t)} trades disclosed since {a.since}')
