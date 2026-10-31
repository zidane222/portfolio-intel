"""House periodic transaction reports (PTRs): download and parse one filing year.

Shared by the daily job (current year -> trades.json) and the history backfill.
Usage: python3 scripts/house_ptr.py --year 2026 --out trades.json [--limit 5000]
"""
import requests, json, datetime, re, io, time
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

# ── OCR for scanned paper filings ───────────────────────────────────────────
# Paper PTRs (McCaul files this way) have no text layer. Render each page with pdftoppm and
# read it with tesseract (both from apt in the workflow). Rows still have to show a ticker in
# parentheses, a transaction type and a date, so OCR noise yields no row rather than a wrong one.
OCR_DPI = 300
OCR_MAX_PAGES = 20
OCR_DATE = re.compile(r'\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b')
OCR_TX = re.compile(r'(?:^|\s)(Partial\s+Sale|S\s*\(partial\)|Purchase|Sale|Exchange|P|S|E)(?=\s)', re.I)
OCR_TICKER = re.compile(r'\(([A-Z0-9]{1,5}(?:\.[A-Z])?)\)')


def ocr_available():
    import shutil
    return bool(shutil.which('tesseract') and shutil.which('pdftoppm'))


def ocr_pdf_text(content, max_pages=OCR_MAX_PAGES):
    """Text of a scanned PDF, page by page. Returns '' if OCR tools are missing or fail."""
    import subprocess, tempfile, glob, os
    if not ocr_available():
        return ''
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, 'f.pdf')
        with open(src, 'wb') as f:
            f.write(content)
        try:
            subprocess.run(['pdftoppm', '-r', str(OCR_DPI), '-gray', '-l', str(max_pages), '-png', src, os.path.join(d, 'p')],
                           check=True, capture_output=True, timeout=120)
            out = []
            for img in sorted(glob.glob(os.path.join(d, 'p*.png'))):
                r = subprocess.run(['tesseract', img, '-', '--psm', '6'], capture_output=True, timeout=120)
                out.append(r.stdout.decode('utf-8', 'replace'))
            return '\n'.join(out)
        except (subprocess.SubprocessError, OSError):
            return ''


def _ocr_date(m):
    mo, dy, yr = (int(x) for x in m.groups())
    if yr < 100:
        yr += 2000
    if not (1 <= mo <= 12 and 1 <= dy <= 31 and 2000 <= yr <= 2100):
        return None
    return f'{mo:02d}/{dy:02d}/{yr}'


