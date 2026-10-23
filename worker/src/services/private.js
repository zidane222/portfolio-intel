import {makeService} from '../lib/service.js';
import {list, stats} from '../modules/private.js';
export default makeService('private', [['GET', /^\/api\/private$/, list], ['GET', /^\/api\/private\/stats$/, stats]]);
