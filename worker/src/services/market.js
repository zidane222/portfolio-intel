import {makeService} from '../lib/service.js';
import * as m from '../modules/market.js';
export default makeService('market', [
  ['GET', /^\/api\/prices(?:\/([^/]+))?$/, m.prices],
  ['GET', /^\/api\/history\/([^/]+)$/, m.history],
  ['GET', /^\/api\/sectors\/([^/]+)$/, m.sectors],
  ['GET', /^\/api\/dividends\/([^/]+)$/, m.dividends],
]);
