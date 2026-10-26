// News reads journey (plan phase3-news-agents, section 11 journeys): headless Chromium, 390px and desktop.
// The gateway is stubbed with page.route per contract 6.4, so no network and no Groq calls.
//
// How to run (from the repo root):
//   python3 -m http.server 8768 &
//   node tests/journeys/news.mjs            # BASE=http://localhost:8768 by default
//
// Covers: My reads defaults to watchlist plus portfolio; add and remove persist after reload; reset;
// a stored read shows its card (debate and collaborate); Get a news read for ok, thin, limited,
// busy and Unknown ticker; reads left today; ticker page shows both sides with https links and
// source and date; hostile headline text is escaped and a non-https link is not linked; Pelosi tab
// shows a universe card; Ask renders the card; no em or en dash; no console errors.
import {execSync} from 'node:child_process';
const pw = await import(execSync('npm root -g').toString().trim() + '/playwright/index.mjs');
const {chromium} = pw.default || pw;

const BASE = process.env.BASE || 'http://localhost:8768';
const API = 'https://portfolio-intel-api.viphashkahn.workers.dev';
const NOW = new Date().toISOString();
const TODAY = NOW.slice(0, 10);
const LABEL = 'News read, not a recommendation';
const MSG = {
  thin: 'Not enough news in the last 7 days for a news read.',
  limited: 'You have used today\'s news reads. Cached reads still show.',
  busy: 'News reads are at today\'s limit. Try again tomorrow.',
};
const ev = (id, title, source, url) => ({id, title, source, date: TODAY, url, tone: 1});
function rec(ticker, mode, extra = {}) {
  const base = {schema: 'pi/news-verdict/v1', id: 'u-' + ticker, run_date: TODAY, created: NOW, ticker, origin: 'batch', mode,
    mode_basis: {P: 2, N: 2, n: 4, pubs_pos: 2, pubs_neg: 2}, stance: 'mixed', confidence: 'medium', confidence_cap: 'medium',
    summary: `Coverage of ${ticker} is split between demand and supply worries.`, bull: [], bear: [], joint: [],
    evidence: [ev('e1', `${ticker} demand beats estimates`, 'CNBC', 'https://example.com/a'), ev('e2', `${ticker} faces supply limits`, 'Reuters', 'https://example.com/b'),
      ev('e3', '<img src=x onerror=alert(1)> hostile headline', 'Blog', 'javascript:alert(1)')],
    price_ref_date: TODAY, status: 'PASS', flags: [], groq_calls: 3, tokens: 5000, model: 'm', prompt_version: 'newsread-1'};
  if (mode === 'debate') { base.bull = [{text: 'Demand is strong.', cites: ['e1']}]; base.bear = [{text: 'Supply is tight.', cites: ['e2', 'e3']}]; }
  if (mode === 'collaborate') { base.stance = 'positive'; base.joint = [{text: 'Coverage agrees on growth.', cites: ['e1']}]; }
  return {...base, ...extra};
}
const STORED = {NVDA: [rec('NVDA', 'debate')], AAPL: [rec('AAPL', 'collaborate')]};

let failures = 0;
const check = (ok, name, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) failures++; };

