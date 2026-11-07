// Feature flags journey: headless Chromium, 390px phone. All off-origin calls are stubbed.
//
// How to run (from the repo root):
//   python3 -m http.server 8765 &
//   BASE=http://localhost:8765 node tests/journeys/flags.mjs
//
// Covers: boot shows the notice banner when a flag is off (and hides it when all are on);
// a disabled answer (503, disabled: true) never falls back to Render, while a plain 503 does;
// sync upload paused while sync_writes is off, then resumed when it flips back on, with only
// enc1: ciphertext sent. Fails on console errors or an em dash in the banner.
import {execSync} from 'node:child_process';
const pw = await import(execSync('npm root -g').toString().trim() + '/playwright/index.mjs');
const {chromium} = pw.default || pw;

const BASE = process.env.BASE || 'http://localhost:8765';
const API = 'https://portfolio-intel-api.viphashkahn.workers.dev';
const RENDER = 'https://portfolio-intel-escf.onrender.com';
const SB = 'https://hqkmumuezvfoxlvrhnrk.supabase.co';
const ALL_ON = {maintenance: false, broker: true, sync_writes: true, ai: true, news: true, disclosures: true, market: true};
const DIS = flag => JSON.stringify({error: 'This feature is turned off for now. Try again later.', disabled: true, flag});
const SECRET = 'PLAINTEXT-MARKER-AAPL-1234';

let failures = 0;
const check = (ok, name, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) failures++; };

const browser = await chromium.launch();
async function open(flags, extra = {}) {
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, serviceWorkers: 'block'});
  await ctx.addInitScript(() => { try { localStorage.setItem('pi.welcome.v1', '1'); } catch (e) {} });
  const page = await ctx.newPage();
  const st = {flags, renderHits: [], sbBodies: [], errors: []};
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/status of 503/.test(t) || /integrity/.test(t)) return; // deliberate 503 stubs, empty CDN stand-ins
    st.errors.push(t);
  });
  page.on('pageerror', e => st.errors.push('pageerror: ' + e.message));
  await page.route(u => !u.href.startsWith(BASE), async route => {
    const u = route.request().url();
    if (u.startsWith(RENDER)) { st.renderHits.push(u); return route.fulfill({status: 200, contentType: 'application/json', body: '{"from":"render"}'}); }
    if (u === API + '/api/flags') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({v: 1, updated: null, flags: st.flags})});
    if (extra[u.replace(API, '')]) { const [s, b] = extra[u.replace(API, '')]; return route.fulfill({status: s, contentType: 'application/json', body: b}); }
    if (u.startsWith(SB + '/rest/v1/synced_data')) {
      if (route.request().method() === 'POST') { st.sbBodies.push(route.request().postData() || ''); return route.fulfill({status: 201, body: ''}); }
      return route.fulfill({status: 200, contentType: 'application/json', body: '[]'});
    }
    if (/\.js(\?|$)/.test(u)) return route.fulfill({status: 200, contentType: 'application/javascript', body: ''});
    return route.fulfill({status: 200, contentType: 'application/json', body: '{}'});
  });
  await page.goto(BASE + '/index.html', {waitUntil: 'load'});
  await page.evaluate(() => flagsReady);
  return {ctx, page, st};
}

// 1. Banner
{
  const {ctx, page, st} = await open({...ALL_ON, ai: false, news: false});
  const vis = await page.isVisible('#flag-notice'), txt = (await page.textContent('#flag-notice')) || '';
  check(vis && txt.includes('The assistant is turned off for now.') && txt.includes('News is turned off for now.'), 'banner shows when ai and news are off', txt);
  check(!txt.includes('—'), 'banner has no em dash');
  check(await page.getAttribute('#flag-notice', 'role') === 'status', 'banner is a status region');
  st.flags = {...ALL_ON, maintenance: true};
  await page.evaluate(() => loadFlags());
  const m = await page.textContent('#flag-notice');
  check(m.startsWith('Portfolio Intel is in maintenance.') && !m.includes('assistant'), 'maintenance shows only the maintenance notice', m);
  st.flags = ALL_ON;
  await page.evaluate(() => loadFlags());
  check(await page.isHidden('#flag-notice'), 'banner hides when every flag is back on');
  check(st.errors.length === 0, 'no console errors (banner)', st.errors.join(' | ').slice(0, 200));
  await ctx.close();
}

// 2. Disabled answer never falls back to Render; a plain outage does
{
  const {ctx, page, st} = await open(ALL_ON, {'/api/all-trades': [503, DIS('disclosures')], '/api/top-rates': [503, '{"error":"upstream down"}']});
  st.renderHits = [];
  const r1 = await page.evaluate(async api => { try { await getJSON(api + '/api/all-trades'); return 'resolved'; } catch (e) { return {msg: e.message, disabled: e.disabled, flag: e.flag, status: e.status}; } }, API);
  check(r1.disabled === true && r1.flag === 'disclosures' && r1.status === 503 && r1.msg === 'This feature is turned off for now. Try again later.', 'disabled answer surfaces as disabled error', JSON.stringify(r1));
  check(!st.renderHits.some(u => u.includes('/api/all-trades')), 'disabled answer did not call Render', st.renderHits.join(','));
  const r2 = await page.evaluate(async api => { try { return await getJSON(api + '/api/top-rates'); } catch (e) { return {err: e.message}; } }, API);
  check(r2.from === 'render' && st.renderHits.some(u => u.endsWith('/api/top-rates')), 'plain 503 still falls back to Render', JSON.stringify(r2));
  check(st.errors.length === 0, 'no console errors (fallback)', st.errors.join(' | ').slice(0, 200));
  await ctx.close();
}

// 3. Sync paused then resumed, ciphertext only
{
  const {ctx, page, st} = await open({...ALL_ON, sync_writes: false});
  const setup = await page.evaluate(async secret => {
    localStorage.setItem('pi.sb.session', JSON.stringify({access_token: 't', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600}));
    localStorage.setItem(LOCK_KEY, JSON.stringify({...(lockConf() || {}), encSalt: 'c2FsdA==', sync: true}));
    VAULT.key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, true, ['encrypt', 'decrypt']);
    watchlist = [secret];
    await syncPush();
    return {held: syncHeld, on: flagOn('sync_writes')};
  }, SECRET);
  check(setup.held === true && setup.on === false && st.sbBodies.length === 0, 'sync_writes off: upload paused, nothing sent', JSON.stringify(setup));
  st.flags = ALL_ON;
  await page.evaluate(() => loadFlags());
  await page.waitForFunction(() => !syncHeld && !syncBusy, null, {timeout: 10000}).catch(() => {});
  for (let i = 0; i < 40 && !st.sbBodies.length; i++) await page.waitForTimeout(250);
  check(st.sbBodies.length === 1, 'sync_writes back on: upload resumed once', String(st.sbBodies.length));
  const body = st.sbBodies[0] || '';
  let payload = ''; try { payload = JSON.parse(body).payload; } catch (e) {}
  check(/^enc1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(payload), 'uploaded payload is enc1 ciphertext');
  check(!body.includes(SECRET) && !body.includes('"watch"'), 'no plaintext in the upload body');
  const stillLocal = await page.evaluate(async p => JSON.parse(await vaultDecrypt(p)).watch, payload).catch(() => null);
  check(Array.isArray(stillLocal) && stillLocal[0] === SECRET, 'ciphertext decrypts on device to the kept data');
  check(st.errors.length === 0, 'no console errors (sync)', st.errors.join(' | ').slice(0, 200));
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} flag journey checks failed` : 'all flag journey checks passed');
process.exit(failures ? 1 : 0);
