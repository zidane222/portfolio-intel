"""
Portfolio Intel Backend - Render.com free tier
"""

from flask import Flask, jsonify, request as flask_request
from flask_cors import CORS
import requests
import json
import re
from datetime import datetime
import os

app = Flask(__name__)
CORS(app)

cache = {
    'house_trades': {'data': [], 'updated': None},
    'senate_trades': {'data': [], 'updated': None},
    'prices': {'data': {}, 'updated': None},
    'news': {'data': [], 'updated': None},
}
CACHE_MINUTES = 5

def is_stale(key):
    if not cache[key]['updated']:
        return True
    diff = (datetime.now() - cache[key]['updated']).total_seconds() / 60
    return diff > CACHE_MINUTES

# ── HOUSE TRADES (Capitol Trades API) ──
@app.route('/api/house-trades')
def house_trades():
    if is_stale('house_trades'):
        try:
            res = requests.get(
                'https://bff.capitoltrades.com/trades?pageSize=100&chamber=house&sortBy=-txDate',
                timeout=10,
                headers={'User-Agent': 'Mozilla/5.0'}
            )
            if res.status_code == 200:
                data = res.json()
                trades = []
                for t in (data.get('data') or [])[:100]:
                    ticker = (t.get('ticker') or t.get('asset', {}).get('ticker') or '').upper().replace('--', '')
                    trades.append({
                        'date': t.get('txDate') or t.get('reportedDate', ''),
                        'representative': t.get('politician', {}).get('name', ''),
                        'ticker': ticker,
                        'type': t.get('txType', ''),
                        'amount': str(t.get('txValue', '')),
                        'description': t.get('asset', {}).get('assetName', ticker),
                        'source': 'house'
                    })
                cache['house_trades']['data'] = [t for t in trades if t['ticker'] and len(t['ticker']) <= 6]
                cache['house_trades']['updated'] = datetime.now()
        except Exception as e:
            print(f'House trades error: {e}')

    return jsonify({
        'trades': cache['house_trades']['data'],
        'updated': str(cache['house_trades']['updated']),
        'count': len(cache['house_trades']['data'])
    })

# ── SENATE TRADES (Capitol Trades API) ──
@app.route('/api/senate-trades')
def senate_trades():
    if is_stale('senate_trades'):
        try:
            res = requests.get(
                'https://bff.capitoltrades.com/trades?pageSize=100&chamber=senate&sortBy=-txDate',
                timeout=10,
                headers={'User-Agent': 'Mozilla/5.0'}
            )
            if res.status_code == 200:
                data = res.json()
                trades = []
                for t in (data.get('data') or [])[:100]:
                    ticker = (t.get('ticker') or t.get('asset', {}).get('ticker') or '').upper().replace('--', '')
                    trades.append({
                        'date': t.get('txDate') or t.get('reportedDate', ''),
                        'representative': t.get('politician', {}).get('name', ''),
                        'ticker': ticker,
                        'type': t.get('txType', ''),
                        'amount': str(t.get('txValue', '')),
                        'description': t.get('asset', {}).get('assetName', ticker),
                        'source': 'senate'
                    })
                cache['senate_trades']['data'] = [t for t in trades if t['ticker'] and len(t['ticker']) <= 6]
                cache['senate_trades']['updated'] = datetime.now()
        except Exception as e:
            print(f'Senate trades error: {e}')

    return jsonify({
        'trades': cache['senate_trades']['data'],
        'updated': str(cache['senate_trades']['updated']),
        'count': len(cache['senate_trades']['data'])
    })

# ── ALL TRADES COMBINED (reads from GitHub-hosted trades.json updated daily) ──
TRADES_JSON_URL = 'https://raw.githubusercontent.com/zidane222/portfolio-intel/main/trades.json'

@app.route('/api/all-trades')
def all_trades():
    if is_stale('house_trades'):
        try:
            res = requests.get(TRADES_JSON_URL, timeout=10)
            if res.status_code == 200:
                data = res.json()
                cache['house_trades']['data'] = data.get('trades', [])
                cache['house_trades']['updated'] = datetime.now()
                return jsonify({
                    'trades': data.get('trades', [])[:150],
                    'house_count': data.get('house_count', 0),
                    'senate_count': data.get('senate_count', 0),
                    'updated': data.get('updated', str(datetime.now()))
                })
        except Exception as e:
            print(f'Trades fetch error: {e}')

    # Return cached data if available
    cached = cache['house_trades']['data']
    return jsonify({
        'trades': cached[:150],
        'house_count': len([t for t in cached if t.get('source') == 'house']),
        'senate_count': len([t for t in cached if t.get('source') == 'senate']),
        'updated': str(cache['house_trades']['updated'])
    })

