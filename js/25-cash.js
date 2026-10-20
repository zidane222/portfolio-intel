// ─────────────────────────────────────────────
//  CASH & YIELD
// ─────────────────────────────────────────────
let rates = null, yields = null, topRates = null, divData = {}, cashTab = 'all';
const cashKey = 'pi.cash.v1';
function cashInputs() {
  let saved = {};
  try { saved = JSON.parse(vget(cashKey)) || {}; } catch (e) {}
  const mm = myPortfolio.filter(h => h.isCash).reduce((s, h) => s + (h.marketValue || 0), 0);
  const cashRows = myPortfolio.filter(h => h.isCash && h.apy);
  const wApy = cashRows.length ? cashRows.reduce((s, h) => s + h.apy * (h.marketValue || 0), 0) / Math.max(1, cashRows.reduce((s, h) => s + (h.marketValue || 0), 0)) : undefined;
  return {bal: saved.bal !== undefined ? saved.bal : (mm || 10000), apy: saved.apy !== undefined ? saved.apy : (wApy !== undefined ? +wApy.toFixed(2) : undefined), fromPortfolio: !saved.bal && mm > 0};
}
function mmEstimate(f) {
  const bill3 = yields && yields.curve && yields.curve['3 Mo'];
  if (!bill3) return null;
  return Math.max(0, bill3 - (f.expense === null || f.expense === undefined ? 0.2 : f.expense));
}
function cashOptions() {
  if (!rates) return [];
  const o = [];
  const norm = n => String(n || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 10);
  const seen = new Set();
  // Today's published top rates first, then researched rates for anyone the article doesn't cover
  if (topRates && topRates.rates) topRates.rates.forEach(r => {
    seen.add(norm(r.institution));
    o.push({name: r.institution, product: r.product, apy: r.apy, min: r.min_deposit || 0, cap: r.cap || null, terms: r.conditions, promo: r.promo,
            cat: r.credit_union ? 'cu' : 'banks', catName: r.credit_union ? 'Credit union' : 'Bank', today: true,
            source: `${topRates.source}, ${new Date(topRates.date + 'T12:00:00').toLocaleDateString('en-US', {month: 'short', day: 'numeric'})}`, url: topRates.url});
  });
  rates.banks.forEach(r => { if (!seen.has(norm(r.name))) o.push({...r, cat: 'banks', catName: 'Bank'}); });
  rates.credit_unions.forEach(r => { if (!seen.has(norm(r.name))) o.push({...r, cat: 'cu', catName: 'Credit union'}); });
  rates.merrill.forEach(r => o.push({...r, cat: 'merrill', catName: 'Merrill'}));
  rates.money_market_funds.forEach(f => { const e = mmEstimate(f); if (e !== null) o.push({name: `${f.ticker} · ${f.name}`, product: f.type, apy: +e.toFixed(2), est: true, min: 0, terms: f.expense === null ? 'Estimated from the 3-month T-bill rate minus a typical 0.20% fee. Enter your exact 7-day yield above.' : `Estimated from the 3-month T-bill rate minus its ${f.expense}% fee`, cat: 'mmf', catName: 'Money market fund', yours: f.yours, tk: f.ticker}); });
  if (yields && yields.curve) [['1 Mo', '4-week'], ['3 Mo', '13-week'], ['6 Mo', '26-week'], ['1 Yr', '52-week']].forEach(([k, l]) => { if (yields.curve[k]) o.push({name: `${l} Treasury bill`, product: 'US government, buy at Merrill or TreasuryDirect', apy: yields.curve[k], min: 100, terms: 'Interest is exempt from state and local tax. Held to maturity, no price risk.', cat: 'bonds', catName: 'T-bill', live: true, source: `US Treasury, ${yields.date}`}); });
  rates.bond_etfs.forEach(b => { const d = divData[b.ticker]; if (d && d.yield) o.push({name: `${b.ticker} · ${b.name}`, product: b.type, apy: d.yield, min: d.price, terms: `Trailing 12-month payout yield. Price can move${/T-bills/.test(b.type) ? ' very little' : ''}.${b.ticker === 'MUB' ? ' Interest is federally tax-free.' : ''}`, cat: 'bonds', catName: 'Bond ETF', live: true, tk: b.ticker, source: 'Live, last 12 months'}); });
  return o;
}
function earn(o, bal) {
  if (bal < (o.min || 0) && o.cat !== 'mmf' && o.cat !== 'bonds') return null;
  const base = o.cap ? Math.min(bal, o.cap) : bal;
  return base * o.apy / 100;
}
function renderCash() {
  if (!rates) return;
  const {bal, apy, fromPortfolio} = cashInputs();
  const mine = rates.money_market_funds.find(f => f.yours);
  const myEst = mine ? mmEstimate(mine) : null;
  const curApy = apy !== undefined ? apy : (myEst !== null ? +myEst.toFixed(2) : 0.01);
  const balEl = $('cash-bal'), apyEl = $('cash-apy');
  if (document.activeElement !== balEl) balEl.value = Math.round(bal).toLocaleString('en-US');
  if (document.activeElement !== apyEl) apyEl.value = curApy;
  $('cash-hint').textContent = (fromPortfolio ? 'Balance taken from the money market in your portfolio. ' : '') + (apy === undefined && mine ? `Rate is an estimate for ${mine.ticker}. Check the 7-day yield in your Merrill account and type it in for an exact comparison.` : 'Saved on this device.');
  const now = bal * curApy / 100;
  animateTo($('cash-now'), 'cashnow', now, x => usd(x, 0), false);
  const opts = cashOptions().map(o => ({...o, yr: earn(o, bal)}));
  // Compare cash only with cash-safe options: insured deposits, money market funds and T-bills, not bond funds
  const safe = o => o.cat !== 'bonds' || /t-bill/i.test(o.product) || /bill/i.test(o.name);
  const best = opts.filter(o => o.yr !== null && !o.promo && safe(o)).sort((a, b) => b.yr - a.yr)[0];
  if (best) { animateTo($('cash-best'), 'cashbest', best.yr, x => usd(x, 0), false); $('cash-best-name').textContent = `${best.name.split(' · ')[0]} · ${best.apy.toFixed(2)}%${best.yr > now ? ` · +${usd(best.yr - now, 0)}/yr` : ''}`; }
  // Treasury strip
  if (yields && yields.curve) {
    const show = ['1 Mo', '3 Mo', '6 Mo', '1 Yr', '2 Yr', '10 Yr'];
    $('tbill').innerHTML = show.filter(k => yields.curve[k] !== undefined).map(k => { const v = yields.curve[k], m = yields.month_ago && yields.month_ago.curve[k], d = m !== undefined ? v - m : null;
      return `<div class="tb"><div class="k">${k.replace('Mo', 'month').replace('Yr', 'year')} Treasury</div><div class="v">${v.toFixed(2)}%</div>${d !== null ? `<div class="d">${d >= 0 ? '+' : ''}${d.toFixed(2)} vs month ago</div>` : ''}</div>`; }).join('');
  }
  const tabs = [['all', 'All'], ['banks', 'Banks'], ['cu', 'Credit unions'], ['merrill', 'Merrill'], ['mmf', 'Money market funds'], ['bonds', 'T-bills & bonds']];
  $('cash-tabs').innerHTML = tabs.map(([k, l]) => `<button type="button" aria-pressed="${k === cashTab}" data-c="${k}">${l}</button>`).join('');
  $('cash-tabs').querySelectorAll('button').forEach(b => b.onclick = () => { cashTab = b.dataset.c; renderCash(); });
  const list = opts.filter(o => cashTab === 'all' || o.cat === cashTab).sort((a, b) => b.apy - a.apy);
  $('cash-list').innerHTML = list.map(o => {
    const diff = o.yr !== null ? o.yr - now : null;
    return `<div class="rate"><div><div class="n">${o.tk ? `<button type="button" class="tk-link" data-tk="${esc(o.tk)}">${esc(o.name.split(' · ')[0])}</button> ${esc(o.name.split(' · ')[1] || '')}` : esc(o.name)}<span class="tag">${esc(o.catName)}</span>${o.yours ? '<span class="tag you">Yours</span>' : ''}${o.today ? '<span class="tag you">Today</span>' : ''}${o.promo ? '<span class="tag warn">Promo</span>' : ''}${o.est ? '<span class="tag">Estimate</span>' : ''}${o.cat === 'bonds' && !/t-bill/i.test(o.product) && !/bill/i.test(o.name) ? '<span class="tag warn">Price can drop</span>' : ''}</div>
      <div class="p">${esc(o.product)}${o.min ? ` · min ${usd(o.min, 0)}` : ''}${o.terms ? ` · ${esc(o.terms)}` : ''}</div>
      <div class="p">${o.url ? `<a class="src" href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.source)}</a>` : esc(o.source || '')}</div></div>
      <div><div class="a">${o.apy.toFixed(2)}%</div><div class="x">${o.yr === null ? `<span class="muted-l">Needs ${usd(o.min, 0)}</span>` : `${usd(o.yr, 0)}/yr${diff > 1 ? ` <span class="up">+${usd(diff, 0)}</span>` : ''}`}</div></div></div>`;
  }).join('') || '<div class="empty">Loading rates…</div>';
  $('cash-note').textContent = `${topRates && topRates.rates ? `Top savings rates read today from ${topRates.source}'s daily rate list. ` : ''}${rates.note} Other bank and credit union rates researched ${new Date(rates.as_of + 'T12:00:00').toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'})}. Treasury yields ${yields ? 'as of ' + yields.date : 'loading'}. Savings and money market accounts at banks and credit unions are FDIC or NCUA insured up to $250,000; money market funds and ETFs are not.`;
}
function wireCash() {
  const save = () => {
    const bal = parseFloat($('cash-bal').value.replace(/[$,\s]/g, '')), apy = parseFloat($('cash-apy').value);
    vset(cashKey, JSON.stringify({bal: isFinite(bal) ? bal : undefined, apy: isFinite(apy) ? apy : undefined}));
    renderCash();
  };
  $('cash-bal').addEventListener('change', save); $('cash-apy').addEventListener('change', save);
  $('cash-bal').addEventListener('input', () => { clearTimeout(wireCash.t); wireCash.t = setTimeout(save, 500); });
  $('cash-apy').addEventListener('input', () => { clearTimeout(wireCash.t); wireCash.t = setTimeout(save, 500); });
}
