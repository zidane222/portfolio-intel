// pi-insights: private service. Serves the weekly insights.json and strategies.json from Pages.
// No secrets. Routes require X-PI-Internal: 1 (set by the gateway or by the Ask data agent).
import {makeService} from '../lib/service.js';
import {getInsights, getStrategies} from '../modules/insights.js';
export default makeService('insights', [['GET', /^\/api\/insights$/, getInsights], ['GET', /^\/api\/insights\/strategies$/, getStrategies]]);
