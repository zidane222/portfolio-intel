"""House periodic transaction reports (PTRs): download and parse one filing year.

Shared by the daily job (current year -> trades.json) and the history backfill.
Usage: python3 scripts/house_ptr.py --year 2026 --out trades.json [--limit 5000]
"""
import requests, json, datetime, re, io
from bs4 import BeautifulSoup
import pdfplumber

BASE = 'https://disclosures-clerk.house.gov'
headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': '*/*',
    'Referer': BASE + '/FinancialDisclosure',
}

FUND_RE = re.compile(r'\bETF\b|\bSPDR\b|\biShares\b|Invesco QQQ|Exchange[- ]Traded|Index Fund', re.I)


def classify_fund(ticker, name, reported=''):
    """Mutual fund, ETF or Stock. Members often file ETFs as plain stock, so check the name and
    ticker too: mutual fund tickers are 5 letters ending in X (VFIAX, FXAIX)."""
    r = (reported or '').lower()
    if 'mutual' in r or re.fullmatch(r'[A-Z]{4}X', ticker or ''):
        return 'Mutual fund'
    if 'etf' in r or 'exchange traded' in r or FUND_RE.search(name or ''):
        return 'ETF'
    return 'Stock'

SKIP = {'ST','OT','SP','JT','OP','PT','RE','CO','FX','HE','PE','CS','PS'}

def scrape(year, log=print):
    session = requests.Session()
    all_trades = []

    # Get CSRF token
    r = session.get(BASE + '/FinancialDisclosure/ViewSearch', headers=headers, timeout=15)
    soup = BeautifulSoup(r.text, 'html.parser')
    csrf = soup.find('input', {'name': '__RequestVerificationToken'})
    csrf_token = csrf['value'] if csrf else ''

    # Get PTR filings list
    payload = {
        'LastName': '', 'FilingYear': str(year),
        'State': '', 'District': '',
        '__RequestVerificationToken': csrf_token,
        'FilingType': 'P',
    }
    r2 = session.post(
        BASE + '/FinancialDisclosure/ViewMemberSearchResult',
        data=payload,
        headers={**headers, 'Content-Type': 'application/x-www-form-urlencoded'},
        timeout=20
    )
    soup2 = BeautifulSoup(r2.text, 'html.parser')
    table = soup2.find('table')

    filings = []
    if table:
        rows = table.find_all('tr')[1:]
        for row in rows:
            cells = row.find_all('td')
            if len(cells) >= 4:
                name = cells[0].get_text(strip=True).replace('Hon.. ', '').strip()
                link = row.find('a')
                href = link['href'] if link else ''
                if href and '.pdf' in href:
                    filings.append({'name': name, 'url': BASE + '/' + href})

    log(f"Found {len(filings)} PTR filings, parsing all...")

    def extract_ticker(text):
        m = re.search(r'\(([A-Z]{1,5}(?:\.[A-Z])?)\)\s*\[', text)
        if m and m.group(1) not in SKIP:
            return m.group(1)
        m = re.search(r'(?:NYSEARCA|NASDAQ|NYSE):\s*([A-Z]{1,5})', text)
        if m:
            return m.group(1)
        m = re.search(r'\(([A-Z]{1,5})\)', text)
        if m and m.group(1) not in SKIP:
            return m.group(1)
        return None

    def parse_date(date_str):
        # Convert MM/DD/YYYY to YYYY-MM-DD for proper sorting
        try:
            return datetime.datetime.strptime(date_str, '%m/%d/%Y').strftime('%Y-%m-%d')
        except:
            return date_str

    def fund_kind(text):
        # House reports tag each asset with a code: [ST] stock, [EF] exchange-traded fund, [MF] mutual fund
        code = re.search(r'\[([A-Z]{2})\]', text)
        code = code.group(1) if code else ''
        reported = {'MF': 'mutual fund', 'EF': 'etf'}.get(code, '')
        return classify_fund(extract_ticker(text), text, reported)

    def asset_kind(text):
        code = re.search(r'\[([A-Z]{2})\]', text)
        code = code.group(1) if code else ''
        t = text.upper()
        if code in ('GS', 'CS') or re.search(r'\d%|\bDUE\b|\bBDS?\b|\bREV\b|\bBOND|\bNOTES?\b|\bTREASURY', t):
            return 'Bond'
        if re.search(r'\bLLC\b|\bL\.?P\.?\b|\bFUND\b|\bPARTNERS|\bHOLDINGS?\b|\bTRUST\b|\bREIT\b', t):
            return 'Private investment'
        return 'Other asset'

    RANGES = {1001: '$1,001 - $15,000', 15001: '$15,001 - $50,000', 50001: '$50,001 - $100,000',
              100001: '$100,001 - $250,000', 250001: '$250,001 - $500,000', 500001: '$500,001 - $1,000,000',
              1000001: '$1,000,001 - $5,000,000', 5000001: '$5,000,001 - $25,000,000',
              25000001: '$25,000,001 - $50,000,000'}

    def make_trade(name, asset_text, tx, date_str, amount_text, filed_date, desc_text=None):
        ticker = extract_ticker(asset_text)
        company = re.split(r'\(|\[', desc_text if desc_text is not None else asset_text)[0]
        company = re.sub(r'\s+', ' ', company).strip()[:60]
        if not ticker and not company:
            return None
        tx = tx.strip()
        tx_type = 'Purchase' if tx.startswith('P') else 'Sale' if tx.startswith('S') else 'Exchange' if tx.startswith('E') else tx
        amount_clean = re.sub(r'\([A-Z.\-]{1,7}\)|\[[A-Z]{2}\]', ' ', amount_text or '')
        amount_clean = re.sub(r'\s+', ' ', amount_clean).strip()
        am = re.search(r'\$[\d,]+\s*-\s*\$[\d,]+', amount_clean) or re.search(r'Over \$[\d,]+', amount_clean)
        amount = re.sub(r'\s*-\s*', ' - ', am.group(0)) if am else ''
        if not amount:
            # Wrapped cells can cut off the upper bound; House ranges are fixed, so infer it
            lo = re.search(r'\$([\d,]+)\s*-', amount_clean)
            if lo:
                amount = RANGES.get(int(lo.group(1).replace(',', '')), '')
        return {
            'date': parse_date(date_str),
            'filed': filed_date,
            'representative': name,
            'ticker': ticker or '',
            'type': tx_type,
            'amount': amount,
            'description': company,
            'private': not ticker,
            'kind': fund_kind(asset_text) if ticker else asset_kind(asset_text),
            'source': 'house'
        }

    # A row the table extractor collapsed into one cell, e.g.
    # "SP REOF XXX, LLC [AB] P 09/08/2026 09/08/2026 $1,000,001 - $5,000,000"
    COLLAPSED = re.compile(r'^(?:(?:SP|JT|DC)\s+)?(.+?)\s+(P|S \(partial\)|S|E)\s+(\d{2}/\d{2}/\d{4})\s+\d{2}/\d{2}/\d{4}\s*(.*)$', re.S)

    def parse_pdf(name, url):
        trades = []
        try:
            r3 = session.get(url, headers=headers, timeout=15)
            if r3.status_code != 200:
                return trades
            with pdfplumber.open(io.BytesIO(r3.content)) as pdf:
                text = '\n'.join((pg.extract_text() or '') for pg in pdf.pages)
                # Filing date = when the member signed the report, not the notification column
                sm = re.search(r'Digitally Signed:[^\n]*?(\d{2}/\d{2}/\d{4})', text)
                filed_date = parse_date(sm.group(1)) if sm else ''
                for page in pdf.pages:
                    for tbl in page.extract_tables():
                        for row in tbl:
                            if not row:
                                continue
                            cells = [str(c or '').replace('\x00', '') for c in row]
                            t = None
                            if len(cells) >= 7 and re.search(r'\d{2}/\d{2}/\d{4}', cells[4]) and cells[3].strip()[:1] in ('P', 'S', 'E'):
                                dm = re.search(r'(\d{2}/\d{2}/\d{4})', cells[4])
                                t = make_trade(name, cells[2], cells[3], dm.group(1), cells[6], filed_date)
                            elif cells[0].strip() and not any(c.strip() for c in cells[1:]):
                                m = COLLAPSED.match(re.sub(r'\s+', ' ', cells[0]).strip())
                                if m:
                                    asset, tx, d, rest = m.groups()
                                    # The ticker can land after the amount when the cell wraps
                                    t = make_trade(name, asset + ' ' + rest, tx, d, rest, filed_date, desc_text=asset)
                            if t:
                                trades.append(t)
        except Exception as e:
            log(f"Error {name}: {e}")
        return trades

    # Process ALL filings
    for i, filing in enumerate(filings):
        trades = parse_pdf(filing['name'], filing['url'])
        all_trades.extend(trades)
        if (i+1) % 50 == 0:
            log(f"Processed {i+1}/{len(filings)}, trades: {len(all_trades)}")

    # Deduplicate. The same trade can appear twice (a collapsed copy plus the full row),
    # so prefer the most complete version and drop no-ticker copies of a stock row.
    def norm(x):
        return re.sub(r'[^a-z0-9]', '', (x or '').lower())[:14]
    def score(t):
        return (bool(t['ticker']), bool(t['amount']), bool(t['filed']))
    best = {}
    for t in all_trades:
        key = (t['representative'], t['date'], t['type'], t['ticker'] or norm(t['description']))
        if key not in best or score(t) > score(best[key]):
            best[key] = t
    stock_desc = {(t['representative'], t['date'], t['type'], norm(t['description'])) for t in best.values() if t['ticker']}
    unique = [t for t in best.values()
              if t['ticker'] or (t['representative'], t['date'], t['type'], norm(t['description'])) not in stock_desc]

    # Sort newest first
    unique.sort(key=lambda x: x.get('date', ''), reverse=True)
    log(f"\nTotal unique trades: {len(unique)}")
    for t in unique[:10]:
        log(f"  {t['representative']} | {t['ticker'] or 'PRIVATE ' + t['description']} | {t['type']} | {t['date']} | filed {t['filed']}")

    return unique


if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--year', type=int, default=datetime.datetime.now().year)
    ap.add_argument('--out', default='trades.json')
    ap.add_argument('--limit', type=int, default=5000)
    ap.add_argument('--plain', action='store_true', help='write a plain list (for the history loader)')
    a = ap.parse_args()
    unique = scrape(a.year)
    if a.plain:
        with open(a.out, 'w') as f:
            json.dump(unique, f)
    else:
        output = {
            'trades': unique[:a.limit],  # full year; the limit is only a safety cap
            'house_count': len(unique),
            'senate_count': 0,
            'updated': datetime.datetime.now(datetime.timezone.utc).isoformat()
        }
        with open(a.out, 'w') as f:
            json.dump(output, f)
    print(f"Saved {len(unique)} trades for {a.year}")
