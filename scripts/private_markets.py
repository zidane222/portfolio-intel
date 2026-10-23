"""Private company raises from SEC EDGAR: Form D (private placements) and Form C (crowdfunding).

Every US startup raising a private round files a Form D within 15 days of the first sale.
Crowdfunding raises open to anyone (Wefunder, StartEngine, Republic...) file a Form C.
This reads EDGAR's daily form index, then each new filing's XML, and keeps a rolling window.
Pooled investment funds (hedge, VC and PE funds raising money) and amendments are left out.

Usage: python3 scripts/private_markets.py --days 60 --out private_markets.json
SEC asks for a descriptive User-Agent with contact info and at most 10 requests a second.
"""
import argparse, datetime, json, os, re, sys, time
import xml.etree.ElementTree as ET
import requests

UA = {'User-Agent': 'Portfolio Intel research hasham.abbasi17@gmail.com', 'Accept-Encoding': 'gzip, deflate'}
ARCH = 'https://www.sec.gov/Archives/'
FORMS = {'D', 'C'}
s = requests.Session(); s.headers.update(UA)
_last = [0.0]


def get(url, tries=4):
    for i in range(tries):
        wait = 0.12 - (time.time() - _last[0])
        if wait > 0: time.sleep(wait)
        _last[0] = time.time()
        try:
            r = s.get(url, timeout=30)
        except requests.RequestException:
            time.sleep(2 * (i + 1)); continue
        if r.status_code == 200: return r
        if r.status_code == 404: return None
        time.sleep(3 * (i + 1))  # 429 / 403 / 5xx: back off
    return None


def strip_ns(root):
    for el in root.iter():
        if isinstance(el.tag, str) and '}' in el.tag: el.tag = el.tag.split('}', 1)[1]
    return root


def txt(el, path):
    if el is None: return None
    x = el.find(path)
    return x.text.strip() if x is not None and x.text and x.text.strip() else None


def num(v):
    try: return float(str(v).replace(',', '').replace('$', ''))
    except (TypeError, ValueError): return None


def daily_index(day):
    q = (day.month - 1) // 3 + 1
    r = get(f'{ARCH}edgar/daily-index/{day.year}/QTR{q}/form.{day:%Y%m%d}.idx')
    if r is None: return None  # weekend, holiday, or not published yet
    out = []
    for line in r.text.splitlines():
        parts = re.split(r'\s{2,}', line.strip())
        if len(parts) >= 5 and parts[0] in FORMS and parts[-1].startswith('edgar/data/'):
            out.append({'form': parts[0], 'name': parts[1], 'cik': parts[2], 'path': parts[-1]})
    return out


def filing_urls(path):
    cik = path.split('/')[2]
    acc = os.path.basename(path).replace('.txt', '')
    base = f'{ARCH}edgar/data/{cik}/{acc.replace("-", "")}/'
    return base + 'primary_doc.xml', base + f'{acc}-index.htm', acc


def stage(amount):
    if amount is None: return 'Undisclosed'
    if amount <= 2_000_000: return 'Pre-seed / seed'
    if amount <= 15_000_000: return 'Seed / Series A'
    if amount <= 75_000_000: return 'Growth'
    return 'Late stage'


def parse_d(root, day, item, link):
    iss = root.find('.//primaryIssuer')
    off = root.find('.//offeringData')
    if off is None: return None
    if (txt(off, './/typeOfFiling/newOrAmendment/isAmendment') or '').lower() == 'true': return None
    ind = txt(off, './/industryGroup/industryGroupType')
    if ind and 'pooled investment fund' in ind.lower(): return None
    total = txt(off, './/offeringSalesAmounts/totalOfferingAmount')
    amt = num(total)
    exemptions = [x.text.strip() for x in off.findall('.//federalExemptionsExclusions/item') if x.text]
    sec = [k.replace('is', '').replace('Type', '') for k in ('isEquityType', 'isDebtType', 'isOptionToAcquireType',
           'isPooledInvestmentFundType', 'isMineralPropertyType') if (txt(off, f'.//typesOfSecuritiesOffered/{k}') or '').lower() == 'true']
    if (txt(off, './/typesOfSecuritiesOffered/isOtherType') or '').lower() == 'true':
        sec.append(txt(off, './/typesOfSecuritiesOffered/descriptionOfOtherType') or 'Other')
    return {
        'f': 'D', 'd': day, 'n': txt(iss, 'entityName') or item['name'], 'cik': item['cik'],
        'city': txt(iss, './/issuerAddress/city'), 'st': txt(iss, './/issuerAddress/stateOrCountry'),
        'y': txt(iss, './/yearOfInc/value'), 'ind': ind,
        'amt': amt, 'indef': total is not None and amt is None,
        'sold': num(txt(off, './/offeringSalesAmounts/totalAmountSold')),
        'min': num(txt(off, './/minimumInvestmentAccepted')),
        'inv': num(txt(off, './/investors/totalNumberAlreadyInvested')),
        'ex': exemptions, 'sec': sec, 'first': txt(off, './/dateOfFirstSale/value'),
        'stage': stage(amt), 'u': link,
    }


