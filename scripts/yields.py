"""
Treasury yields for the Cash & yield tab, refreshed by the daily GitHub Action.
Writes yields.json from the US Treasury's free daily par yield curve.
"""
import csv
import datetime
import io
import json

import requests

H = {'User-Agent': 'Mozilla/5.0 (Portfolio Intel personal project)'}
KEEP = ['1 Mo', '2 Mo', '3 Mo', '4 Mo', '6 Mo', '1 Yr', '2 Yr', '5 Yr', '10 Yr', '30 Yr']


def curve(year):
    url = (f'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/'
           f'{year}/all?type=daily_treasury_yield_curve&field_tdr_date_value={year}&page&_format=csv')
    r = requests.get(url, headers=H, timeout=30)
    r.raise_for_status()
    rows = list(csv.DictReader(io.StringIO(r.text)))
    return rows


def sofr(today):
    """Secured Overnight Financing Rate: latest, about a month ago, and last year end (NY Fed)."""
    base = 'https://markets.newyorkfed.org/api/rates/secured/sofr'
    try:
        recent = requests.get(f'{base}/last/40.json', headers=H, timeout=30).json().get('refRates', [])
        recent.sort(key=lambda r: r['effectiveDate'], reverse=True)
        month = next((r for r in recent if r['effectiveDate'] <= (today - datetime.timedelta(days=30)).isoformat()), recent[-1] if recent else None)
        ye = requests.get(f'{base}/search.json', params={'startDate': f'{today.year - 1}-12-15', 'endDate': f'{today.year - 1}-12-31'}, headers=H, timeout=30).json().get('refRates', [])
        ye.sort(key=lambda r: r['effectiveDate'], reverse=True)
        pt = lambda r: {'date': r['effectiveDate'], 'rate': r['percentRate']} if r else None
        return {'now': pt(recent[0]) if recent else None, 'month_ago': pt(month), 'year_end': pt(ye[0] if ye else None)}
    except Exception as e:
        print('SOFR error', e)
        return None


def main():
    today = datetime.date.today()
    rows = curve(today.year)
    if not rows:  # first days of January
        rows = curve(today.year - 1)
    # Newest first in Treasury's CSV, but sort to be safe
    rows.sort(key=lambda r: datetime.datetime.strptime(r['Date'], '%m/%d/%Y'), reverse=True)
    latest = rows[0]
    month_ago = next((r for r in rows if datetime.datetime.strptime(r['Date'], '%m/%d/%Y').date() <= today - datetime.timedelta(days=30)), rows[-1])
    pick = lambda r: {k: float(r[k]) for k in KEEP if r.get(k) not in (None, '', 'N/A')}
    # Last trading day of the previous year, for "year end" comparisons
    year_end = None
    try:
        prev = curve(today.year - 1)
        prev.sort(key=lambda r: datetime.datetime.strptime(r['Date'], '%m/%d/%Y'), reverse=True)
        if prev:
            year_end = {'date': datetime.datetime.strptime(prev[0]['Date'], '%m/%d/%Y').date().isoformat(), 'curve': pick(prev[0])}
    except Exception as e:
        print('year-end curve error', e)
    out = {
        'updated': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'date': datetime.datetime.strptime(latest['Date'], '%m/%d/%Y').date().isoformat(),
        'curve': pick(latest),
        'month_ago': {'date': datetime.datetime.strptime(month_ago['Date'], '%m/%d/%Y').date().isoformat(), 'curve': pick(month_ago)},
        'year_end': year_end,
        'sofr': sofr(today),
        'source': 'U.S. Department of the Treasury, Daily Treasury Par Yield Curve Rates; SOFR from the Federal Reserve Bank of New York',
    }
    with open('yields.json', 'w') as f:
        json.dump(out, f, indent=1)
    print('Treasury curve', out['date'], out['curve'])


if __name__ == '__main__':
    main()