# ── STOCK PRICES (Yahoo Finance) ──
@app.route('/api/prices')
@app.route('/api/prices/<tickers>')
def prices(tickers='VOO,QQQM,GLD,NVDA,AAPL,TSLA,META,MSFT,GOOGL,AMZN,AMD,CRWD,XOM,DJT'):
    # Cache per ticker so a request for new tickers is never answered with another list's cache
    ticker_list = [t.strip().upper() for t in tickers.split(',') if t.strip()][:40]
    stale = is_stale('prices')
    if stale:
        cache['prices']['data'] = {}
    missing = [t for t in ticker_list if t not in cache['prices']['data']]
    if missing:
        price_data = cache['prices']['data']
        for ticker in missing:
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
        if stale:
            cache['prices']['updated'] = datetime.now()

    return jsonify({
        'prices': {t: cache['prices']['data'][t] for t in ticker_list if t in cache['prices']['data']},
        'updated': str(cache['prices']['updated'])
    })

# ── PRICE HISTORY (Yahoo Finance) for the interactive chart ──
RANGE_MAP = {
    '1d': ('1d', '5m'),
    '5d': ('5d', '30m'),
    '1mo': ('1mo', '1d'),
    '6mo': ('6mo', '1d'),
    'ytd': ('ytd', '1d'),
    '1y': ('1y', '1d'),
    '5y': ('5y', '1wk'),
}
history_cache = {}
HISTORY_CACHE_MINUTES = 15

@app.route('/api/history/<tickers>')
def history(tickers):
    rng = flask_request.args.get('range', '6mo').lower()
    yr, interval = RANGE_MAP.get(rng, RANGE_MAP['6mo'])
    ticker_list = [t.strip().upper() for t in tickers.split(',') if t.strip()][:40]
    series = {}
    for ticker in ticker_list:
        key = f'{ticker}:{yr}'
        hit = history_cache.get(key)
        if hit and (datetime.now() - hit['updated']).total_seconds() / 60 < HISTORY_CACHE_MINUTES:
            series[ticker] = hit['data']
            continue
        try:
            url = f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range={yr}&interval={interval}'
            res = requests.get(url, timeout=8, headers={'User-Agent': 'Mozilla/5.0'})
            if res.status_code != 200:
                continue
            result = (res.json().get('chart', {}).get('result') or [{}])[0]
            stamps = result.get('timestamp') or []
            closes = ((result.get('indicators', {}).get('quote') or [{}])[0].get('close')) or []
            points = [[ts, round(c, 4)] for ts, c in zip(stamps, closes) if c is not None]
            if points:
                history_cache[key] = {'data': points, 'updated': datetime.now()}
                series[ticker] = points
        except Exception as e:
            print(f'History error for {ticker}: {e}')

    return jsonify({'range': rng, 'series': series, 'updated': str(datetime.now())})

# ── TODAY'S TOP SAVINGS RATES (from a daily published rate article) ──
# The Motley Fool publishes "Best High-Yield Savings Rates Today" every day. Its page mixes
# picks with ad widgets, so the article text is read by the AI and returned as structured rates.
top_rates_cache = {'data': None, 'updated': None}
TOP_RATES_HOURS = 12

def _article_text(html_text):
    t = re.sub(r'<(script|style|noscript|svg)[^>]*>.*?</\1>', ' ', html_text, flags=re.S | re.I)
    t = re.sub(r'<br\s*/?>|</(p|li|tr|h\d|div)>', '\n', t, flags=re.I)
    t = re.sub(r'<[^>]+>', ' ', t)
    import html as htmllib
    t = htmllib.unescape(t)
    lines = [re.sub(r'\s+', ' ', l).strip() for l in t.split('\n')]
    lines = [l for l in lines if l]
    # Keep the part of the page that talks about APYs
    keep = [i for i, l in enumerate(lines) if 'APY' in l or '%' in l]
    if not keep:
        return ''
    return '\n'.join(lines[max(0, keep[0] - 5): keep[-1] + 5])[:14000]

