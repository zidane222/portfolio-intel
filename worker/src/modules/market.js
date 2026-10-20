// Market data module: prices, history, sectors, dividends (Yahoo Finance).
import {json, nowIso, tickers, grab, memGet, memSet, pool} from '../lib/http.js';

const CHART = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const RANGE_MAP = {'1d': ['1d', '5m'], '5d': ['5d', '30m'], '1mo': ['1mo', '1d'], '6mo': ['6mo', '1d'], 'ytd': ['ytd', '1d'], '1y': ['1y', '1d'], '5y': ['5y', '1wk']};
const r2 = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// Close of the trading day before the latest one (Yahoo often omits previousClose).
export function previousClose(result, price) {
  const meta = result.meta || {};
  const stamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const off = meta.gmtoffset || 0;
  const day = ts => new Date((ts + off) * 1000).toISOString().slice(0, 10);
  const bars = stamps.map((t, i) => [day(t), closes[i]]).filter(([, c]) => c != null);
  const session = meta.regularMarketTime ? day(meta.regularMarketTime) : (bars.length ? bars[bars.length - 1][0] : null);
  const earlier = bars.filter(([d]) => session && d < session).map(([, c]) => c);
  if (earlier.length) return earlier[earlier.length - 1];
  return meta.previousClose || meta.chartPreviousClose || price;
}

async function priceOf(t) {
  const hit = memGet('p:' + t);
  if (hit) return hit;
  const d = await grab(`${CHART}${encodeURIComponent(t)}?interval=1d&range=5d`);
  const result = d?.chart?.result?.[0];
  if (!result) return null;
  const meta = result.meta || {};
  const price = meta.regularMarketPrice || 0;
  const prev = previousClose(result, price);
  const out = {price: r2(price), prev_close: r2(prev), change_pct: r2(prev ? (price - prev) / prev * 100 : 0), currency: meta.currency || 'USD'};
  memSet('p:' + t, out, 60);
  return out;
}

export async function prices(req, env, url, raw) {
  const list = tickers(raw || 'VOO,QQQM,GLD,NVDA,AAPL,MSFT,GOOGL,AMZN', 40);
  const vals = await pool(list, 10, priceOf);
  const out = {};
  list.forEach((t, i) => { if (vals[i]) out[t] = vals[i]; });
  return json({prices: out, updated: nowIso()});
}

export async function history(req, env, url, raw) {
  const rng = (url.searchParams.get('range') || '6mo').toLowerCase();
  const [yr, interval] = RANGE_MAP[rng] || RANGE_MAP['6mo'];
  const list = tickers(raw, 40);
  const series = {};
  await pool(list, 10, async t => {
    const key = `h:${t}:${yr}`;
    let pts = memGet(key);
    if (!pts) {
      const d = await grab(`${CHART}${encodeURIComponent(t)}?range=${yr}&interval=${interval}`);
      const res = d?.chart?.result?.[0];
      if (!res) return;
      const closes = res.indicators?.quote?.[0]?.close || [];
      pts = (res.timestamp || []).map((ts, i) => [ts, closes[i]]).filter(([, c]) => c != null).map(([ts, c]) => [ts, r2(c, 4)]);
      if (pts.length) memSet(key, pts, 900);
    }
    if (pts && pts.length) series[t] = pts;
  });
  return json({range: rng, series, updated: nowIso()});
}

export async function sectors(req, env, url, raw) {
  const list = tickers(raw, 40);
  const out = {};
  await pool(list, 10, async t => {
    let info = memGet('s:' + t);
    if (!info) {
      const d = await grab(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(t)}&quotesCount=5&newsCount=0`);
      const q = (d?.quotes || []).find(x => String(x.symbol || '').toUpperCase() === t);
      if (!q) return;
      const type = String(q.quoteType || '').toUpperCase();
      info = (type === 'ETF' || type === 'MUTUALFUND')
        ? {sector: 'Funds & ETFs', industry: q.longname || q.shortname || ''}
        : {sector: q.sectorDisp || q.sector || '', industry: q.industryDisp || q.industry || ''};
      if (!info.sector) return;
      memSet('s:' + t, info, 7 * 86400);
    }
    out[t] = info;
  });
  return json({sectors: out});
}

export async function dividends(req, env, url, raw) {
  const list = tickers(raw, 45);
  const out = {};
  const ymd = s => new Date(s * 1000).toISOString().slice(0, 10);
  await pool(list, 10, async t => {
    let data = memGet('d:' + t);
    if (!data) {
      const d = await grab(`${CHART}${encodeURIComponent(t)}?range=1y&interval=1d&events=div`);
      const res = d?.chart?.result?.[0];
      if (!res) return;
      const meta = res.meta || {};
      const price = meta.regularMarketPrice || 0;
      const cutoff = Date.now() / 1000 - 365 * 86400;
      const paid = Object.values(res.events?.dividends || {}).filter(x => (x.date || 0) >= cutoff).map(x => [x.date, x.amount || 0]).sort((a, b) => a[0] - b[0]);
      const ttm = paid.reduce((s, [, a]) => s + a, 0);
      const closes = (res.indicators?.quote?.[0]?.close || []).filter(Boolean);
      data = {
        price: r2(price), ttm_dividend: r2(ttm, 4), yield: price ? r2(ttm / price * 100) : 0, payments: paid.length,
        history: paid.map(([ts, a]) => [ymd(ts), r2(a, 4)]),
        last_paid: paid.length ? ymd(paid[paid.length - 1][0]) : null,
        return_1y: closes.length > 1 ? r2((closes[closes.length - 1] / closes[0] - 1) * 100) : null,
        name: meta.longName || meta.shortName || t,
      };
      memSet('d:' + t, data, 12 * 3600);
    }
    out[t] = data;
  });
  return json({dividends: out, updated: nowIso()});
}
