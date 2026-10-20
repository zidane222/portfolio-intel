import {makeService} from '../lib/service.js';
import {topRates} from '../modules/rates.js';
export default makeService('rates', [['GET', /^\/api\/top-rates$/, topRates]]);