@app.route('/api/top-rates')
def top_rates():
    fresh = top_rates_cache['updated'] and (datetime.now() - top_rates_cache['updated']).total_seconds() / 3600 < TOP_RATES_HOURS
    if fresh and top_rates_cache['data']:
        return jsonify(top_rates_cache['data'])
    api_key = os.environ.get('GROQ_API_KEY', '')
    if not api_key:
        return jsonify({'error': 'AI not configured'}), 503
    headers = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36'}
    from datetime import timedelta
    for back in range(0, 4):
        d = datetime.now() - timedelta(days=back)
        url = f"https://www.fool.com/money/banks/articles/top-savings-account-rates-today-{d.strftime('%b').lower()}-{d.day}-{d.year}/"
        try:
            r = requests.get(url, headers=headers, timeout=15)
        except Exception:
            continue
        if r.status_code != 200:
            continue
        text = _article_text(r.text)
        if len(text) < 200:
            continue
        system = ('Extract savings and money market account offers from this article. Return ONLY a JSON array, no prose. '
                  'Each item: {"institution": string, "product": string, "apy": number, "min_deposit": number|null, '
                  '"balance_cap": number|null, "conditions": string, "credit_union": boolean, "promo": boolean}. '
                  'balance_cap is the maximum balance that earns the APY (e.g. 5000 for "5% on the first $5,000"), else null. '
                  'Use only offers the article states with a specific APY. Skip national averages, CDs, checking accounts, and duplicates. '
                  'conditions is a short phrase about caps, minimum balances, promo periods or fees, or "" if none.')
        try:
            ai = requests.post('https://api.groq.com/openai/v1/chat/completions',
                               headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {api_key}'},
                               json={'model': 'openai/gpt-oss-120b', 'max_tokens': 2500,
                                     'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': text}]},
                               timeout=60).json()
            answer = ai.get('choices', [{}])[0].get('message', {}).get('content', '')
            arr = json.loads(answer[answer.index('['): answer.rindex(']') + 1])
        except Exception as e:
            print('Top rates AI error:', e)
            continue
        rates = []
        for x in arr:
            try:
                apy = float(x.get('apy'))
            except (TypeError, ValueError):
                continue
            if 0.5 <= apy <= 10 and x.get('institution'):
                rates.append({'institution': str(x['institution'])[:80], 'product': str(x.get('product') or 'Savings')[:80],
                              'apy': round(apy, 2), 'min_deposit': x.get('min_deposit'),
                              'cap': x.get('balance_cap') if isinstance(x.get('balance_cap'), (int, float)) and x.get('balance_cap') > 0 else None,
                              'conditions': str(x.get('conditions') or '')[:160],
                              'credit_union': bool(x.get('credit_union')), 'promo': bool(x.get('promo'))})
        if rates:
            rates.sort(key=lambda x: -x['apy'])
            data = {'source': 'The Motley Fool', 'url': url, 'date': d.strftime('%Y-%m-%d'), 'rates': rates[:15]}
            top_rates_cache.update({'data': data, 'updated': datetime.now()})
            return jsonify(data)
    if top_rates_cache['data']:
        return jsonify(top_rates_cache['data'])
    return jsonify({'error': 'No rate article could be read today'}), 502

# ── DIVIDEND YIELDS (trailing 12 months, from Yahoo dividend history) ──
div_cache = {}
DIV_HOURS = 12

@app.route('/api/dividends/<tickers>')
def dividends(tickers):
    ticker_list = [t.strip().upper() for t in tickers.split(',') if t.strip()][:60]
    out = {}
    for ticker in ticker_list:
        hit = div_cache.get(ticker)
        if hit and (datetime.now() - hit['updated']).total_seconds() / 3600 < DIV_HOURS:
            out[ticker] = hit['data']
            continue
        try:
            url = f'https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range=1y&interval=1d&events=div'
            res = requests.get(url, timeout=8, headers={'User-Agent': 'Mozilla/5.0'})
            if res.status_code != 200:
                continue
            result = (res.json().get('chart', {}).get('result') or [{}])[0]
            meta = result.get('meta', {})
            price = meta.get('regularMarketPrice') or 0
            divs = (result.get('events') or {}).get('dividends') or {}
            cutoff = datetime.now().timestamp() - 365 * 86400
            paid = sorted((d.get('date', 0), d.get('amount', 0)) for d in divs.values() if d.get('date', 0) >= cutoff)
            ttm = sum(a for _, a in paid)
            closes = [c for c in ((result.get('indicators', {}).get('quote') or [{}])[0].get('close') or []) if c]
            data = {
                'price': round(price, 2),
                'ttm_dividend': round(ttm, 4),
                'yield': round(ttm / price * 100, 2) if price else 0,
                'payments': len(paid),
                'last_paid': datetime.fromtimestamp(paid[-1][0]).strftime('%Y-%m-%d') if paid else None,
                'return_1y': round((closes[-1] / closes[0] - 1) * 100, 2) if len(closes) > 1 else None,
                'name': meta.get('longName') or meta.get('shortName') or ticker,
            }
            div_cache[ticker] = {'data': data, 'updated': datetime.now()}
            out[ticker] = data
        except Exception as e:
            print(f'Dividend error for {ticker}: {e}')
    return jsonify({'dividends': out, 'updated': str(datetime.now())})

