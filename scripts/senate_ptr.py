"""Senate periodic transaction reports from the Senate's official eFD site (efdsearch.senate.gov).

Electronic reports are HTML tables and are parsed here. Scanned paper reports are skipped.
Output rows use the same shape as scripts/house_ptr.py, with source 'senate'.

Usage: python3 scripts/senate_ptr.py --since 2021-01-01 --out senate.json
"""
import argparse, datetime, json, re, time
import requests
from bs4 import BeautifulSoup

BASE = 'https://efdsearch.senate.gov'
UA = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36'}
PTR = 11  # eFD report type id for periodic transaction reports
SENATORS = '[1,5]'  # eFD filer types: 1 sitting senator, 5 former senator (candidates, 4, are excluded)


def session():
    """Open a search session. The site asks visitors to acknowledge its terms of use (personal,
    non-commercial use) before searching; this does the same as ticking that box."""
    s = requests.Session()
    s.headers.update(UA)
    r = s.get(BASE + '/search/home/', timeout=30)
    soup = BeautifulSoup(r.text, 'html.parser')
    tok = soup.find('input', {'name': 'csrfmiddlewaretoken'})
    s.post(BASE + '/search/home/', data={'prohibition_agreement': '1', 'csrfmiddlewaretoken': tok['value'] if tok else ''},
           headers={'Referer': BASE + '/search/home/'}, timeout=30)
    return s


def list_reports(s, since):
    out, start = [], 0
    while True:
        r = s.post(BASE + '/search/report/data/', timeout=60, headers={
            'Referer': BASE + '/search/', 'X-CSRFToken': s.cookies.get('csrftoken', ''), 'X-Requested-With': 'XMLHttpRequest'},
            data={'start': str(start), 'length': '100', 'report_types': f'[{PTR}]', 'filer_types': SENATORS,
                  'submitted_start_date': since.strftime('%m/%d/%Y 00:00:00'), 'submitted_end_date': '',
                  'candidate_state': '', 'senator_state': '', 'office_id': '', 'first_name': '', 'last_name': '', 'draw': '1'})
        r.raise_for_status()
        d = r.json()
        rows = d.get('data') or []
        for first, last, _office, link, received in rows:
            m = re.search(r'href="([^"]+)"', link)
            if not m:
                continue
            out.append({'name': f"{BeautifulSoup(last, 'html.parser').get_text(strip=True)}, {BeautifulSoup(first, 'html.parser').get_text(strip=True)}",
                        'url': BASE + m.group(1), 'paper': '/paper/' in m.group(1), 'received': received})
        start += len(rows)
        if not rows or start >= int(d.get('recordsFiltered') or 0):
            return out
        time.sleep(0.5)


def iso(d):
    try:
        return datetime.datetime.strptime(d.strip(), '%m/%d/%Y').strftime('%Y-%m-%d')
    except Exception:
        return ''


def tx_type(t):
    t = t.lower()
    return 'Purchase' if t.startswith('purchase') else 'Sale' if t.startswith('sale') else 'Exchange' if t.startswith('exchange') else t.title()


def parse_report(html, name, filed):
    """Read the transactions table of one electronic report."""
    soup = BeautifulSoup(html, 'html.parser')
    out = []
    for table in soup.find_all('table'):
        heads = [th.get_text(' ', strip=True).lower() for th in table.find_all('th')]
        if not any('ticker' in h for h in heads) or not any('amount' in h for h in heads):
            continue
        col = {k: next((i for i, h in enumerate(heads) if k in h), None) for k in ('transaction date', 'ticker', 'asset name', 'asset type', 'type', 'amount')}
        # "type" also matches "asset type"; pick the plain "type" column
        col['type'] = next((i for i, h in enumerate(heads) if h == 'type'), col['type'])
        for tr in table.find('tbody').find_all('tr') if table.find('tbody') else []:
            cells = [td.get_text(' ', strip=True) for td in tr.find_all('td')]
            get = lambda k: cells[col[k]] if col[k] is not None and col[k] < len(cells) else ''
            ticker = re.sub(r'[^A-Z.]', '', get('ticker').upper()) if get('ticker') not in ('--', '') else ''
            asset = re.sub(r'\s+', ' ', get('asset name')).strip()
            kind = get('asset type') or ''
            amount = re.sub(r'\s*-\s*', ' - ', get('amount')).strip()
            date = iso(get('transaction date'))
            if not date or not (ticker or asset):
                continue
            stock = bool(ticker) and ('stock' in kind.lower() or 'etf' in kind.lower() or not kind)
            out.append({'date': date, 'filed': filed, 'representative': name, 'ticker': ticker if stock else '',
                        'type': tx_type(get('type')), 'amount': amount, 'description': asset[:60],
                        'private': not stock, 'kind': 'Stock' if stock else (kind or 'Other asset'), 'source': 'senate'})
    return out


def scrape(since, log=print):
    s = session()
    reports = list_reports(s, since)
    electronic = [r for r in reports if not r['paper']]
    log(f'Senate: {len(reports)} reports since {since}, {len(electronic)} electronic (paper ones skipped)')
    trades = []
    for i, rep in enumerate(electronic):
        try:
            r = s.get(rep['url'], timeout=30)
            if r.status_code == 200:
                trades.extend(parse_report(r.text, rep['name'], iso(rep['received'])))
        except Exception as e:
            log(f"Error {rep['name']}: {e}")
        if (i + 1) % 50 == 0:
            log(f'Processed {i + 1}/{len(electronic)}, trades: {len(trades)}')
        time.sleep(0.3)  # be gentle with the Senate's site
    seen, unique = set(), []
    for t in trades:
        k = (t['representative'], t['date'], t['type'], t['ticker'] or t['description'], t['amount'])
        if k not in seen:
            seen.add(k)
            unique.append(t)
    unique.sort(key=lambda t: t['date'], reverse=True)
    log(f'Senate: {len(unique)} unique trades')
    return unique


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', default=None, help='YYYY-MM-DD, default Jan 1 of this year')
    ap.add_argument('--out', default='senate.json')
    a = ap.parse_args()
    since = datetime.date.fromisoformat(a.since) if a.since else datetime.date(datetime.date.today().year, 1, 1)
    trades = scrape(since)
    with open(a.out, 'w') as f:
        json.dump(trades, f)
    print(f'Saved {len(trades)} Senate trades')
