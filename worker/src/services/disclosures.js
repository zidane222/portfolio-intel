import {makeService} from '../lib/service.js';
import {allTrades, insiderBuys} from '../modules/disclosures.js';
export default makeService('disclosures', [['GET', /^\/api\/all-trades$/, allTrades], ['GET', /^\/api\/insiders$/, insiderBuys]]);
