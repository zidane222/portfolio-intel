// Sync account journey (KAN-120): headless Chromium with a fake Supabase, so no network.
//
// How to run (from the repo root):
//   python3 -m http.server 8767 &
//   node tests/journeys/sync-account.mjs
//
// The device turns on sync with OWNER. Then a sign-up link for a different, empty account (OTHER)
// is opened in the same browser while sync is still on. Checks that nothing uploads to OTHER until
// the user taps "Use this account", that "Sign out" leaves OTHER empty, that the code screen explains
// a link-only email, and that first-time set-up for OWNER still uploads with no extra step.
// Fails on console errors or an em/en dash in rendered text.
import {execSync} from 'node:child_process';
const pw = await import(execSync('npm root -g').toString().trim() + '/playwright/index.mjs');
const {chromium} = pw.default || pw;

const BASE = process.env.BASE || 'http://localhost:8767';
const SB = 'https://hqkmumuezvfoxlvrhnrk.supabase.co';
const OWNER = 'owner@example.com', OTHER = 'other@example.com', PASS = 'correct horse 42', CODE = '123456';

let failures = 0;
const check = (ok, name, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) failures++; };

// Fake Supabase: one synced row per account, the account chosen by the bearer token
const TOKENS = {'at-owner': OWNER, 'at-other': OTHER};
const db = {rows: {}, posts: {[OWNER]: 0, [OTHER]: 0}};
const json = (route, status, body) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body), headers: {'access-control-allow-origin': '*'}});

