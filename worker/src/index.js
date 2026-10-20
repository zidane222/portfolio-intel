// Portfolio Intel API on Cloudflare Workers.
// One Worker made of modules (market, news, rates, ai, broker, disclosures). Each module can later
// move into its own Worker behind this router without changing the app.
import {json, corsHeaders} from './lib/http.js';
import {rateLimited} from './lib/ratelimit.js';
import {resolveSecrets} from './lib/secrets.js';
import * as market from './modules/market.js';
import * as news from './modules/news.js';
import * as rates from './modules/rates.js';
import * as broker from './modules/broker.js';
import * as disclosures from './modules/disclosures.js';
import {ai} from './modules/ai.js';

const ROUTES = [
  ['GET', /^\/api\/prices(?:\/([^/]+))?$/, market.prices],
  ['GET', /^\/api\/history\/([^/]+)$/, market.history],
  ['GET', /^\/api\/sectors\/([^/]+)$/, market.sectors],
  ['GET', /^\/api\/dividends\/([^/]+)$/, market.dividends],
  ['GET', /^\/api\/news\/tickers\/([^/]+)$/, news.tickerNews],
  ['GET', /^\/api\/news$/, news.news],
  ['GET', /^\/api\/feeds$/, news.feeds],
  ['GET', /^\/api\/top-rates$/, rates.topRates],
  ['GET', /^\/api\/all-trades$/, disclosures.allTrades],
  ['POST', /^\/api\/ai$/, ai],
  ['GET', /^\/api\/plaid\/status$/, broker.status],
  ['POST', /^\/api\/plaid\/link-token$/, broker.linkToken],
  ['POST', /^\/api\/plaid\/exchange$/, broker.exchange],
  ['POST', /^\/api\/plaid\/holdings$/, broker.holdings],
  ['POST', /^\/api\/plaid\/remove$/, broker.remove],
];

function health() {
  return json({status: 'ok', service: 'Portfolio Intel API (Cloudflare Worker)', modules: ['market', 'news', 'rates', 'ai', 'broker', 'disclosures'], updated: new Date().toISOString()});
}

export default {
  async fetch(req, rawEnv) {
    const env = await resolveSecrets(rawEnv);
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
    let res;
    try {
      if (url.pathname === '/' || url.pathname === '/health') res = health();
      else if (url.pathname.startsWith('/api/') && rateLimited(req, 'api')) res = json({error: 'Too many requests. Try again in a minute.'}, 429);
      else {
        const hit = ROUTES.find(([m, re]) => m === req.method && re.test(url.pathname));
        if (!hit) res = json({error: 'Not found'}, 404);
        else {
          const raw = url.pathname.match(hit[1])[1];
          res = await hit[2](req, env, url, raw ? decodeURIComponent(raw) : raw);
        }
      }
    } catch (e) {
      console.log('Unhandled', url.pathname, String(e && e.stack || e));
      res = json({error: 'Server error'}, 500);
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};
