import {makeService} from '../lib/service.js';
import {allTrades} from '../modules/disclosures.js';
export default makeService('disclosures', [['GET', /^\/api\/all-trades$/, allTrades]]);