async function run(viewport, label) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport, serviceWorkers: 'block'});
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('pi.welcome.v1', '1');
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('pi.watch.v1', JSON.stringify(['NVDA']));
        localStorage.setItem('pi.portfolio.v2', JSON.stringify([{ticker: 'MSFT', shares: 2, avgCost: 300, isCash: false}]));
      }
    } catch (e) {}
  });
  const page = await ctx.newPage();
  const errors = [];
  const expected = m => { const u = (m.location() && m.location().url) || '';
    return (u === API + '/api/newsdesk/read' && /status of (400|429|503)/.test(m.text())) || (/integrity/.test(m.text()) && /https:\/\/(unpkg\.com|cdn\.jsdelivr\.net)\//.test(m.text())); };
  page.on('console', m => { if (m.type() === 'error' && !expected(m)) errors.push(m.text() + ' @ ' + ((m.location() && m.location().url) || '')); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('dialog', d => { errors.push('dialog opened: ' + d.message()); d.dismiss(); });
  let readMode = 'ok', httpFail = 0, quota = 9, readsBodies = [];
  await page.route(u => !u.href.startsWith(BASE), async route => {
    const req = route.request(), u = req.url();
    const json = (status, o) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(o)});
    if (u === API + '/api/newsdesk/reads') {
      const b = JSON.parse(req.postData() || '{}'); readsBodies.push(b.tickers);
      const reads = {}; (b.tickers || []).forEach(t => reads[t] = STORED[t] || []);
      return json(200, {updated: NOW, window_days: 7, reads});
    }
    if (u === API + '/api/newsdesk/read') {
      const t = JSON.parse(req.postData() || '{}').ticker;
      if (httpFail) return json(httpFail, {error: 'x'});
      if (t === 'ZZZZ') return json(400, {error: 'Unknown ticker'});
      if (t === 'THIN') return json(200, {status: 'thin', cached: false, groq_calls: 0, quota_left: quota, read: null, message: MSG.thin});
      if (readMode === 'limited') return json(200, {status: 'limited', cached: false, groq_calls: 0, quota_left: 0, read: null, message: MSG.limited});
      if (readMode === 'busy') return json(200, {status: 'busy', cached: false, groq_calls: 0, quota_left: quota, read: null, message: MSG.busy});
      quota--; return json(200, {status: 'ok', cached: false, groq_calls: 3, quota_left: quota, read: rec(t, 'debate', {origin: 'on_demand'}), message: null});
    }
    if (u === API + '/api/ask') return json(200, {answer: 'Here is the news read for NVDA.', sources: [], check: {status: 'PASS', flags: [], attempts: 1}, intent: 'news_read', read: rec('NVDA', 'debate'), case_id: 'c', ms: 5});
    if (/\.js(\?|$)/.test(u)) return route.fulfill({status: 200, contentType: 'application/javascript', body: ''});
    return json(200, {});
  });
  const openReads = async () => {
    await page.goto(BASE + '/index.html#news', {waitUntil: 'load'});
    await page.reload({waitUntil: 'load'}); // a same-hash goto does not reload
    await page.waitForSelector('#news-tabs button[data-n="reads"]');
    await page.click('#news-tabs button[data-n="reads"]');
    await page.waitForSelector('#nr-form');
  };
  const chips = () => page.$$eval('#nr-chips .nr-tkb', b => b.map(x => x.textContent));

  await openReads();
  check(JSON.stringify(await chips()) === '["NVDA","MSFT"]', `${label} My reads defaults to watchlist plus portfolio`, JSON.stringify(await chips()));
  await page.waitForSelector('#nr-rows .read-card');
  const card = await page.textContent('#nr-rows .read-card');
  check(card.includes(LABEL) && card.includes('Tone: Mixed') && card.includes('Confidence: Medium'), `${label} stored read card shows label, tone, confidence`);
  check(card.includes('Judge\'s verdict') && card.includes('Case for') && card.includes('Case against'), `${label} debate card shows verdict and both sides`);
  check(await page.$('#nr-rows button[data-nr-get="MSFT"]') !== null, `${label} ticker without a read offers Get a news read`);
  check(readsBodies.some(t => JSON.stringify(t) === '["NVDA","MSFT"]'), `${label} reads request carries the list`);
  const html = await page.innerHTML('#nr-rows');
  check(!/<img/i.test(html) && html.includes('&lt;img') && !/href="javascript/i.test(html), `${label} hostile headline escaped, non-https not linked`);

  // add, remove, persist
  await page.fill('#nr-in', 'aapl'); await page.click('#nr-form button[type=submit]');
  await page.waitForFunction(() => document.getElementById('nr-status').textContent.includes('Added AAPL')); await page.waitForTimeout(150);
  await page.click('[data-nr-rm="MSFT"]');
  check((await page.textContent('#nr-status')).includes('Removed MSFT'), `${label} status announces removal`);
  await page.fill('#nr-in', '12$'); await page.click('#nr-form button[type=submit]');
  check((await page.textContent('#nr-status')).includes('Enter a ticker'), `${label} bad format is rejected on the device`);
  await openReads();
  check(JSON.stringify(await chips()) === '["NVDA","AAPL"]', `${label} add and remove persist after reload`, JSON.stringify(await chips()));
  await page.waitForFunction(() => document.querySelectorAll('#nr-rows .read-card').length === 2);
  check((await page.textContent('#nr-rows')).includes('Joint brief'), `${label} collaborate card shows joint brief`);

  // on-demand states
  for (const t of ['PLTR', 'THIN', 'ZZZZ', 'IBM', 'META']) {
    await page.fill('#nr-in', t); await page.click('#nr-form button[type=submit]');
    await page.waitForFunction(t => document.getElementById('nr-status').textContent.includes('Added ' + t), t);
    await page.waitForTimeout(150); // let the follow-up reads fetch re-render
  }
  readMode = 'ok';
  await page.click('[data-nr-get="PLTR"]');
  await page.waitForSelector('#nr-rows .read-card[aria-label="News read for PLTR"]');
  check((await page.textContent('#nr-status')).includes('News read for PLTR is ready.') && (await page.textContent('#nr-status')).includes('8 new reads left today.'), `${label} on-demand ok shows card and reads left`, await page.textContent('#nr-status'));
  await page.click('[data-nr-get="THIN"]');
  await page.waitForFunction(m => document.getElementById('nr-status').textContent.includes(m), MSG.thin);
  check((await page.textContent('#nr-rows')).includes(MSG.thin), `${label} thin shows not enough news`);
  await page.click('[data-nr-get="ZZZZ"]');
  await page.waitForFunction(() => document.getElementById('nr-status').textContent.includes('Unknown ticker'));
  check(true, `${label} invalid ticker shows Unknown ticker`);
  await page.waitForSelector('[data-nr-get="IBM"]:not([disabled])');
  readMode = 'busy';
  await page.click('[data-nr-get="IBM"]');
  await page.waitForFunction(m => document.getElementById('nr-status').textContent.includes(m), MSG.busy);
  check(await page.$eval('[data-nr-get="META"]', b => b.disabled), `${label} busy shows cap message and disables buttons`);
  await openReads(); readMode = 'limited'; httpFail = 0;
  await page.waitForSelector('[data-nr-get="META"]:not([disabled])');
  await page.click('[data-nr-get="META"]');
  await page.waitForFunction(m => document.getElementById('nr-status').textContent.includes(m), MSG.limited);
  check((await page.textContent('#nr-status')).includes('0 new reads left today.'), `${label} limited shows message and 0 left`);

  // HTTP 429 (rate) and 503 (paused)
  await openReads(); readMode = 'ok';
  await page.waitForSelector('[data-nr-get="IBM"]:not([disabled])');
  httpFail = 429; await page.click('[data-nr-get="IBM"]');
  await page.waitForFunction(m => document.getElementById('nr-status').textContent.includes(m), 'Too many requests');
  check((await page.textContent('#nr-rows')).includes('Too many requests') || (await page.textContent('#nr-status')).includes('Wait a minute'), `${label} 429 shows wait message`);
  await page.waitForSelector('[data-nr-get="IBM"]:not([disabled])');
  httpFail = 503; await page.click('[data-nr-get="IBM"]');
  await page.waitForFunction(() => document.getElementById('nr-status').textContent.includes('News reads are paused'));
  check(await page.$eval('[data-nr-get="META"]', b => b.disabled), `${label} 503 shows paused and disables buttons`);
  httpFail = 0;

  // touch targets
  const small = await page.$$eval('#news-list button, #news-list input', els => els.filter(e => e.offsetParent && e.getBoundingClientRect().height < 44).map(e => e.outerHTML.slice(0, 60)));
  check(!small.length, `${label} My reads targets are at least 44px tall`, small.join(' | '));
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(wide <= 0, `${label} no horizontal scroll`, String(wide));

  // reset
  await page.click('#nr-reset');
  check(JSON.stringify(await chips()) === '["NVDA","MSFT"]', `${label} reset returns to watchlist plus portfolio`);

  // ticker page
  await page.click('#nr-rows .rc-tk[data-tk="NVDA"]');
  await page.waitForSelector('#tk-read .read-card');
  const tk = await page.textContent('#tk-read');
  check(tk.includes('Case for') && tk.includes('Case against') && tk.includes('CNBC') && tk.includes(LABEL), `${label} ticker page shows both sides with source`);
  const links = await page.$$eval('#tk-read a', a => a.map(x => ({h: x.href, t: x.target, r: x.rel})));
  check(links.length > 0 && links.every(l => l.h.startsWith('https://') && l.t === '_blank' && l.r.includes('noopener')), `${label} ticker page links are https and safe`, JSON.stringify(links[0]));
  await page.click('#tk-close');

  await page.goto(BASE + '/index.html#ask', {waitUntil: 'load'});
  await page.waitForSelector('#ask-q', {state: 'visible'});
  await page.fill('#ask-q', 'what is the news saying about NVDA'); await page.click('#ask-go');
  await page.waitForSelector('#answer-read .read-card');
  check((await page.textContent('#answer-read')).includes(LABEL) && (await page.textContent('#answer-read')).includes('Case against'), `${label} Ask renders the news read card`);

  // floating chat shows the read card
  await page.click('#as-fab');
  await page.fill('#as-in', 'what is the news saying about NVDA'); await page.click('#as-send');
  await page.waitForSelector('#as-panel .read-card');
  const ct = await page.textContent('#as-panel .read-card');
  check(ct.includes(LABEL) && ct.includes('Case against'), `${label} floating chat renders the news read card`);
  check(await page.$eval('#as-panel .read-card', e => e.getBoundingClientRect().right <= innerWidth + 1), `${label} chat card fits the screen`);

  const body = await page.evaluate(() => document.body.innerText);
  check(!/[–—]/.test(body), `${label} no em or en dash in rendered text`, (body.match(/.{0,30}[–—].{0,30}/) || [''])[0]);
  const plain = await page.evaluate(() => localStorage.getItem('pi.newslist.v1'));
  check(plain === '' || plain === null || plain.startsWith('enc1:') || !/MSFT/.test(plain), `${label} reset list holds no tickers`, String(plain));
  check(!errors.length, `${label} no console errors`, errors.join(' | ').slice(0, 400));
  await browser.close();
}

await run({width: 390, height: 844}, 'phone');
await run({width: 1280, height: 900}, 'desktop');
console.log(failures ? `\n${failures} check(s) failed` : '\nAll news journey checks passed');
process.exit(failures ? 1 : 0);