# ── SECTORS (Yahoo Finance search) for the industry pie chart ──
sector_cache = {}  # sectors rarely change, so cache for the life of the process

@app.route('/api/sectors/<tickers>')
def sectors(tickers):
    ticker_list = [t.strip().upper() for t in tickers.split(',') if t.strip()][:40]
    out = {}
    for ticker in ticker_list:
        if ticker in sector_cache:
            out[ticker] = sector_cache[ticker]
            continue
        try:
            url = f'https://query2.finance.yahoo.com/v1/finance/search?q={ticker}&quotesCount=5&newsCount=0'
            res = requests.get(url, timeout=8, headers={'User-Agent': 'Mozilla/5.0'})
            if res.status_code != 200:
                continue
            quotes = res.json().get('quotes') or []
            q = next((x for x in quotes if (x.get('symbol') or '').upper() == ticker), None)
            if not q:
                continue
            qtype = (q.get('quoteType') or '').upper()
            if qtype in ('ETF', 'MUTUALFUND'):
                info = {'sector': 'Funds & ETFs', 'industry': q.get('longname') or q.get('shortname') or ''}
            else:
                info = {'sector': q.get('sectorDisp') or q.get('sector') or '', 'industry': q.get('industryDisp') or q.get('industry') or ''}
            if info['sector']:
                sector_cache[ticker] = info
                out[ticker] = info
        except Exception as e:
            print(f'Sector error for {ticker}: {e}')
    return jsonify({'sectors': out})

# ── NEWS ──
# ── PUBLISHER FEEDS (Morning Brew, CNBC, Bloomberg, Reddit, ...) ──
# Social platforms like Instagram and X don't allow free access, so we use the same
# publishers' own RSS feeds. The front end groups duplicate stories across sources.
FEEDS = [
    ('Morning Brew', 'https://www.morningbrew.com/feed.xml'),
    ('CNBC', 'https://www.cnbc.com/id/20910258/device/rss/rss.html'),
    ('MarketWatch', 'https://feeds.content.dowjones.io/public/rss/mw_topstories'),
    ('Bloomberg', 'https://feeds.bloomberg.com/markets/news.rss'),
    ('Financial Times', 'https://www.ft.com/markets?format=rss'),
    ('Seeking Alpha', 'https://seekingalpha.com/market_currents.xml'),
    ('Nasdaq', 'https://www.nasdaq.com/feed/rssoutbound?category=Markets'),
    ('Axios', 'https://api.axios.com/feed/'),
    ('r/stocks', 'https://www.reddit.com/r/stocks/top/.rss?t=day'),
    ('r/wallstreetbets', 'https://www.reddit.com/r/wallstreetbets/top/.rss?t=day'),
]
feeds_cache = {'data': [], 'updated': None, 'sources': {}}
FEEDS_MINUTES = 15

def _parse_feed(source, text):
    import xml.etree.ElementTree as ET
    from email.utils import parsedate_to_datetime
    import html as htmllib
    root = ET.fromstring(text.encode('utf-8') if isinstance(text, str) else text)
    for el in root.iter():
        if '}' in el.tag:
            el.tag = el.tag.split('}', 1)[1]
    out = []
    for it in list(root.iter('item')) + list(root.iter('entry')):
        title = htmllib.unescape(re.sub(r'<[^>]+>', '', (it.findtext('title') or '')).strip())
        link = (it.findtext('link') or '').strip()
        if not link:
            l = it.find('link')
            link = l.get('href', '') if l is not None else ''
        raw = it.findtext('pubDate') or it.findtext('published') or it.findtext('updated') or ''
        try:
            pub = parsedate_to_datetime(raw).isoformat() if ',' in raw else datetime.fromisoformat(raw.replace('Z', '+00:00')).isoformat()
        except Exception:
            pub = ''
        if title and link.startswith('http'):
            out.append({'title': title, 'link': link, 'published': pub, 'source': source,
                        'social': source.startswith('r/')})
    return out[:25]

