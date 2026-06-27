"""
Portfolio Intel Backend - Render.com free tier
"""

from flask import Flask, jsonify, request as flask_request
from flask_cors import CORS
import requests
import json
from datetime import datetime
import os

app = Flask(__name__)
CORS(app)

cache = {
    'trades': {'data': {}, 'updated': None},
    'prices': {'data': {}, 'updated': None},
    'news': {'data': [], 'updated': None},
}
CACHE_MINUTES = 30

def is_stale(key):
    if not cache[key]['updated']:
        return True
    diff = (datetime.now() - cache[key]['updated']).total_seconds() / 60
    return diff > CACHE_MINUTES

# ── ALL TRADES (reads from GitHub-hosted trades.json updated daily) ──
TRADES_JSON_URL = 'https://raw.githubusercontent.com/zidane222/portfolio-intel/main/trades.json'

@app.route('/api/all-trades')
@app.route('/api/house-trades')
@app.route('/api/senate-trades')
def all_trades():
    if is_stale('trades'):
        try:
            res = requests.get(TRADES_JSON_URL, timeout=10)
            if res.status_code == 200:
                data = res.json()
                cache['trades']['data'] = data
                cache['trades']['updated'] = datetime.now()
        except Exception as e:
            print(f'Trades fetch error: {e}')

    data = cache['trades'].get('data', {})
    return jsonify({
        'trades': data.get('trades', [])[:150],
        'house_count': data.get('house_count', 0),
        'senate_count': data.get('senate_count', 0),
        'updated': data.get('updated', str(datetime.now()))
    })

# ── STOCK PRICES (Yahoo Finance) ──
@app.route('/api/prices')
@app.route('/api/prices/<tickers>')
def prices(tickers='VOO,QQQM,GLD,NVDA,AAPL,TSLA,META,MSFT,GOOGL,AMZN,AMD,CRWD,XOM,DJT,INTC,UBER'):
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

# ── NEWS ──
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

# ── AI INSIGHTS (Groq — free, key set as GROQ_API_KEY env var on Render) ──
@app.route('/api/ai', methods=['POST'])
def ai_insights():
    api_key = os.environ.get('GROQ_API_KEY', '')
    if not api_key:
        return jsonify({'error': 'AI not configured — set GROQ_API_KEY on Render'}), 503

    body = flask_request.get_json()
    if not body or not body.get('question'):
        return jsonify({'error': 'Missing question'}), 400

    try:
        res = requests.post(
            'https://api.groq.com/openai/v1/chat/completions',
            headers={
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {api_key}'
            },
            json={
                'model': 'llama-3.3-70b-versatile',
                'max_tokens': 1000,
                'messages': [
                    {'role': 'system', 'content': body.get('system', '')},
                    {'role': 'user', 'content': body.get('question', '')}
                ]
            },
            timeout=30
        )
        data = res.json()
        text = data.get('choices', [{}])[0].get('message', {}).get('content', '')
        return jsonify({'answer': text})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ── HEALTH CHECK ──
@app.route('/')
@app.route('/health')
def health():
    return jsonify({
        'status': 'ok',
        'service': 'Portfolio Intel API',
        'endpoints': ['/api/all-trades', '/api/prices', '/api/news', '/api/ai'],
        'updated': str(datetime.now())
    })

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
