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
    """The free plan serves only the newest page (about 100 filings, roughly two months of Senate
    disclosures) and rejects page and limit parameters. The daily job adds these to the saved copy."""
    rows = get(path, {'page': 0}, k)
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


# Same company, different symbol. Filers and FMP disagree on share class or listing (GOOG vs GOOGL,
# NOK vs the OTC line NOKBF). Each group maps to one canonical symbol for matching only.
SAME_COMPANY = [
    {'GOOG', 'GOOGL'}, {'BRK.A', 'BRK.B'}, {'NOK', 'NOKBF'}, {'FOX', 'FOXA'}, {'NWS', 'NWSA'},
    {'UA', 'UAA'}, {'LBRDA', 'LBRDK'}, {'LEN', 'LEN.B'}, {'HEI', 'HEI.A'}, {'MOG.A', 'MOG.B'},
]
_CANON = {t: sorted(g)[0] for g in SAME_COMPANY for t in g}


def norm_ticker(sym):
    """Comparable symbol: upper case, BRK-B and BRK/B written as BRK.B, share classes folded together."""
    s = re.sub(r'[-/ ]', '.', str(sym or '').strip().upper())
    return _CANON.get(s, s)


_FILLER = {'the', 'inc', 'corp', 'corporation', 'company', 'class', 'common', 'stock', 'new', 'shs', 'ord', 'ads', 'adr',
           'oyj', 'plc', 'ltd', 'limited', 'capital', 'sponsored', 'american', 'depositary', 'shares', 'group', 'holdings'}


def _company_words(text):
    """First three distinctive words of a company name, for matching when the sources use different symbols."""
    return [w for w in re.findall(r'[a-z0-9&]+', str(text or '').lower()) if len(w) >= 3 and w not in _FILLER][:3]


def _same_company(a, b):
    """The distinctive words both names have must agree, in order (iShares Core S&P 500 is not
    iShares Core MSCI EAFE). A name reduced to one word ('Nokia') matches on that word."""
    wa, wb = _company_words(a), _company_words(b)
    n = min(len(wa), len(wb))
    return n > 0 and wa[:n] == wb[:n]


def _plus_days(day, n):
    try:
        return (datetime.date.fromisoformat(day) + datetime.timedelta(days=n)).isoformat()
    except ValueError:
        return day


def house_check(trades_path, k, days=21):
    """Share of FMP's recent House trades that also appear in our official House scrape.

    A trade matches on member last name, trade date, type and normalized ticker. When the tickers
    differ, the same member, date and type with the same company name still counts (reported as
    matched_other_symbol). Every miss is kept and given a cause so the gap can be worked down.
    """
    since = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()
    fmp = fetch_latest('house-latest', since, k)
    d = json.load(open(trades_path))
    ours = [t for t in d.get('trades', []) if t.get('source', 'house') == 'house']
    def last(n): return str(n).split(',')[0].strip().lower()
    have = {(last(t.get('representative', '')), norm_ticker(t.get('ticker')), t.get('date'), (t.get('type') or '')[:4]) for t in ours}
    by_mdt = {}
    for t in ours:
        by_mdt.setdefault((last(t.get('representative', '')), t.get('date'), (t.get('type') or '')[:4]), []).append(t)
    members = {last(t.get('representative', '')) for t in ours}
    newest_filed = max((t.get('filed') or '' for t in ours), default='')
    empty = {last(e.get('name', '')) for e in (d.get('house_parse_report') or {}).get('empty', [])}

    checked = matched = other_symbol = 0
    misses, causes, used = [], {}, set()
    for r in fmp:
        sym = str(r.get('symbol') or '').upper()
        date = (r.get('transactionDate') or '')[:10]
        if not sym or not date:
            continue
        checked += 1
        name, typ = str(r.get('lastName') or '').strip().lower(), tx_type(str(r.get('type') or ''))[:4]
        if (name, norm_ticker(sym), date, typ) in have:
            matched += 1
            continue
        cand = [t for t in by_mdt.get((name, date, typ), [])
                if id(t) not in used and _same_company(t.get('description'), r.get('assetDescription'))]
        if cand:
            used.add(id(cand[0]))  # one of our trades can stand in for only one FMP row
            matched += 1; other_symbol += 1
            continue
        filed = (r.get('disclosureDate') or '')[:10]
        # Our 'filed' is the signature date; FMP's is the Clerk posting date, often a few days later
        if filed and newest_filed and filed > _plus_days(newest_filed, 3):
            cause = 'filed_after_our_last_scrape'
        elif name not in members:
            cause = 'member_has_no_trades_in_our_data' + ('' if name not in empty else '_filing_unreadable')
        else:
            cause = 'trade_missing_for_known_member'
        causes[cause] = causes.get(cause, 0) + 1
        near = sorted(h for h in have if h[0] == name and h[1] == norm_ticker(sym))[:2]
        misses.append({'fmp': [name, sym, date, typ], 'filed': filed, 'cause': cause,
                       'ours_same_member_ticker': [list(x) for x in near]})
    # Reverse direction: share of our recent official House trades (filed in FMP's window) that FMP also has
    fmp_keys = {(str(r.get('lastName') or '').strip().lower(), norm_ticker(r.get('symbol')), (r.get('transactionDate') or '')[:10],
                 tx_type(str(r.get('type') or ''))[:4]) for r in fmp}
    oldest = min((r.get('disclosureDate') or '9999')[:10] for r in fmp) if fmp else '9999'
    recent = [t for t in ours if t.get('ticker') and (t.get('filed') or '') >= oldest]
    ours_found = sum(1 for t in recent if (last(t.get('representative', '')), norm_ticker(t['ticker']), t.get('date'), (t.get('type') or '')[:4]) in fmp_keys)
    return {'ours_checked': len(recent), 'ours_found_in_fmp': ours_found, 'checked': checked, 'matched': matched,
            'matched_other_symbol': other_symbol, 'rate': round(matched / checked, 3) if checked else None,
            'window_days': days, 'miss_causes': causes, 'misses': misses[:100]}


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
        if res.get('miss_causes'):
            print('::notice::misses by cause ' + json.dumps(res['miss_causes']))
        for m in res['misses']:
            print('::notice::miss ' + json.dumps(m))
    else:
        known = []
        if a.known and os.path.exists(a.known):
            d = json.load(open(a.known))
            known = sorted({x['representative'] for x in (d.get('trades', d) if isinstance(d, dict) else d) if x.get('representative')})
        t = senate(a.since, k, known)
        json.dump(t, open(a.out, 'w'))
        print(f'::notice::FMP Senate: {len(t)} trades disclosed since {a.since}')