def parse_c(root, day, item, link):
    iss = root.find('.//issuerInformation')
    off = root.find('.//offeringInformation')
    target = num(txt(off, 'offeringAmount'))
    mx = num(txt(off, 'maximumOfferingAmount'))
    return {
        'f': 'C', 'd': day, 'n': txt(iss, './/nameOfIssuer') or item['name'], 'cik': item['cik'],
        'city': txt(iss, './/issuerAddress/city'), 'st': txt(iss, './/issuerAddress/stateOrCountry'),
        'web': txt(iss, './/issuerWebsite'), 'portal': txt(iss, 'companyName'),
        'type': txt(off, 'securityOfferedType'), 'price': num(txt(off, 'price')),
        'amt': target, 'max': mx, 'dl': txt(off, 'deadlineDate'),
        'emp': num(txt(root, './/annualReportDisclosureRequirements/currentEmployees')),
        'rev': num(txt(root, './/annualReportDisclosureRequirements/revenueMostRecentFiscalYear')),
        'stage': stage(mx or target), 'u': link,
    }


def fetch_day(day):
    items = daily_index(day)
    if items is None: return None
    out = []
    for it in items:
        xml_url, link, acc = filing_urls(it['path'])
        r = get(xml_url)
        if r is None: continue
        try: root = strip_ns(ET.fromstring(r.content))
        except ET.ParseError: continue
        try:
            row = (parse_d if it['form'] == 'D' else parse_c)(root, day.isoformat(), it, link)
        except Exception as e:  # one odd filing must not stop the run
            print(f'  skip {acc}: {e}', file=sys.stderr); continue
        if row: row['acc'] = acc; out.append({k: v for k, v in row.items() if v not in (None, [], '')})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=60, help='rolling window to keep')
    ap.add_argument('--out', default='private_markets.json')
    ap.add_argument('--max-new-days', type=int, default=70, help='cap on index days fetched this run')
    a = ap.parse_args()
    try: data = json.load(open(a.out))
    except (OSError, ValueError): data = {'raises': [], 'done': []}
    today = datetime.date.today()
    start = today - datetime.timedelta(days=a.days)
    done = {d for d in data.get('done', []) if d >= start.isoformat()}
    raises = [r for r in data.get('raises', []) if r['d'] >= start.isoformat()]
    seen = {r['acc'] for r in raises}
    fetched = 0
    day = today - datetime.timedelta(days=1)
    while day >= start and fetched < a.max_new_days:
        if day.weekday() < 5 and day.isoformat() not in done:
            rows = fetch_day(day)
            fetched += 1
            if rows is None:
                print(f'{day}: no index')
                if (today - day).days > 4: done.add(day.isoformat())  # holiday: stop retrying
            else:
                new = [r for r in rows if r['acc'] not in seen]
                raises += new; seen.update(r['acc'] for r in new); done.add(day.isoformat())
                print(f'{day}: {sum(r["f"] == "D" for r in new)} Form D, {sum(r["f"] == "C" for r in new)} Form C')
        day -= datetime.timedelta(days=1)
    raises.sort(key=lambda r: (r['d'], r.get('amt') or 0), reverse=True)
    json.dump({'updated': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
               'window_days': a.days, 'done': sorted(done), 'raises': raises},
              open(a.out, 'w'), separators=(',', ':'))
    print(f'Saved {len(raises)} raises ({sum(r["f"] == "D" for r in raises)} D, {sum(r["f"] == "C" for r in raises)} C), '
          f'{os.path.getsize(a.out) / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
