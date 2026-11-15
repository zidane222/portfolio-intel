"""
Smart money data from the SEC, refreshed by the daily GitHub Action.

Writes:
  smart_money.json  - famous investors' 13F holdings (last 5 quarters)
  insiders.json     - open-market insider purchases (Form 4, code P), rolling 90 days
Caches (committed so each document is fetched once):
  data_cache/cusip_map.json, data_cache/13f/<cik>_<accession>.json
"""
import datetime
import json
import math
import os
import re
import time
import xml.etree.ElementTree as ET

import requests

# The SEC asks automated tools to identify themselves with contact details
UA = {'User-Agent': 'Portfolio Intel (personal project) hasham.abbasi17@gmail.com',
      'Accept-Encoding': 'gzip, deflate'}
SEC_DELAY = 0.13  # stay under the SEC's 10 requests per second

INVESTORS = [
    {'id': 'buffett', 'name': 'Warren Buffett', 'firm': 'Berkshire Hathaway', 'cik': '0001067983'},
    {'id': 'ackman', 'name': 'Bill Ackman', 'firm': 'Pershing Square', 'cik': '0001336528'},
    {'id': 'druckenmiller', 'name': 'Stanley Druckenmiller', 'firm': 'Duquesne Family Office', 'cik': '0001536411'},
    {'id': 'wood', 'name': 'Cathie Wood', 'firm': 'ARK Invest', 'cik': '0001697748'},
    {'id': 'tepper', 'name': 'David Tepper', 'firm': 'Appaloosa', 'cik': '0001656456'},
    {'id': 'bridgewater', 'name': 'Bridgewater', 'firm': 'Bridgewater Associates (founded by Ray Dalio)', 'cik': '0001350694'},
]
TOP_N = 40          # holdings kept per filing
QUARTERS = 5        # filings kept per investor
INSIDER_DAYS = 90   # rolling window for insider buys
INSIDER_MIN = 25000 # ignore tiny purchases
INSIDER_MAX = 1e9   # no single open-market insider purchase comes near this: larger is a filing or parse error
# Time budget for the Form 4 loop. When it runs out, the run keeps what it has and saves "seen",
# so a backlog clears over a few runs instead of one run using up the job limit.
INSIDER_BUDGET_MIN = float(os.environ.get('SMART_MONEY_INSIDER_BUDGET_MIN') or 8)
INSIDER_MAX_TRIES = 3  # a Form 4 that fails this many runs in a row is given up and logged
# Daily indexes read each run. A filing still waiting when its day leaves this window is never read,
# so it matches the 8 days "seen" is kept (KAN-118; was 4).
INSIDER_LOOKBACK_DAYS = int(os.environ.get('SMART_MONEY_LOOKBACK_DAYS') or 7)
# smart_money.yml runs every 3 hours; the 13F, yields and OGE parts run only when older than this
DAILY_HOURS = float(os.environ.get('SMART_MONEY_DAILY_HOURS') or 20)


