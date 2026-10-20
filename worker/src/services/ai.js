import {makeService} from '../lib/service.js';
import {ai} from '../modules/ai.js';
export default makeService('ai', [['POST', /^\/api\/ai$/, ai]]);
