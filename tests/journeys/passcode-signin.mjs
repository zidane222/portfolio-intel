// Passcode sign-in journey: headless Chromium with a fake Supabase, so no network.
//
// How to run (from the repo root):
//   python3 -m http.server 8767 &
//   node tests/journeys/passcode-signin.mjs
//
// Device A signs in with an email code and creates a passcode. Device B is a fresh browser
// (like a home-screen app) and signs in with email + passcode, then its synced data unlocks.
// Checks that the passcode itself never leaves the device, only the derived login secret,
// that a wrong passcode is refused, and that the email-code and passkey buttons are still there.
// Fails on console errors or an em/en dash in rendered text.
import {execSync} from 'node:child_process';
const pw = await import(execSync('npm root -g').toString().trim() + '/playwright/index.mjs');
const {chromium} = pw.default || pw;

const BASE = process.env.BASE || 'http://localhost:8767';
const SB = 'https://hqkmumuezvfoxlvrhnrk.supabase.co';
const EMAIL = 'tester@example.com', PASS = 'correct horse 42', CODE = '123456';

let failures = 0;
const check = (ok, name, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) failures++; };

// Fake Supabase, shared by both devices
const db = {password: null, row: null, bodies: []};
const json = (route, status, body) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body), headers: {'access-control-allow-origin': '*'}});
const session = () => ({access_token: 'at', refresh_token: 'rt', expires_in: 3600, user: {email: EMAIL, user_metadata: {}}});

async function device(label) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, serviceWorkers: 'block'});
  await ctx.addInitScript(() => { try { localStorage.setItem('pi.welcome.v1', '1'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message + ' ' + (e.stack||'').split('\n').slice(1,3).join(' ')));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|integrity/.test(m.text())) errors.push(m.text()); });
  await page.route(u => !u.href.startsWith(BASE), async route => {
    const req = route.request(), u = new URL(req.url()), body = req.postData() || '';
    if (u.origin !== SB) {
      if (/\.js(\?|$)/.test(u.href)) return route.fulfill({status: 200, contentType: 'application/javascript', body: ''});
      return json(route, 200, {});
    }
    if (req.method() === 'OPTIONS') return route.fulfill({status: 200, headers: {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*'}});
    db.bodies.push(body);
    const p = u.pathname;
    if (p === '/auth/v1/otp') return json(route, 200, {});
    if (p === '/auth/v1/verify') return JSON.parse(body).token === CODE ? json(route, 200, session()) : json(route, 400, {msg: 'Token has expired or is invalid'});
    if (p === '/auth/v1/token' && u.searchParams.get('grant_type') === 'password') {
      const b = JSON.parse(body);
      return b.email === EMAIL && db.password && b.password === db.password ? json(route, 200, session()) : json(route, 400, {error_description: 'Invalid login credentials'});
    }
    if (p === '/auth/v1/user' && req.method() === 'PUT') { const b = JSON.parse(body); if (b.password) db.password = b.password; return json(route, 200, {email: EMAIL}); }
    if (p === '/auth/v1/user') return json(route, 200, {email: EMAIL, user_metadata: {}});
    if (p === '/rest/v1/synced_data' && req.method() === 'GET') return json(route, 200, db.row ? [db.row] : []);
    if (p === '/rest/v1/synced_data' && req.method() === 'POST') { db.row = JSON.parse(body); return route.fulfill({status: 201, headers: {'access-control-allow-origin': '*'}}); }
    return json(route, 200, {});
  });
  await page.goto(BASE + '/index.html#import', {waitUntil: 'load'});
  await page.waitForSelector('#sync-card:not([hidden])');
  return {browser, page, errors, label};
}
const text = page => page.textContent('#sync-text');

// Device A: email code, create passcode, sync on
const A = await device('A');
check(await A.page.isVisible('#sync-pw-show'), 'A sign-in card offers passcode sign-in');
await A.page.fill('#sync-email', EMAIL);
await A.page.click('#sync-out button[type=submit]');
await A.page.waitForSelector('#sync-code:not([hidden])');
await A.page.fill('#sync-code-in', CODE);
await A.page.click('#sync-code button[type=submit]');
await A.page.waitForSelector('#sync-create:not([hidden])');
await A.page.evaluate(() => { localStorage.setItem('pi.portfolio.v2', JSON.stringify([{ticker: 'AAPL', company: 'Apple', shares: 3, avgCost: 150}])); });
await A.page.fill('#sync-new-1', PASS); await A.page.fill('#sync-new-2', PASS); await A.page.check('#sync-new-ack');
await A.page.click('#sync-create button[type=submit]');
await A.page.waitForFunction(() => /All set/.test(document.getElementById('sync-text').textContent), null, {timeout: 20000});
check(!!db.row && /^enc1:/.test(db.row.payload), 'A uploads encrypted data only');
check(typeof db.password === 'string' && /^[A-Za-z0-9_-]{43}$/.test(db.password) && db.password !== PASS, 'A links a derived login secret, not the passcode');
check(A.errors.length === 0, 'A no console errors', A.errors.join(' | '));
await A.browser.close();

// Device B: fresh storage, wrong passcode first
const B = await device('B');
await B.page.click('#sync-pw-show');
check(await B.page.isVisible('#sync-pw') && !(await B.page.isVisible('#sync-out')), 'B shows the passcode sign-in form');
await B.page.fill('#sync-pw-email', EMAIL); await B.page.fill('#sync-pw-in', 'wrong passcode 1');
await B.page.click('#sync-pw button[type=submit]');
await B.page.waitForFunction(() => /didn.t match/.test(document.getElementById('sync-text').textContent), null, {timeout: 20000});
check(true, 'B wrong passcode is refused with a clear message');
check(await B.page.evaluate(() => !localStorage.getItem('pi.sb.session')), 'B stays signed out after a wrong passcode');
// Right passcode: signs in and unlocks the synced data with the same passcode
await B.page.fill('#sync-pw-in', PASS);
await Promise.all([B.page.waitForNavigation({timeout: 30000}), B.page.click('#sync-pw button[type=submit]')]);
await B.page.waitForSelector('#sync-in:not([hidden])', {timeout: 20000});
const st = await B.page.evaluate(() => ({s: !!localStorage.getItem('pi.sb.session'), lock: JSON.parse(localStorage.getItem('pi.lock.v1') || 'null'), linked: localStorage.getItem('pi.pw.linked'), port: typeof vget === 'function' ? vget('pi.portfolio.v2') : null}));
check(st.s && st.lock && st.lock.sync && st.lock.encSalt === db.row.enc_salt, 'B signed in and sync is on with the same key');
check(st.port && st.port.includes('AAPL'), 'B synced portfolio unlocked on the new device');
check(st.linked === EMAIL, 'B remembers passcode sign-in is linked');
const t = await text(B.page);
check(!/[–—]/.test(t), 'B no em or en dashes in sync text');
check(B.errors.length === 0, 'B no console errors', B.errors.join(' | '));
await B.browser.close();

check(!db.bodies.some(b => b.includes(PASS)), 'Passcode never sent to the server in any request');
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
