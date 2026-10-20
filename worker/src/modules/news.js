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
  ['r/stocks', 'https://www.reddit.com/r/stocks/top/.rss?t=day'],
  ['r/wallstreetbets', 'https://www.reddit.com/r/wallstreetbets/top/.rss?t=day'],
];

const tag = (s, name) => { const m = s.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i')); return m ? m[1] : ''; };
const clean = s => unescapeHtml(String(s).replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '')).trim();

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

export async function feeds() {
  let data = memGet('feeds');
  if (!data) {
    const prev = memGet('feeds:last') || {articles: []};
    const results = await pool(FEEDS, 10, async ([name, u]) => {
      const text = await grab(u, {as: 'text', timeout: 10000});
      return [name, text ? parseFeed(name, text) : null];
    });
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
    if (!items) { items = await googleNews(`"${t}" stock when:7d`, 6); memSet('tn:' + t, items, 1200); }
    return items;
  });
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

export async function news() {
  let data = memGet('news');
  if (!data) {
    const queries = ['Congress stock trade disclosure', 'Pelosi stock trade', 'Senate stock trade', 'stock market today'];
    const lists = await pool(queries, 4, q => googleNews(q, 4));
    const seen = new Set(), articles = [];
    queries.forEach((q, i) => (lists[i] || []).forEach(a => { if (!seen.has(a.title)) { seen.add(a.title); articles.push({...a, query: q}); } }));
    data = {articles: articles.slice(0, 20), updated: nowIso(), count: Math.min(articles.length, 20)};
    memSet('news', data, 300);
  }
  return json(data);
}
