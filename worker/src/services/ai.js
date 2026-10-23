import {makeService} from '../lib/service.js';
import {ai, intent, build} from '../modules/ai.js';
// /internal/* is never in the gateway OWNERS table, so only the gateway (over AI_SVC) reaches it.
export default makeService('ai', [
  ['POST', /^\/api\/ai$/, ai],
  ['POST', /^\/internal\/intent$/, intent],
  ['POST', /^\/internal\/build$/, build],
]);