def daily_due(path='smart_money.json', now=None):
    """True when the daily parts (13F holdings, yields, OGE) should run: the file is missing,
    unreadable or older than DAILY_HOURS."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    try:
        with open(path) as f:
            ts = datetime.datetime.fromisoformat(str(json.load(f).get('updated') or '').replace('Z', '+00:00'))
    except Exception:
        return True
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=datetime.timezone.utc)
    return (now - ts).total_seconds() >= DAILY_HOURS * 3600


def implausible(sh, px):
    """A transaction whose numbers cannot be right: not a finite positive number, or worth more than
    INSIDER_MAX. The known case (LeonaBio, Oct 2026): $3,149.47 a share for 3,149,470 shares, $9.9B."""
    try:
        sh, px = float(sh), float(px)
    except (TypeError, ValueError):
        return True
    if not (math.isfinite(sh) and math.isfinite(px)) or sh <= 0 or px <= 0:
        return True
    return sh * px > INSIDER_MAX

os.makedirs('data_cache/13f', exist_ok=True)


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def sec_get(url, **kw):
    time.sleep(SEC_DELAY)
    r = requests.get(url, headers=UA, timeout=30, **kw)
    r.raise_for_status()
    return r


# ── 13F holdings ─────────────────────────────────────────────
def strip_ns(root):
    for el in root.iter():
        if '}' in el.tag:
            el.tag = el.tag.split('}', 1)[1]
    return root


def parse_13f(cik, accession):
    cache_path = f'data_cache/13f/{cik}_{accession}.json'
    cached = load(cache_path, None)
    if cached:
        return cached
    folder = f'https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession.replace("-", "")}'
    items = sec_get(folder + '/index.json').json()['directory']['item']
    xmls = [i['name'] for i in items if i['name'].lower().endswith('.xml') and 'primary_doc' not in i['name'].lower()]
    if not xmls:
        return []
    root = strip_ns(ET.fromstring(sec_get(f'{folder}/{xmls[0]}').content))
    agg = {}
    for row in root.iter('infoTable'):
        if (row.findtext('putCall') or '').strip():
            continue  # skip options, keep share positions
        cusip = (row.findtext('cusip') or '').strip().upper()
        val = float(row.findtext('value') or 0)
        sh = float(row.findtext('shrsOrPrnAmt/sshPrnamt') or 0)
        a = agg.setdefault(cusip, {'cusip': cusip, 'name': (row.findtext('nameOfIssuer') or '').strip(), 'value': 0, 'shares': 0})
        a['value'] += val
        a['shares'] += sh
    rows = sorted(agg.values(), key=lambda x: -x['value'])
    with open(cache_path, 'w') as f:
        json.dump(rows, f)
    return rows


def map_cusips(cusips, cmap):
    """CUSIP to ticker via OpenFIGI (free, 10 per request, about 25 requests a minute)."""
    need = [c for c in dict.fromkeys(cusips) if c and c not in cmap]
    for i in range(0, len(need), 10):
        batch = need[i:i + 10]
        try:
            r = requests.post('https://api.openfigi.com/v3/mapping',
                              json=[{'idType': 'ID_CUSIP', 'idValue': c} for c in batch], timeout=30)
            if r.status_code == 429:
                time.sleep(30)
                r = requests.post('https://api.openfigi.com/v3/mapping',
                                  json=[{'idType': 'ID_CUSIP', 'idValue': c} for c in batch], timeout=30)
            for c, res in zip(batch, r.json()):
                data = res.get('data') or []
                pick = next((d for d in data if d.get('exchCode') == 'US'), data[0] if data else None)
                cmap[c] = (pick.get('ticker') or '').replace('/', '.') if pick else ''
        except Exception as e:
            print('figi error', e)
        time.sleep(2.6)
    return cmap


def investors():
    cmap = load('data_cache/cusip_map.json', {})
    out = []
    for inv in INVESTORS:
        try:
            sub = sec_get(f'https://data.sec.gov/submissions/CIK{inv["cik"]}.json').json()['filings']['recent']
            filings = [(sub['filingDate'][i], sub['accessionNumber'][i], sub['reportDate'][i])
                       for i in range(len(sub['form'])) if sub['form'][i] == '13F-HR'][:QUARTERS]
            quarters = []
            for filed, acc, period in filings:
                rows = parse_13f(inv['cik'], acc)
                # Some filers still report values in thousands. If the implied share price
                # is implausibly low for most positions, scale the values up.
                implied = sorted(r['value'] / r['shares'] for r in rows if r['shares'])
                if implied and implied[len(implied) // 2] < 1:
                    rows = [{**r, 'value': r['value'] * 1000} for r in rows]
                total = sum(r['value'] for r in rows)
                top = rows[:TOP_N]
                map_cusips([r['cusip'] for r in top], cmap)
                quarters.append({
                    'period': period, 'filed': filed, 'total': round(total), 'positions': len(rows),
                    'holdings': [{'ticker': cmap.get(r['cusip'], ''), 'cusip': r['cusip'], 'name': r['name'].title(),
                                  'value': round(r['value']), 'shares': round(r['shares']),
                                  'pct': round(r['value'] / total * 100, 2) if total else 0} for r in top],
                })
            out.append({**inv, 'quarters': quarters})
            print(f'{inv["name"]}: {len(quarters)} filings, latest {quarters[0]["period"] if quarters else "none"}')
        except Exception as e:
            print('13F error', inv['name'], e)
    with open('data_cache/cusip_map.json', 'w') as f:
        json.dump(cmap, f, indent=0, sort_keys=True)
    return out


# ── Insider purchases (Form 4) ───────────────────────────────
def text_of(block, tag):
    m = re.search(rf'<{tag}>\s*(?:<value>)?\s*([^<]*?)\s*(?:</value>)?\s*</{tag}>', block, re.S)
    return m.group(1).strip() if m else ''


def parse_form4(txt, filed):
    doc = txt[txt.find('<ownershipDocument'):]
    if not doc:
        return None
    buys = []
    for tx in re.findall(r'<nonDerivativeTransaction>(.*?)</nonDerivativeTransaction>', doc, re.S):
        if text_of(tx, 'transactionCode') != 'P':
            continue
        try:
            sh = float(text_of(tx, 'transactionShares') or 0)
            px = float(text_of(tx, 'transactionPricePerShare') or 0)
        except ValueError:
            continue
        if implausible(sh, px):
            print(f'form4 suspect transaction skipped: {re.sub(r"[^A-Z0-9.-]", "", text_of(doc, "issuerTradingSymbol").upper())[:8]} shares {sh:.0f} price {px:.2f}')
            continue
        buys.append((text_of(tx, 'transactionDate'), sh, px))
    if not buys:
        return None
    value = sum(sh * px for _, sh, px in buys)
    if value < INSIDER_MIN:
        return None
    shares = sum(sh for _, sh, _ in buys)
    roles = []
    if text_of(doc, 'isDirector') in ('1', 'true'):
        roles.append('Director')
    title = text_of(doc, 'officerTitle')
    if title:
        roles.append(title)
    elif text_of(doc, 'isOfficer') in ('1', 'true'):
        roles.append('Officer')
    if text_of(doc, 'isTenPercentOwner') in ('1', 'true'):
        roles.append('10% owner')
    return {
        'ticker': text_of(doc, 'issuerTradingSymbol').upper(),
        'company': text_of(doc, 'issuerName'),
        'owner': text_of(doc, 'rptOwnerName'),
        'role': ', '.join(roles) or 'Insider',
        'date': max(d for d, _, _ in buys),
        'filed': filed,
        'shares': round(shares),
        'price': round(value / shares, 2) if shares else 0,
        'value': round(value),
    }


def insiders(budget_s=None, clock=time.monotonic):
    """Insider buys from the last 4 daily indexes. Stops once budget_s seconds have passed
    (default INSIDER_BUDGET_MIN minutes), keeps what it has and reports how many filings still wait."""
    budget_s = INSIDER_BUDGET_MIN * 60 if budget_s is None else budget_s
    start = clock()
    store = load('insiders.json', {'buys': [], 'seen': {}})
    seen = store.get('seen') if isinstance(store.get('seen'), dict) else {}  # index path -> day checked
    # Filings whose fetch or parse failed: path -> {'day', 'tries'}. Retried after new filings,
    # given up (marked seen) after INSIDER_MAX_TRIES so one bad filing cannot eat every budget.
    failed = store.get('failed') if isinstance(store.get('failed'), dict) else {}
    buys = store.get('buys', [])
    today = datetime.date.today()
    queue = []
    for back in range(1, INSIDER_LOOKBACK_DAYS + 1):
        day = today - datetime.timedelta(days=back)
        q = (day.month - 1) // 3 + 1
        try:
            idx = sec_get(f'https://www.sec.gov/Archives/edgar/daily-index/{day.year}/QTR{q}/form.{day:%Y%m%d}.idx').text
        except Exception:
            continue  # weekends and holidays have no index
        paths = [l.split()[-1] for l in idx.splitlines() if l.startswith('4 ')]
        new = [p for p in dict.fromkeys(paths) if p not in seen and p not in failed]
        print(f'{day}: {len(paths)} Form 4 filings, {len(new)} new')
        queue += [(p, day) for p in new]
    # Retries go last, oldest first, so new filings always get the budget first
    retries = sorted(((p, f) for p, f in failed.items() if p not in seen), key=lambda x: x[1].get('day', ''))
    queue += [(p, datetime.date.fromisoformat(f.get('day') or today.isoformat())) for p, f in retries]
    done = gave_up = errors = 0
    for p, day in queue:
        if clock() - start >= budget_s:
            break
        done += 1
        try:
            b = parse_form4(sec_get('https://www.sec.gov/Archives/' + p).text, day.isoformat())
        except Exception as e:
            errors += 1
            tries = int((failed.get(p) or {}).get('tries', 0)) + 1
            if tries >= INSIDER_MAX_TRIES:
                print(f'form4 error {p}: {type(e).__name__}, try {tries}, giving up')
                failed.pop(p, None)
                seen[p] = day.isoformat()
                gave_up += 1
            else:
                print(f'form4 error {p}: {type(e).__name__}, try {tries}, will retry next run')
                failed[p] = {'day': day.isoformat(), 'tries': tries}
            continue
        if b and re.fullmatch(r'[A-Z][A-Z0-9.\-]{0,6}', b['ticker'] or '') and b['ticker'] not in ('NA', 'N.A.', 'NONE'):
            buys.append(b)
        failed.pop(p, None)
        seen[p] = day.isoformat()
    waiting = len(queue) - done
    # Oldest filing day not yet read: unread queue items plus filings that failed and will be retried
    pending_days = [d.isoformat() for _, d in queue[done:]] + [f.get('day') for f in failed.values() if f.get('day')]
    oldest_waiting = min(pending_days) if pending_days else None
    print(f'Form 4 filings read this run: {done} ({errors} failed). Still waiting: {waiting}. '
          f'Retrying next run: {len(failed)}. Given up this run: {gave_up}. Oldest waiting: {oldest_waiting or "none"}'
          + (f' (time budget of {budget_s / 60:.1f} minutes reached)' if waiting else ''))
    cutoff = (today - datetime.timedelta(days=INSIDER_DAYS)).isoformat()
    uniq = {}
    for b in buys:
        if b['filed'] >= cutoff and not implausible(b.get('shares') or 0, b.get('price') or 0):  # also clears rows stored before this check
            uniq[(b['ticker'], b['owner'], b['date'], b['value'])] = b
    buys = sorted(uniq.values(), key=lambda b: (b['filed'], b['value']), reverse=True)
    # Remember only the last week of checked filings so the file stays small
    week = (today - datetime.timedelta(days=8)).isoformat()
    return {'buys': buys, 'seen': {k: v for k, v in seen.items() if v >= week},
            'failed': {k: v for k, v in failed.items() if (v.get('day') or '') >= week},
            'read': done, 'waiting': waiting, 'retrying': len(failed), 'gave_up': gave_up,
            'oldest_waiting': oldest_waiting}


if __name__ == '__main__':
    import sys
    if '--daily-due' in sys.argv:  # smart_money.yml asks whether the daily parts should run
        print('true' if daily_due() else 'false')
        raise SystemExit
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    # Insiders first and saved at once: the time budget bounds it, and its "seen" list is what lets
    # the next run resume, so a slow 13F fetch after it can never lose it.
    ins = insiders()
    with open('insiders.json', 'w') as f:
        json.dump({'updated': now, **ins}, f)
    print(f'Insider buys kept: {len(ins["buys"])}')
    if os.environ.get('SMART_MONEY_DAILY') == 'false':
        print('13F holdings are fresh (updated in the last day); skipped this run')
        raise SystemExit
    inv = investors()
    if inv:
        with open('smart_money.json', 'w') as f:
            json.dump({'updated': now, 'investors': inv}, f)
