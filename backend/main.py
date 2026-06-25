"""
Portfolio Intel Backend
Runs on Railway.app (free tier)
Fetches real politician trades + stock prices
No API keys needed
"""

from flask import Flask, jsonify
from flask_cors import CORS
import requests
import json
from datetime import datetime
import os

app = Flask(__name__)
CORS(app)  # Allow dashboard to call this from any domain

# ── Cache to avoid hitting APIs too often ──
cache = {
    'house_trades': {'data': [], 'updated': None},
    'senate_trades': {'data': [], 'updated': None},
    'prices': {'data': {}, 'updated': None},
    'news': {'data': [], 'updated': None},
}
CACHE_MINUTES = 60  # refresh every 60 minutes

def is_stale(key):
    if not cache[key]['updated']:
        return True
    diff = (datetime.now() - cache[key]['updated']).total_seconds() / 60
    return diff > CACHE_MINUTES

# ── HOUSE TRADES (Pelosi etc) ──
@app.route('/api/house-trades')
def house_trades():
    if is_stale('house_trades'):
        try:
            res = requests.get('https://housestockwatcher.com/api', timeout=10)
            if res.status_code == 200:
                data = res.json()
                # Clean and format
                trades = []
                for t in data[:100]:  # last 100 trades
                    trades.append({
                        'date': t.get('transaction_date', ''),
                        'representative': t.get('representative', ''),
                        'ticker': (t.get('ticker') or '').upper().replace('--', ''),
                        'type': t.get('type', ''),
                        'amount': t.get('amount', ''),
                        'description': t.get('asset_description', ''),
                        'source': 'house'
                    })
                cache['house_trades']['data'] = trades
                cache['house_trades']['updated'] = datetime.now()
        except Exception as e:
            print(f'House trades error: {e}')

    return jsonify({
        'trades': cache['house_trades']['data'],
        'updated': str(cache['house_trades']['updated']),
        'count': len(cache['house_trades']['data'])
    })

# ── SENATE TRADES ──
@app.route('/api/senate-trades')
def senate_trades():
    if is_stale('senate_trades'):
        try:
            res = requests.get('https://senatestockwatcher.com/api', timeout=10)
            if res.status_code == 200:
                data = res.json()
                trades = []
                for t in data[:100]:
                    trades.append({
                        'date': t.get('transaction_date', ''),
                        'representative': t.get('senator', ''),
                        'ticker': (t.get('ticker') or '').upper().replace('--', ''),
                        'type': t.get('type', ''),
                        'amount': t.get('amount', ''),
                        'description': t.get('asset_description', ''),
                        'source': 'senate'
                    })
                cache['senate_trades']['data'] = trades
                cache['senate_trades']['updated'] = datetime.now()
        except Exception as e:
            print(f'Senate trades error: {e}')

    return jsonify({
        'trades': cache['senate_trades']['data'],
        'updated': str(cache['senate_trades']['updated']),
        'count': len(cache['senate_trades']['data'])
    })

# ── ALL TRADES COMBINED ──
@app.route('/api/all-trades')
def all_trades():
    house = house_trades().get_json()
    senate = senate_trades().get_json()
    all_t = house.get('trades', []) + senate.get('trades', [])
    # Sort by date descending
    all_t.sort(key=lambda x: x.get('date', ''), reverse=True)
    return jsonify({
        'trades': all_t[:150],
        'house_count': house.get('count', 0),
        'senate_count': senate.get('count', 0),
        'updated': str(datetime.now())
    })

# ── STOCK PRICES (Yahoo Finance) ──
@app.route('/api/prices')
@app.route('/api/prices/<tickers>')
def prices(tickers='VOO,QQQM,GLD,NVDA,AAPL,TSLA,META,MSFT,GOOGL,AMZN,AMD,CRWD,XOM,DJT'):
    if is_stale('prices'):
        ticker_list = tickers.split(',')
        price_data = {}
        for ticker in ticker_list:
            try:
                url = f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=2d'
                res = requests.get(url, timeout=8, headers={'User-Agent': 'Mozilla/5.0'})
                if res.status_code == 200:
                    data = res.json()
                    meta = data.get('chart', {}).get('result', [{}])[0].get('meta', {})
                    price = meta.get('regularMarketPrice', 0)
                    prev = meta.get('previousClose', price)
                    change_pct = ((price - prev) / prev * 100) if prev else 0
                    price_data[ticker] = {
                        'price': round(price, 2),
                        'prev_close': round(prev, 2),
                        'change_pct': round(change_pct, 2),
                        'currency': meta.get('currency', 'USD')
                    }
            except Exception as e:
                print(f'Price error for {ticker}: {e}')

        cache['prices']['data'] = price_data
        cache['prices']['updated'] = datetime.now()

    return jsonify({
        'prices': cache['prices']['data'],
        'updated': str(cache['prices']['updated'])
    })

# ── NEWS (Google News RSS) ──
@app.route('/api/news')
def news():
    if is_stale('news'):
        queries = [
            'Congress stock trade disclosure',
            'Pelosi stock trade',
            'Senate stock trade',
            'stock market today',
        ]
        articles = []
        seen = set()
        for query in queries:
            try:
                url = f'https://news.google.com/rss/search?q={requests.utils.quote(query)}&hl=en-US&gl=US&ceid=US:en'
                res = requests.get(url, timeout=8)
                if res.status_code != 200:
                    continue
                # Parse RSS manually (no lxml needed)
                import re
                items = re.findall(r'<item>(.*?)</item>', res.text, re.DOTALL)
                for item in items[:4]:
                    title = re.search(r'<title>(.*?)</title>', item)
                    link = re.search(r'<link>(.*?)</link>', item)
                    pub = re.search(r'<pubDate>(.*?)</pubDate>', item)
                    source = re.search(r'<source[^>]*>(.*?)</source>', item)
                    if title and link:
                        t = title.group(1).replace('<![CDATA[', '').replace(']]>', '').strip()
                        if t not in seen:
                            seen.add(t)
                            articles.append({
                                'title': t,
                                'link': link.group(1).strip(),
                                'published': pub.group(1).strip() if pub else '',
                                'source': source.group(1).strip() if source else '',
                                'query': query
                            })
            except Exception as e:
                print(f'News error: {e}')

        cache['news']['data'] = articles[:20]
        cache['news']['updated'] = datetime.now()

    return jsonify({
        'articles': cache['news']['data'],
        'updated': str(cache['news']['updated']),
        'count': len(cache['news']['data'])
    })

# ── HEALTH CHECK ──
@app.route('/')
@app.route('/health')
def health():
    return jsonify({
        'status': 'ok',
        'service': 'Portfolio Intel API',
        'endpoints': [
            '/api/all-trades',
            '/api/house-trades',
            '/api/senate-trades',
            '/api/prices',
            '/api/news'
        ],
        'updated': str(datetime.now())
    })

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
