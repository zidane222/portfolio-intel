// Flags UI journey at 375px: notice banner layout with the sticky nav, and the pi-flags admin page.
//
// How to run (from the repo root):
//   python3 -m http.server 8765 &
//   BASE=http://localhost:8765 node tests/journeys/flags-ui.mjs
//
// Part A: banner on a 375px phone. Banner sits above the nav, never overlaps it at the top, while
// scrolling, or after tapping a nav link. No horizontal scroll. No console errors.
// Part B: admin page (served from worker/src/services/flags-page.js on a stub origin, backend stubbed).
// Empty or short reason blocks the toggle and sends nothing. Valid reason saves. 409 shows the conflict
// message and reloads. HTML answer (expired Access session) shows the session ended message. Audit
// failure shows its message. Focus returns to the tapped toggle after a save.
import {execSync} from 'node:child_process';
import {PAGE, STYLE, SCRIPT} from '../../worker/src/services/flags-page.js';
const pw = await import(execSync('npm root -g').toString().trim() + '/playwright/index.mjs');
const {chromium} = pw.default || pw;

const BASE = process.env.BASE || 'http://localhost:8765';
const API = 'https://portfolio-intel-api.viphashkahn.workers.dev';
const ADMIN = 'https://pi-flags.test';
const ALL_ON = {maintenance: false, broker: true, sync_writes: true, ai: true, news: true, disclosures: true, market: true};

