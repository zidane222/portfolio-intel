// News module: Google News searches, ticker news and publisher feeds.
import {json, nowIso, tickers, grab, memGet, memSet, pool, unescapeHtml} from '../lib/http.js';

const FEEDS = [
  ['Morning Brew', 'https://www.morningbrew.com/feed.xml'],
  ['CNBC', 'https://www.cnbc.com/id/20910258/device/rss/rss.html'],
  ['MarketWatch', 'https://feeds.content.dowjones.io/public/rss/mw_topstories'],
  ['Bloomberg', 'https://feeds.bloomberg.com/markets/news.rss'],
  ['Financial Times', 'https://www.ft.com/markets?format=rss'],
  ['Seeking Alpha', 'https://seekingalpha.com/market_currents.xml'],
  ['Nasdaq', 'https://www.nasdaq.com/feed/rssoutbound?category=Markets'],
  ['Axios', 'https://api.axios.com/feed/'],
  ['r/stocks', 'https://old.reddit.com/r/stocks/top/.rss?t=day'],
  ['r/wallstreetbets', 'https://old.reddit.com/r/wallstreetbets/top/.rss?t=day'],
];

const tag = (s, name) => { const m = s.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i')); return m ? m[1] : ''; };
// Strip tags until none are left, decode entities, then drop any angle brackets the decoding produced
const stripTags = s => { let prev; do { prev = s; s = s.replace(/<[^<>]*>/g, ''); } while (s !== prev); return s; };
const clean = s => unescapeHtml(stripTags(String(s).replace(/<!\[CDATA\[|\]\]>/g, ''))).replace(/[<>]/g, '').trim();

function toIso(raw) {
  const d = new Date(String(raw).trim());
  return isNaN(d) ? '' : d.toISOString();
}

// RSS <item> and Atom <entry> without an XML library
export function parseFeed(source, text) {
  const out = [];
  const blocks = String(text).slice(0, 400000).match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks.slice(0, 25)) {
    const title = clean(tag(b, 'title'));
    let link = clean(tag(b, 'link'));
    if (!link) { const m = b.match(/<link\b[^>]*href="([^"]+)"/i); link = m ? unescapeHtml(m[1]) : ''; }
    const pub = toIso(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated'));
    if (title && link.startsWith('http')) out.push({title, link, published: pub, source, social: source.startsWith('r/')});
  }
  return out;
}

async function googleNews(query, limit) {
  const text = await grab(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`, {as: 'text'});
  if (!text) return [];
  return (text.match(/<item>[\s\S]*?<\/item>/g) || []).slice(0, limit).map(it => {
    let t = clean(tag(it, 'title'));
    const src = clean(tag(it, 'source'));
    if (src && t.endsWith(' - ' + src)) t = t.slice(0, -(' - ' + src).length);
    return {title: t, link: clean(tag(it, 'link')), published: clean(tag(it, 'pubDate')), source: src};
  }).filter(a => a.title && a.link);
}

const REDDIT_UA = 'web:portfolio-intel:v1.0 (personal dashboard; github.com/zidane222/portfolio-intel)';

export async function feeds(req, env) {
  let data = memGet('feeds');
  if (!data) {
    const prev = memGet('feeds:last') || {articles: []};
    const results = await pool(FEEDS, 10, async ([name, u]) => {
      // Reddit expects an app-style User-Agent and often refuses cloud servers without one
      const headers = name.startsWith('r/') ? {'User-Agent': REDDIT_UA, 'Accept': 'application/rss+xml'} : {};
      const text = await grab(u, {as: 'text', timeout: 10000, headers});
      return [name, text ? parseFeed(name, text) : null];
    });
    // If Reddit still refuses, borrow its headlines from the backup server (a different network)
    if (results.some(([n, items]) => n.startsWith('r/') && !(items && items.length)) && env && env.FALLBACK_API) {
      const d = await grab(env.FALLBACK_API + '/api/feeds', {timeout: 25000});
      const extra = (d && d.articles || []).filter(a => String(a.source || '').startsWith('r/'));
      for (const r of results) if (r[0].startsWith('r/') && !(r[1] && r[1].length)) { const got = extra.filter(a => a.source === r[0]); if (got.length) r[1] = got; }
    }
    const articles = [], sources = {};
    for (const [name, items] of results) {
      sources[name] = items ? items.length : 'unavailable';
      if (items && items.length) articles.push(...items);
      else articles.push(...prev.articles.filter(a => a.source === name)); // keep the last good copy
    }
    articles.sort((a, b) => (b.published || '').localeCompare(a.published || ''));
    data = {articles, sources, updated: nowIso()};
    memSet('feeds', data, 900);
    memSet('feeds:last', data, 86400);
  }
  return json(data);
}

export async function tickerNews(req, env, url, raw) {
  const list = tickers(raw, 12);
  const per = Math.max(2, Math.min(parseInt(url.searchParams.get('per') || '3', 10) || 3, 6));
  const lists = await pool(list, 6, async t => {
    let items = memGet('tn:' + t);
    if (!items) { items = await googleNews(`"${t}" stock when:7d`, 6); if (items.length) memSet('tn:' + t, items, 1200); }
    return items;
  });
  // Google News often refuses cloud servers: if nothing came back, ask the backup server (a different network)
  if (!lists.some(l => l && l.length) && env && env.FALLBACK_API) {
    const d = await grab(`${env.FALLBACK_API}/api/news/tickers/${list.join(',')}?per=${per}`, {timeout: 25000});
    if (d && Array.isArray(d.articles) && d.articles.length) return json({articles: d.articles, updated: nowIso(), via: 'backup'});
  }
  const seen = new Set(), articles = [];
  list.forEach((t, i) => {
    for (const a of (lists[i] || []).slice(0, per)) {
      const k = a.title.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k); articles.push({...a, ticker: t});
    }
  });
  return json({articles, updated: nowIso()});
}

// Up to n headlines for one ticker from the last 7 days (Google News, then the Render backup).
// Used by pi-newsdesk as a library. Returns [{title, link, published, source}]; never throws.
// Subrequests: 1, or 2 when Google News returns nothing.
export async function fetchTickerHeadlines(t, n = 8, env = {}) {
  const ticker = String(t || '').toUpperCase();
  if (!/^[A-Z.-]{1,6}$/.test(ticker)) return [];
  const lim = Math.max(1, Math.min(n | 0 || 8, 12));
  const key = `tnh:${ticker}:${lim}`;
  const hit = memGet(key);
  if (hit) return hit;
  let items = await googleNews(`"${ticker}" stock when:7d`, lim);
  if (!items.length && env && env.FALLBACK_API) {
    const d = await grab(`${env.FALLBACK_API}/api/news/tickers/${ticker}?per=${Math.min(lim, 6)}`, {timeout: 12000});
    items = (d && Array.isArray(d.articles) ? d.articles : []).filter(a => a && a.title && a.link)
      .slice(0, lim).map(a => ({title: String(a.title), link: String(a.link), published: String(a.published || ''), source: String(a.source || '')}));
  }
  if (items.length) memSet(key, items, 1200);
  return items;
}

export async function news(req, env) {
  let data = memGet('news');
  if (!data) {
    const queries = ['Congress stock trade disclosure', 'Pelosi stock trade', 'Senate stock trade', 'stock market today'];
    const lists = await pool(queries, 4, q => googleNews(q, 4));
    const seen = new Set(), articles = [];
    queries.forEach((q, i) => (lists[i] || []).forEach(a => { if (!seen.has(a.title)) { seen.add(a.title); articles.push({...a, query: q}); } }));
    data = {articles: articles.slice(0, 20), updated: nowIso(), count: Math.min(articles.length, 20)};
    if (!articles.length && env && env.FALLBACK_API) {
      const d = await grab(env.FALLBACK_API + '/api/news', {timeout: 25000});
      if (d && Array.isArray(d.articles) && d.articles.length) data = {...d, via: 'backup'};
    }
    if (data.articles.length) memSet('news', data, 300);
  }
  return json(data);
}