def ocr_rows(text):
    """(asset_text, tx, date, amount_text) per OCR line that holds a ticker, a type and a date.
    The first date on the line is the transaction date; the notification date follows it."""
    rows = []
    for line in text.splitlines():
        line = re.sub(r'\s+', ' ', line).strip()
        tk = OCR_TICKER.search(line)
        dm = next((m for m in OCR_DATE.finditer(line) if _ocr_date(m)), None)
        if not tk or not dm:
            continue
        ticker = tk.group(1).replace('0', 'O')  # OCR reads O as 0 inside tickers
        if not ticker.isalpha() and '.' not in ticker:
            continue
        head = line[:dm.start()]
        txs = list(OCR_TX.finditer(' ' + head[tk.end():] + ' '))
        if not txs:
            continue
        tx = txs[-1].group(1).strip()
        tx = 'S (partial)' if 'partial' in tx.lower() else tx[0].upper()
        asset = line[:tk.start()].strip() + f' ({ticker})'
        rows.append((asset, tx, _ocr_date(dm), line[dm.end():]))
    return rows


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

    filings, skipped_rows = [], []
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
                else:
                    skipped_rows.append({'name': name, 'url': '', 'reason': 'no PDF link in search results'})

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

    def download(url):
        """Long reports can be several MB, so allow 45 s. Retry once only on a timeout, a dropped
        connection or a 5xx; a 404 or other 4xx will not change on a second try."""
        last = None
        for attempt in range(2):
            try:
                r3 = session.get(url, headers=headers, timeout=45)
                if r3.status_code == 200:
                    return r3.content, ''
                last = f'HTTP {r3.status_code}'
                if r3.status_code < 500:
                    break
            except requests.RequestException as e:
                last = type(e).__name__
            if attempt == 0:
                time.sleep(3)
        return None, f'download failed ({last})'

    def parse_pdf(name, url):
        """Returns (trades, reason). reason says why a filing gave no trades, so gaps show up in the log."""
        trades = []
        content, reason = download(url)
        if content is None:
            return trades, reason
        try:
            with pdfplumber.open(io.BytesIO(content)) as pdf:
                text = '\n'.join((pg.extract_text() or '') for pg in pdf.pages)
                if not text.strip():
                    # Paper filings are scanned images with no text layer; read them with OCR
                    pages = len(pdf.pages)
                    ocr_text = ocr_pdf_text(content)
                    for asset, tx, d, rest in ocr_rows(ocr_text):
                        t = make_trade(name, asset, tx, d, rest, '')
                        if t:
                            t['ocr'] = True
                            trades.append(t)
                    if trades:
                        return trades, ''
                    why = 'OCR found no transaction rows' if ocr_text.strip() else 'OCR unavailable or failed'
                    return trades, f'no text layer, likely a scanned paper filing ({pages} pages); {why}'
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
            log(f"Error {safe(name)}: {type(e).__name__}")
            return trades, f'parse error ({type(e).__name__}) after {len(trades)} rows'
        return trades, '' if trades else 'no transaction rows recognized'

    # Process ALL filings
    empty = list(skipped_rows)
    for i, filing in enumerate(filings):
        trades, why = parse_pdf(filing['name'], filing['url'])
        all_trades.extend(check_date(t) for t in trades)
        if why.startswith('parse error') or not trades:
            empty.append({'name': filing['name'], 'url': filing['url'], 'reason': why, 'partial': bool(trades)})
            log(f"::warning::No trades from {safe(filing['name'])}: {why} {safe(filing['url'])}")
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

    suspect = [t for t in unique if t.get('date_suspect')]
    if suspect:
        log(f"::warning::{len(suspect)} trades have a trade date after the filing date")

    report = {'filings': len(filings), 'empty_count': len(empty), 'empty': empty[:200], 'date_suspect': len(suspect),
              'date_corrected': sum(1 for t in unique if t.get('date_as_filed'))}
    log(f"Filings with no trades: {len(empty)} of {len(filings) + len(skipped_rows)}")

    # Sort newest first
    unique.sort(key=lambda x: x.get('date', ''), reverse=True)
    log(f"\nTotal unique trades: {len(unique)}")
    for t in unique[:10]:
        log(f"  {t['representative']} | {t['ticker'] or 'PRIVATE ' + t['description']} | {t['type']} | {t['date']} | filed {t['filed']}")

    return unique, report


def safe(text):
    """Text from the Clerk site printed in a workflow log: escape so it cannot start a new workflow command."""
    return str(text).replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')


def check_date(t):
    """A trade cannot be dated after its filing. When the year is one too high (12/26/2026 on a report
    signed 02/09/2026), the filer meant the prior year: use it and keep the original. Otherwise flag it."""
    d, f = t.get('date') or '', t.get('filed') or ''
    if not (re.fullmatch(r'\d{4}-\d{2}-\d{2}', d) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', f)) or d <= f:
        return t
    prior = f'{int(d[:4]) - 1}{d[4:]}'
    try:
        gap = (datetime.date.fromisoformat(f) - datetime.date.fromisoformat(prior)).days
    except ValueError:
        gap = -1
    if 0 <= gap <= 120:
        t['date_as_filed'], t['date'] = d, prior
    else:
        t['date_suspect'] = True
    return t


if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--year', type=int, default=datetime.datetime.now().year)
    ap.add_argument('--out', default='trades.json')
    ap.add_argument('--limit', type=int, default=5000)
    ap.add_argument('--plain', action='store_true', help='write a plain list (for the history loader)')
    a = ap.parse_args()
    unique, report = scrape(a.year)
    if a.plain:
        with open(a.out, 'w') as f:
            json.dump(unique, f)
    else:
        output = {
            'trades': unique[:a.limit],  # full year; the limit is only a safety cap
            'house_count': len(unique),
            'senate_count': 0,
            'house_parse_report': report,
            'updated': datetime.datetime.now(datetime.timezone.utc).isoformat()
        }
        with open(a.out, 'w') as f:
            json.dump(output, f)
    print(f"Saved {len(unique)} trades for {a.year}")