let failures = 0;
const check = (ok, name, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + info : ''}`); if (!ok) failures++; };
const overlap = (a, b) => a && b && a.width > 0 && a.height > 0 && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const browser = await chromium.launch();
const VIEW = {viewport: {width: 375, height: 812}, serviceWorkers: 'block', hasTouch: true, isMobile: true};

// Part A: banner and nav
{
  const ctx = await browser.newContext(VIEW);
  await ctx.addInitScript(() => { try { localStorage.setItem('pi.welcome.v1', '1'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/status of 503|integrity/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.route(u => !u.href.startsWith(BASE), route => {
    const u = route.request().url();
    if (u === API + '/api/flags') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({v: 1, updated: null, flags: {...ALL_ON, ai: false, news: false, disclosures: false}})});
    if (/\.js(\?|$)/.test(u)) return route.fulfill({status: 200, contentType: 'application/javascript', body: ''});
    return route.fulfill({status: 200, contentType: 'application/json', body: '{}'});
  });
  await page.goto(BASE + '/index.html', {waitUntil: 'load'});
  await page.evaluate(() => flagsReady);
  const rects = () => page.evaluate(() => {
    const r = e => { const b = e.getBoundingClientRect(); return {x: b.x, y: b.y, width: b.width, height: b.height}; };
    const n = document.getElementById('flag-notice');
    return {notice: n.hidden ? null : r(n), nav: r(document.querySelector('nav.top')), sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth};
  });
  let r = await rects();
  check(!!r.notice, 'A1 banner visible at 375px with three flags off');
  check(r.notice && r.notice.y <= 0.5 && r.notice.y + r.notice.height <= r.nav.y + 0.5, 'A2 banner sits above the nav at the top', JSON.stringify(r));
  check(!overlap(r.notice, r.nav), 'A3 no overlap at the top');
  check(r.sw <= r.cw, 'A4 no horizontal scroll at 375px', `${r.sw} vs ${r.cw}`);
  const bad = [];
  for (const y of [40, 120, 400, 1500, 4000]) {
    await page.evaluate(y => window.scrollTo(0, y), y); await page.waitForTimeout(80);
    r = await rects();
    if (overlap(r.notice, r.nav) || r.nav.y < -0.5) bad.push(`y=${y} ${JSON.stringify(r)}`);
  }
  check(!bad.length, 'A5 scrolling: banner never overlaps nav and nav stays on screen', bad.join(' | ').slice(0, 300));
  await page.evaluate(() => window.scrollTo(0, 0));
  const link = page.locator('#navlinks a[href="#news"]');
  if (await link.isVisible()) { await link.click(); } else { await page.evaluate(() => { location.hash = '#news'; }); }
  await page.waitForTimeout(300);
  r = await rects();
  check(!overlap(r.notice, r.nav), 'A6 after nav jump to News: no overlap', JSON.stringify(r));
  const txt = await page.textContent('#flag-notice');
  check(!txt.includes('—'), 'A7 banner has no em dash');
  check(errors.length === 0, 'A8 no console errors', errors.join(' | ').slice(0, 200));
  await ctx.close();
}

// Part B: admin page
function adminDoc(v, flags) {
  const out = {};
  for (const [n, on] of Object.entries(flags)) out[n] = {on, label: n + ' label', at: null, reason: null};
  return {v, flags: out};
}
async function admin(opts = {}) {
  const ctx = await browser.newContext(VIEW);
  const page = await ctx.newPage();
  const st = {v: 3, flags: {...ALL_ON}, posts: [], errors: [], post: opts.post, audit: opts.audit};
  page.on('console', m => { if (m.type() === 'error' && !/status of (409|500|502)/.test(m.text())) st.errors.push(m.text()); });
  page.on('pageerror', e => st.errors.push('pageerror: ' + e.message));
  await page.route(u => true, async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== ADMIN) return route.abort();
    const j = (s, b) => route.fulfill({status: s, contentType: 'application/json', body: JSON.stringify(b)});
    if (url.pathname === '/admin') return route.fulfill({status: 200, contentType: 'text/html; charset=utf-8', body: PAGE});
    if (url.pathname === '/admin/app.js') return route.fulfill({status: 200, contentType: 'text/javascript', body: SCRIPT});
    if (url.pathname === '/admin/app.css') return route.fulfill({status: 200, contentType: 'text/css', body: STYLE});
    if (url.pathname === '/admin/audit') {
      if (st.audit === 'fail') return j(500, {error: 'x'});
      return j(200, {audit: [{at: '2026-11-07T10:00:00Z', name: 'ai', on: true, by: 'owner', reason: 'seed'}]});
    }
    if (url.pathname === '/admin/flags' && req.method() === 'GET') return j(200, adminDoc(st.v, st.flags));
    if (url.pathname === '/admin/flags' && req.method() === 'POST') {
      const b = JSON.parse(req.postData() || '{}'); st.posts.push({b, h: req.headers()});
      if (st.post === '409') { st.v = 4; return j(409, {error: 'Someone else changed the flags. The page has reloaded, try again.'}); }
      if (st.post === 'html') return route.fulfill({status: 200, contentType: 'text/html', body: '<html>Sign in</html>'});
      st.flags[b.name] = b.on; st.v++;
      return j(200, adminDoc(st.v, st.flags));
    }
    return j(404, {error: 'not found'});
  });
  await page.goto(ADMIN + '/admin', {waitUntil: 'load'});
  await page.waitForSelector('#flags button[data-flag="ai"]');
  return {ctx, page, st};
}
const status = page => page.textContent('#status');

{ // reason validation, valid save, focus
  const {ctx, page, st} = await admin();
  const sw = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  check(sw[0] <= sw[1], 'B1 admin page has no horizontal scroll at 375px', sw.join(' vs '));
  const box = await page.locator('#flags button[data-flag="ai"]').boundingBox();
  check(box && box.height >= 44 && box.width >= 44, 'B2 toggle tap target at least 44px', JSON.stringify(box));
  await page.tap('#flags button[data-flag="ai"]');
  check(st.posts.length === 0 && /Type a reason first/.test(await status(page)), 'B3 empty reason blocks the toggle', await status(page));
  check(await page.getAttribute('#reason', 'aria-invalid') === 'true', 'B4 reason marked invalid');
  await page.fill('#reason', '  ab ');
  await page.tap('#flags button[data-flag="ai"]');
  check(st.posts.length === 0, 'B5 short reason (2 chars after trim) blocks the toggle');
  await page.fill('#reason', 'Groq outage test');
  await page.tap('#flags button[data-flag="ai"]');
  await page.waitForFunction(() => /is now/.test(document.getElementById('status').textContent));
  const p = st.posts[0];
  check(st.posts.length === 1 && p.b.name === 'ai' && p.b.on === false && p.b.reason === 'Groq outage test' && p.b.v === 3 && p.h['x-pi-flags'] === '1', 'B6 valid reason saves with name, on, reason, v and X-PI-Flags', JSON.stringify(p && p.b));
  check(await status(page) === 'ai is now off.', 'B7 saved message', await status(page));
  check(await page.getAttribute('#flags button[data-flag="ai"]', 'aria-pressed') === 'false', 'B8 toggle shows off');
  check(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-flag')) === 'ai', 'B9 focus returns to the tapped toggle');
  check(await page.inputValue('#reason') === '', 'B10 reason cleared after save');
  check(st.errors.length === 0, 'B11 no console errors (admin save)', st.errors.join(' | '));
  await ctx.close();
}
{ // 409
  const {ctx, page, st} = await admin({post: '409'});
  await page.fill('#reason', 'conflict test');
  await page.tap('#flags button[data-flag="news"]');
  await page.waitForFunction(() => /Someone else/.test(document.getElementById('status').textContent));
  check(true, 'B12 409 shows the conflict message', await status(page));
  await page.waitForTimeout(200);
  check(await page.getAttribute('#flags button[data-flag="news"]', 'aria-pressed') === 'true' && !(await page.isDisabled('#flags button[data-flag="news"]')), 'B13 after 409 the page reloads and the toggle is usable');
  check(!(await status(page)).includes('—'), 'B14 no em dash in conflict message');
  await ctx.close();
}
{ // HTML answer
  const {ctx, page} = await admin({post: 'html'});
  await page.fill('#reason', 'session test');
  await page.tap('#flags button[data-flag="market"]');
  await page.waitForFunction(() => /session ended/.test(document.getElementById('status').textContent));
  check(await status(page) === 'Your session ended. Reload the page to sign in again.', 'B15 HTML answer shows the session ended message', await status(page));
  check(!(await page.isDisabled('#flags button[data-flag="market"]')), 'B16 toggle re-enabled after session ended');
  await ctx.close();
}
{ // audit failure
  const {ctx, page} = await admin({audit: 'fail'});
  await page.waitForFunction(() => /Could not load recent changes/.test(document.getElementById('audit').textContent));
  check(true, 'B17 audit load failure shows its message', await page.textContent('#audit'));
  check(await page.isVisible('#flags button[data-flag="ai"]'), 'B18 flags still usable when audit fails');
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} failed` : 'all flags-ui checks passed');
process.exit(failures ? 1 : 0);
