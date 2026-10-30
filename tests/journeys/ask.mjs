// Ask journey (plan section 15): headless Chromium, 390px phone and desktop.
// The gateway is mocked with page.route, so no network and no real Groq calls.
//
// How to run (from the repo root):
//   python3 -m http.server 8767 &            # serve the repo
//   node tests/journeys/ask.mjs              # uses the global Playwright install
//   (optional) BASE=http://localhost:8767 node tests/journeys/ask.mjs
//
// Covers: Ask panel PASS (answer, Checked badge, Sources with dates), fallback (note, sources open,
// no AI text), /api/ask 404 (falls back to /api/ai, "Sources unavailable right now."), the chat for
// the same three cases, the insider buys question (Checked, SEC EDGAR Form 4 sources, no fallback note), and the Private markets page loading with filters.
// Fails on console errors, CSP violations, or an em/en dash in rendered text.
import {execSync} from 'node:child_process';
const pw = await import(execSync('npm root -g').toString().trim() + '/playwright/index.mjs');
const {chromium} = pw.default || pw;

const BASE = process.env.BASE || 'http://localhost:8767';
const API = 'https://portfolio-intel-api.viphashkahn.workers.dev';
const RENDER = 'https://portfolio-intel-escf.onrender.com';
const DISCLAIMER = 'This is general information from the sources listed, not personalized investment advice. Simulated or past results do not predict future returns.';
const SRC = [
  {fact: 'f1', label: 'Portfolio total value', value: '$12,345.67', status: 'verified', source: 'Your portfolio (on this device)', asof: '2026-10-23T14:02:00Z', url: null},
  {fact: 'f2', label: 'AAPL price', value: 'Unknown', status: 'unknown', source: 'Yahoo Finance via pi-market', asof: '2026-10-23T14:00:00Z', url: 'https://finance.yahoo.com/quote/AAPL'},
];
const RESP = {
  pass: {answer: 'Your portfolio total is $12,345.67.\n\n' + DISCLAIMER, sources: SRC, check: {status: 'PASS', flags: [], attempts: 1}, intent: 'holdings', case_id: 'x', ms: 10},
  // Insider buys (SEC Form 4): the question that used to land on Congress data and fall back.
  insiders: {answer: 'From SEC insider filings: LRN (Stride, Inc.), bought by Haggart Dylan G., Director, filed 2026-10-27, worth $12.18M. RENT (Rent the Runway, Inc.), bought by Nexus Capital Management LP and STORY3 Capital Partners, LLC, Director, 10% owner, filed 2026-10-23, worth $2.25M. These are company insiders, not members of Congress.\n\n' + DISCLAIMER,
    sources: [
      {fact: 'f1', label: 'Insider buy LRN', value: 'LRN (Stride, Inc.), bought by Haggart Dylan G., Director, filed 2026-10-27', status: 'verified', source: 'SEC EDGAR Form 4', asof: '2026-10-30T11:53:48Z', url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4'},
      {fact: 'f2', label: 'Value of LRN insider buy', value: '$12.18M', status: 'verified', source: 'SEC EDGAR Form 4', asof: '2026-10-30T11:53:48Z', url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4'},
      {fact: 'f3', label: 'Insider buy RENT', value: 'RENT (Rent the Runway, Inc.), bought by Nexus Capital Management LP and STORY3 Capital Partners, LLC, Director, 10% owner, filed 2026-10-23', status: 'verified', source: 'SEC EDGAR Form 4', asof: '2026-10-30T11:53:48Z', url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4'},
      {fact: 'f4', label: 'Value of RENT insider buy', value: '$2.25M', status: 'verified', source: 'SEC EDGAR Form 4', asof: '2026-10-30T11:53:48Z', url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4'},
    ], check: {status: 'PASS', flags: [], attempts: 1}, intent: 'insiders', case_id: 'z', ms: 10},
  fallback: {answer: 'Here is what the sources show:\n* Portfolio total value: $12,345.67\n\n' + DISCLAIMER, sources: SRC.slice(0, 1), check: {status: 'fallback', flags: ['V4'], attempts: 2}, intent: 'holdings', case_id: 'y', ms: 10},
};
const AI_TEXT = 'Plain answer from the old assistant.';

let failures = 0;
const check = (ok, name, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) failures++; };

async function run(viewport, label) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport, serviceWorkers: 'block'});
  await ctx.addInitScript(() => { try { localStorage.setItem('pi.welcome.v1', '1'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = [];
  // Two errors are expected from the stubs themselves and are excused by URL only:
  // the deliberate 404 from /api/ask, and the empty stand-in for CDN scripts failing their SRI hash.
  const expected = m => { const u = (m.location() && m.location().url) || '';
    return (u === API + '/api/ask' && /status of 404/.test(m.text())) || (/integrity/.test(m.text()) && /^https:\/\/(unpkg\.com|cdn\.jsdelivr\.net)\//.test(m.text().match(/https:\/\/\S+?(?=')/)?.[0] || '')); };
  page.on('console', m => { if (m.type() === 'error' && !expected(m)) errors.push(m.text() + ' @ ' + ((m.location() && m.location().url) || '')); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  let mode = 'pass', askHits = 0, aiHits = 0;
  // Everything off-origin is stubbed; nothing leaves the machine.
  await page.route(u => !u.href.startsWith(BASE), async route => {
    const u = route.request().url();
    if (u === API + '/api/ask') {
      askHits++;
      if (mode === '404') return route.fulfill({status: 404, contentType: 'application/json', body: '{"error":"Not found"}'});
      return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(RESP[mode])});
    }
    if (u === API + '/api/ai' || u === RENDER + '/api/ai') { aiHits++; return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({answer: AI_TEXT})}); }
    if (/\.js(\?|$)/.test(u)) return route.fulfill({status: 200, contentType: 'application/javascript', body: ''});
    return route.fulfill({status: 200, contentType: 'application/json', body: '{}'});
  });
  await page.goto(BASE + '/index.html#ask', {waitUntil: 'load'});
  await page.waitForSelector('#ask-q', {state: 'visible'});

  const askOnce = async q => { await page.fill('#ask-q', q); await page.click('#ask-go'); await page.waitForFunction(() => document.getElementById('ask-go').textContent === 'Ask' && !document.getElementById('ask-go').disabled); };

  // PASS
  mode = 'pass';
  await askOnce('How diversified am I?');
  const a1 = await page.textContent('#answer');
  check(a1.includes('$12,345.67') && !a1.includes(DISCLAIMER), `${label} ask PASS shows the answer without repeating the disclaimer`);
  check((await page.textContent('#ask')).includes('not personalized investment advice'), `${label} ask shows the disclaimer once on the page`);
  check(await page.isVisible('#answer-check .check-badge') && (await page.textContent('#answer-check')).trim() === 'Checked', `${label} ask PASS shows Checked badge`);
  check(!(await page.getAttribute('#answer-sources', 'hidden') !== null), `${label} ask PASS sources visible`);
  check((await page.textContent('#answer-sources-n')) === 'Sources (2)', `${label} ask PASS sources count`);
  await page.click('#answer-sources-n');
  const srcText = await page.textContent('#answer-sources-list');
  check(/as of Oct 23, 2026/.test(srcText) && srcText.includes('Unknown'), `${label} ask sources open with dates and Unknown tag`, srcText.slice(0, 120));
  check(await page.$eval('#answer-sources-list a', a => a.rel.includes('noopener') && a.target === '_blank'), `${label} source link is safe`);

  // fallback
  mode = 'fallback';
  await askOnce('Should I buy more?');
  check((await page.isHidden('#answer')), `${label} ask fallback hides AI text`);
  check((await page.textContent('#answer-check')).includes('Shown from sources only, the written answer did not pass our checks.'), `${label} ask fallback note`);
  check(await page.$eval('#answer-sources', d => !d.hidden && d.open), `${label} ask fallback sources open`);

  // 404 -> /api/ai
  mode = '404'; const aiBefore = aiHits;
  await askOnce('What is a bond?');
  check(aiHits === aiBefore + 1 && (await page.textContent('#answer')) === AI_TEXT, `${label} ask 404 uses /api/ai`, `aiHits ${aiHits - aiBefore}`);
  check((await page.textContent('#answer-check')).includes('Sources unavailable right now.') && !(await page.isVisible('#answer-check .check-badge')), `${label} ask 404 note, no badge`);
  check(await page.$eval('#answer-sources', d => d.hidden), `${label} ask 404 no sources`);

  // Insider buys: Checked badge, Form 4 sources, no fallback note
  mode = 'insiders'; let insBody = null;
  page.once('request', r => { if (r.url() === API + '/api/ask') insBody = r.postData(); });
  await askOnce('Any big insider buys this week?');
  const ai1 = await page.textContent('#answer');
  check(ai1.includes('LRN (Stride, Inc.)') && ai1.includes('$12.18M') && !ai1.includes(DISCLAIMER), `${label} ask insiders shows the answer`, ai1.slice(0, 80));
  check(await page.isVisible('#answer-check .check-badge') && (await page.textContent('#answer-check')).trim() === 'Checked', `${label} ask insiders shows Checked badge`);
  check(!(await page.textContent('#answer-check')).includes('Shown from sources only'), `${label} ask insiders has no fallback note`);
  check((await page.textContent('#answer-sources-n')) === 'Sources (4)', `${label} ask insiders sources count`);
  await page.click('#answer-sources-n');
  const insSrc = await page.textContent('#answer-sources-list');
  check(insSrc.includes('SEC EDGAR Form 4') && /as of Oct 30, 2026/.test(insSrc) && !/Congress|House|Senate/.test(insSrc), `${label} ask insiders sources are SEC Form 4 with dates`, insSrc.slice(0, 120));
  check(!!insBody && insBody.includes('Any big insider buys this week?'), `${label} ask insiders question sent to /api/ask`);

  // Chat
  await page.click('#as-fab');
  await page.waitForSelector('#as-panel:not([hidden])');
  const chatOnce = async q => { const n = await page.$$eval('#as-msgs .as-m.bot', x => x.length); await page.fill('#as-in', q); await page.click('#as-send');
    await page.waitForFunction(n => document.querySelectorAll('#as-msgs .as-m.bot:not(:has(.as-typing))').length > n, n); return page.$$eval('#as-msgs .as-m.bot', x => x[x.length - 1].innerText); };
  mode = 'pass'; const askBefore = askHits;
  let last = await chatOnce('How diversified am I?');
  check(askHits === askBefore + 1 && last.includes('$12,345.67') && last.includes('Checked') && last.includes('Sources (2)'), `${label} chat PASS via /api/ask with badge and sources`, last.slice(0, 80));
  mode = 'fallback';
  last = await chatOnce('Should I buy more?');
  check(last.includes('Shown from sources only') && last.includes('Sources (1)') && !last.includes('Here is what'), `${label} chat fallback`);
  check(await page.$$eval('#as-msgs .as-m.bot details.sources', d => d[d.length - 1].open), `${label} chat fallback sources open`);
  mode = '404'; const ai2 = aiHits;
  last = await chatOnce('What is a bond?');
  check(aiHits === ai2 + 1 && last.includes(AI_TEXT) && last.includes('Sources unavailable right now.'), `${label} chat 404 uses /api/ai`);
  const stored = await page.evaluate(() => sessionStorage.getItem('pi.chat') || '');
  check(!stored.includes('Portfolio total value'), `${label} chat sources not kept in sessionStorage`);
  let parsed = []; try { parsed = JSON.parse(stored); } catch (e) {}
  check(Array.isArray(parsed) && parsed.length === 3 && parsed.every(m => m.role === 'user') && !stored.includes('$12,345.67') && !stored.includes(AI_TEXT) && !stored.includes('Shown from sources only'), `${label} chat sessionStorage holds no bot text`, stored.slice(0, 120));
  await page.click('#as-close');

  // Private markets page with filters (data is the real private_markets.json served by the repo)
  await page.goto(BASE + '/index.html#private', {waitUntil: 'load'});
  await page.waitForFunction(() => document.querySelectorAll('#pm-list .rate').length > 0, null, {timeout: 15000});
  const allCount = await page.textContent('#pm-count');
  check(/raises/.test(allCount), `${label} private page loads`, allCount);
  await page.selectOption('#pm-state', 'TX');
  await page.waitForFunction(() => !document.getElementById('pm-city').disabled);
  const tx = await page.textContent('#pm-count');
  check(tx !== allCount && parseInt(tx.replace(/,/g, '')) > 0, `${label} private state filter`, tx);
  await page.selectOption('#pm-stage', 'Seed / Series A');
  const txSeed = await page.textContent('#pm-count');
  check(parseInt(txSeed.replace(/,/g, '')) <= parseInt(tx.replace(/,/g, '')), `${label} private stage filter`, txSeed);
  await page.click('#pm-tabs button[data-f="C"]');
  check((await page.textContent('#pm-count')).includes('crowdfunding'), `${label} private Form C tab`);
  await page.selectOption('#pm-state', ''); await page.selectOption('#pm-stage', ''); await page.click('#pm-tabs button[data-f="D"]');
  await page.fill('#pm-q', 'zzzz-no-such-company'); await page.waitForTimeout(400);
  check((await page.textContent('#pm-list')).includes('No matches'), `${label} private search filter`);

  // Page-wide checks
  const body = await page.evaluate(() => document.body.innerText);
  await page.goto(BASE + '/index.html#ask', {waitUntil: 'load'});
  const body2 = await page.evaluate(() => document.body.innerText);
  check(!/[–—]/.test(body + body2), `${label} no em or en dash in rendered text`, ((body + body2).match(/.{0,30}[–—].{0,30}/) || [''])[0]);
  const csp = errors.filter(e => /Content Security Policy|Refused to/i.test(e));
  check(!csp.length, `${label} no CSP violations`, csp.join(' | ').slice(0, 300));
  check(!errors.length, `${label} no console errors`, errors.join(' | ').slice(0, 400));
  await browser.close();
}

await run({width: 390, height: 844}, 'phone');
await run({width: 1280, height: 900}, 'desktop');
console.log(failures ? `\n${failures} check(s) failed` : '\nAll ask journey checks passed');
process.exit(failures ? 1 : 0);
