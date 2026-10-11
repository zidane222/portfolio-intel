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
    out = {
        'updated': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'date': datetime.datetime.strptime(latest['Date'], '%m/%d/%Y').date().isoformat(),
        'curve': pick(latest),
        'month_ago': {'date': datetime.datetime.strptime(month_ago['Date'], '%m/%d/%Y').date().isoformat(), 'curve': pick(month_ago)},
        'source': 'U.S. Department of the Treasury, Daily Treasury Par Yield Curve Rates',
    }
    with open('yields.json', 'w') as f:
        json.dump(out, f, indent=1)
    print('Treasury curve', out['date'], out['curve'])


if __name__ == '__main__':
    main()
