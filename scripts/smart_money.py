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


def insiders():
    store = load('insiders.json', {'buys': [], 'seen': {}})
    seen = store.get('seen') if isinstance(store.get('seen'), dict) else {}  # index path -> day checked
    buys = store.get('buys', [])
    today = datetime.date.today()
    for back in range(1, 5):
        day = today - datetime.timedelta(days=back)
        q = (day.month - 1) // 3 + 1
        try:
            idx = sec_get(f'https://www.sec.gov/Archives/edgar/daily-index/{day.year}/QTR{q}/form.{day:%Y%m%d}.idx').text
        except Exception:
            continue  # weekends and holidays have no index
        paths = [l.split()[-1] for l in idx.splitlines() if l.startswith('4 ')]
        new = [p for p in paths if p not in seen]
        print(f'{day}: {len(paths)} Form 4 filings, {len(new)} new')
        for p in new:
            try:
                b = parse_form4(sec_get('https://www.sec.gov/Archives/' + p).text, day.isoformat())
                if b and re.fullmatch(r'[A-Z][A-Z0-9.\-]{0,6}', b['ticker'] or '') and b['ticker'] not in ('NA', 'N.A.', 'NONE'):
                    buys.append(b)
            except Exception as e:
                print('form4 error', p, e)
            seen[p] = day.isoformat()
    cutoff = (today - datetime.timedelta(days=INSIDER_DAYS)).isoformat()
    uniq = {}
    for b in buys:
        if b['filed'] >= cutoff:
            uniq[(b['ticker'], b['owner'], b['date'], b['value'])] = b
    buys = sorted(uniq.values(), key=lambda b: (b['filed'], b['value']), reverse=True)
    # Remember only the last week of checked filings so the file stays small
    week = (today - datetime.timedelta(days=8)).isoformat()
    return {'buys': buys, 'seen': {k: v for k, v in seen.items() if v >= week}}


if __name__ == '__main__':
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    inv = investors()
    if inv:
        with open('smart_money.json', 'w') as f:
            json.dump({'updated': now, 'investors': inv}, f)
    ins = insiders()
    with open('insiders.json', 'w') as f:
        json.dump({'updated': now, **ins}, f)
    print(f'Insider buys kept: {len(ins["buys"])}')
