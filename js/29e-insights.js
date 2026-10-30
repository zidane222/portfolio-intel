// ─────────────────────────────────────────────
//  INSIGHTS (weekly data science and simulated strategy results)
// ─────────────────────────────────────────────
// Reads /api/insights and /api/insights/strategies from the gateway, falls back to the static
// /insights.json and /strategies.json. Contract: docs/plans/phase4-data-science-strategy.md.
// Every string from the files goes through esc(). Nothing here gives advice or places trades.
let insData = null, insStr = null, insTab = 'findings', insWin = 'full', insLoaded = false;
const INS_LABEL = 'Historical analysis of public disclosures. Not investment advice. Past results do not predict future results.';
const INS_SIM_LABEL = 'SIMULATED. Hypothetical backtests on past data. Not investment advice, not a recommendation, no trades are placed. Past results do not predict future results.';
const INS_STALE_MS = 10 * 864e5;
const INS_STATUS = {no_evidence: 'No evidence of an effect', unstable: 'Unstable across periods', insufficient_data: 'Not enough data', finding: 'Passed all tests'};
const INS_EVIDENCE = {ahead: 'Ahead of SPY over this period and in the hold-out period', behind: 'Behind SPY over this period and in the hold-out period', not_distinguishable: 'Not statistically distinguishable from SPY'};
const insNum = (v, d = 2) => typeof v === 'number' && isFinite(v) ? v.toFixed(d) : null;
const insPct = (v, d = 2) => { const s = insNum(v, d); return s == null ? '-' : s + '%'; };
const insPts = v => { const s = insNum(v, 2); return s == null ? '-' : (v > 0 ? '+' : '') + s + ' pts'; };
const insInt = v => typeof v === 'number' && isFinite(v) ? v.toLocaleString('en-US') : '-';
const insCI = a => Array.isArray(a) && a.length === 2 ? `${insPct(a[0])} to ${insPct(a[1])}` : '-';
const insDate = s => { const d = new Date(s); return s && !isNaN(d) ? d.toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'}) : '-'; };
const insAsof = s => s ? esc(insDate(s + 'T12:00:00')) : 'not available';
const insOk = (d, schema) => d && typeof d === 'object' && d.schema === schema;

async function insFetch(gw, file, schema) {
  const v = Math.floor(Date.now() / 3.6e6);
  try { const d = await getJSON(BACKEND_URL + gw, {timeout: 8000}); if (insOk(d, schema)) return d; } catch (e) {}
  try { const d = await getJSON('./' + file + '?v=' + v); if (insOk(d, schema)) return d; } catch (e) {}
  return null;
}
const insStale = d => d.stale === true || (d.stale == null && (!d.generated || Date.now() - new Date(d.generated).getTime() > INS_STALE_MS));
const insPlaceholder = d => !d.generated || new Date(d.generated).getFullYear() < 2000;

async function loadInsights() {
  [insData, insStr] = await Promise.all([insFetch('/api/insights', 'insights.json', 'pi/insights/v1'), insFetch('/api/insights/strategies', 'strategies.json', 'pi/strategies/v1')]);
  insLoaded = true;
  renderInsights();
}

function insCaveats(ids, all) {
  const map = {}; (all || []).forEach(c => { if (c && c.id) map[c.id] = c.text; });
  return (ids || []).map(id => `<span class="tag" title="${esc(map[id] || '')}">${esc(String(id).replace(/_/g, ' '))}</span>`).join('');
}
function insCaveatList(all) {
  if (!all || !all.length) return '';
  return `<details class="copy-how" style="color:var(--dark-3)"><summary style="color:var(--dark-2)">Caveats</summary>${all.map(c => `<p><strong>${esc(String(c.id || '').replace(/_/g, ' '))}.</strong> ${esc(c.text)}</p>`).join('')}</details>`;
}

// Line chart of growth of 100, strategy against SPY, with a text summary for screen readers
function insChart(run, bench) {
  const c = run.curve || {}, ds = c.dates || [], a = c.strategy || [], b = c.benchmark || [];
  const n = Math.min(ds.length, a.length, b.length);
  if (n < 2) return '<p class="fine">Not enough history to draw a chart.</p>';
  const W = 600, H = 200, P = 34, all = a.slice(0, n).concat(b.slice(0, n)).filter(v => typeof v === 'number');
  const lo = Math.min(...all), hi = Math.max(...all), sp = hi - lo || 1;
  const X = i => P + (W - P - 8) * i / (n - 1), Y = v => H - 22 - (H - 40) * (v - lo) / sp;
  const path = arr => arr.slice(0, n).map((v, i) => typeof v === 'number' ? (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1) : '').join('');
  const last = n - 1;
  const text = `Growth of 100 from ${insDate(ds[0] + 'T12:00:00')} to ${insDate(ds[last] + 'T12:00:00')}. Simulated strategy ends at ${insNum(a[last], 1)}. ${esc(bench)} ends at ${insNum(b[last], 1)}. Hypothetical, past results do not predict future results.`;
  return `<figure style="margin:8px 0 0"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(text)}" style="max-width:100%;height:auto">
    <line x1="${P}" y1="${H - 22}" x2="${W - 8}" y2="${H - 22}" stroke="#9AA8BC" stroke-width="1"/>
    <text x="4" y="${Y(hi) + 4}" font-size="11" fill="#5A6B85">${esc(insNum(hi, 0))}</text><text x="4" y="${Y(lo) + 4}" font-size="11" fill="#5A6B85">${esc(insNum(lo, 0))}</text>
    <text x="${P}" y="${H - 6}" font-size="11" fill="#5A6B85">${esc(ds[0])}</text><text x="${W - 8}" y="${H - 6}" font-size="11" fill="#5A6B85" text-anchor="end">${esc(ds[last])}</text>
    <path d="${path(b)}" fill="none" stroke="#7A8AA3" stroke-width="2" stroke-dasharray="5 4"/>
    <path d="${path(a)}" fill="none" stroke="#0A5FD0" stroke-width="2.5"/></svg>
    <figcaption class="fine"><span style="color:#0A5FD0">Solid line</span>: simulated strategy. <span>Dashed line</span>: ${esc(bench)}. Growth of 100, month end. ${esc(text)}</figcaption></figure>`;
}

function insHead(d, sim) {
  if (!d) return '';
  const stale = insStale(d) && !insPlaceholder(d);
  const asof = Object.entries(d.data_asof || {}).filter(([k]) => k !== 'news_verdicts').map(([k, v]) => `${esc(k)}: ${insAsof(v)}`).join(' · ');
  return `<p class="ins-label" style="font-weight:600;margin:0 0 6px">${sim ? '<span class="tag warn" style="margin:0 8px 0 0">Simulated</span>' : ''}${esc(d.label || (sim ? INS_SIM_LABEL : INS_LABEL))}</p>
    <p class="fine">${insPlaceholder(d) ? 'First weekly run pending.' : `Updated ${esc(insDate(d.generated))}`}${asof ? ' · Data as of ' + asof : ''}</p>
    ${stale ? '<p class="ins-stale" role="status" style="background:#FFF1D6;color:#8A4B00;border-radius:10px;padding:10px 12px;margin:8px 0;font-size:14px">This data is more than 10 days old. The weekly update may be delayed.</p>' : ''}`;
}

function insFindingCard(f, caveats) {
  const s = f.subject || {}, h = f.holdout || {};
  const kind = f.statistic === 'mean_difference' ? 'Difference in average return' : f.statistic === 'slope_span' ? 'Change in excess return, smallest to largest size range' : 'Average return above SPY';
  const place = f.placebo_pct != null ? `<div class="p">Placebo check: random picks reached ${esc(insPct(f.placebo_pct))} at the 95th percentile.</div>` : '';
  const na = f.not_achievable_trade_date_pct != null ? `<div class="p">Not achievable: measured from the trade date, the figure would be ${esc(insPct(f.not_achievable_trade_date_pct))}, but trades are only public after filing.</div>` : '';
  return `<article class="rate" aria-label="${esc(f.title)}"><div>
    <div class="n">${esc(f.title)} <span class="tag">${esc(f.family)}</span><span class="tag">Historical</span></div>
    <div class="p">${esc(f.summary)}</div>
    <div class="p"><strong>${esc(kind)}:</strong> ${esc(insPts(f.mean_excess_pct))} (95% interval ${esc(insCI(f.ci95_pct))}), ${esc(insPts(f.net_mean_excess_pct))} after assumed costs. ${esc(insInt(f.n_events))} events over ${esc(insInt(f.n_months))} months, ${esc(insInt(f.n_tickers))} tickers${f.horizon_days ? ', ' + esc(f.horizon_days) + '-day horizon' : ''}.</div>
    <div class="p">Hold-out period: ${esc(insPts(h.mean_excess_pct))} over ${esc(insInt(h.n_events))} events. The effect ${h.replicates ? 'also appeared' : 'did not appear'} in the hold-out period.</div>
    ${place}${na}
    <div class="p" style="margin-top:6px">${insCaveats(f.caveats, caveats)}</div></div></article>`;
}

function insFindings() {
  const d = insData;
  if (!d) return '<div class="empty">Insights are not available right now. Try again later.</div>';
  const t = d.tests_run || {}, n = (t.confirmatory || 0) + (t.exploratory || 0);
  let h = insHead(d, false);
  if (insPlaceholder(d)) h += '<div class="empty">First weekly run pending. Results appear here after the next Sunday run.</div>';
  else {
    h += '<h3 style="margin:18px 0 4px;font-size:18px">Findings</h3>';
    h += (d.findings || []).length ? (d.findings || []).map(f => insFindingCard(f, d.caveats)).join('')
      : `<div class="empty">No result passed all tests this week. ${esc(insInt(n))} ${n === 1 ? 'test was' : 'tests were'} run.</div>`;
  }
  const tested = d.tested || [], sc = d.scan_summary || {};
  h += `<details class="copy-how" style="color:var(--dark-3)"><summary style="color:var(--dark-2)">What was tested</summary>
    ${tested.length ? `<div style="overflow-x:auto"><table class="ins-table"><caption class="sr">Planned tests and their status</caption><thead><tr><th scope="col">Test</th><th scope="col">Status</th><th scope="col">Events</th><th scope="col">Mean vs SPY</th><th scope="col">95% interval</th></tr></thead><tbody>${tested.map(r => `<tr><th scope="row">${esc(r.id)}</th><td>${esc(INS_STATUS[r.status] || r.status)}</td><td>${esc(insInt(r.n_events))}</td><td>${esc(insPts(r.mean_excess_pct))}</td><td>${esc(insCI(r.ci95_pct))}</td></tr>`).join('')}</tbody></table></div>` : '<p>No test results yet.</p>'}
    <p>Members: ${esc(insInt((sc.members || {}).tested))} tested of ${esc(insInt((sc.members || {}).eligible))} eligible, ${esc(insInt((sc.members || {}).findings))} findings. Sectors: ${esc(insInt((sc.sectors || {}).tested))} tested of ${esc(insInt((sc.sectors || {}).eligible))} eligible, ${esc(insInt((sc.sectors || {}).findings))} findings. Counts only.</p></details>`;
  const ds = d.descriptive || {}, fb = ds.filing_delay_buckets || [], sb = ds.size_buckets || [];
  if (fb.length || sb.length) {
    const rows = (arr, key, lab) => arr.map(r => `<tr><th scope="row">${esc(r.bucket)}</th><td>${esc(insInt(r.n))}</td><td>${esc(insPts(r[key]))}</td></tr>`).join('');
    h += `<details class="copy-how" style="color:var(--dark-3)"><summary style="color:var(--dark-2)">Filing delay and trade size (descriptive only)</summary>
      <p>These tables describe the data. They are not tests. A dash means fewer than 100 events.</p>
      ${fb.length ? `<table class="ins-table"><caption>Filing delay</caption><thead><tr><th scope="col">Delay</th><th scope="col">Events</th><th scope="col">Trade to filing vs SPY</th></tr></thead><tbody>${rows(fb, 'trade_to_filing_excess_pct')}</tbody></table>` : ''}
      ${sb.length ? `<table class="ins-table"><caption>Disclosed size range</caption><thead><tr><th scope="col">Size</th><th scope="col">Events</th><th scope="col">90-day mean vs SPY</th></tr></thead><tbody>${rows(sb, 'mean_excess_pct_90d')}</tbody></table>` : ''}</details>`;
  }
  const ns = d.news_stance;
  if (ns && ns.needed) {
    const p = Math.max(0, Math.min(100, Math.round(100 * (ns.scored || 0) / ns.needed)));
    h += `<div style="margin-top:14px"><div class="n" style="font-weight:600">News stance</div>
      <div class="p fine">${ns.status === 'gated' ? 'Not analysed yet. The test opens after enough scored news reads.' : 'The gate is open. The analysis has not run yet.'}</div>
      <progress max="${esc(ns.needed)}" value="${esc(Math.min(ns.scored || 0, ns.needed))}" aria-label="News reads scored toward the gate" style="width:100%;height:12px"></progress>
      <div class="fine">${esc(insInt(ns.scored))} of ${esc(insInt(ns.needed))} reads scored (${p}%), ${esc(insInt(ns.distinct_days))} of ${esc(insInt(ns.days_needed))} days.</div></div>`;
  }
  const c = d.coverage || {};
  h += `<p class="fine" style="margin-top:12px">Coverage: ${esc(insInt(c.events_used))} of ${esc(insInt(c.trades_total))} disclosed trades used, ${esc(insInt(c.tickers_priced))} tickers priced.</p>` + insCaveatList(d.caveats);
  return h;
}

function insStrategies() {
  const d = insStr;
  if (!d) return `<p class="ins-label" style="font-weight:600"><span class="tag warn" style="margin:0 8px 0 0">Simulated</span>${esc(INS_SIM_LABEL)}</p><div class="empty">Strategy results are not available right now. Try again later.</div>`;
  const runs = d.runs || [], bench = d.benchmark || 'SPY', w = insWin;
  let h = insHead(d, true);
  if (insPlaceholder(d) || !runs.length) return h + '<div class="empty">First weekly run pending. Simulated results appear here after the next Sunday run.</div>';
  const a = d.assumptions || {}, cs = a.cost_bps_per_side || {};
  h += `<div class="seg seg-light" id="ins-win" role="group" aria-label="Time window" style="margin:10px 0"><button type="button" data-w="full" aria-pressed="${w === 'full'}">Full period</button><button type="button" data-w="common" aria-pressed="${w === 'common'}">Common window${a.common_window_start ? ' from ' + esc(a.common_window_start) : ''}</button></div>`;
  h += `<div style="overflow-x:auto"><table class="ins-table"><caption class="sr">Simulated strategies against ${esc(bench)}, ${w === 'full' ? 'full period' : 'common window'}</caption><thead><tr><th scope="col">Strategy</th><th scope="col">Period</th><th scope="col">CAGR</th><th scope="col">Volatility</th><th scope="col">Max drawdown</th><th scope="col">Sharpe</th><th scope="col">vs ${esc(bench)} (CAGR)</th><th scope="col">Evidence</th></tr></thead><tbody>`;
  h += runs.map(r => {
    const m = (r.metrics || {})[w] || {}, rel = r.relative || {};
    return `<tr><th scope="row">${esc(r.name)} <span class="tag warn">Simulated</span></th><td>${esc((r.period || {}).start)} to ${esc((r.period || {}).end)}</td><td>${esc(insPct(m.cagr_pct))}</td><td>${esc(insPct(m.vol_pct))}</td><td>${esc(insPct(m.max_dd_pct))}</td><td>${esc(insNum(m.sharpe) ?? '-')}</td><td>${esc(insPts(rel.excess_cagr_pct))}</td><td>${esc(INS_EVIDENCE[r.evidence] || r.evidence || '-')}</td></tr>`;
  }).join('') + '</tbody></table></div>';
  h += runs.map(r => {
    const bm = ((r.benchmark_metrics || {})[w]) || {}, rel = r.relative || {}, sn = r.sensitivity || {}, ho = r.holdout, ref = r.reference_in_sample;
    return `<details class="copy-how" style="color:var(--dark-3)"><summary style="color:var(--dark-2)">${esc(r.name)}: details and chart</summary>
      <p><span class="tag warn" style="margin-left:0">Simulated</span> ${esc(r.description)}</p>
      <p>${esc(bench)} over the same window: CAGR ${esc(insPct(bm.cagr_pct))}, volatility ${esc(insPct(bm.vol_pct))}, max drawdown ${esc(insPct(bm.max_dd_pct))}. Excess CAGR 95% interval ${esc(insCI(rel.excess_cagr_ci95_pct))}. Beta ${esc(insNum(rel.beta) ?? '-')}.</p>
      <p>With costs doubled: CAGR ${esc(insPct(sn.cost_x2_cagr_pct))}.${sn.trade_date_hypothetical_cagr_pct != null ? ` Not achievable, measured from trade dates: ${esc(insPct(sn.trade_date_hypothetical_cagr_pct))}.` : ''}${ho ? ` Hold-out from ${esc(ho.start)}: excess CAGR ${esc(insPts(ho.excess_cagr_pct))}, ${ho.same_sign ? 'same direction' : 'opposite direction'}.` : ''}</p>
      ${ref ? `<p>Reference, not evidence: ${esc(insPct(ref.cagr_pct))} CAGR. ${esc(ref.label)}</p>` : ''}
      <p class="fine">${Object.entries(r.params || {}).map(([k, v]) => esc(k.replace(/_/g, ' ')) + ': ' + esc(v)).join(' · ')}</p>
      ${insChart(r, bench)}<p>${insCaveats(r.caveats, d.caveats)}</p></details>`;
  }).join('');
  h += `<div class="card-l" style="margin-top:14px;padding:16px"><div class="n" style="font-weight:600">Assumptions</div><ul class="fine" style="margin:6px 0 0 18px">
    <li>Entry: ${esc(a.entry)}</li><li>Costs per side: stocks ${esc(cs.stock)} bps, ETFs ${esc(cs.etf)} bps</li><li>Cash: ${esc(a.cash_return)}</li><li>Taxes: ${esc(a.taxes)}</li><li>Prices: ${esc(a.price_basis)}</li><li>Filing delay: ${esc(a.filing_delay)}</li><li>${esc(insInt(d.strategies_tried))} strategies were tried and all are shown.</li></ul></div>` + insCaveatList(d.caveats);
  return h;
}

function renderInsights() {
  const box = $('ins-body'); if (!box) return;
  $('ins-tabs').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.t === insTab)));
  if (!insLoaded) { box.innerHTML = '<div class="empty">Loading…</div>'; return; }
  box.innerHTML = insTab === 'findings' ? insFindings() : insStrategies();
  box.querySelectorAll('#ins-win button').forEach(b => b.onclick = () => { insWin = b.dataset.w; renderInsights(); const nb = $('ins-body').querySelector(`#ins-win button[data-w="${insWin}"]`); if (nb) nb.focus(); });
  $('ins-status').textContent = insTab === 'findings' ? 'Showing findings.' : 'Showing simulated strategies.';
}

function wireInsights() {
  if (!$('ins-body')) return;
  $('ins-tabs').innerHTML = '<button type="button" data-t="findings" aria-pressed="true">Findings</button><button type="button" data-t="strategies" aria-pressed="false">Strategies (simulated)</button>';
  $('ins-tabs').querySelectorAll('button').forEach(b => b.onclick = () => { insTab = b.dataset.t; renderInsights(); });
  renderInsights();
  loadInsights();
}
