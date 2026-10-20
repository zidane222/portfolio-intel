import {makeService} from '../lib/service.js';
import * as b from '../modules/broker.js';
export default makeService('broker', [
  ['GET', /^\/api\/plaid\/status$/, b.status],
  ['POST', /^\/api\/plaid\/link-token$/, b.linkToken],
  ['POST', /^\/api\/plaid\/exchange$/, b.exchange],
  ['POST', /^\/api\/plaid\/holdings$/, b.holdings],
  ['POST', /^\/api\/plaid\/remove$/, b.remove],
]);
