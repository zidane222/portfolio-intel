import {makeService} from '../lib/service.js';
import * as n from '../modules/news.js';
export default makeService('news', [
  ['GET', /^\/api\/news\/tickers\/([^/]+)$/, n.tickerNews],
  ['GET', /^\/api\/news$/, n.news],
  ['GET', /^\/api\/feeds$/, n.feeds],
]);
