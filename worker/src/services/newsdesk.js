// pi-newsdesk: private service (no public URL), reached only through the gateway NEWSDESK binding.
// Holds SUPABASE_SERVICE_KEY and GROQ_API_KEY (Secrets Store). Routes require X-PI-Internal: 1.
// The Cron Trigger (config/newsdesk.toml) runs one batch tick per invocation.
import {makeService} from '../lib/service.js';
import * as d from '../modules/newsdesk.js';
import {buildPack} from '../agents/newsread/pack.js';
import {chooseMode} from '../agents/newsread/mode.js';
import {runNewsRead, newsCase} from '../agents/newsread/supervisor.js';

export const AGENTS = {buildPack, chooseMode, runNewsRead, newsCase};

export default makeService('newsdesk', [
  ['POST', /^\/read$/, (req, env) => d.read(req, env, d.makeDeps(env, AGENTS))],
  ['POST', /^\/reads$/, (req, env) => d.reads(req, env, d.makeDeps(env, AGENTS))],
], {
  scheduled(event, env, ctx) {
    ctx.waitUntil(d.tick(env, d.makeDeps(env, AGENTS), event.scheduledTime)
      .then(r => console.log('newsdesk tick', JSON.stringify({run_date: r.run_date, n: (r.results || []).length, skipped: r.skipped || null})))
      .catch(e => console.log('newsdesk tick failed', String(e && e.message || e).slice(0, 160))));
  },
});