@app.route('/api/feeds')
def feeds():
    import re as _re  # noqa: F401  (re is imported inside helpers too)
    from concurrent.futures import ThreadPoolExecutor
    if not feeds_cache['updated'] or (datetime.now() - feeds_cache['updated']).total_seconds() / 60 > FEEDS_MINUTES:
        headers = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36'}
        def grab(src):
            name, url = src
            try:
                r = requests.get(url, headers=headers, timeout=10)
                if r.status_code != 200:
                    return name, None, f'HTTP {r.status_code}'
                return name, _parse_feed(name, r.content), None
            except Exception as e:
                return name, None, str(e)[:120]
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(grab, FEEDS))
        articles, status = [], {}
        for name, items, err in results:
            status[name] = err or len(items)
            if items:
                articles.extend(items)
            elif err:
                # keep the last good copy of a feed that failed this time
                articles.extend(a for a in feeds_cache['data'] if a['source'] == name)
        articles.sort(key=lambda a: a['published'] or '', reverse=True)
        feeds_cache.update({'data': articles, 'updated': datetime.now(), 'sources': status})
    return jsonify({'articles': feeds_cache['data'], 'sources': feeds_cache['sources'], 'updated': str(feeds_cache['updated'])})

# ── NEWS FOR SPECIFIC TICKERS (Google News RSS, last 7 days) ──
ticker_news_cache = {}
TICKER_NEWS_MINUTES = 20

def _rss_items(query, limit):
    import re
    url = f'https://news.google.com/rss/search?q={requests.utils.quote(query)}&hl=en-US&gl=US&ceid=US:en'
    res = requests.get(url, timeout=8, headers={'User-Agent': 'Mozilla/5.0'})
    if res.status_code != 200:
        return []
    out = []
    for item in re.findall(r'<item>(.*?)</item>', res.text, re.DOTALL)[:limit]:
        title = re.search(r'<title>(.*?)</title>', item)
        link = re.search(r'<link>(.*?)</link>', item)
        pub = re.search(r'<pubDate>(.*?)</pubDate>', item)
        source = re.search(r'<source[^>]*>(.*?)</source>', item)
        if title and link:
            t = title.group(1).replace('<![CDATA[', '').replace(']]>', '').strip()
            src = source.group(1).strip() if source else ''
            # Google appends " - Source" to titles; drop it since the source is shown separately
            if src and t.endswith(' - ' + src):
                t = t[: -len(' - ' + src)]
            out.append({'title': t, 'link': link.group(1).strip(),
                        'published': pub.group(1).strip() if pub else '', 'source': src})
    return out

@app.route('/api/news/tickers/<tickers>')
def ticker_news(tickers):
    ticker_list = [t.strip().upper() for t in tickers.split(',') if t.strip()][:12]
    per = max(2, min(int(flask_request.args.get('per', 3)), 6))
    articles, seen = [], set()
    for ticker in ticker_list:
        hit = ticker_news_cache.get(ticker)
        if not hit or (datetime.now() - hit['updated']).total_seconds() / 60 > TICKER_NEWS_MINUTES:
            try:
                items = _rss_items(f'"{ticker}" stock when:7d', 6)
                ticker_news_cache[ticker] = {'data': items, 'updated': datetime.now()}
            except Exception as e:
                print(f'Ticker news error for {ticker}: {e}')
                items = hit['data'] if hit else []
        else:
            items = hit['data']
        for a in items[:per]:
            key = a['title'].lower()
            if key in seen:
                continue
            seen.add(key)
            articles.append({**a, 'ticker': ticker})
    return jsonify({'articles': articles, 'updated': str(datetime.now())})

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
             'model': 'openai/gpt-oss-120b',
                'max_tokens': min(int(body.get('max_tokens', 1000)), 4000),
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
        'endpoints': [
            '/api/all-trades',
            '/api/house-trades',
            '/api/senate-trades',
            '/api/prices',
            '/api/history/<tickers>?range=6mo',
            '/api/sectors/<tickers>',
            '/api/news',
            '/api/news/tickers/<tickers>',
            '/api/feeds',
            '/api/dividends/<tickers>',
            '/api/top-rates',
            '/api/ai'
        ],
        'updated': str(datetime.now())
    })

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