async function device() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, serviceWorkers: 'block'});
  await ctx.addInitScript(() => { try { localStorage.setItem('pi.welcome.v1', '1'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|integrity/.test(m.text())) errors.push(m.text()); });
  await page.route(u => !u.href.startsWith(BASE), async route => {
    const req = route.request(), u = new URL(req.url()), body = req.postData() || '';
    if (u.origin !== SB) {
      if (/\.js(\?|$)/.test(u.href)) return route.fulfill({status: 200, contentType: 'application/javascript', body: ''});
      if (u.pathname === '/api/flags') return json(route, 200, {v: 1, updated: null, flags: {maintenance: false, broker: true, sync_writes: true, ai: true, news: true, disclosures: true, market: true}});
      return json(route, 200, {});
    }
    if (req.method() === 'OPTIONS') return route.fulfill({status: 200, headers: {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*'}});
    const who = TOKENS[(req.headers().authorization || '').replace('Bearer ', '')];
    const p = u.pathname;
    if (p === '/auth/v1/otp') return json(route, 200, {});
    if (p === '/auth/v1/verify') return JSON.parse(body).token === CODE
      ? json(route, 200, {access_token: 'at-owner', refresh_token: 'rt', expires_in: 3600, user: {email: OWNER, user_metadata: {}}})
      : json(route, 400, {msg: 'Token has expired or is invalid'});
    if (p === '/auth/v1/user' && req.method() === 'PUT') return json(route, 200, {email: who});
    if (p === '/auth/v1/user') return who ? json(route, 200, {email: who, user_metadata: {}}) : json(route, 401, {msg: 'no session'});
    if (p === '/auth/v1/logout') return json(route, 200, {});
    if (p === '/rest/v1/synced_data' && req.method() === 'GET') return json(route, 200, db.rows[who] ? [db.rows[who]] : []);
    if (p === '/rest/v1/synced_data' && req.method() === 'POST') { db.rows[who] = JSON.parse(body); db.posts[who]++; return route.fulfill({status: 201, headers: {'access-control-allow-origin': '*'}}); }
    return json(route, 200, {});
  });
  await page.goto(BASE + '/index.html#import', {waitUntil: 'load'});
  await page.waitForSelector('#sync-card:not([hidden])');
  return {browser, page, errors};
}
const syncText = page => page.textContent('#sync-text');
const noDash = (t, name) => check(!/[–—]/.test(t), name + ': no em or en dashes');

// 1. First-time set-up for OWNER still uploads straight away
const D = await device();
await D.page.fill('#sync-email', OWNER);
await D.page.click('#sync-out button[type=submit]');
await D.page.waitForSelector('#sync-code:not([hidden])');
const codeText = await syncText(D.page);
check(/no code/.test(codeText) && /email you used before/.test(codeText), 'code screen explains a link-only email');
noDash(codeText, 'code screen');
await D.page.fill('#sync-code-in', CODE);
await D.page.click('#sync-code button[type=submit]');
await D.page.waitForSelector('#sync-create:not([hidden])');
await D.page.evaluate(() => { localStorage.setItem('pi.portfolio.v2', JSON.stringify([{ticker: 'AAPL', company: 'Apple', shares: 3, avgCost: 150}])); });
await D.page.fill('#sync-new-1', PASS); await D.page.fill('#sync-new-2', PASS); await D.page.check('#sync-new-ack');
await D.page.click('#sync-create button[type=submit]');
await D.page.waitForFunction(() => /All set/.test(document.getElementById('sync-text').textContent), null, {timeout: 20000});
check(db.posts[OWNER] >= 1 && /^enc1:/.test(db.rows[OWNER].payload), 'first-time set-up uploads encrypted data to OWNER');
check(await D.page.evaluate(o => JSON.parse(localStorage.getItem('pi.lock.v1')).syncFor === o, OWNER), 'device remembers it syncs with OWNER');

// 2. A sign-up link for OTHER opens in the same browser while sync is still on
await D.page.goto(BASE + '/index.html?from=email#access_token=at-other&refresh_token=rt2&expires_in=3600&type=signup', {waitUntil: 'load'});
await D.page.waitForSelector('#sync-other:not([hidden])', {timeout: 20000});
const otherText = await syncText(D.page);
check(otherText.includes(OTHER) && otherText.includes(OWNER) && /no synced portfolio yet/.test(otherText), 'prompt names both accounts', otherText);
noDash(otherText, 'prompt');
check(!(await D.page.isVisible('#sync-in')), 'Sync is on panel is not shown for OTHER');
await D.page.evaluate(() => syncPush());
await D.page.evaluate(() => syncPush());
check(db.posts[OTHER] === 0, 'nothing uploads to OTHER before the user chooses', String(db.posts[OTHER]));

// 3a. Sign out from the prompt: OTHER stays empty, OWNER untouched
const ownerPosts = db.posts[OWNER];
await D.page.click('#sync-other-out');
await D.page.waitForSelector('#sync-out:not([hidden])');
check(await D.page.evaluate(() => !localStorage.getItem('pi.sb.session')), 'Sign out clears the OTHER session');
check(db.posts[OTHER] === 0 && !db.rows[OTHER] && db.posts[OWNER] === ownerPosts, 'Sign out uploads nothing anywhere');

// 3b. Open the OTHER link again and choose "Use this account": now it uploads
await D.page.evaluate(() => { const c = JSON.parse(localStorage.getItem('pi.lock.v1')); c.sync = true; localStorage.setItem('pi.lock.v1', JSON.stringify(c)); });
await D.page.goto(BASE + '/index.html?from=email-again#access_token=at-other&refresh_token=rt2&expires_in=3600&type=signup', {waitUntil: 'load'});
await D.page.waitForSelector('#sync-other:not([hidden])', {timeout: 20000});
await D.page.click('#sync-other-use');
await D.page.waitForSelector('#sync-in:not([hidden])', {timeout: 20000});
check(db.posts[OTHER] === 1 && /^enc1:/.test(db.rows[OTHER].payload), 'Use this account uploads encrypted data to OTHER');
check(await D.page.evaluate(o => JSON.parse(localStorage.getItem('pi.lock.v1')).syncFor === o, OTHER), 'device now remembers OTHER');
const inText = await syncText(D.page);
check(inText.includes(OTHER) && /Sync is on/.test(inText), 'Sync is on for OTHER afterwards');
noDash(inText, 'sync on');

check(D.errors.length === 0, 'no console errors', D.errors.join(' | '));
await D.browser.close();
check(!JSON.stringify(db.rows).includes(PASS), 'passcode never sent to the server');
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
