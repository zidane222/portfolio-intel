// Insights journey (Phase 4): headless Chromium. Gateway and every off-origin call are stubbed.
// Run from the repo root:
//   python3 -m http.server 8767 &
//   node tests/journeys/insights.mjs        (BASE=http://localhost:8767 to override)
// Covers: nav entry, #insights deep link, placeholder state from the real repo files, stubbed data,
// gateway 503 falling back to static files, both sources down, tab and window toggles, 375px,
// keyboard only, Simulated labels, no dashes, no console errors, and Private/Risk/Ask still working.
import {execSync} from 'node:child_process';
const pw = await import(execSync('npm root -g').toString().trim() + '/playwright/index.mjs');
const {chromium} = pw.default || pw;
const BASE = process.env.BASE || 'http://localhost:8767';
const API = 'https://portfolio-intel-api.viphashkahn.workers.dev';
let failures = 0;
const check = (ok, name, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' :: ' + String(info).slice(0, 160) : ''}`); if (!ok) failures++; };

const SIM = 'SIMULATED. Hypothetical backtests on past data. Not investment advice, not a recommendation, no trades are placed. Past results do not predict future results.';
const now = new Date().toISOString();
const dates = Array.from({length: 24}, (_, i) => `2024-${String(i % 12 + 1).padStart(2, '0')}-28`.replace(/^2024/, i < 12 ? '2024' : '2025'));
const INS = {schema: 'pi/insights/v1', method_version: 'ds-1', generated: now, data_asof: {trades: '2026-10-25', prices: '2026-10-28', news_verdicts: null},
  label: 'Historical analysis of public disclosures. Not investment advice. Past results do not predict future results.',
  coverage: {trades_total: 30000, events_used: 21000, tickers_priced: 900, dropped: {}}, tests_run: {confirmatory: 12, exploratory: 40},
  findings: [{id: 'a1', title: 'Senate purchases, 90 days', family: 'confirmatory', summary: 'Purchases filed by Senators did better than SPY.', statistic: 'mean_excess', horizon_days: 90,
    mean_excess_pct: 1.9, ci95_pct: [0.4, 3.4], net_mean_excess_pct: 1.4, n_events: 4000, n_months: 40, n_tickers: 300, holdout: {mean_excess_pct: 1.1, n_events: 900, replicates: true},
    placebo_pct: 0.8, not_achievable_trade_date_pct: 4.2, caveats: ['survivorship', 'costs']}],
  tested: [{id: 'A1 Senate 30d', status: 'no_evidence', n_events: 3000, mean_excess_pct: 0.2, ci95_pct: [-0.5, 0.9]}, {id: 'A4 member X', status: 'unstable', n_events: 50, mean_excess_pct: 3, ci95_pct: [-1, 7]}],
  scan_summary: {members: {eligible: 80, tested: 80, findings: 0}, sectors: {eligible: 11, tested: 11, findings: 0}},
  descriptive: {filing_delay_buckets: [{bucket: '0-15 days', n: 500, trade_to_filing_excess_pct: 0.3}], size_buckets: [{bucket: 'Up to $15K', n: 900, mean_excess_pct_90d: 0.1}]},
  news_stance: {status: 'gated', scored: 57, needed: 200, distinct_days: 9, days_needed: 40},
  caveats: [{id: 'survivorship', text: 'Delisted names may be missing.'}, {id: 'costs', text: 'Costs are assumptions.'}]};
const mk = (name, n) => ({id: n, name, description: 'Rule based test of ' + name + '.', period: {start: '2021-01-01', end: '2026-09-30'},
  metrics: {full: {cagr_pct: 11.2, vol_pct: 16.1, max_dd_pct: -22.4, sharpe: 0.62}, common: {cagr_pct: 9.8, vol_pct: 15.0, max_dd_pct: -18.0, sharpe: 0.55}},
  benchmark_metrics: {full: {cagr_pct: 12.1, vol_pct: 17, max_dd_pct: -24, sharpe: 0.7}, common: {cagr_pct: 10.5, vol_pct: 16, max_dd_pct: -20, sharpe: 0.6}},
  relative: {excess_cagr_pct: -0.9, excess_cagr_ci95_pct: [-3, 1.2], beta: 0.9}, evidence: 'not_distinguishable', sensitivity: {cost_x2_cagr_pct: 10.7}, params: {top_n: 10},
  curve: {dates, strategy: dates.map((_, i) => 100 + i * 2), benchmark: dates.map((_, i) => 100 + i * 2.2)}, caveats: ['costs']});
const STR = {schema: 'pi/strategies/v1', method_version: 'st-1', generated: now, data_asof: {prices: '2026-10-28', trades: '2026-10-25'}, label: SIM, benchmark: 'SPY',
  assumptions: {entry: 'next close after signal', cost_bps_per_side: {stock: 25, etf: 5}, cash_return: '0 unless SHV held', taxes: 'none', price_basis: 'close', filing_delay: 'after filing', common_window_start: '2022-01-03'},
  strategies_tried: 2, runs: [mk('Copy all purchases', 's1'), mk('Sector momentum', 's3')], caveats: [{id: 'costs', text: 'Costs are assumptions.'}]};

// mode per source: 'ok' | '503' | 'static' (gateway 503, static stub) | 'real' (gateway 503, real repo files)
async function open(viewport, mode, hash = '#insights') {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport, serviceWorkers: 'block'});
  await ctx.addInitScript(() => { try { localStorage.setItem('pi.welcome.v1', '1'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = [], hits = {gw: 0, st: 0};
  // Failed network responses we caused on purpose log "Failed to load resource" with a 503 or 404 status.
  page.on('console', m => { if (m.type() === 'error' && !/status of 50[0-9]|status of 404/.test(m.text()) && !/integrity/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  const j = (route, o) => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(o)});
  await page.route(u => u.pathname.startsWith('/insights.json') || u.pathname.startsWith('/strategies.json'), route => {
    hits.st++;
    const isI = route.request().url().includes('/insights.json');
    if (mode === 'static') return j(route, isI ? INS : STR);
    if (mode === '503') return route.fulfill({status: 503, body: 'down'});
    return route.continue();
  });
  await page.route(u => !u.href.startsWith(BASE), route => {
    const u = route.request().url();
    if (u.startsWith(API + '/api/insights')) {
      hits.gw++;
      if (mode === 'ok') return j(route, u.endsWith('/strategies') ? STR : INS);
      return route.fulfill({status: 503, contentType: 'application/json', body: '{"error":"down"}'});
    }
    if (/\.js(\?|$)/.test(u)) return route.fulfill({status: 200, contentType: 'application/javascript', body: ''});
    return route.fulfill({status: 200, contentType: 'application/json', body: '{}'});
  });
  await page.goto(BASE + '/index.html' + hash, {waitUntil: 'load'});
  return {browser, page, errors, hits};
}
const body = p => p.textContent('#ins-body');
const noOverflow = p => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const dashes = p => p.evaluate(() => /[—–]/.test(document.getElementById('insights').innerText));

// 1. Placeholder state from the real repo files, gateway down
{
  const {browser, page, errors, hits} = await open({width: 1100, height: 900}, 'real');
  await page.waitForFunction(() => /First weekly run pending/.test(document.getElementById('ins-body').textContent), null, {timeout: 10000});
  check(await page.isVisible('#insights'), 'deep link #insights shows the Insights page');
  check(await page.locator('#navlinks a[data-page="insights"]').count() === 1 && /Insights/.test(await page.textContent('#navlinks a[data-page="insights"]')), 'nav has an Insights entry');
  check(hits.gw >= 2 && hits.st >= 2, 'gateway tried first, static files used after 503', JSON.stringify(hits));
  check(/First weekly run pending/.test(await body(page)) && /Historical analysis of public disclosures/.test(await body(page)), 'placeholder: pending note and label');
  await page.click('#ins-tabs button[data-t="strategies"]');
  const t = await body(page);
  check(/Simulated/.test(t) && /First weekly run pending/.test(t), 'placeholder strategies tab: Simulated label and pending note');
  check(!(await dashes(page)), 'placeholder: no em or en dash');
  check(errors.length === 0, 'placeholder: no console errors', errors.join(' | '));
  await browser.close();
}

// 2. Stubbed data through the gateway, desktop
{
  const {browser, page, errors, hits} = await open({width: 1100, height: 900}, 'ok');
  await page.waitForSelector('#ins-body article.rate', {timeout: 10000});
  const t = await body(page);
  check(hits.st === 0, 'gateway ok: static files not requested', JSON.stringify(hits));
  check(/Senate purchases, 90 days/.test(t) && /\+1\.90 pts/.test(t) && /also appeared/.test(t), 'finding card shows numbers and hold-out');
  check(/Placebo check/.test(t) && /Not achievable/.test(t), 'finding card shows placebo and not-achievable notes');
  check(/57 of 200/.test(t), 'news stance progress shown', '57 of 200');
  check(/No evidence of an effect/.test(t) && /Unstable across periods/.test(t), 'tested table rendered with status labels');
  check((await page.locator('#ins-body details').first().textContent()).includes('What was tested'), 'What was tested disclosure present');
  check(await page.getAttribute('#ins-tabs button[data-t="findings"]', 'aria-pressed') === 'true', 'findings tab selected by default');
  await page.click('#ins-tabs button[data-t="strategies"]');
  check(await page.getAttribute('#ins-tabs button[data-t="strategies"]', 'aria-pressed') === 'true' && await page.getAttribute('#ins-tabs button[data-t="findings"]', 'aria-pressed') === 'false', 'tab switch updates aria-pressed');
  const s = await body(page);
  check(s.includes(SIM), 'strategies: full SIMULATED label shown');
  check(await page.locator('#ins-body tbody tr th .tag.warn').count() === 2, 'strategies: Simulated tag on every row');
  check(/11\.20%/.test(s) && /Full period/.test(s), 'strategies: full-period metrics');
  check(await page.locator('#ins-body svg[role="img"]').count() === 2 && /Hypothetical/.test(await page.getAttribute('#ins-body svg', 'aria-label')), 'charts have text alternative with hypothetical wording');
  await page.click('#ins-win button[data-w="common"]');
  const c = await body(page);
  check(/9\.80%/.test(c) && !/11\.20%/.test(c.split('details')[0]) , 'window toggle switches to common window metrics');
  check(await page.getAttribute('#ins-win button[data-w="common"]', 'aria-pressed') === 'true', 'window toggle aria-pressed');
  check(c.includes(SIM) && await page.locator('#ins-body tbody tr th .tag.warn').count() === 2, 'Simulated labels still present after toggle');
  await page.click('#ins-tabs button[data-t="findings"]');
  check(/Senate purchases/.test(await body(page)), 'back to findings tab');
  check(!(await dashes(page)), 'no em or en dash');
  check(errors.length === 0, 'no console errors', errors.join(' | '));
  await browser.close();
}

// 3. Gateway 503, static stubs serve the data
{
  const {browser, page, errors, hits} = await open({width: 1100, height: 900}, 'static');
  await page.waitForSelector('#ins-body article.rate', {timeout: 10000});
  check(hits.gw >= 2 && hits.st >= 2, '503 fallback: static files used', JSON.stringify(hits));
  await page.click('#ins-tabs button[data-t="strategies"]');
  check((await body(page)).includes(SIM), '503 fallback: strategies render with SIMULATED label');
  check(errors.length === 0, '503 fallback: no console errors', errors.join(' | '));
  await browser.close();
}

// 4. Everything down
{
  const {browser, page, errors} = await open({width: 1100, height: 900}, '503');
  await page.waitForFunction(() => /not available right now/.test(document.getElementById('ins-body').textContent), null, {timeout: 15000});
  check(true, 'both sources down: friendly message on findings');
  await page.click('#ins-tabs button[data-t="strategies"]');
  const t = await body(page);
  check(/not available right now/.test(t) && t.includes(SIM) && /Simulated/.test(t), 'both sources down: strategies keep SIMULATED label');
  check(errors.length === 0, 'both sources down: no console errors', errors.join(' | '));
  await browser.close();
}

// 5. 375px
{
  const {browser, page, errors} = await open({width: 375, height: 800}, 'ok');
  await page.waitForSelector('#ins-body article.rate', {timeout: 10000});
  check(await noOverflow(page), '375px: no page-level horizontal scroll (findings)');
  await page.click('#ins-tabs button[data-t="strategies"]');
  check(await noOverflow(page), '375px: no page-level horizontal scroll (strategies)');
  const small = await page.evaluate(() => [...document.querySelectorAll('#ins-tabs button, #ins-win button')].filter(b => b.getBoundingClientRect().height < 40).length);
  check(small === 0, '375px: toggle buttons at least 40px tall', 'small=' + small);
  check((await body(page)).includes(SIM), '375px: SIMULATED label present');
  await page.click('#ins-win button[data-w="common"]');
  check(await noOverflow(page), '375px: no horizontal scroll after window toggle');
  check(errors.length === 0, '375px: no console errors', errors.join(' | '));
  await browser.close();
}

// 6. Keyboard only
{
  const {browser, page, errors} = await open({width: 1100, height: 900}, 'ok');
  await page.waitForSelector('#ins-body article.rate', {timeout: 10000});
  await page.focus('#ins-tabs button[data-t="findings"]');
  await page.keyboard.press('Tab');
  check(await page.evaluate(() => document.activeElement.dataset.t) === 'strategies', 'keyboard: Tab reaches Strategies tab');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#ins-win');
  check((await body(page)).includes(SIM), 'keyboard: Enter opens Strategies');
  await page.focus('#ins-win button[data-w="full"]');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#ins-win button[data-w="common"]').getAttribute('aria-pressed') === 'true');
  check(await page.evaluate(() => document.activeElement.dataset.w) === 'common', 'keyboard: Space toggles window and focus stays on the toggle');
  await page.focus('#ins-body details summary');
  await page.keyboard.press('Enter');
  check(await page.evaluate(() => document.activeElement.closest('details').open), 'keyboard: Enter opens a details block');
  const ring = await page.evaluate(() => { document.querySelector('#ins-tabs button').focus(); const s = getComputedStyle(document.activeElement); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2; });
  check(ring, 'keyboard: visible focus ring');
  check(await page.evaluate(() => document.getElementById('ins-status').textContent.length > 0), 'status region announces the view');
  check(errors.length === 0, 'keyboard: no console errors', errors.join(' | '));
  await browser.close();
}

// 7. Other pages still work, and navigation between pages
{
  const {browser, page, errors} = await open({width: 1100, height: 900}, 'ok', '#private');
  await page.waitForFunction(() => document.querySelectorAll('#pm-list .rate').length > 0, null, {timeout: 15000});
  check(true, 'Private markets page loads');
  await page.click('#navlinks a[data-page="risk"]');
  await page.waitForTimeout(300);
  check(await page.isVisible('#risk') && !(await page.isVisible('#insights')), 'Risk page opens, Insights hidden');
  await page.click('#navlinks a[data-page="insights"]');
  await page.waitForSelector('#ins-body article.rate');
  check(await page.isVisible('#insights') && !(await page.isVisible('#risk')), 'nav click opens Insights');
  await page.goto(BASE + '/index.html#ask', {waitUntil: 'load'});
  await page.waitForSelector('#ask-q', {state: 'visible'});
  check(true, 'Ask page loads');
  check(errors.length === 0, 'other pages: no console errors', errors.join(' | '));
  await browser.close();
}

console.log(failures ? `\n${failures} insights journey check(s) FAILED` : '\nAll insights journey checks passed');
process.exit(failures ? 1 : 0);
