// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
const BACKEND_URL = 'https://portfolio-intel-escf.onrender.com';
const STORE_KEY = 'pi.portfolio.v2';
const WATCH_KEY = 'pi.watch.v1';

// Reference baskets. Nothing here is a guess at share counts.
// Pelosi: built at load time from her House filings (buildPelosiRef).
// Trump: only the DJT stake reported in SEC filings (Form 4, 114,750,000 shares held by his revocable trust).
// His other assets are private or reported only in value ranges in OGE reports, so they are not modeled.
const REF = {
  pelosi: [],
  trump: [
    {ticker:'DJT',shares:114750000,sector:'Communication Services',src:'SEC Form 4'},
  ],
};
function amountMid(a) {
  const n = String(a || '').match(/[\d,]+/g); if (!n) return 0;
  const v = n.map(x => +x.replace(/,/g, '')).filter(Boolean);
  return v.length > 1 ? (v[0] + v[1]) / 2 : v[0] || 0;
}
// Stocks she has bought and not sold since, sized by the middle of each reported range.
function buildPelosiRef() {
  const rows = trades.filter(t => /pelosi/i.test(t.representative) && t.ticker && !t.private && /^(Purchase|Sale)/.test(t.type))
    .sort((x, y) => (x.date || '').localeCompare(y.date || '') || (/^Sale/.test(x.type) ? -1 : 1));
  const m = {};
  rows.forEach(t => {
    if (/^Sale/.test(t.type)) delete m[t.ticker];
    else m[t.ticker] = {ticker: t.ticker, usd: (m[t.ticker] ? m[t.ticker].usd : 0) + amountMid(t.amount), sector: t.sector || sectorOf(t.ticker) || 'Other', since: t.date};
  });
  REF.pelosi = Object.values(m).sort((x, y) => y.usd - x.usd).slice(0, 15).map(h => ({...h, shares: 0}));
  sizeRef();
}
function sizeRef() { REF.pelosi.forEach(h => { const p = prices[h.ticker]; if (p && p.price) { h.shares = h.usd / p.price; h.cost = p.price; } }); }
const CASH_TICKERS = new Set(['MLPDA','TMCXX','SPAXX','FDRXX','VMFXX','VMMXX','SWVXX','SPRXX','CASH','MMDA','QACDS']);
// Known sectors so the pie works instantly; anything else is looked up once and cached on the device
const SECTOR_MAP = {
  'Technology': 'AAPL MSFT NVDA AMD AVGO ORCL CRM ADBE INTC QCOM TXN CSCO IBM CRWD PANW NOW SNOW PLTR MU AMAT LRCX KLAC SHOP UBER INTU ANET SMCI DELL ARM MRVL',
  'Communication Services': 'GOOGL GOOG META NFLX DIS T VZ TMUS CMCSA DJT SPOT RDDT PINS SNAP',
  'Consumer Cyclical': 'AMZN TSLA HD MCD NKE SBUX LOW BKNG TJX GM F RIVN ABNB CMG LULU',
  'Consumer Defensive': 'WMT COST PG KO PEP PM MO MDLZ CL TGT KR',
  'Financial Services': 'JPM BAC WFC C GS MS V MA AXP SCHW BLK BRK.B BRK-B PYPL SQ XYZ COIN HOOD SOFI',
  'Healthcare': 'UNH JNJ LLY PFE MRK ABBV TMO ABT DHR BMY AMGN GILD CVS ISRG NVO',
  'Energy': 'XOM CVX COP SLB EOG OXY PSX MPC KMI',
  'Industrials': 'BA CAT GE HON UPS RTX LMT DE UNP NOC GD MMM',
  'Utilities': 'NEE DUK SO D AEP',
  'Real Estate': 'GEO PLD AMT O SPG EQIX',
  'Basic Materials': 'LIN NEM FCX DOW',
  'Funds & ETFs': 'VOO SPY IVV VTI QQQ QQQM DIA SCHD VUG VGT VXUS VEA VWO BND AGG GLD SLV IAU TLT ARKK XLK XLF XLE SOXX SMH IWM VYM JEPI',
};
const SECTOR_OF = {};
Object.entries(SECTOR_MAP).forEach(([sec, list]) => list.split(' ').forEach(t => SECTOR_OF[t] = sec));
const SECTOR_KEY = 'pi.sectors.v1';
const MIX_COLORS = ['#0A84FF','#64D2FF','#BF5AF2','#FF9F0A','#30D158','#FF375F','#FFD60A','#5E5CE6'];
const BANNER_EXTRA = ['SPY','QQQ','DIA'];
const RANGES = [['1D','1d'],['1W','5d'],['1M','1mo'],['6M','6mo'],['YTD','ytd'],['1Y','1y'],['5Y','5y']];
const SERIES = [
  {key:'me',label:'You',color:'#F5F5F7',width:3},
  {key:'pelosi',label:'Pelosi',color:'#0A84FF',width:2,area:true},
  {key:'trump',label:'Trump',color:'#FF9F0A',width:2},
  {key:'voo',label:'VOO',color:'#8E9BB3',width:2,dashed:true},
];

// ─────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────

// ── Encrypted storage ──
// With a passcode set, holdings, cash and value history are stored encrypted (AES-GCM, key from the passcode via PBKDF2).
// The key lives only in this tab's session storage and is dropped on lock, so the data is unreadable without the passcode.
const VAULT_KEYS = ['pi.portfolio.v2', 'pi.snapshots.v1', 'pi.cash.v1', 'pi.plaid.v1'];
const VAULT = {key: null, cache: {}};
const vb64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const vunb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
function vaultOn() { try { const c = JSON.parse(localStorage.getItem('pi.lock.v1')); return !!(c && c.encSalt); } catch (e) { return false; } }
async function vaultDerive(pass, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 210000}, base, {name: 'AES-GCM', length: 256}, true, ['encrypt', 'decrypt']);
}
async function vaultEncrypt(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return 'enc1:' + vb64(iv) + ':' + vb64(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, VAULT.key, new TextEncoder().encode(text)));
}
async function vaultDecrypt(v) {
  const [, iv, ct] = v.split(':');
  return new TextDecoder().decode(await crypto.subtle.decrypt({name: 'AES-GCM', iv: vunb64(iv)}, VAULT.key, vunb64(ct)));
}
function vget(k) {
  if (!VAULT_KEYS.includes(k)) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  if (k in VAULT.cache) return VAULT.cache[k];
  let v = null; try { v = localStorage.getItem(k); } catch (e) {}
  return v && v.startsWith('enc1:') ? null : v;
}
function vset(k, val) {
  if (VAULT_KEYS.includes(k) && VAULT.key) {
    VAULT.cache[k] = val;
    vaultEncrypt(val).then(c => { try { localStorage.setItem(k, c); } catch (e) {} });
    return;
  }
  if (VAULT_KEYS.includes(k) && vaultOn()) return; // locked: never write plain text over encrypted data
  try { localStorage.setItem(k, val); } catch (e) {}
}
// Open the vault with the key saved for this tab, if any
async function openVault() {
  if (!vaultOn()) return;
  let raw = null; try { raw = sessionStorage.getItem('pi.vk'); } catch (e) {}
  if (!raw) return;
  try { VAULT.key = await crypto.subtle.importKey('raw', vunb64(raw), 'AES-GCM', true, ['encrypt', 'decrypt']); }
  catch (e) { VAULT.key = null; return; }
  for (const k of VAULT_KEYS) {
    let v = null; try { v = localStorage.getItem(k); } catch (e) {}
    if (!v) continue;
    try { VAULT.cache[k] = v.startsWith('enc1:') ? await vaultDecrypt(v) : v; } catch (e) { VAULT.cache[k] = null; }
  }
}
async function vaultUse(key) {
  VAULT.key = key;
  try { sessionStorage.setItem('pi.vk', vb64(await crypto.subtle.exportKey('raw', key))); } catch (e) {}
}
// Turn encryption on (or re-key it) using the current plain or decrypted values
async function vaultSeal(pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const vals = {}; VAULT_KEYS.forEach(k => vals[k] = vget(k));
  await vaultUse(await vaultDerive(pass, salt));
  for (const k of VAULT_KEYS) if (vals[k] != null) { VAULT.cache[k] = vals[k]; localStorage.setItem(k, await vaultEncrypt(vals[k])); }
  return vb64(salt);
}
function vaultUnseal() {
  VAULT_KEYS.forEach(k => { const v = vget(k); try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} });
  VAULT.key = null; VAULT.cache = {};
  try { sessionStorage.removeItem('pi.vk'); } catch (e) {}
}
let myPortfolio = loadPortfolio();
let watchlist = (() => { try { return JSON.parse(localStorage.getItem(WATCH_KEY)) || []; } catch (e) { return []; } })();
function saveWatch() { try { localStorage.setItem(WATCH_KEY, JSON.stringify(watchlist)); } catch (e) {} }
const followed = () => new Set([...stocks().map(h => h.ticker), ...watchlist]);
let prices = {};
let trades = [];
let tradesUpdated = null;
let trumpFilings = [];
let smart = {investors: []}, insiderBuys = [];
let trumpLimit = 6;
// Remember the last visit so new filings can be called out
let lastVisit = null;
try { lastVisit = localStorage.getItem('pi.lastVisit'); localStorage.setItem('pi.lastVisit', new Date().toISOString().slice(0, 10)); } catch (e) {}
if (lastVisit === new Date().toISOString().slice(0, 10)) { try { lastVisit = localStorage.getItem('pi.prevVisit'); } catch (e) {} } else { try { lastVisit && localStorage.setItem('pi.prevVisit', lastVisit); } catch (e) {} }
let range = '6mo';
let feedFilter = 'all';
let feedAdv = {member: '', sector: '', type: '', size: 0, flagged: false};
const FLAG_KEY = 'pi.flags.v1';
let flags = (() => { try { return JSON.parse(localStorage.getItem(FLAG_KEY)) || {}; } catch (e) { return {}; } })();
const saveFlags = () => { try { localStorage.setItem(FLAG_KEY, JSON.stringify(flags)); } catch (e) {} };
const tradeKey = t => `${t.representative}|${t.ticker || t.description}|${t.date}|${t.type}|${t.amount}`;
const LARGE = 100001;
let feedLimit = 12;
let chart = null;
const lines = {};
let lastReturns = {};
let mixWho = 'me';
let mixHot = null;
let sectorCache = (() => { try { return JSON.parse(localStorage.getItem(SECTOR_KEY)) || {}; } catch (e) { return {}; } })();
const shown = {};

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd = (v, d=2) => (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', {minimumFractionDigits:d, maximumFractionDigits:d});
const compact = v => v >= 1e9 ? '$' + (v/1e9).toFixed(2) + 'B' : v >= 1e6 ? '$' + (v/1e6).toFixed(1) + 'M' : v >= 1e3 ? '$' + (v/1e3).toFixed(1) + 'K' : usd(v);
const pct = (v, d=1) => (v >= 0 ? '+' : '') + v.toFixed(d) + '%';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
function store(get, val) { return get ? vget(STORE_KEY) : vset(STORE_KEY, val); }
function loadPortfolio() { try { return JSON.parse(store(true)) || []; } catch (e) { return []; } }
function savePortfolio() { store(false, JSON.stringify(myPortfolio)); }
function stocks() { return myPortfolio.filter(h => !h.isCash); }
function priceOf(t, fallback=0) { return prices[t] ? prices[t].price : fallback; }
function ago(date) {
  const m = Math.max(0, Math.round((Date.now() - date) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  if (m < 1440) return Math.round(m/60) + ' hr ago';
  return Math.round(m/1440) + ' days ago';
}
async function getJSON(url, opts) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), (opts && opts.timeout) || 45000); // Render free tier can take a while to wake
  try {
    const {timeout, ...rest} = opts || {};
    const r = await fetch(url, {...rest, signal: ctl.signal});
    if (!r.ok) { let msg = 'HTTP ' + r.status; try { const j = await r.json(); if (j.error) msg = j.error; } catch (e) {} const err = new Error(msg); err.status = r.status; throw err; }
    return await r.json();
  }
  finally { clearTimeout(t); }
}
function loadScript(lib) {
  const [src, integrity] = Array.isArray(lib) ? lib : [lib, null];
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement('script'); s.src = src;
    if (integrity) { s.integrity = integrity; s.crossOrigin = 'anonymous'; }
    s.onload = res; s.onerror = () => rej(new Error('A required component failed to load or did not pass its security check. Try again.'));
    document.head.appendChild(s);
  });
}

// Animated number: counts from the last shown value to the new one
function animateTo(el, key, value, fmt, flash=true) {
  const from = shown[key];
  shown[key] = value;
  if (reduced || from === undefined || !isFinite(from)) { el.textContent = fmt(value); return; }
  if (flash && from !== value) { el.classList.remove('flash-up','flash-down'); void el.offsetWidth; el.classList.add(value > from ? 'flash-up' : 'flash-down'); }
  const t0 = performance.now(), dur = 900;
  const step = now => {
    const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (value - from) * e);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function setRet(el, key, v) {
  el.classList.remove('up','down');
  if (v === null || v === undefined || !isFinite(v)) { el.textContent = 'No data'; return; }
  el.classList.add(v >= 0 ? 'up' : 'down');
  animateTo(el, key, v, x => pct(x), false);
}

// ─────────────────────────────────────────────
//  DATA: PRICES
// ─────────────────────────────────────────────
function allTickers() {
  const set = new Set(['VOO', ...BANNER_EXTRA]);
  stocks().forEach(h => set.add(h.ticker));
  watchlist.forEach(t => set.add(t));
  REF.pelosi.forEach(h => set.add(h.ticker));
  REF.trump.forEach(h => set.add(h.ticker));
  return [...set].slice(0, 40);
}
async function loadPrices() {
  try {
    const d = await getJSON(BACKEND_URL + '/api/prices/' + allTickers().join(','));
    prices = {...prices, ...(d.prices || {})};
    sizeRef();
    $('live-dot').classList.add('ok');
    $('live-text').textContent = 'Live prices · updated ' + new Date().toLocaleTimeString('en-US', {hour:'numeric', minute:'2-digit'});
  } catch (e) {
    $('live-dot').classList.remove('ok');
    $('live-text').textContent = Object.keys(prices).length ? 'Prices may be stale. Retrying…' : 'Market data is waking up. Retrying…';
  }
  renderHero(); renderHoldings(); renderCompareSubs(); renderSignals(); renderTicker(); renderMix();
  if (feedFilter === 'trump') renderFeed();
}

// ─────────────────────────────────────────────
//  HERO
// ─────────────────────────────────────────────
function portfolioTotals() {
  let total = 0, prev = 0, cost = 0, stockVal = 0;
  for (const h of myPortfolio) {
    if (h.isCash) { total += h.marketValue || 0; prev += h.marketValue || 0; continue; }
    const p = prices[h.ticker];
    const now = p ? p.price : (h.currentPrice || h.avgCost || 0);
    const pc = p ? (p.prev_close || p.price) : now;
    total += h.shares * now; prev += h.shares * pc; stockVal += h.shares * now;
    cost += h.shares * (h.avgCost || now);
  }
  return {total, day: total - prev, dayPct: prev ? (total - prev) / prev * 100 : 0, gain: stockVal - cost, gainPct: cost ? (stockVal - cost) / cost * 100 : 0};
}
function renderHero() {
  const v = $('hero-value'), c = $('hero-change');
  if (!myPortfolio.length) {
    $('hero-label').textContent = 'Portfolio Intel';
    v.textContent = 'Track the trades.';
    c.innerHTML = '<span style="color:var(--ink-2)">Compare your portfolio with what Congress is buying.</span>';
    $('hero-cta').style.display = 'block';
    return;
  }
  $('hero-label').textContent = 'Total portfolio value';
  $('hero-cta').style.display = 'none';
  if (!Object.keys(prices).length && !myPortfolio.some(h => h.currentPrice || h.isCash)) { v.innerHTML = '<span class="sk">$000,000</span>'; return; }
  const t = portfolioTotals();
  animateTo(v, 'hero', t.total, x => usd(x));
  c.className = 'hero-change num ' + (t.day >= 0 ? 'up' : 'down');
  c.textContent = `${t.day >= 0 ? '+' : '-'}${usd(Math.abs(t.day))} · ${pct(t.dayPct, 2)} today`;
}

// ─────────────────────────────────────────────
//  CHART (TradingView Lightweight Charts)
// ─────────────────────────────────────────────
function buildChart() {
  const legend = $('legend');
  legend.innerHTML = SERIES.map(s => `<button class="chip" type="button" aria-pressed="true" data-k="${s.key}"><span class="sw" style="background:${s.color}"></span>${s.label} <span class="v num" id="lv-${s.key}"></span></button>`).join('');
  legend.querySelectorAll('.chip').forEach(b => b.onclick = () => {
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', on);
    lines[b.dataset.k] && lines[b.dataset.k].applyOptions({visible: on});
  });
  $('ranges').innerHTML = RANGES.map(([l, r]) => `<button type="button" aria-pressed="${r === range}" data-r="${r}">${l}</button>`).join('');
  $('ranges').querySelectorAll('button').forEach(b => b.onclick = () => {
    range = b.dataset.r;
    $('ranges').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b));
    loadHistory();
  });

  if (!window.LightweightCharts) { $('chart-msg').textContent = 'Chart library failed to load.'; return; }
  chart = LightweightCharts.createChart($('chart'), {
    autoSize: true,
    layout: {background: {type: 'solid', color: 'transparent'}, textColor: '#9FB1CE', fontFamily: getComputedStyle(document.body).fontFamily, fontSize: 12},
    grid: {vertLines: {visible: false}, horzLines: {color: 'rgba(255,255,255,0.06)'}},
    rightPriceScale: {borderVisible: false, scaleMargins: {top: 0.1, bottom: 0.08}},
    timeScale: {borderVisible: false, timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true},
    crosshair: {mode: 0, vertLine: {color: 'rgba(255,255,255,0.35)', width: 1, style: 0, labelBackgroundColor: '#12306A'}, horzLine: {visible: false, labelVisible: false}},
    localization: {locale: 'en-US', priceFormatter: v => pct(v)},
    handleScroll: false, handleScale: false,
  });
  for (const s of SERIES) {
    const opts = {color: s.color, lineColor: s.color, lineWidth: s.width, lineStyle: s.dashed ? 2 : 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerRadius: 4};
    lines[s.key] = s.area
      ? chart.addAreaSeries({...opts, topColor: 'rgba(10,132,255,0.28)', bottomColor: 'rgba(10,132,255,0)'})
      : chart.addLineSeries(opts);
  }
  chart.subscribeCrosshairMove(p => {
    if (!p || !p.time) { showLegendValues(lastReturns); $('chart-date').textContent = 'Return over period'; return; }
    const vals = {};
    for (const s of SERIES) { const d = p.seriesData.get(lines[s.key]); if (d) vals[s.key] = d.value; }
    showLegendValues(vals);
    const dt = new Date(p.time * 1000);
    $('chart-date').textContent = dt.toLocaleString('en-US', range === '1d' || range === '5d' ? {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'} : {month:'short', day:'numeric', year:'numeric'});
  });
}
function showLegendValues(vals) {
  for (const s of SERIES) { const el = $('lv-' + s.key); if (el) el.textContent = vals[s.key] !== undefined ? pct(vals[s.key]) : ''; }
}

// Value of a basket over time, normalized to % return from the first point where every ticker has a price
function basketSeries(holdings, hist) {
  const ok = holdings.filter(h => hist[h.ticker] && hist[h.ticker].length);
  if (!ok.length) return [];
  const times = [...new Set(ok.flatMap(h => hist[h.ticker].map(p => p[0])))].sort((a, b) => a - b);
  const idx = ok.map(() => 0), last = ok.map(() => null), out = [];
  for (const t of times) {
    let total = 0, complete = true;
    ok.forEach((h, i) => {
      const s = hist[h.ticker];
      while (idx[i] < s.length && s[idx[i]][0] <= t) { last[i] = s[idx[i]][1]; idx[i]++; }
      if (last[i] === null) complete = false; else total += h.shares * last[i];
    });
    if (complete) out.push({time: t, value: total});
  }
  if (!out.length) return [];
  const base = out[0].value;
  return out.map(p => ({time: p.time, value: (p.value / base - 1) * 100}));
}

let historyReq = 0;
async function loadHistory() {
  const req = ++historyReq;
  const msg = $('chart-msg');
  msg.style.display = 'flex'; msg.textContent = 'Loading price history…';
  try {
    const d = await getJSON(`${BACKEND_URL}/api/history/${allTickers().join(',')}?range=${range}`);
    if (req !== historyReq) return;
    const hist = d.series || {};
    const data = {
      me: basketSeries(stocks().map(h => ({ticker: h.ticker, shares: h.shares})), hist),
      pelosi: basketSeries(REF.pelosi, hist),
      trump: basketSeries(REF.trump, hist),
      voo: basketSeries([{ticker: 'VOO', shares: 1}], hist),
    };
    lastReturns = {};
    for (const s of SERIES) {
      lines[s.key] && lines[s.key].setData(data[s.key]);
      if (data[s.key].length) lastReturns[s.key] = data[s.key][data[s.key].length - 1].value;
    }
    if (!Object.keys(lastReturns).length) throw new Error('empty');
    msg.style.display = 'none';
    chart && chart.timeScale().fitContent();
    showLegendValues(lastReturns);
    setRet($('ret-me'), 'rme', myPortfolio.length ? lastReturns.me : null);
    if (!stocks().length) { $('ret-me').classList.remove('up','down'); $('ret-me').textContent = 'Not added'; }
    setRet($('ret-pelosi'), 'rpel', lastReturns.pelosi);
    setRet($('ret-trump'), 'rtr', lastReturns.trump);
    setRet($('ret-voo'), 'rvoo', lastReturns.voo);
    renderAnyMember();
    renderSignals();
  } catch (e) {
    if (req !== historyReq) return;
    msg.style.display = 'flex';
    msg.textContent = 'Price history is unavailable right now. It will retry shortly.';
    setTimeout(() => { if (req === historyReq) loadHistory(); }, 60000);
  }
}
let cmpMember = null;
async function renderAnyMember() {
  const sel = $('cmp-member');
  const cands = copyCandidates();
  if (!cands.length) return;
  cmpMember = cmpMember || cands.find(r => !/pelosi/i.test(r)) || cands[0];
  const invs = smart.investors.filter(x => x.quarters && x.quarters.length);
  sel.innerHTML = (invs.length ? `<optgroup label="Famous investors">${invs.map(x => `<option value="inv:${esc(x.id)}"${'inv:' + x.id === cmpMember ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>` : '')
    + `<optgroup label="Congress">${cands.slice(0, 60).sort((a, b) => nameOf(a).localeCompare(nameOf(b))).map(r => `<option value="${esc(r)}"${r === cmpMember ? ' selected' : ''}>${esc(nameOf(r))}</option>`).join('')}</optgroup>`;
  const el = $('ret-any'), sub = $('sub-any');
  try { await ensureHistory(['VOO', ...((planFor(cmpMember) || {}).tickers || [])]); } catch (e) { el.textContent = 'No data'; return; }
  const res = simulate(cmpMember);
  if (!res) { el.classList.remove('up', 'down'); el.textContent = 'No data'; sub.textContent = 'No stock filings in the past year'; return; }
  // Return over the same window as the chart above
  const days = {'1d': 1, '5d': 7, '1mo': 31, '6mo': 183, '1y': 366, '5y': 9999}[range];
  const startTs = range === 'ytd' ? Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000 : Date.now() / 1000 - (days || 183) * 86400;
  const i = Math.max(0, res.copySeries.findIndex(p => p.time >= startTs));
  const r = (res.copySeries[res.copySeries.length - 1].value / res.copySeries[i].value - 1) * 100;
  const vr = (res.vooSeries[res.vooSeries.length - 1].value / res.vooSeries[i].value - 1) * 100;
  setRet(el, 'rany', r);
  const since = res.copySeries[i].time > startTs + 5 * 86400 ? ` · since ${new Date(res.copySeries[i].time * 1000).toLocaleDateString('en-US', {month: 'short', day: 'numeric'})}` : '';
  sub.innerHTML = `${r - vr >= 0 ? 'Beat' : 'Trailed'} VOO by ${Math.abs(r - vr).toFixed(1)} pts${since}`;
}
function renderCompareSubs() {
  const val = list => list.reduce((s, h) => s + h.shares * priceOf(h.ticker, h.cost), 0);
  $('sub-pelosi').textContent = `${REF.pelosi.length} positions · ${compact(val(REF.pelosi))} from filings`;
  $('sub-trump').textContent = `DJT stake · ${compact(val(REF.trump))}`;
  if (myPortfolio.length) {
    const t = portfolioTotals();
    $('sub-me').textContent = `${stocks().length} positions · ${compact(t.total)}`;
  }
  if (prices.VOO) $('sub-voo').textContent = `VOO ${usd(prices.VOO.price)} · ${pct(prices.VOO.change_pct, 2)} today`;
}

// ─────────────────────────────────────────────
//  DISCLOSURES FEED
// ─────────────────────────────────────────────
async function loadTrades() {
  let d = null;
  try { d = await getJSON('./trades.json?v=' + Math.floor(Date.now() / 3.6e6)); }
  catch (e) { try { d = await getJSON(BACKEND_URL + '/api/all-trades'); } catch (e2) {} }
  if (d && Array.isArray(d.trades)) {
    trades = d.trades.filter(t => (t.ticker && t.ticker.length <= 6) || (t.private && t.description)).map(t => ({...t, amount: String(t.amount || '').replace(/\s+/g, ' ').replace(/\s*-\s*/, ' - ')})).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    tradesUpdated = d.updated ? new Date(d.updated) : null;
  }
  buildPelosiRef();
  if (REF.pelosi.some(h => !prices[h.ticker])) loadPrices().then(loadHistory);
  try { const t = await getJSON('./trump_filings.json?v=' + Math.floor(Date.now() / 3.6e6)); trumpFilings = t.filings || []; } catch (e) {}
  try { smart = await getJSON('./smart_money.json?v=' + Math.floor(Date.now() / 3.6e6)); smart.investors = smart.investors || []; } catch (e) {}
  try { insiderBuys = (await getJSON('./insiders.json?v=' + Math.floor(Date.now() / 3.6e6))).buys || []; } catch (e) {}
  renderSmart();
  fillFeedFilters(); renderFeed(); renderHoldings(); renderSignals();
  bestCache = null; renderAnyMember();
  runCopyTest(); renderLeaderboard();
}
function renderFeed() {
  const filters = [['all','All'],['pelosi','Pelosi'],['trump','Trump'],['large','Large trades'],['mine','My stocks + watchlist']];
  $('feed-filter').innerHTML = filters.map(([k, l]) => `<button type="button" aria-pressed="${k === feedFilter}" data-f="${k}">${l}</button>`).join('');
  $('feed-filter').querySelectorAll('button').forEach(b => b.onclick = () => { feedFilter = b.dataset.f; feedLimit = 12; trumpLimit = 6; renderFeed(); });

  const mine = new Set(stocks().map(h => h.ticker));
  let list = trades;
  if (feedFilter === 'pelosi') list = trades.filter(t => /pelosi/i.test(t.representative || ''));
  if (feedFilter === 'mine') { const f = followed(); list = trades.filter(t => f.has(t.ticker)); }
  if (feedFilter === 'large') list = trades.filter(t => lowerBound(t.amount) >= LARGE);
  // Advanced filters
  const fm = feedAdv.member.trim().toLowerCase();
  if (fm) list = list.filter(t => nameOf(t.representative).toLowerCase().includes(fm) || (t.representative || '').toLowerCase().includes(fm));
  if (feedAdv.sector) list = list.filter(t => (t.sector || sectorOf(t.ticker) || '') === feedAdv.sector);
  if (feedAdv.type) list = list.filter(t => feedAdv.type === 'buy' ? /purchase/i.test(t.type) : /sale/i.test(t.type));
  if (feedAdv.size) list = list.filter(t => lowerBound(t.amount) >= feedAdv.size);
  if (feedAdv.flagged) list = list.filter(t => flags[tradeKey(t)]);
  const advOn = fm || feedAdv.sector || feedAdv.type || feedAdv.size || feedAdv.flagged;
  const fresh = lastVisit ? trades.filter(t => (t.filed || '') > lastVisit).length : 0;
  $('feed-lede').innerHTML = (tradesUpdated ? `${trades.length} recent trades · filings checked ${esc(ago(tradesUpdated))}` : 'Congressional trades, as filed.') + (fresh ? `<span class="new-dot">${fresh} new since your last visit</span>` : '');

  const feed = $('feed');
  if (feedFilter === 'trump') { renderTrumpFeed(feed); return; }
  if (!trades.length) { feed.innerHTML = '<div class="chart-msg" style="position:static;padding:28px">Loading disclosures…</div>'; $('feed-more').style.display = 'none'; return; }
  if (!list.length) {
    const why = feedAdv.flagged && !Object.keys(flags).length ? 'Nothing flagged yet. Tap Flag on any trade to save it for review.' : feedFilter === 'mine' && !advOn ? (mine.size ? 'No recent filings touch your stocks.' : 'Add your portfolio to see trades in your stocks.') : 'No filings match these filters.';
    feed.innerHTML = `<div class="chart-msg" style="position:static;padding:28px">${why}</div>`; $('feed-more').style.display = 'none'; return;
  }
  if (advOn || feedFilter !== 'all') $('feed-lede').innerHTML += ` <span class="new-dot" style="background:rgba(255,255,255,.18)">${list.length} match</span>`;
  feed.innerHTML = list.slice(0, feedLimit).map(t => {
    const buy = /purchase|buy/i.test(t.type || '');
    const k = tradeKey(t), fl = flags[k], big = lowerBound(t.amount) >= LARGE;
    const name = nameOf(t.representative);
    const fmtD = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'}) : '';
    const traded = fmtD(t.date), filed = fmtD(t.filed);
    const lag = t.date && t.filed ? Math.round((new Date(t.filed) - new Date(t.date)) / 864e5) : null;
    const label = t.private ? `<span class="priv">${esc(t.description)}</span>` : `<button type="button" class="tk-link" data-tk="${esc(t.ticker)}">${esc(t.ticker)}</button>`;
    return `<div class="trade${fl ? ' flagged' : ''}">
      <div><div class="who">${esc(name)}${t.sector ? ' · ' + esc(t.sector) : ''}</div><div class="what">${label}<span class="pill ${buy ? 'buy' : 'sell'}">${buy ? 'Buy' : 'Sell'}</span>${big ? '<span class="pill big">Large</span>' : ''}${t.private ? `<span class="pill priv-pill">${esc(t.kind || 'Private investment')}</span>` : ''}${mine.has(t.ticker) ? '<span class="pill mine">You own</span>' : ''}${lag !== null && lag > LATE_DAYS ? `<span class="pill late">Filed late</span>` : ''}${t.committees && t.committees.length ? `<span class="pill cmte" title="${esc('Sits on ' + t.committees.join(', '))}">Committee overlap</span>` : ''}</div>${t.committees && t.committees.length ? `<div class="who" style="margin-top:2px">Sits on ${esc(t.committees.join(', '))}</div>` : ''}</div>
      <div><div class="amt num">${esc(t.amount || '')}</div><div class="when">Traded ${esc(traded)}</div>${filed ? `<div class="when">Filed ${esc(filed)}${lag !== null && lag >= 0 ? ` · ${lag}d later` : ''}</div>` : ''}
        <div class="row-acts">${t.ticker ? `<button type="button" class="mini" data-track="${esc(t.ticker)}" aria-label="Track ${esc(t.ticker)} in your portfolio">+ Track</button>` : ''}<button type="button" class="mini" data-flag="${esc(k)}" aria-pressed="${!!fl}" aria-label="${fl ? 'Unflag' : 'Flag for review'}">${fl ? 'Flagged' : 'Flag'}</button></div></div>
      ${fl ? `<div style="grid-column:1 / -1"><label class="sr" for="n-${esc(btoa(unescape(encodeURIComponent(k))).slice(0, 16))}">Review note</label><input class="flag-note" id="n-${esc(btoa(unescape(encodeURIComponent(k))).slice(0, 16))}" data-note="${esc(k)}" placeholder="Add a review note" value="${esc(fl.note || '')}"></div>` : ''}
    </div>`;
  }).join('');
  $('feed-more').style.display = list.length > feedLimit ? 'inline-flex' : 'none';
  feed.querySelectorAll('[data-flag]').forEach(b => b.onclick = () => {
    const key = b.dataset.flag;
    if (flags[key]) delete flags[key]; else flags[key] = {at: new Date().toISOString().slice(0, 10), note: ''};
    saveFlags(); renderFeed();
  });
  feed.querySelectorAll('[data-note]').forEach(i => i.onchange = () => { if (flags[i.dataset.note]) { flags[i.dataset.note].note = i.value.slice(0, 200); saveFlags(); } });
  feed.querySelectorAll('[data-track]').forEach(b => b.onclick = () => openTicker(b.dataset.track, true));
  $('f-flagged').textContent = `Flagged${Object.keys(flags).length ? ' (' + Object.keys(flags).length + ')' : ''}`;
}

function fillFeedFilters() {
  const names = [...new Set(trades.map(t => nameOf(t.representative)))].sort();
  $('member-list').innerHTML = names.map(n => `<option value="${esc(n)}">`).join('');
  const secs = [...new Set(trades.map(t => t.sector).filter(Boolean))].sort();
  const cur = $('f-sector').value;
  $('f-sector').innerHTML = '<option value="">Any industry</option>' + secs.map(x => `<option${x === cur ? ' selected' : ''}>${esc(x)}</option>`).join('');
}
function wireFeedFilters() {
  const upd = () => { feedAdv = {member: $('f-member').value, sector: $('f-sector').value, type: $('f-type').value, size: +$('f-size').value, flagged: $('f-flagged').getAttribute('aria-pressed') === 'true'}; feedLimit = 12; renderFeed(); };
  $('f-member').addEventListener('input', () => { clearTimeout(wireFeedFilters.t); wireFeedFilters.t = setTimeout(upd, 250); });
  ['f-sector', 'f-type', 'f-size'].forEach(id => $(id).onchange = upd);
  $('f-flagged').onclick = () => { $('f-flagged').setAttribute('aria-pressed', $('f-flagged').getAttribute('aria-pressed') !== 'true'); upd(); };
  $('f-clear').onclick = () => { $('f-member').value = ''; $('f-sector').value = ''; $('f-type').value = ''; $('f-size').value = '0'; $('f-flagged').setAttribute('aria-pressed', 'false'); feedFilter = 'all'; upd(); };
  $('f-alert').onclick = () => {
    const a = {members: $('f-member').value.trim(), sectors: $('f-sector').value, type: $('f-type').value, min: +$('f-size').value || 0};
    if (feedFilter === 'pelosi' && !a.members) a.members = 'Pelosi';
    if (feedFilter === 'large' && !a.min) a.min = LARGE;
    try { localStorage.setItem('pi.alertrule', JSON.stringify(a)); } catch (e) {}
    renderAlerts(); $('alerts').scrollIntoView({behavior: reduced ? 'auto' : 'smooth'});
  };
}

// Trump files with the Office of Government Ethics, not the House, so his trades
// aren't in the House feed. Show his disclosed positions with live prices instead.
function renderTrumpFeed(feed) {
  const mine = new Set(stocks().map(h => h.ticker));
  const fmtD = d => new Date(d + 'T12:00:00').toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'});
  const head = t => `<div class="trade" style="display:block;padding-top:22px"><div class="what" style="font-size:13px;color:var(--ink-3);font-weight:600">${t}</div></div>`;
  const note = `<div class="trade" style="display:block;border-top:0"><div class="who" style="line-height:1.5">Trump files with the Office of Government Ethics, not the House. His reports are scanned documents, so they're listed here with links to the originals.</div></div>`;

  const filings = trumpFilings.slice(0, trumpLimit).map(f => {
    // The filename carries the date he signed it, e.g. "Donald-J-Trump.09.17.2026-278T.pdf"
    const m = decodeURIComponent(f.url || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    const signed = m ? fmtD(`${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`) : '';
    const kind = /annual/i.test(f.type) ? f.type.replace(/^Annual/i, 'Annual report') : /transaction/i.test(f.type) ? 'Transaction report' : f.type;
    const href = /^https:\/\/extapps2\.oge\.gov\//.test(f.url) ? f.url : '';
    return `<div class="trade">
      <div><div class="who">${signed ? 'Signed ' + esc(signed) : 'Office of Government Ethics'}</div><div class="what" style="font-size:15px">${esc(kind)}${f.amended ? '<span class="pill hold-pill">Amended</span>' : ''}</div></div>
      <div style="text-align:right"><div class="amt">${href ? `<a href="${esc(href)}" target="_blank" rel="noopener" style="color:#8EC5FF;text-decoration:none;font-weight:600">Open</a>` : ''}</div><div class="when">Posted ${esc(fmtD(f.date))}${f.pages ? ` · ${f.pages} pages` : ''}</div></div>
    </div>`;
  }).join('');
  const moreFilings = trumpFilings.length > trumpLimit ? `<div class="more"><button class="btn glass small" type="button" id="trump-more">Show more reports</button></div>` : '';

  const rows = REF.trump.map(h => ({...h, value: h.shares * priceOf(h.ticker, h.cost)})).sort((a, b) => b.value - a.value);
  const positions = rows.map(h => {
    const p = prices[h.ticker], chg = p ? p.change_pct : null;
    return `<div class="trade">
      <div><div class="who">${esc(h.sector)}</div><div class="what"><button type="button" class="tk-link" data-tk="${esc(h.ticker)}">${esc(h.ticker)}</button><span class="pill hold-pill">Holds</span>${mine.has(h.ticker) ? '<span class="pill mine">You own</span>' : ''}</div></div>
      <div><div class="amt num">${compact(h.value)}</div><div class="when">${p ? usd(p.price) : ''}${chg !== null ? ` · <span class="${chg >= 0 ? 'up' : 'down'}">${pct(chg, 2)}</span> today` : ''}</div></div>
    </div>`;
  }).join('');

  feed.innerHTML = note
    + (trumpFilings.length ? head('Latest filings') + filings + moreFilings : '')
    + head('Disclosed stock (SEC filings)') + positions;
  const btn = $('trump-more');
  if (btn) btn.onclick = () => { trumpLimit += 10; renderFeed(); };
  $('feed-more').style.display = 'none';
}

// ─────────────────────────────────────────────
//  HOLDINGS TABLE
// ─────────────────────────────────────────────
function tradersOf(ticker) {
  const names = new Set();
  trades.forEach(t => { if (t.ticker === ticker) names.add(t.representative); });
  return names.size;
}
function renderHoldings() {
  const tb = $('my-tbl');
  if (!myPortfolio.length) { tb.innerHTML = ''; $('my-empty').style.display = 'block'; $('my-actions').style.display = 'none'; return; }
  $('my-empty').style.display = 'none'; $('my-actions').style.display = 'flex';
  const pel = new Set(REF.pelosi.map(h => h.ticker)), tr = new Set(REF.trump.map(h => h.ticker));
  const rows = [...myPortfolio].sort((a, b) => (a.isCash - b.isCash) || ((b.shares * priceOf(b.ticker, b.currentPrice || 0)) - (a.shares * priceOf(a.ticker, a.currentPrice || 0))));
  tb.innerHTML = rows.map(h => {
    if (h.isCash) return `<tr><td><strong>${esc(h.ticker)}</strong><div class="co">${esc(h.company && h.company !== h.ticker ? h.company : 'Money market')}</div></td><td>–</td><td>$1.00</td><td>${usd(h.marketValue || 0)}</td><td>${usd(h.marketValue || 0)}</td><td class="muted-l">–</td><td>${h.apy ? usd(incomeOf(h), 0) : '<span class="muted-l">–</span>'}</td><td>${h.apy ? h.apy.toFixed(2) + '%' : '<span class="muted-l">Add APY</span>'}</td><td></td></tr>`;
    const p = priceOf(h.ticker, h.currentPrice || 0);
    const r = h.avgCost > 0 && p > 0 ? (p - h.avgCost) / h.avgCost * 100 : null;
    const n = tradersOf(h.ticker);
    const badges = (pel.has(h.ticker) ? '<span class="badge b-pelosi">Pelosi</span>' : '') + (tr.has(h.ticker) ? '<span class="badge b-trump">Trump</span>' : '') + (n ? `<span class="badge b-cong">${n} in Congress</span>` : '');
    return `<tr>
      <td><strong><button type="button" class="tk-link" data-tk="${esc(h.ticker)}">${esc(h.ticker)}</button></strong>${h.company && h.company !== h.ticker ? `<div class="co">${esc(h.company)}</div>` : ''}</td>
      <td>${h.shares.toLocaleString('en-US', {maximumFractionDigits: 4})}</td>
      <td>${p ? usd(p) : '<span class="sk">$000</span>'}</td>
      <td>${p ? usd(h.shares * p) : '–'}</td>
      <td>${h.avgCost > 0 ? usd(h.shares * h.avgCost) : '<span class="muted-l">–</span>'}</td>
      <td class="${r === null ? 'muted-l' : r >= 0 ? 'up' : 'down'}">${r === null ? '–' : `${(p - h.avgCost) * h.shares >= 0 ? '+' : '-'}${usd(Math.abs((p - h.avgCost) * h.shares))}<div class="co" style="color:inherit">${pct(r)}</div>`}</td>
      <td>${divData[h.ticker] ? usd(incomeOf(h), 0) : '<span class="muted-l">–</span>'}</td>
      <td>${divData[h.ticker] ? (divData[h.ticker].yield || 0).toFixed(2) + '%' : '<span class="muted-l">–</span>'}</td>
      <td>${badges || '<span class="muted-l">–</span>'}</td>
    </tr>`;
  }).join('');
}

// ─────────────────────────────────────────────
//  IMPORT: any document → holdings
// ─────────────────────────────────────────────
const LIBS = {
  // Exact versions, each checked against a fingerprint before it runs
  xlsx: ['https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', 'sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw'],
  pdf: ['https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js', 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e'],
  pdfWorker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
  ocr: ['https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js', 'sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F'],
};
function importState(s, text) {
  $('import-card').style.display = s === 'review' ? 'none' : 'block';
  $('review').style.display = s === 'review' ? 'block' : 'none';
  $('fail').style.display = s === 'fail' ? 'block' : 'none';
  $('progress').style.display = s === 'busy' ? 'flex' : 'none';
  $('drop').style.display = s === 'busy' ? 'none' : 'flex';
  if (s === 'fail' && text) $('fail-text').textContent = text;
  if (s === 'busy' && text) $('progress-text').textContent = text;
  if (s === 'fail') $('import-card').style.display = 'none';
}
function splitCSVLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur); return out;
}
function parseCSV(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  let h = -1;
  for (let i = 0; i < Math.min(15, lines.length); i++) { const l = lines[i].toLowerCase(); if ((l.includes('symbol') || l.includes('ticker')) && (l.includes('quantity') || l.includes('shares') || l.includes('qty'))) { h = i; break; } }
  if (h < 0) return [];
  const hdr = splitCSVLine(lines[h]).map(x => x.replace(/"/g, '').trim().toLowerCase());
  const find = keys => { for (const k of keys) { const i = hdr.findIndex(x => x.includes(k)); if (i >= 0) return i; } return -1; };
  const cT = find(['symbol', 'ticker']), cS = find(['quantity', 'shares', 'qty']);
  const cC = find(['avg cost', 'average cost', 'unit cost', 'cost/share', 'cost per share', 'avg price', 'cost basis']);
  const cP = find(['last price', 'current price', 'market price', 'price']), cV = find(['market value', 'current value', 'total value', 'value']);
  const cN = find(['description', 'security', 'name', 'company']);
  const num = s => parseFloat(String(s || '').replace(/[$,%\s"]/g, '').replace(/^\((.*)\)$/, '-$1'));
  const rows = [];
  for (let i = h + 1; i < lines.length; i++) {
    const c = splitCSVLine(lines[i]);
    const ticker = String(c[cT] || '').replace(/"/g, '').trim().toUpperCase();
    if (!ticker || /^\d+$/.test(ticker) || /symbol|total|account/i.test(ticker)) continue;
    const shares = num(c[cS]);
    const price = num(c[cP]) || 0, value = num(c[cV]) || 0;
    const isCash = CASH_TICKERS.has(ticker) || /money market|cash/i.test(c[cN] || '') && !(shares > 0 && price > 1.01);
    if (!(shares > 0) && !(isCash && value > 0)) continue;
    let cost = num(c[cC]) || 0;
    // Some brokers export total cost basis; convert to per-share when it is clearly a total
    if (cost && price && shares > 1 && cost > price * 5) cost = cost / shares;
    rows.push({ticker, shares: shares || 0, avgCost: cost || 0, currentPrice: price, marketValue: value || shares * price, company: cN >= 0 ? String(c[cN] || '').replace(/"/g, '').trim() : '', isCash});
  }
  return rows;
}
function redact(text) {
  let lines = String(text).split(/\r?\n/);
  // Learn the owner's name from header lines like "JANE DOE Account Number: ..." and remove it everywhere
  const names = new Set();
  lines.forEach(l => { const m = l.match(/^\s*([A-Za-z][A-Za-z .'-]{2,50}?)\s+(account\s*(number|no\.?|#)|your .{0,30}(report|statement))/i); if (m && m[1].trim().split(/\s+/).length <= 5) names.add(m[1].trim()); });
  const firstLine = lines.find(l => l.trim());
  if (firstLine && /^[A-Z][A-Za-z.'-]+(\s+[A-Z][A-Za-z.'-]+){1,3}\s*$/.test(firstLine.trim())) names.add(firstLine.trim());
  names.forEach(n => { const re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'); lines = lines.map(l => l.replace(re, '')); });
  // Statements open with the owner's name and address: skip everything before the first financial heading
  const start = lines.findIndex(l => /portfolio|summary|holdings|assets|positions|symbol|quantity|account value|net worth|balance/i.test(l) && !/account number|access code/i.test(l));
  const SENSITIVE = [
    /account\s*(number|no\.?|#)|primary account|access code|routing|social security|ssn|tax id|date of birth/i,
    /\b\d{1,6}\s+[\w .'-]{0,40}\b(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|way|court|ct|circle|cir|place|pl|parkway|pkwy|highway|hwy|apt|suite|ste|unit)\b\.?(\s+#?\w{1,6})?\s*$/i,
    /\bp\.?\s?o\.?\s*box\b/i,
    /\b[A-Z][A-Za-z .'-]+,?\s+[A-Z]{2}\s+\d{5}(-\d{4})?\b/,
    /@[\w-]+\.[\w.]+|\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/,
  ];
  return lines.slice(Math.max(0, start))
    .filter(l => !SENSITIVE.some(r => r.test(l)))
    .join('\n')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted]')
    .replace(/\b[A-Z0-9]{2,4}-[A-Z0-9]{2,4}[A-Z0-9-]*\b/g, m => /\d/.test(m) && /[A-Z]/.test(m) ? '[redacted]' : m)
    .replace(/\b[A-Z0-9]{0,4}\d{6,}[A-Z0-9-]*\b/g, '[redacted]')
    .split('\n').filter(l => /\d/.test(l) || /holdings|positions|cash|money market|deposit|equities|funds|symbol|description|quantity/i.test(l))
    .filter(l => !/^\s*(page \d|member sipc|investment products|are not fdic|important information)/i.test(l))
    .map(l => l.replace(/\s{2,}/g, ' ').trim()).filter(Boolean)
    .join('\n').slice(0, 24000);
}
async function aiExtract(text) {
  // The extraction instructions live on the server
  const req = () => getJSON(BACKEND_URL + '/api/ai', {method: 'POST', timeout: 120000, headers: {'Content-Type': 'application/json'}, body: JSON.stringify({mode: 'extract', question: redact(text)})});
  // Wake the server first, then retry once if the first try fails (cold start or a busy AI model)
  try { await getJSON(BACKEND_URL + '/health', {timeout: 60000}); } catch (e) {}
  let d;
  try { d = await req(); } catch (e) { if (e.status === 429 && /limit/i.test(e.message)) throw e; importState('busy', 'Still working, trying once more…'); await new Promise(r => setTimeout(r, 3000)); d = await req(); }
  if (d.error) throw new Error(d.error);
  const a = String(d.answer || '');
  let arr = [];
  try {
    const o = JSON.parse(a.slice(a.indexOf('{'), a.lastIndexOf('}') + 1));
    if (Array.isArray(o)) throw new Error('array');
    arr = Array.isArray(o.holdings) ? o.holdings : [];
    stmtInfo = o.statement_date && o.net_value > 0 ? {d: String(o.statement_date).slice(0, 10), v: +o.net_value} : null;
  } catch (err) {
    const s = a.indexOf('['), e = a.lastIndexOf(']');
    if (s < 0 || e < s) return [];
    try { arr = JSON.parse(a.slice(s, e + 1)); } catch (err2) { return []; }
  }
  return (Array.isArray(arr) ? arr : []).map(x => ({
    ticker: String(x.ticker || '').toUpperCase().trim(),
    shares: Number(x.shares) || 0,
    avgCost: Number(x.avgCost) || 0,
    company: String(x.name || ''),
    isCash: !!x.isCash || CASH_TICKERS.has(String(x.ticker || '').toUpperCase()),
    marketValue: Number(x.marketValue) || 0,
    apy: Number(x.apy) > 0 && Number(x.apy) < 20 ? Number(x.apy) : undefined,
  })).filter(x => x.ticker || x.isCash);
}
async function fileToText(file) {
  const name = file.name.toLowerCase(), type = file.type || '';
  if (/\.(csv|txt)$/.test(name) || type === 'text/csv') return {kind: 'csv', text: await file.text()};
  if (/\.(xlsx|xls)$/.test(name)) {
    importState('busy', 'Opening spreadsheet…');
    await loadScript(LIBS.xlsx);
    const wb = XLSX.read(await file.arrayBuffer(), {type: 'array'});
    const text = wb.SheetNames.map(n => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n');
    return {kind: 'csv', text};
  }
  if (/\.pdf$/.test(name) || type === 'application/pdf') {
    importState('busy', 'Reading PDF…');
    await loadScript(LIBS.pdf);
    pdfjsLib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
    let pdf;
    try { pdf = await pdfjsLib.getDocument({data: await file.arrayBuffer(), isEvalSupported: false}).promise; }
    catch (e) { throw new Error(/password/i.test(e.message) ? 'This PDF is password protected. Remove the password or upload a screenshot instead.' : 'This PDF could not be opened.'); }
    let text = '';
    for (let i = 1; i <= Math.min(pdf.numPages, 25); i++) {
      const c = await (await pdf.getPage(i)).getTextContent();
      let lastY = null;
      for (const it of c.items) { if (lastY !== null && Math.abs(it.transform[5] - lastY) > 2) text += '\n'; else text += ' '; text += it.str; lastY = it.transform[5]; }
      text += '\n';
    }
    if (text.replace(/\s/g, '').length < 40) throw new Error('This PDF looks like a scanned image. Upload a screenshot of it instead.');
    return {kind: 'text', text};
  }
  if (type.startsWith('image/') || /\.(png|jpe?g|webp|heic)$/.test(name)) {
    importState('busy', 'Reading screenshot…');
    await loadScript(LIBS.ocr);
    const r = await Tesseract.recognize(file, 'eng');
    const text = (r && r.data && r.data.text) || '';
    if (text.replace(/\s/g, '').length < 20) throw new Error('We couldn\'t read text in this image. Try a sharper screenshot of your positions page.');
    return {kind: 'text', text};
  }
  throw new Error('That file type isn\'t supported. Use a PDF, screenshot, spreadsheet, or CSV.');
}
async function handleFile(file) {
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) return importState('fail', 'That file is over 20 MB. Try a smaller export or a screenshot.');
  importState('busy', 'Reading your file…');
  try {
    const {kind, text} = await fileToText(file);
    let rows = kind === 'csv' ? parseCSV(text) : [];
    stmtInfo = null;
    if (!rows.length) { importState('busy', 'Finding your holdings… this can take up to a minute for long statements.'); rows = await aiExtract(text); }
    if (!rows.length) return importState('fail', 'We couldn\'t find holdings in this file. It may not be a statement, or the positions may be cut off. Try another file or add them by hand.');
    openReview(rows, file.name);
  } catch (e) {
    importState('fail', /HTTP|abort|fetch|unavailable/i.test(e.message) ? 'The reader is temporarily unavailable. Try again in a minute, or add holdings by hand.' : e.message);
  }
}
let draft = [];
let stmtInfo = null;
function openReview(rows, source) {
  draft = rows.map(r => ({...r}));
  importState('review');
  $('review-title').textContent = source ? `Found ${draft.filter(r => !r.isCash).length} holdings` : 'Your holdings';
  $('review-sub').textContent = source ? `From ${source}. Check the numbers. Nothing is saved until you confirm.` : 'Add a row for each stock or fund you own.';
  renderReview();
  $('review').scrollIntoView({behavior: reduced ? 'auto' : 'smooth', block: 'center'});
}
function rowFlags(r) {
  const f = [];
  if (!r.isCash && !/^[A-Z][A-Z0-9.\-]{0,6}$/.test(r.ticker)) f.push('ticker');
  if (!r.isCash && !(r.shares > 0)) f.push('shares');
  return f;
}
function renderReview() {
  const box = $('review-rows');
  box.innerHTML = draft.map((r, i) => {
    const f = rowFlags(r);
    return `<div class="review-row ${f.length ? 'flag' : ''}" data-i="${i}">
      <input aria-label="Ticker" class="${f.includes('ticker') ? 'f' : ''}" data-k="ticker" value="${esc(r.ticker)}" autocapitalize="characters">
      ${r.isCash
        ? `<input aria-label="Money market balance" data-k="marketValue" inputmode="decimal" value="${r.marketValue || ''}" placeholder="Balance $">`
        : `<input aria-label="Shares" class="${f.includes('shares') ? 'f' : ''}" data-k="shares" inputmode="decimal" value="${r.shares || ''}" placeholder="0">`}
      ${r.isCash ? `<input aria-label="Yield (APY %)" data-k="apy" inputmode="decimal" value="${r.apy || ''}" placeholder="APY %">` : `<input aria-label="Average cost" data-k="avgCost" inputmode="decimal" value="${r.avgCost || ''}" placeholder="Optional">`}
      <button class="icon-btn" type="button" aria-label="Remove ${esc(r.ticker || 'row')}" data-del="${i}"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>
    </div>`;
  }).join('') || '<div class="empty" style="padding:16px">No rows yet.</div>';
  const flagged = draft.filter(r => rowFlags(r).length).length;
  $('review-warn').style.display = flagged ? 'block' : 'none';
  $('review-warn').textContent = flagged ? `${flagged} ${flagged === 1 ? 'row needs' : 'rows need'} a look. Fix or remove the highlighted fields.` : '';
  box.querySelectorAll('input').forEach(inp => inp.oninput = () => {
    const i = +inp.closest('.review-row').dataset.i, k = inp.dataset.k;
    draft[i][k] = k === 'ticker' ? inp.value.toUpperCase().trim() : parseFloat(inp.value.replace(/[$,]/g, '')) || 0;
    const row = inp.closest('.review-row'), f = rowFlags(draft[i]);
    row.classList.toggle('flag', f.length > 0);
    row.querySelectorAll('input').forEach(x => x.classList.toggle('f', f.includes(x.dataset.k)));
  });
  box.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { draft.splice(+b.dataset.del, 1); renderReview(); });
}
function confirmReview() {
  const bad = draft.filter(r => rowFlags(r).length);
  if (bad.length) { $('review-warn').style.display = 'block'; $('review-warn').textContent = 'Fix or remove the highlighted rows before saving.'; return; }
  myPortfolio = draft.filter(r => r.isCash ? r.marketValue > 0 : r.shares > 0).map(r => ({...r, isCash: !!r.isCash}));
  savePortfolio();
  if (stmtInfo) saveSnap(stmtInfo.d, stmtInfo.v, 'statement');
  stmtInfo = null;
  importState('idle');
  $('file').value = '';
  refreshAll();
  $('overview').scrollIntoView({behavior: reduced ? 'auto' : 'smooth'});
}
function wireImport() {
  const drop = $('drop'), inp = $('file');
  inp.onchange = () => handleFile(inp.files[0]);
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => handleFile(e.dataTransfer.files[0]));
  const manual = () => openReview(myPortfolio.length ? myPortfolio : [{ticker: '', shares: 0, avgCost: 0}], null);
  $('manual').onclick = manual; $('fail-manual').onclick = manual; $('edit-holdings').onclick = manual;
  $('retry').onclick = () => { importState('idle'); inp.value = ''; inp.click(); };
  $('add-row').onclick = () => { draft.push({ticker: '', shares: 0, avgCost: 0}); renderReview(); };
  $('confirm').onclick = confirmReview;
  $('cancel').onclick = () => { importState('idle'); inp.value = ''; };
  $('clear-holdings').onclick = () => { if (confirm('Remove your saved portfolio from this device?')) { myPortfolio = []; savePortfolio(); delete shown.hero; refreshAll(); } };
}


// ─────────────────────────────────────────────
//  BROKER SYNC (PLAID)
// ─────────────────────────────────────────────
// Plaid's script cannot be fingerprinted (Plaid updates it in place), so it is only loaded when you tap Connect.
const PLAID_JS = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
const PLAID_KEY = 'pi.plaid.v1';
function plaidConn() { try { return JSON.parse(vget(PLAID_KEY)) || null; } catch (e) { return null; } }
function plaidUI(msg) {
  const c = plaidConn();
  $('plaid-connect').hidden = !!c; $('plaid-sync').hidden = !c; $('plaid-off').hidden = !c;
  $('plaid-text').textContent = msg || (c ? `Connected${c.accounts ? ' · ' + c.accounts : ''}${c.synced ? ' · last synced ' + new Date(c.synced + 'T12:00:00').toLocaleDateString('en-US', {month: 'short', day: 'numeric'}) : ''}.` : 'Sign in to Merrill or another broker through Plaid and your holdings sync automatically. Your login goes to Plaid, never to this app.');
}
const plaidPost = (path, body) => getJSON(BACKEND_URL + '/api/plaid/' + path, {method: 'POST', timeout: 60000, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body || {})});
async function plaidOpen(receivedRedirectUri) {
  try {
    plaidUI('Opening Plaid…');
    await loadScript(PLAID_JS);
    let token = receivedRedirectUri ? sessionStorage.getItem('pi.plaid.lt') : null;
    if (!token) { token = (await plaidPost('link-token')).link_token; try { sessionStorage.setItem('pi.plaid.lt', token); } catch (e) {} }
    const h = Plaid.create({
      token, receivedRedirectUri: receivedRedirectUri || undefined,
      onSuccess: async publicToken => {
        try {
          plaidUI('Connecting…');
          const d = await plaidPost('exchange', {public_token: publicToken});
          vset(PLAID_KEY, JSON.stringify({token: d.token}));
          try { sessionStorage.removeItem('pi.plaid.lt'); } catch (e) {}
          await plaidSync();
        } catch (e) { plaidUI(e.message); }
      },
      onExit: err => plaidUI(err ? (err.display_message || err.error_message || 'Connection was not finished.') : undefined),
    });
    h.open();
  } catch (e) { plaidUI(/not set up/i.test(e.message) ? 'Broker sync is not switched on yet. Plaid keys need to be added to the server.' : e.message); }
}
async function plaidSync() {
  const c = plaidConn(); if (!c) return plaidUI();
  plaidUI('Syncing your holdings…');
  try {
    const d = await plaidPost('holdings', {token: c.token});
    vset(PLAID_KEY, JSON.stringify({...c, accounts: d.accounts, synced: d.as_of}));
    const rows = (d.holdings || []).map(x => ({ticker: x.ticker, shares: x.shares, avgCost: x.avgCost || 0, company: x.name, isCash: x.isCash || CASH_TICKERS.has(x.ticker), marketValue: x.marketValue || 0}));
    plaidUI();
    if (!rows.length) return plaidUI('Connected, but the account has no holdings yet.');
    openReview(rows, (d.accounts || 'Broker') + ' via Plaid');
  } catch (e) { plaidUI(e.message); }
}
function wirePlaid() {
  $('plaid-connect').onclick = () => plaidOpen();
  $('plaid-sync').onclick = plaidSync;
  $('plaid-off').onclick = async () => {
    if (!confirm('Disconnect your broker? Your saved holdings stay; they just stop syncing.')) return;
    const c = plaidConn(); vset(PLAID_KEY, 'null'); try { localStorage.removeItem(PLAID_KEY); } catch (e) {}
    if (c) plaidPost('remove', {token: c.token}).catch(() => {});
    plaidUI();
  };
  plaidUI();
  // Returning from a bank's own sign-in page (OAuth)
  if (/[?&]oauth_state_id=/.test(location.search)) { plaidOpen(location.href); history.replaceState(null, '', location.pathname + location.hash); }
}

// ─────────────────────────────────────────────
//  NEWS
// ─────────────────────────────────────────────
let newsTab = null, newsCache = {};
// Group headlines about the same story so each story shows once
const STOP = new Set('the a an and or of to in on for with at by from as is are was were be its it this that after over into amid says said new will could may than more how why what who stock stocks shares market markets s'.split(' '));
function words(t) { return new Set(String(t).toLowerCase().replace(/[^a-z0-9$% ]+/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w))); }
function clusterNews(items) {
  const sorted = items.slice().sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0));
  const groups = [];
  for (const a of sorted) {
    const w = words(a.title);
    let best = null, bestScore = 0;
    for (const g of groups) {
      let shared = 0; w.forEach(x => { if (g.words.has(x)) shared++; });
      const score = shared / Math.max(1, Math.min(w.size, g.words.size));
      if (score > bestScore) { bestScore = score; best = g; }
    }
    if (best && bestScore >= 0.6 && w.size >= 3) { best.more.push(a); w.forEach(x => best.words.add(x)); }
    else groups.push({...a, words: w, more: []});
  }
  // Stories covered by more sources rank a little higher
  return groups.sort((a, b) => (b.more.length - a.more.length) * 6 * 3600e3 + (new Date(b.published || 0) - new Date(a.published || 0)));
}
function newsItem(a) {
  const href = /^https?:\/\//.test(a.link || '') ? a.link : '#';
  const when = a.published ? ago(new Date(a.published)) : '';
  const tag = a.ticker ? `<button type="button" class="news-tag tk-link" data-tk="${esc(a.ticker)}" style="text-decoration:none">${esc(a.ticker)}</button>${a.why ? `<span class="news-tag" style="background:rgba(90,107,133,.12);color:#3A4A63">${esc(a.why)}</span>` : ''}` : '';
  const others = (a.more || []).filter(o => o.source !== a.source || o.link !== a.link);
  const srcs = new Set([a.source, ...others.map(o => o.source)]);
  const more = others.length ? `<details class="news-more"><summary>Also covered by ${esc([...srcs].filter(x => x !== a.source).slice(0, 3).join(', ') || others.length + ' more')}</summary>${others.slice(0, 6).map(o => `<a href="${esc(/^https?:\/\//.test(o.link || '') ? o.link : '#')}" target="_blank" rel="noopener">${esc(o.source)}: ${esc(o.title)}</a>`).join('')}</details>` : '';
  return `<div class="news-item"><a href="${esc(href)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none"><div class="t">${esc(a.title)}</div></a><div class="m">${tag}${esc(a.source)}${a.source && when ? ' · ' : ''}${esc(when)}${srcs.size > 1 ? `<span class="src-count">${srcs.size} sources</span>` : ''}</div>${more}</div>`;
}
function newsTabs() {
  const f = [...followed()];
  const pel = [...new Set([...trades.filter(t => /pelosi/i.test(t.representative) && t.ticker).map(t => t.ticker), ...REF.pelosi.map(h => h.ticker)])].slice(0, 8);
  const cut = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const counts = {}; trades.filter(t => t.ticker && (t.filed || t.date) >= cut).forEach(t => counts[t.ticker] = (counts[t.ticker] || 0) + 1);
  const hot = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(x => x[0]);
  return [
    ['mine', 'Your stocks', f.slice(0, 12)],
    ['market', 'Top stories', null],
    ['social', 'Reddit', null],
    ['pelosi', 'Pelosi', pel],
    ['trump', 'Trump', REF.trump.map(h => h.ticker)],
    ['congress', 'Most traded', hot],
  ];
}
function whyTag(tk) {
  const f = followed(), own = stocks().some(h => h.ticker === tk);
  if (own) return 'You own';
  if (f.has(tk)) return 'Watching';
  if (REF.pelosi.some(h => h.ticker === tk)) return 'Pelosi bought';
  if (REF.trump.some(h => h.ticker === tk)) return 'Trump holds';
  const n = new Set(trades.filter(t => t.ticker === tk).map(t => t.representative)).size;
  return n ? `${n} in Congress` : '';
}
async function loadNews() {
  const tabs = newsTabs();
  if (!newsTab) newsTab = tabs[0][2].length ? 'mine' : 'market';
  $('news-tabs').innerHTML = tabs.map(([k, l]) => `<button type="button" aria-pressed="${k === newsTab}" data-n="${k}">${l}</button>`).join('');
  $('news-tabs').querySelectorAll('button').forEach(b => b.onclick = () => { newsTab = b.dataset.n; loadNews(); });
  const el = $('news-list');
  const [, , tickers] = tabs.find(t => t[0] === newsTab);
  if (newsTab === 'mine' && !tickers.length) { el.innerHTML = '<div class="empty">Add your portfolio or a watchlist to see news about your stocks.</div>'; return; }
  if (newsCache[newsTab]) { el.innerHTML = newsCache[newsTab]; return; }
  el.innerHTML = '<div class="empty">Loading headlines…</div>';
  const tab = newsTab;
  try {
    let raw;
    if (tickers) raw = (await getJSON(`${BACKEND_URL}/api/news/tickers/${tickers.join(',')}?per=4`)).articles || [];
    else {
      try { raw = (await getJSON(BACKEND_URL + '/api/feeds')).articles || []; }
      catch (e) { raw = (await getJSON(BACKEND_URL + '/api/news')).articles || []; }
      raw = raw.filter(a => tab === 'social' ? a.social : !a.social);
    }
    const items = clusterNews(raw.map(a => ({...a, why: a.ticker ? whyTag(a.ticker) : ''}))).slice(0, 14);
    if (!items.length) throw new Error('none');
    newsCache[tab] = items.map(newsItem).join('');
  } catch (e) {
    newsCache[tab] = null;
    if (tab === newsTab) el.innerHTML = '<div class="empty">Headlines are unavailable right now.</div>';
    return;
  }
  if (tab === newsTab) el.innerHTML = newsCache[tab];
}

// ─────────────────────────────────────────────
//  WATCHLIST
// ─────────────────────────────────────────────
function renderWatch() {
  $('watch-chips').innerHTML = watchlist.length
    ? watchlist.map(t => `<span class="chip-l"><button type="button" class="tk-link" data-tk="${esc(t)}" style="width:auto;height:auto;color:inherit;text-decoration:none">${esc(t)}</button><button type="button" aria-label="Remove ${esc(t)}" data-unwatch="${esc(t)}"><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button></span>`).join('')
    : '<span class="fine">Nothing yet. Add a ticker, or tap the star on any stock.</span>';
  $('watch-chips').querySelectorAll('[data-unwatch]').forEach(b => b.onclick = () => toggleWatch(b.dataset.unwatch));
}
function toggleWatch(t, on) {
  setTimeout(renderAlerts, 0);
  t = String(t || '').toUpperCase().trim();
  if (!/^[A-Z][A-Z0-9.\-]{0,7}$/.test(t)) return;
  const has = watchlist.includes(t);
  if (on === undefined) on = !has;
  watchlist = on ? (has ? watchlist : [...watchlist, t]) : watchlist.filter(x => x !== t);
  saveWatch(); renderWatch(); renderTicker(); renderFeed(); newsCache = {};
  if (newsTab === 'mine') loadNews();
  if (on && !prices[t]) loadPrices();
}

// ─────────────────────────────────────────────
//  TICKER PAGE (tap any ticker)
// ─────────────────────────────────────────────
let sheetChart = null, sheetLine = null, sheetTicker = null;
async function openTicker(tk, focusTrack) {
  tk = String(tk || '').toUpperCase(); if (!tk) return;
  sheetTicker = tk;
  const dlg = $('tk-sheet'), box = $('tk-body');
  const pos = myPortfolio.find(h => h.ticker === tk && !h.isCash);
  const tr = trades.filter(t => t.ticker === tk);
  const co = (pos && pos.company) || (tr[0] && tr[0].description) || '';
  const sector = sectorOf(tk) || (tr.find(t => t.sector) || {}).sector || '';
  const pel = REF.pelosi.find(h => h.ticker === tk), trm = REF.trump.find(h => h.ticker === tk);
  const p = prices[tk];
  const members = [...new Set(tr.map(t => t.representative))];
  const lags = tr.map(lagOf).filter(x => x !== null && x >= 0);
  box.innerHTML = `
    <div class="sheet-head">
      <div><div class="sheet-tk">${esc(tk)}</div><div class="sheet-co">${esc(co)}${sector ? ' · ' + esc(sector) : ''}</div>
        <div class="sheet-px num" id="tk-px">${p ? `${usd(p.price)} <span class="${p.change_pct >= 0 ? 'up' : 'down'}" style="font-size:16px">${pct(p.change_pct, 2)} today</span>` : '<span class="sk">$000.00</span>'}</div></div>
      <div class="sheet-btns">
        <button class="icon-d" type="button" id="tk-star" aria-pressed="${watchlist.includes(tk)}" aria-label="Watch ${esc(tk)}"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="${watchlist.includes(tk) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.3 12 2"/></svg></button>
        <button class="icon-d" type="button" id="tk-close" aria-label="Close"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button>
      </div>
    </div>
    <div id="tk-chart" style="height:180px;margin-top:14px;position:relative"><div class="chart-msg" id="tk-chart-msg">Loading chart…</div></div>
    <div class="facts" style="margin-top:14px">
      ${pos ? `<div class="fact">Your position<b class="num">${pos.shares.toLocaleString('en-US', {maximumFractionDigits: 4})} sh${p ? ' · ' + usd(pos.shares * p.price) : ''}</b></div>` : ''}
      ${pel ? `<div class="fact">Pelosi<b>Holds (est.)</b></div>` : ''}
      ${trm ? `<div class="fact">Trump<b>Holds (est.)</b></div>` : ''}
      <div class="fact">In Congress<b class="num">${members.length} member${members.length === 1 ? '' : 's'} · ${tr.length} trade${tr.length === 1 ? '' : 's'}</b></div>
      ${(() => { const ib = insiderBuys.filter(b => b.ticker === tk); return ib.length ? `<div class="fact">Insiders bought (90d)<b class="num">${compact(ib.reduce((s, b) => s + b.value, 0))} · ${ib.length} buy${ib.length === 1 ? '' : 's'}</b></div>` : ''; })()}
      ${(() => { const who = smart.investors.filter(x => x.quarters && x.quarters[0] && x.quarters[0].holdings.some(h => h.ticker === tk)).map(x => x.name.split(' ').slice(-1)[0]); return who.length ? `<div class="fact">Held by<b>${esc(who.join(', '))}</b></div>` : ''; })()}
      ${lags.length ? `<div class="fact">Avg filing delay<b class="num">${Math.round(lags.reduce((a, b) => a + b, 0) / lags.length)} days</b></div>` : ''}
    </div>
    <h3>${pos ? 'Update your position' : 'Track in your portfolio'}</h3>
    <form class="track-form" id="track-form"><label class="sr" for="track-sh">Shares</label><input id="track-sh" inputmode="decimal" placeholder="Shares" value="${pos ? pos.shares : ''}"><label class="sr" for="track-cost">Cost per share</label><input id="track-cost" inputmode="decimal" placeholder="Cost/share (opt.)" value="${pos && pos.avgCost ? pos.avgCost : ''}"><button class="btn small" type="submit">${pos ? 'Save' : 'Add'}</button><span class="track-ok" id="track-ok" aria-live="polite"></span></form>
    <h3>Congress trades</h3>
    <div>${tr.length ? tr.slice(0, 12).map(t => { const buy = /purchase/i.test(t.type); const lag = lagOf(t);
      return `<div class="trade"><div><div class="who">${esc(nameOf(t.representative))}</div><div class="what" style="font-size:15px">${buy ? 'Bought' : 'Sold'}<span class="pill ${buy ? 'buy' : 'sell'}">${esc(t.amount)}</span>${lag !== null && lag > LATE_DAYS ? '<span class="pill late">Filed late</span>' : ''}${t.committees && t.committees.length ? '<span class="pill cmte">Committee overlap</span>' : ''}</div></div><div><div class="when">Traded ${esc(t.date)}</div><div class="when">Filed ${esc(t.filed || '')}</div></div></div>`; }).join('')
      : '<div class="muted-d" style="font-size:14px;padding:8px 0">No congressional trades in this stock this year.</div>'}</div>
    <h3>News</h3>
    <div id="tk-news"><div class="muted-d" style="font-size:14px;padding:8px 0">Loading headlines…</div></div>`;
  $('tk-close').onclick = () => dlg.close();
  $('track-form').onsubmit = e => {
    e.preventDefault();
    const sh = parseFloat($('track-sh').value.replace(/,/g, '')), cost = parseFloat($('track-cost').value.replace(/[$,]/g, ''));
    if (!(sh > 0)) { $('track-ok').textContent = 'Enter a number of shares.'; $('track-ok').style.color = '#FF8A80'; return; }
    const i = myPortfolio.findIndex(h => h.ticker === tk && !h.isCash);
    const row = {ticker: tk, shares: sh, avgCost: isFinite(cost) && cost > 0 ? cost : (prices[tk] ? prices[tk].price : 0), company: co, isCash: false};
    if (i >= 0) myPortfolio[i] = {...myPortfolio[i], ...row}; else myPortfolio.push(row);
    savePortfolio(); refreshAll(); renderFeed();
    $('track-ok').style.color = ''; $('track-ok').textContent = i >= 0 ? 'Updated.' : 'Added to your portfolio.';
  };
  if (focusTrack) setTimeout(() => $('track-sh') && $('track-sh').focus(), 300);
  $('tk-star').onclick = () => { toggleWatch(tk); const on = watchlist.includes(tk); $('tk-star').setAttribute('aria-pressed', on); $('tk-star').querySelector('svg').setAttribute('fill', on ? 'currentColor' : 'none'); };
  if (!dlg.open) { dlg.showModal(); }
  sheetChart && sheetChart.remove(); sheetChart = null;
  // chart
  try {
    const d = await getJSON(`${BACKEND_URL}/api/history/${tk}?range=6mo`);
    if (sheetTicker !== tk) return;
    const pts = ((d.series || {})[tk] || []).map(([time, value]) => ({time, value}));
    if (!pts.length) throw new Error('none');
    $('tk-chart-msg').style.display = 'none';
    const up = pts[pts.length - 1].value >= pts[0].value, col = up ? '#30D158' : '#FF453A';
    sheetChart = LightweightCharts.createChart($('tk-chart'), {autoSize: true, layout: {background: {type: 'solid', color: 'transparent'}, textColor: '#9FB1CE', fontSize: 11},
      grid: {vertLines: {visible: false}, horzLines: {color: 'rgba(255,255,255,0.05)'}}, rightPriceScale: {borderVisible: false}, timeScale: {borderVisible: false, fixLeftEdge: true, fixRightEdge: true},
      crosshair: {mode: 0, horzLine: {visible: false, labelVisible: false}}, localization: {locale: 'en-US', priceFormatter: v => usd(v)}, handleScroll: false, handleScale: false});
    sheetChart.addAreaSeries({lineColor: col, topColor: up ? 'rgba(48,209,88,.25)' : 'rgba(255,69,58,.25)', bottomColor: 'rgba(0,0,0,0)', lineWidth: 2, priceLineVisible: false, lastValueVisible: false}).setData(pts);
    sheetChart.timeScale().fitContent();
  } catch (e) { if (sheetTicker === tk) $('tk-chart-msg').textContent = 'Chart unavailable right now.'; }
  // news
  try {
    const d = await getJSON(`${BACKEND_URL}/api/news/tickers/${tk}?per=5`);
    if (sheetTicker !== tk) return;
    const items = (d.articles || []).slice(0, 5);
    $('tk-news').innerHTML = items.length ? items.map(newsItem).join('') : '<div class="muted-d" style="font-size:14px;padding:8px 0">No recent headlines.</div>';
  } catch (e) { if (sheetTicker === tk) $('tk-news').innerHTML = '<div class="muted-d" style="font-size:14px;padding:8px 0">Headlines unavailable right now.</div>'; }
}
function wireTickerLinks() {
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-tk]');
    if (!el || el.closest('[data-unwatch]')) return;
    e.preventDefault(); openTicker(el.dataset.tk);
  });
  const dlg = $('tk-sheet');
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => { sheetTicker = null; sheetChart && sheetChart.remove(); sheetChart = null; });
}

// ─────────────────────────────────────────────
//  ALERTS SETUP
// ─────────────────────────────────────────────
function renderAlerts() {
  let topic = null;
  try { topic = localStorage.getItem('pi.ntfy'); } catch (e) {}
  if (!topic || topic.startsWith('portfolio-intel-')) { // older short names are replaced with a longer random one
    const rnd = (crypto.getRandomValues ? [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(36).padStart(2, '0')).join('') : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
    topic = 'pi-' + rnd.slice(0, 28);
    try { localStorage.setItem('pi.ntfy', topic); } catch (e) {}
  }
  $('ntfy-topic').textContent = topic; $('v-topic').textContent = topic;
  $('v-tickers').textContent = [...followed()].join(',') || 'NVDA,VOO';
  let rule = {};
  try { rule = JSON.parse(localStorage.getItem('pi.alertrule')) || {}; } catch (e) {}
  const last = rule.members ? rule.members.split(/\s+/).slice(-1)[0] : 'Pelosi';
  $('v-members').textContent = last;
  $('v-sectors').textContent = rule.sectors || '(optional)';
  $('v-type').textContent = rule.type || '(optional)';
  $('v-min').textContent = rule.min ? String(rule.min) : '(optional)';
}
function wireCopyButtons() {
  document.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
    const text = $(b.dataset.copy).textContent;
    try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; }
    catch (e) { const r = document.createRange(); r.selectNodeContents($(b.dataset.copy)); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); b.textContent = 'Selected'; }
    setTimeout(() => b.textContent = 'Copy', 1600);
  });
}

// ─────────────────────────────────────────────
//  SHARE CARD (image of the copy-test result)
// ─────────────────────────────────────────────
async function shareCopy() {
  if (!lastCopy) return;
  const W = 1080, H = 1080, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), font = getComputedStyle(document.body).fontFamily;
  const bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#071228'); bg.addColorStop(0.6, '#12306A'); bg.addColorStop(1, '#1F4E8F');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.fillStyle = '#9FB1CE'; g.font = `500 40px ${font}`; g.fillText(`$10,000 copying ${lastCopy.who}`, 80, 140);
  g.fillStyle = '#FFFFFF'; g.font = `600 150px ${font}`; g.fillText(usd(lastCopy.end, 0), 80, 300);
  g.font = `600 52px ${font}`; g.fillStyle = lastCopy.r >= 0 ? '#30D158' : '#FF453A'; g.fillText(pct(lastCopy.r), 80, 380);
  g.fillStyle = '#C7D2E3'; g.font = `500 44px ${font}`; g.fillText(`vs VOO ${pct(lastCopy.vr)}`, 80 + g.measureText(pct(lastCopy.r) + '   ').width * 1.15, 380);
  // chart
  const x0 = 80, x1 = W - 80, y0 = 470, y1 = 900, all = [...lastCopy.copySeries, ...lastCopy.vooSeries].map(p => p.value);
  const lo = Math.min(...all), hi = Math.max(...all), n = lastCopy.copySeries.length;
  const X = i => x0 + (x1 - x0) * i / Math.max(1, n - 1), Y = v => y1 - (y1 - y0) * (v - lo) / Math.max(1, hi - lo);
  const line = (pts, col, w, dash) => { g.beginPath(); g.setLineDash(dash || []); pts.forEach((p, i) => i ? g.lineTo(X(i), Y(p.value)) : g.moveTo(X(i), Y(p.value))); g.strokeStyle = col; g.lineWidth = w; g.lineJoin = 'round'; g.stroke(); g.setLineDash([]); };
  line(lastCopy.vooSeries, '#8E9BB3', 5, [14, 12]); line(lastCopy.copySeries, '#0A84FF', 8);
  g.fillStyle = '#9FB1CE'; g.font = `500 32px ${font}`;
  g.fillText(`Since ${new Date(lastCopy.start + 'T12:00:00').toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'})} · following filings`, 80, 980);
  g.fillText('Portfolio Intel · not investment advice', 80, 1030);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const file = new File([blob], 'portfolio-intel-copy-test.png', {type: 'image/png'});
  try {
    if (navigator.canShare && navigator.canShare({files: [file]})) { await navigator.share({files: [file], title: 'Portfolio Intel'}); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ─────────────────────────────────────────────
//  PASSCODE LOCK (optional)
// ─────────────────────────────────────────────
const LOCK_KEY = 'pi.lock.v1', AWAY_MS = 5 * 60 * 1000;
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function hashPass(pass, salt, iter) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter}, key, 256));
}
function lockConf() { try { return JSON.parse(localStorage.getItem(LOCK_KEY)); } catch (e) { return null; } }
function showLock(on) {
  if (on && VAULT.key) { VAULT.key = null; VAULT.cache = {}; try { sessionStorage.removeItem('pi.vk'); } catch (e) {} myPortfolio = []; snapshots = []; }
  document.body.classList.toggle('locked', on);
  $('lock').hidden = !on;
  if (on) { $('lock-in').value = ''; $('lock-err').textContent = ''; setTimeout(() => $('lock-in').focus(), 50); $('tk-sheet').open && $('tk-sheet').close(); }
}
let lockFails = 0, lockUntil = 0;
function wireLock() {
  const conf = lockConf();
  $('lock-set').textContent = conf ? 'Change passcode' : 'Set passcode';
  let unlockedAt = 0;
  try { unlockedAt = +sessionStorage.getItem('pi.unlocked') || 0; } catch (e) {}
  if (conf && Date.now() - unlockedAt > AWAY_MS) showLock(true);
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (lockConf() && hiddenAt && Date.now() - hiddenAt > AWAY_MS) showLock(true);
  });
  $('lock-form').onsubmit = async e => {
    e.preventDefault();
    const c = lockConf(); if (!c) return showLock(false);
    if (Date.now() < lockUntil) { $('lock-err').textContent = `Too many tries. Wait ${Math.ceil((lockUntil - Date.now()) / 1000)} seconds.`; return; }
    const ok = await hashPass($('lock-in').value, unb64(c.salt), c.iter) === c.hash;
    if (ok) {
      lockFails = 0; try { sessionStorage.setItem('pi.unlocked', String(Date.now())); } catch (e2) {}
      if (c.encSalt) { await vaultUse(await vaultDerive($('lock-in').value, unb64(c.encSalt))); location.reload(); return; }
      // Older passcode without encryption: turn it on now
      try { c.encSalt = await vaultSeal($('lock-in').value); localStorage.setItem(LOCK_KEY, JSON.stringify(c)); } catch (e2) {}
      showLock(false);
    }
    else { lockFails++; $('lock-in').value = ''; if (lockFails >= 5) { lockUntil = Date.now() + 30000; lockFails = 0; } $('lock-err').textContent = Date.now() < lockUntil ? 'Too many tries. Wait 30 seconds.' : 'Wrong passcode.'; }
  };
  $('lock-forgot').onclick = () => {
    if (!confirm('Forgot your passcode? This removes the passcode and all Portfolio Intel data saved on this device (portfolio, watchlist, flags, notes). It cannot be undone.')) return;
    try { Object.keys(localStorage).filter(k => k.startsWith('pi.')).forEach(k => localStorage.removeItem(k)); sessionStorage.clear(); } catch (e) {}
    location.reload();
  };
  const dlg = $('pass-dlg');
  $('lock-set').onclick = () => { $('pass-1').value = ''; $('pass-2').value = ''; $('pass-err').textContent = ''; $('pass-off').style.display = lockConf() ? '' : 'none'; dlg.showModal(); };
  $('pass-cancel').onclick = () => dlg.close();
  $('pass-off').onclick = () => { vaultUnseal(); try { localStorage.removeItem(LOCK_KEY); } catch (e) {} $('lock-set').textContent = 'Set passcode'; dlg.close(); };
  $('pass-form').onsubmit = async e => {
    e.preventDefault();
    const a = $('pass-1').value, b = $('pass-2').value;
    if (a.length < 4) { $('pass-err').textContent = 'Use at least 4 characters.'; return; }
    if (a !== b) { $('pass-err').textContent = 'Passcodes don\'t match.'; return; }
    const salt = crypto.getRandomValues(new Uint8Array(16)), iter = 210000;
    try { const encSalt = await vaultSeal(a); localStorage.setItem(LOCK_KEY, JSON.stringify({salt: b64(salt), iter, hash: await hashPass(a, salt, iter), encSalt})); sessionStorage.setItem('pi.unlocked', String(Date.now())); }
    catch (err) { $('pass-err').textContent = 'Couldn\'t save on this device.'; return; }
    $('lock-set').textContent = 'Change passcode'; dlg.close();
  };
}

// ─────────────────────────────────────────────
//  ASK
// ─────────────────────────────────────────────
const PRESETS = ['Should I follow Pelosi\'s trades?', 'Which of my stocks is Congress buying?', 'Compare my risk to Trump\'s portfolio', 'What sectors is Congress buying this month?'];
// Everything the assistant knows: the same live data shown on the page
function buildContext() {
  const L = [];
  L.push(`Today: ${new Date().toISOString().slice(0, 10)}.`);
  const priceCtx = Object.entries(prices).slice(0, 45).map(([t, p]) => `${t} $${p.price} (${pct(p.change_pct, 2)})`).join(', ');
  if (priceCtx) L.push(`Live prices (change is the latest session): ${priceCtx}`);
  if (myPortfolio.length) {
    const tot = myPortfolio.reduce((s, h) => s + valueOf(h), 0);
    L.push(`USER PORTFOLIO, total ${usd(tot)}:`);
    myPortfolio.forEach(h => {
      if (h.isCash) L.push(`- ${h.ticker} (cash/money market): ${usd(h.marketValue || 0)}${h.apy ? ` earning ${h.apy}% APY (${usd(incomeOf(h), 0)}/yr)` : ', yield unknown'}`);
      else { const p = priceOf(h.ticker, 0); L.push(`- ${h.ticker}: ${h.shares} sh, value ${usd(valueOf(h))}${h.avgCost ? `, cost ${usd(h.avgCost)}/sh, gain ${pct((p - h.avgCost) / h.avgCost * 100)}` : ''}${divData[h.ticker] ? `, dividend yield ${divData[h.ticker].yield}%` : ''}, ${classOf(h)}`); }
    });
    const inc = myPortfolio.reduce((s, h) => s + incomeOf(h), 0);
    const cls = {}; myPortfolio.forEach(h => cls[classOf(h)] = (cls[classOf(h)] || 0) + valueOf(h));
    L.push(`Allocation: ${Object.entries(cls).map(([k, v]) => `${k} ${(v / tot * 100).toFixed(1)}%`).join(', ')}. Estimated annual income ${usd(inc, 0)}.`);
    const snapStmt = snapshots.filter(x => x.src === 'statement').pop();
    if (snapStmt) L.push(`Last uploaded statement: ${usd(snapStmt.v)} on ${snapStmt.d}.`);
  } else L.push('User has not added a portfolio yet.');
  if (watchlist.length) L.push(`Watchlist: ${watchlist.join(', ')}`);
  if (Object.keys(lastReturns).length) L.push(`Chart returns over ${range}: ` + Object.entries(lastReturns).map(([k, v]) => `${k} ${pct(v)}`).join(', '));
  if (yields && yields.curve) L.push(`Treasury yields ${yields.date}: ` + Object.entries(yields.curve).map(([k, v]) => `${k} ${v}%`).join(', '));
  try {
    const opts = cashOptions().filter(o => !o.promo).sort((x, y) => y.apy - x.apy).slice(0, 8);
    if (opts.length) L.push('Cash options: ' + opts.map(o => `${o.name.split(' · ')[0]} ${o.apy}%${o.min ? ` (min ${usd(o.min, 0)})` : ''}${o.cap ? ` (only first ${usd(o.cap, 0)})` : ''} [${o.catName}]`).join('; '));
  } catch (e) {}
  L.push(`Pelosi basket (stocks bought in her filings and not sold since; not her full portfolio): ${REF.pelosi.map(h => h.ticker).join(', ')}. Trump disclosed public stock (SEC filings; other assets private): ${REF.trump.map(h => h.ticker).join(', ')}.`);
  const tr = trades.slice(0, 50).map(t => `${t.filed || t.date} ${nameOf(t.representative)} ${/purchase/i.test(t.type) ? 'BUY' : 'SELL'} ${t.ticker || t.description + ' (private)'} ${t.amount}${t.committees && t.committees.length ? ' [committee overlap]' : ''}`);
  if (tr.length) L.push('Recent congressional filings (newest first):\n' + tr.join('\n'));
  if (insiderBuys.length) L.push('Recent insider purchases: ' + insiderBuys.slice(0, 12).map(b => `${b.ticker} ${compact(b.value)} by ${b.role} (${b.filed})`).join('; '));
  const invs = (smart.investors || []).filter(x => x.quarters && x.quarters[0]);
  if (invs.length) L.push('Famous investors top holdings: ' + invs.map(x => `${x.name}: ${x.quarters[0].holdings.slice(0, 5).map(h => h.ticker || h.name).join(', ')}`).join('; '));
  return L.join('\n').slice(0, 14000);
}
// The assistant's instructions live on the server (backend/main.py, AI_MODES).
async function askAI(question, history) {
  const convo = (history || []).slice(-8).map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`).join('\n');
  const d = await getJSON(BACKEND_URL + '/api/ai', {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({mode: 'assistant', context: buildContext(), question: (convo ? 'Conversation so far:\n' + convo + '\n\nNew question: ' : '') + question})});
  if (d.error) throw new Error(d.error);
  return (d.answer || 'No answer came back. Try rephrasing.').replace(/\*\*|__|^#+\s/gm, '').trim();
}
async function ask(q) {
  q = (q || '').trim(); if (!q) return;
  const btn = $('ask-go'), out = $('answer');
  btn.disabled = true; btn.textContent = 'Thinking…'; out.textContent = '';
  try { out.textContent = await askAI(q); }
  catch (e) { out.textContent = 'The assistant is unavailable right now. Try again in a minute.'; }
  btn.disabled = false; btn.textContent = 'Ask';
}

// ─────────────────────────────────────────────
//  FLOATING ASSISTANT (pop-up chat)
// ─────────────────────────────────────────────
let chat = [];
try { chat = JSON.parse(sessionStorage.getItem('pi.chat')) || []; } catch (e) {}
function chatSuggestions() {
  const s = [];
  if (myPortfolio.length) {
    if (myPortfolio.some(h => h.isCash)) s.push('How much more could my cash earn?');
    s.push('Am I too heavy in cash?', 'Which of my stocks is Congress trading?', 'Explain my risk level');
  } else s.push('How do I add my portfolio?');
  s.push('What is Congress buying this month?', 'Who is the best politician to copy?', 'Any big insider buys this week?');
  return s.slice(0, 5);
}
function renderChat() {
  const box = $('as-msgs');
  if (!chat.length) {
    box.innerHTML = `<div class="as-hello"><div class="as-hi">Hi, how can I help?</div><div class="as-sub">I can see your portfolio, live prices, Congress filings, insider buys and cash rates.</div>
      <div class="as-chips">${chatSuggestions().map(q => `<button type="button" class="as-chip">${esc(q)}</button>`).join('')}</div></div>`;
    box.querySelectorAll('.as-chip').forEach(b => b.onclick = () => sendChat(b.textContent));
  } else {
    box.innerHTML = chat.map(m => `<div class="as-m ${m.role}">${m.role === 'bot' ? '' : ''}<div class="as-b">${esc(m.text)}</div></div>`).join('')
      + (chat.busy ? '<div class="as-m bot"><div class="as-b as-typing" aria-label="Thinking"><span></span><span></span><span></span></div></div>' : '');
  }
  box.scrollTop = box.scrollHeight;
  try { sessionStorage.setItem('pi.chat', JSON.stringify(chat.slice(-30))); } catch (e) {}
}
async function sendChat(q) {
  q = (q || '').trim(); if (!q || chat.busy) return;
  const hist = chat.slice();
  chat.push({role: 'user', text: q}); chat.busy = true; renderChat();
  $('as-in').value = ''; $('as-send').disabled = true;
  try { chat.push({role: 'bot', text: await askAI(q, hist)}); }
  catch (e) { chat.push({role: 'bot', text: e.status === 429 ? e.message : 'I can\'t reach the assistant right now. Try again in a minute.'}); }
  chat.busy = false; $('as-send').disabled = false; renderChat();
  if (matchMedia('(hover: hover)').matches) $('as-in').focus();
}
function openAssist(open) {
  const panel = $('as-panel'), fab = $('as-fab');
  const on = open === undefined ? panel.hidden : open;
  panel.hidden = !on; fab.setAttribute('aria-expanded', on);
  fab.classList.toggle('open', on);
  if (on) { renderChat(); setTimeout(() => { if (matchMedia('(hover: hover)').matches) $('as-in').focus(); }, 50); }
  else fab.focus();
}
function wireAssist() {
  $('as-fab').onclick = () => openAssist();
  $('as-close').onclick = () => openAssist(false);
  $('as-clear').onclick = () => { chat = []; renderChat(); };
  $('as-form').onsubmit = e => { e.preventDefault(); sendChat($('as-in').value); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('as-panel').hidden) openAssist(false); });
  // Tap or click anywhere outside the chat to close it
  document.addEventListener('pointerdown', e => { if (!$('as-panel').hidden && !e.target.closest('#as-panel, #as-fab, #tk-sheet')) openAssist(false); });
}

function wireAsk() {
  $('presets').innerHTML = [...new Set([...chatSuggestions().slice(0, 3), ...PRESETS])].slice(0, 5).map(p => `<button class="preset" type="button">${esc(p)}</button>`).join('');
  $('presets').querySelectorAll('.preset').forEach(b => b.onclick = () => { $('ask-q').value = b.textContent; ask(b.textContent); });
  $('ask-form').onsubmit = e => { e.preventDefault(); ask($('ask-q').value); };
}

// ─────────────────────────────────────────────
//  SIGNALS (computed, not hardcoded)
// ─────────────────────────────────────────────
function renderSignals() {
  const out = [];
  const share = (list, sector) => {
    const tot = list.reduce((s, h) => s + h.shares * priceOf(h.ticker, h.cost), 0);
    const part = list.filter(h => h.sector === sector).reduce((s, h) => s + h.shares * priceOf(h.ticker, h.cost), 0);
    return tot ? part / tot * 100 : 0;
  };
  if (Object.keys(prices).length) {
    out.push({h: `Pelosi is ${share(REF.pelosi, 'Technology').toFixed(0)}% tech`, p: `Her recent buys lean on ${REF.pelosi.filter(h => h.sector === 'Technology').map(h => h.ticker).slice(0, 4).join(', ')}.`});
    if (prices.DJT) out.push({h: `Trump's DJT stake: ${compact(REF.trump[0].shares * prices.DJT.price)}`, p: `His only disclosed public stock, ${pct(prices.DJT.change_pct, 2)} today. His other assets are private.`});
  }
  if (trades.length) {
    const cut = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const counts = {};
    const who = {};
    trades.filter(t => t.ticker && (t.filed || t.date) >= cut && /purchase/i.test(t.type || '')).forEach(t => { counts[t.ticker] = (counts[t.ticker] || 0) + 1; (who[t.ticker] = who[t.ticker] || new Set()).add(t.representative); });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (top) out.push({h: `Most bought this month: ${top[0]}`, p: `${top[1]} purchases filed in the last 30 days by ${who[top[0]].size} member${who[top[0]].size === 1 ? '' : 's'} of Congress.`});
    const ib = insiderBuys.filter(b => b.filed >= cut).sort((a, b) => b.value - a.value)[0];
    if (ib) out.push({h: `Biggest insider buy: ${ib.ticker}`, p: `${ib.owner} (${ib.role}) bought ${compact(ib.value)} of ${ib.company} stock, filed ${ib.filed}.`});
  }
  const mine = stocks();
  if (mine.length && trades.length) {
    const hit = mine.filter(h => tradersOf(h.ticker) > 0);
    out.push({h: `${hit.length} of your ${mine.length} stocks`, p: hit.length ? `Members of Congress filed trades in ${hit.slice(0, 5).map(h => h.ticker).join(', ')}.` : 'None of your stocks appear in recent filings.'});
  }
  if (lastReturns.me !== undefined && lastReturns.voo !== undefined && mine.length) {
    const d = lastReturns.me - lastReturns.voo;
    out.push({h: d >= 0 ? `Beating the S&P by ${d.toFixed(1)} pts` : `Trailing the S&P by ${Math.abs(d).toFixed(1)} pts`, p: `Over the selected period, compared with VOO.`});
  }
  $('signal-list').innerHTML = out.length
    ? out.slice(0, 6).map(s => `<article class="signal"><h3>${esc(s.h)}</h3><p>${esc(s.p)}</p></article>`).join('')
    : '<article class="signal"><h3>Gathering data</h3><p>Signals appear once prices and filings load.</p></article>';
}

// ─────────────────────────────────────────────
//  TICKER BANNER
// ─────────────────────────────────────────────
const ARROW_UP = '<svg aria-hidden="true" width="9" height="9" viewBox="0 0 10 10"><path d="M5 1 9 8H1z" fill="currentColor"/></svg>';
const ARROW_DN = '<svg aria-hidden="true" width="9" height="9" viewBox="0 0 10 10"><path d="M5 9 1 2h8z" fill="currentColor"/></svg>';
function renderTicker() {
  const order = [...new Set(['SPY', 'QQQ', 'DIA', 'VOO', ...stocks().map(h => h.ticker), ...watchlist, ...REF.pelosi.map(h => h.ticker), ...REF.trump.map(h => h.ticker)])];
  const items = order.filter(t => prices[t]).map(t => {
    const p = prices[t], up = p.change_pct >= 0;
    return `<span class="tk" data-tk="${esc(t)}"><b>${esc(t)}</b>${usd(p.price)}<span class="${up ? 'up' : 'down'}">${up ? ARROW_UP : ARROW_DN} ${Math.abs(p.change_pct).toFixed(2)}%</span></span>`;
  }).join('');
  const track = $('ticker-track');
  if (!items) { track.innerHTML = '<span class="tk">Loading prices…</span>'; track.style.animation = 'none'; return; }
  // Two copies side by side so the loop is seamless; speed scales with length
  track.innerHTML = items + items.replace(/class="tk"/g, 'class="tk" aria-hidden="true"');
  track.style.animation = '';
  track.style.setProperty('--dur', Math.max(30, order.length * 3.2) + 's');
  if (reduced) { track.style.animation = 'none'; $('ticker').style.overflowX = 'auto'; }
}

// ─────────────────────────────────────────────
//  INDUSTRY MIX (donut)
// ─────────────────────────────────────────────
function sectorOf(t) { return (sectorCache[t] && sectorCache[t].sector) || SECTOR_OF[t] || null; }
async function loadSectors() {
  const need = stocks().map(h => h.ticker).filter(t => !sectorOf(t));
  if (!need.length) return;
  try {
    const d = await getJSON(BACKEND_URL + '/api/sectors/' + need.join(','));
    Object.assign(sectorCache, d.sectors || {});
    try { localStorage.setItem(SECTOR_KEY, JSON.stringify(sectorCache)); } catch (e) {}
  } catch (e) {}
  renderMix();
}
function mixData(who) {
  const list = who === 'pelosi' ? REF.pelosi.map(h => ({ticker: h.ticker, value: h.shares * priceOf(h.ticker, h.cost), sector: h.sector}))
    : who === 'trump' ? REF.trump.map(h => ({ticker: h.ticker, value: h.shares * priceOf(h.ticker, h.cost), sector: h.sector}))
    : myPortfolio.map(h => h.isCash
        ? {ticker: h.ticker, value: h.marketValue || 0, sector: 'Money market'}
        : {ticker: h.ticker, value: h.shares * priceOf(h.ticker, h.currentPrice || h.avgCost || 0), sector: sectorOf(h.ticker) || 'Other'});
  const groups = {};
  list.filter(x => x.value > 0).forEach(x => { (groups[x.sector] = groups[x.sector] || {sector: x.sector, value: 0, tickers: []}); groups[x.sector].value += x.value; groups[x.sector].tickers.push(x); });
  let arr = Object.values(groups).sort((a, b) => b.value - a.value);
  // Keep at most 7 named slices; fold the rest into Other. Money market and Other always sit last in gray tones.
  const tail = arr.filter(g => g.sector === 'Money market' || g.sector === 'Other');
  let named = arr.filter(g => g.sector !== 'Money market' && g.sector !== 'Other');
  if (named.length > 7) {
    const extra = named.slice(7); named = named.slice(0, 7);
    const other = tail.find(g => g.sector === 'Other') || (tail.push({sector: 'Other', value: 0, tickers: []}), tail[tail.length - 1]);
    extra.forEach(g => { other.value += g.value; other.tickers.push(...g.tickers); });
  }
  arr = [...named.map((g, i) => ({...g, color: MIX_COLORS[i]})), ...tail.sort((a, b) => a.sector === 'Money market' ? 1 : -1).map(g => ({...g, color: g.sector === 'Money market' ? '#C7D2E3' : '#6E7F9C'}))];
  const total = arr.reduce((s, g) => s + g.value, 0);
  return {groups: arr.map(g => ({...g, pct: total ? g.value / total * 100 : 0, tickers: g.tickers.sort((a, b) => b.value - a.value).map(x => x.ticker)})), total};
}
function renderMix() {
  const who = [['me', 'You'], ['pelosi', 'Pelosi'], ['trump', 'Trump']];
  $('mix-who').innerHTML = who.map(([k, l]) => `<button type="button" aria-pressed="${k === mixWho}" data-w="${k}">${l}</button>`).join('');
  $('mix-who').querySelectorAll('button').forEach(b => b.onclick = () => { mixWho = b.dataset.w; mixHot = null; renderMix(); });

  const svg = $('donut'), legend = $('mix-legend'), center = $('donut-center');
  if (mixWho === 'me' && !myPortfolio.length) {
    svg.innerHTML = '<circle cx="100" cy="100" r="70" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="34"/>';
    center.innerHTML = '<div class="small">No holdings yet</div>';
    legend.innerHTML = '<div class="muted-d" style="font-size:15px;line-height:1.5;padding:8px">Add your portfolio to see how it splits across industries. <a href="#import" style="color:#8EC5FF">Add portfolio</a></div>';
    return;
  }
  const {groups, total} = mixData(mixWho);
  if (!total) {
    svg.innerHTML = '<circle cx="100" cy="100" r="70" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="34"/>';
    center.innerHTML = '<div class="small">Waiting for prices</div>'; legend.innerHTML = ''; return;
  }
  const R = 70, C = 2 * Math.PI * R, gap = groups.length > 1 ? 1.2 : 0;
  let off = 0;
  svg.innerHTML = groups.map((g, i) => {
    const len = Math.max(0, g.pct / 100 * C - gap);
    const el = `<circle class="seg${mixHot === null ? '' : mixHot === i ? ' hot' : ' dim'}" data-i="${i}" cx="100" cy="100" r="${R}" stroke="${g.color}" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}"><title>${esc(g.sector)} ${g.pct.toFixed(1)}%</title></circle>`;
    off += g.pct / 100 * C;
    return el;
  }).join('');
  const h = mixHot !== null ? groups[mixHot] : null;
  center.innerHTML = h
    ? `<div class="big num">${h.pct.toFixed(1)}%</div><div class="small">${esc(h.sector)}</div>`
    : `<div class="big num">${compact(total)}</div><div class="small">${groups.length} ${groups.length === 1 ? 'industry' : 'industries'}</div>`;
  legend.innerHTML = groups.map((g, i) => `<button type="button" class="mix-row${mixHot === i ? ' hot' : ''}" data-i="${i}">
      <span class="sw" style="background:${g.color}"></span><span>${esc(g.sector)}</span><span class="pc">${g.pct.toFixed(1)}%</span><span class="dl">${compact(g.value)}</span>
      <span class="tks">${esc(g.tickers.slice(0, 6).join(', '))}${g.tickers.length > 6 ? ` +${g.tickers.length - 6}` : ''}</span>
    </button>`).join('');
  const pick = i => { mixHot = mixHot === i ? null : i; renderMix(); };
  svg.querySelectorAll('.seg').forEach(c => { c.onclick = () => pick(+c.dataset.i); c.onmouseenter = () => { if (mixHot !== +c.dataset.i) { mixHot = +c.dataset.i; renderMix(); } }; });
  svg.onmouseleave = () => { if (mixHot !== null) { mixHot = null; renderMix(); } };
  legend.querySelectorAll('.mix-row').forEach(b => b.onclick = () => pick(+b.dataset.i));
  $('mix-desc').textContent = 'Industry breakdown: ' + groups.map(g => `${g.sector} ${g.pct.toFixed(0)}%`).join(', ');
}

// ─────────────────────────────────────────────
//  MOTION: reveal on scroll
// ─────────────────────────────────────────────
// Highlight the nav link for the section on screen, and keep it visible in the phone's swipe row
// ─────────────────────────────────────────────
//  COPY TEST: what if you'd followed Pelosi's filings
// ─────────────────────────────────────────────
// Shared one-year daily price history, fetched in batches and reused
const hist1y = {};
async function ensureHistory(tickers) {
  const need = [...new Set(tickers)].filter(t => !(t in hist1y));
  for (let i = 0; i < need.length; i += 40) {
    const batch = need.slice(i, i + 40);
    const d = await getJSON(`${BACKEND_URL}/api/history/${batch.join(',')}?range=1y`);
    batch.forEach(t => { hist1y[t] = (d.series || {})[t] || []; });
  }
}
const dayOf = ts => new Date(ts * 1000).toISOString().slice(0, 10);
const nameOf = rep => {
  if (!rep) return 'Unknown';
  const [last, first = ''] = rep.split(/,(.*)/s);
  const words = first.split(/\s+/).filter(w => w && !/^(dr|hon|mr|mrs|ms|the)\.?$/i.test(w));
  const isSuffix = w => /^(jr|sr|ii|iii|iv)\.?$/i.test(w);
  const suffix = words.filter(isSuffix).map(w => w.replace(/\.$/, '').replace(/^(jr|sr)$/i, m => m[0].toUpperCase() + m.slice(1).toLowerCase() + '.'));
  return [...words.filter(w => !isSuffix(w)), last.trim(), ...suffix].join(' ').replace(/\s+/g, ' ').trim();
};
const lagOf = t => t.date && t.filed ? Math.round((new Date(t.filed) - new Date(t.date)) / 864e5) : null;
const LATE_DAYS = 45;
function memberTrades(rep) {
  const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  return trades.filter(t => t.representative === rep && t.ticker && t.filed && t.filed >= yearAgo && /purchase|sale/i.test(t.type || ''));
}
// Follow one member's filings with $10,000, acting on each filing date
// A copy plan: which tickers, and what to do on each filing date
function planFor(key) {
  if (key.startsWith('inv:')) {
    const inv = smart.investors.find(x => 'inv:' + x.id === key);
    if (!inv) return null;
    const yearAgo = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
    const qs = inv.quarters.filter(q => q.filed >= yearAgo).slice().reverse();
    const steps = qs.map(q => ({date: q.filed, weights: Object.fromEntries(q.holdings.filter(h => h.ticker).slice(0, 25).map(h => [h.ticker, h.pct]))}));
    return {steps, tickers: [...new Set(steps.flatMap(s => Object.keys(s.weights)))]};
  }
  const mine = memberTrades(key);
  return {steps: mine.map(t => ({date: t.filed, buy: /purchase/i.test(t.type) ? t.ticker : null, sell: /purchase/i.test(t.type) ? null : t.ticker})), tickers: [...new Set(mine.map(t => t.ticker))]};
}
function simulate(key) {
  const plan = planFor(key);
  const voo = hist1y.VOO || [];
  if (!plan || !plan.steps.length || !voo.length) return null;
  const tickers = plan.tickers;
  const days = voo.map(p => dayOf(p[0]));
  const close = {};
  for (const t of ['VOO', ...tickers]) {
    const m = new Map((hist1y[t] || []).map(p => [dayOf(p[0]), p[1]]));
    let last = null;
    close[t] = days.map(d => (m.has(d) ? (last = m.get(d)) : last));
  }
  const events = new Map();
  for (const st of plan.steps) {
    const i = days.findIndex(d => d >= st.date);
    if (i < 0) continue;
    const e = events.get(i) || {buy: new Set(), sell: new Set(), weights: null};
    if (st.weights) e.weights = st.weights;
    if (st.buy) e.buy.add(st.buy);
    if (st.sell) e.sell.add(st.sell);
    events.set(i, e);
  }
  if (!events.size) return null;
  const startIdx = Math.min(...events.keys());
  let cash = 10000, held = {}, followed = 0;
  const skipped = new Set(), copySeries = [], vooSeries = [];
  const vooShares = 10000 / close.VOO[startIdx];
  for (let i = startIdx; i < days.length; i++) {
    const value = () => cash + Object.entries(held).reduce((s, [t, sh]) => s + sh * (close[t][i] || 0), 0);
    const e = events.get(i);
    if (e && e.weights) {
      // Investor filing: match their portfolio weights
      const total = value();
      const avail = Object.entries(e.weights).filter(([t]) => { const ok = close[t] && close[t][i]; if (!ok) skipped.add(t); return ok; });
      const sum = avail.reduce((s, [, w]) => s + w, 0);
      held = {}; cash = total; followed += avail.length;
      if (sum > 0) { avail.forEach(([t, w]) => { held[t] = total * (w / sum) / close[t][i]; }); cash = 0; }
    } else if (e) {
      const keep = new Set(Object.keys(held));
      e.sell.forEach(t => keep.delete(t));
      e.buy.forEach(t => { if (close[t] && close[t][i]) keep.add(t); else skipped.add(t); });
      followed += e.buy.size + e.sell.size;
      const total = value();
      held = {}; cash = total;
      if (keep.size) { const each = total / keep.size; keep.forEach(t => { held[t] = each / close[t][i]; }); cash = 0; }
    }
    copySeries.push({time: voo[i][0], value: value()});
    vooSeries.push({time: voo[i][0], value: vooShares * close.VOO[i]});
  }
  const end = copySeries[copySeries.length - 1].value, vooEnd = vooSeries[vooSeries.length - 1].value;
  return {copySeries, vooSeries, end, vooEnd, r: (end / 10000 - 1) * 100, vr: (vooEnd / 10000 - 1) * 100,
          followed, filings: events.size, held: Object.keys(held), skipped: [...skipped], start: days[startIdx]};
}

let copyChart = null, copyLines = [], copyMember = null, lastCopy = null;
const keyName = k => k.startsWith('inv:') ? ((smart.investors.find(x => 'inv:' + x.id === k) || {}).name || 'Investor') : nameOf(k);
const keyShort = k => k.startsWith('inv:') ? keyName(k).split(' ').slice(-1)[0] : k.split(',')[0].trim();
function copyCandidates() {
  const counts = {};
  trades.forEach(t => { if (t.ticker && t.filed) counts[t.representative] = (counts[t.representative] || 0) + 1; });
  return Object.entries(counts).filter(([rep]) => memberTrades(rep).length).sort((a, b) => b[1] - a[1]).map(([rep]) => rep);
}
async function runCopyTest(rep) {
  const msg = $('copy-msg');
  const cands = copyCandidates();
  if (!cands.length) { msg.textContent = trades.length ? 'No stock filings in the past year.' : 'Waiting for disclosures…'; return; }
  copyMember = rep || copyMember || cands.find(r => /pelosi/i.test(r)) || cands[0];
  const sel = $('copy-member');
  const list = [...new Set([...(copyMember.startsWith('inv:') ? [] : [copyMember]), ...cands.slice(0, 40)])].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const invs = smart.investors.filter(x => x.quarters && x.quarters.length);
  sel.innerHTML = (invs.length ? `<optgroup label="Famous investors">${invs.map(x => `<option value="inv:${esc(x.id)}"${'inv:' + x.id === copyMember ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>` : '')
    + `<optgroup label="Congress">${list.map(r => `<option value="${esc(r)}"${r === copyMember ? ' selected' : ''}>${esc(nameOf(r))}</option>`).join('')}</optgroup>`;
  const who = keyName(copyMember);
  $('copy-title').textContent = `What if you copied ${keyShort(copyMember)}?`;
  $('copy-name').textContent = `Copying ${who}`;
  msg.style.display = 'flex'; msg.textContent = 'Running the numbers…';
  try { await ensureHistory(['VOO', ...((planFor(copyMember) || {}).tickers || [])]); }
  catch (e) { msg.textContent = 'Price history is unavailable right now. It will retry shortly.'; setTimeout(() => runCopyTest(), 60000); return; }
  const res = simulate(copyMember);
  if (!res) { msg.textContent = 'No filings fall inside the price history yet.'; return; }
  lastCopy = {...res, who};
  animateTo($('copy-val'), 'copy', res.end, x => usd(x, 0));
  animateTo($('copy-voo'), 'copyvoo', res.vooEnd, x => usd(x, 0));
  $('copy-ret').innerHTML = `<span class="${res.r >= 0 ? 'up' : 'down'}">${pct(res.r)}</span> <span class="muted-d">${res.r - res.vr >= 0 ? 'ahead of' : 'behind'} VOO by ${Math.abs(res.r - res.vr).toFixed(1)} pts</span>`;
  $('copy-voo-ret').innerHTML = `<span class="${res.vr >= 0 ? 'up' : 'down'}">${pct(res.vr)}</span>`;
  const startDay = new Date(res.start + 'T12:00:00').toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'});
  $('copy-foot').textContent = `Since ${startDay} · ${copyMember.startsWith('inv:') ? `rebalanced to their 13F weights at ${res.filings} quarterly filings` : `${res.followed} trades followed across ${res.filings} filings`} · now holding ${res.held.length ? res.held.slice(0, 8).join(', ') + (res.held.length > 8 ? ` and ${res.held.length - 8} more` : '') : 'cash'}${res.skipped.length ? ` · skipped ${res.skipped.join(', ')} (no price data)` : ''}`;
  if (!window.LightweightCharts) { msg.textContent = 'Chart library failed to load.'; return; }
  msg.style.display = 'none';
  if (!copyChart) {
    copyChart = LightweightCharts.createChart($('copy-chart'), {
      autoSize: true,
      layout: {background: {type: 'solid', color: 'transparent'}, textColor: '#9FB1CE', fontFamily: getComputedStyle(document.body).fontFamily, fontSize: 12},
      grid: {vertLines: {visible: false}, horzLines: {color: 'rgba(255,255,255,0.06)'}},
      rightPriceScale: {borderVisible: false}, timeScale: {borderVisible: false, fixLeftEdge: true, fixRightEdge: true},
      crosshair: {mode: 0, horzLine: {visible: false, labelVisible: false}, vertLine: {color: 'rgba(255,255,255,0.35)', labelBackgroundColor: '#12306A'}},
      localization: {locale: 'en-US', priceFormatter: v => usd(v, 0)}, handleScroll: false, handleScale: false,
    });
    copyLines = [
      copyChart.addAreaSeries({lineColor: '#0A84FF', topColor: 'rgba(10,132,255,0.28)', bottomColor: 'rgba(10,132,255,0)', lineWidth: 2.5, priceLineVisible: false, lastValueVisible: false}),
      copyChart.addLineSeries({color: '#8E9BB3', lineWidth: 2, lineStyle: 2, priceLineVisible: false, lastValueVisible: false}),
    ];
  }
  copyLines[0].setData(res.copySeries); copyLines[1].setData(res.vooSeries);
  copyChart.timeScale().fitContent();
}

// ─────────────────────────────────────────────
//  SMART MONEY: insider buys + famous investors (SEC filings)
// ─────────────────────────────────────────────
let smTab = 'insiders', smInv = null, smFilter = 'all';
function renderSmart() {
  const tabs = [['insiders', 'Insider buys'], ['investors', 'Famous investors']];
  $('sm-tabs').innerHTML = tabs.map(([k, l]) => `<button type="button" aria-pressed="${k === smTab}" data-k="${k}">${l}</button>`).join('');
  $('sm-tabs').querySelectorAll('button').forEach(b => b.onclick = () => { smTab = b.dataset.k; renderSmart(); });
  const box = $('sm-body');
  const fmtD = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', {month: 'short', day: 'numeric'}) : '';
  if (smTab === 'insiders') {
    if (!insiderBuys.length) { box.innerHTML = '<div class="chart-msg" style="position:static;padding:28px">Insider filings appear after the next daily update.</div>'; return; }
    const f = followed();
    const filters = [['all', 'All'], ['big', '$1M+'], ['ceo', 'CEOs & CFOs'], ['mine', 'My stocks']];
    let list = insiderBuys;
    if (smFilter === 'big') list = list.filter(b => b.value >= 1e6);
    if (smFilter === 'ceo') list = list.filter(b => /chief executive|ceo|chief financial|cfo|president/i.test(b.role));
    if (smFilter === 'mine') list = list.filter(b => f.has(b.ticker));
    const month = insiderBuys.filter(b => b.filed >= new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10));
    const total = month.reduce((s, b) => s + b.value, 0);
    box.innerHTML = `<div class="sm-head"><div><div class="muted-d" style="font-size:13px">Open-market purchases, last 30 days</div><div class="sm-big num">${compact(total)} by ${new Set(month.map(b => b.owner)).size} insiders</div></div>
      <div class="seg seg-scroll" id="sm-filter">${filters.map(([k, l]) => `<button type="button" aria-pressed="${k === smFilter}" data-f="${k}">${l}</button>`).join('')}</div></div>
      <div class="lb-note muted-d">Executives and directors buying their own company's stock with their own money. Filed within 2 business days.</div>`
      + (list.slice(0, 25).map(b => `<div class="trade">
          <div><div class="who">${esc(b.owner)} · ${esc(b.role)}</div><div class="what"><button type="button" class="tk-link" data-tk="${esc(b.ticker)}">${esc(b.ticker)}</button><span class="pill buy">Bought</span>${f.has(b.ticker) ? '<span class="pill mine">You own</span>' : ''}</div><div class="who" style="margin-top:2px">${esc(b.company)}</div></div>
          <div><div class="amt num">${compact(b.value)}</div><div class="when">${b.shares.toLocaleString('en-US')} sh @ ${usd(b.price)}</div><div class="when">Traded ${esc(fmtD(b.date))} · filed ${esc(fmtD(b.filed))}</div></div>
        </div>`).join('') || '<div class="chart-msg" style="position:static;padding:28px">No purchases match this filter.</div>');
    box.querySelectorAll('#sm-filter button').forEach(b => b.onclick = () => { smFilter = b.dataset.f; renderSmart(); });
    return;
  }
  const invs = smart.investors.filter(x => x.quarters && x.quarters.length);
  if (!invs.length) { box.innerHTML = '<div class="chart-msg" style="position:static;padding:28px">Investor holdings appear after the next daily update.</div>'; return; }
  smInv = smInv || invs[0].id;
  const inv = invs.find(x => x.id === smInv) || invs[0];
  const [q, prev] = inv.quarters;
  const prevMap = new Map((prev ? prev.holdings : []).map(h => [h.cusip, h]));
  const curSet = new Set(q.holdings.map(h => h.cusip));
  const sold = prev ? prev.holdings.filter(h => !curSet.has(h.cusip) && h.pct >= 0.5) : [];
  box.innerHTML = `<div class="sm-head" style="margin-bottom:12px"><label class="sr" for="sm-inv">Investor</label><select id="sm-inv" class="picker">${invs.map(x => `<option value="${esc(x.id)}"${x.id === inv.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      <button class="btn glass small" type="button" id="sm-copy">Copy test</button></div>
    <div class="muted-d" style="font-size:13px">${esc(inv.firm)} · holdings as of ${esc(new Date(q.period + 'T12:00:00').toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric'}))} · filed ${esc(fmtD(q.filed))}</div>
    <div class="sm-big num" style="margin:4px 0 10px">${compact(q.total)} across ${q.positions} positions</div>`
    + q.holdings.slice(0, 15).map(h => {
      const p = prevMap.get(h.cusip);
      const chg = !prev ? '' : !p ? '<span class="chg new">New</span>' : h.shares > p.shares * 1.05 ? `<span class="chg add">Added ${Math.round((h.shares / p.shares - 1) * 100)}%</span>` : h.shares < p.shares * 0.95 ? `<span class="chg cut">Trimmed ${Math.round((1 - h.shares / p.shares) * 100)}%</span>` : '';
      return `<div class="hold"><div><div class="what" style="font-size:15px">${h.ticker ? `<button type="button" class="tk-link" data-tk="${esc(h.ticker)}">${esc(h.ticker)}</button>` : ''} <span class="who" style="font-weight:400">${esc(h.name)}</span>${chg}</div></div>
        <div class="num" style="text-align:right;font-weight:600">${h.pct.toFixed(1)}%<div class="when">${compact(h.value)}</div></div>
        <div class="bar"><span style="width:${Math.min(100, h.pct / q.holdings[0].pct * 100)}%"></span></div></div>`;
    }).join('')
    + (sold.length ? `<div class="soldout">Sold out since last quarter: ${sold.slice(0, 10).map(h => esc(h.ticker || h.name)).join(', ')}</div>` : '')
    + '<div class="lb-note muted-d" style="margin-top:12px">13F filings are due 45 days after each quarter ends, so these holdings can be up to 4.5 months old. Long US stock positions only.</div>';
  $('sm-inv').onchange = e => { smInv = e.target.value; renderSmart(); };
  $('sm-copy').onclick = () => { runCopyTest('inv:' + inv.id); $('copy').scrollIntoView({behavior: reduced ? 'auto' : 'smooth'}); };
}

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

// ─────────────────────────────────────────────
//  DIVIDENDS
// ─────────────────────────────────────────────
let divTab = 'stocks';
async function loadYieldData() {
  try { rates = await getJSON('./rates.json?v=' + Math.floor(Date.now() / 3.6e6)); } catch (e) {}
  try { yields = await getJSON('./yields.json?v=' + Math.floor(Date.now() / 3.6e6)); } catch (e) {}
  renderCash(); renderDividends();
  getJSON(BACKEND_URL + '/api/top-rates').then(d => { if (d && d.rates && d.rates.length) { topRates = d; renderCash(); } }).catch(() => {});
  if (!rates) return;
  const tks = [...rates.bond_etfs.map(b => b.ticker), ...rates.dividend_etfs, ...rates.dividend_stocks, ...rates.model_portfolios.map(m => m.ticker)];
  try {
    for (let i = 0; i < tks.length; i += 60) Object.assign(divData, (await getJSON(`${BACKEND_URL}/api/dividends/${tks.slice(i, i + 60).join(',')}`)).dividends || {});
  } catch (e) {}
  renderCash(); renderDividends(); loadRisk(); renderReviewSec();
}
function renderDividends() {
  const tabs = [['stocks', 'Top dividend stocks'], ['etfs', 'Dividend ETFs'], ['models', 'All-in-one portfolios']];
  $('div-tabs').innerHTML = tabs.map(([k, l]) => `<button type="button" aria-pressed="${k === divTab}" data-d="${k}">${l}</button>`).join('');
  $('div-tabs').querySelectorAll('button').forEach(b => b.onclick = () => { divTab = b.dataset.d; renderDividends(); });
  if (!rates) { $('div-list').innerHTML = '<div class="empty">Loading…</div>'; return; }
  const own = new Set(stocks().map(h => h.ticker));
  let list = divTab === 'stocks' ? rates.dividend_stocks.map(t => ({t})) : divTab === 'etfs' ? rates.dividend_etfs.map(t => ({t})) : rates.model_portfolios.map(m => ({t: m.ticker, mix: m.mix, full: m.name}));
  list = list.map(x => ({...x, d: divData[x.t]})).filter(x => x.d && x.d.price);
  if (!list.length) { $('div-list').innerHTML = '<div class="empty">Loading yields…</div>'; return; }
  if (divTab !== 'models') list.sort((a, b) => b.d.yield - a.d.yield);
  list = list.slice(0, divTab === 'stocks' ? 12 : 10);
  $('div-list').innerHTML = list.map(x => {
    const d = x.d, trap = d.yield >= 8 && divTab === 'stocks';
    return `<div class="rate"><div><div class="n"><button type="button" class="tk-link" data-tk="${esc(x.t)}">${esc(x.t)}</button> <span style="font-weight:400">${esc(x.full || d.name)}</span>${own.has(x.t) ? '<span class="tag you">You own</span>' : ''}${trap ? '<span class="tag warn">Very high, check if sustainable</span>' : ''}</div>
      <div class="p">${x.mix ? esc(x.mix) + ' · ' : ''}${usd(d.price)} · ${d.payments} payment${d.payments === 1 ? '' : 's'} in 12 months${d.return_1y !== null ? ` · price ${pct(d.return_1y)} over 1 year` : ''}</div></div>
      <div><div class="a">${d.yield.toFixed(2)}%</div><div class="x">${usd(10000 * d.yield / 100, 0)}/yr per $10K</div></div></div>`;
  }).join('');
  $('div-note').textContent = divTab === 'models'
    ? 'BlackRock iShares Core allocation ETFs hold a fixed stock and bond mix in one fund and rebalance for you. Yields shown are trailing 12-month payouts.'
    : 'Trailing 12-month dividends divided by today\'s price. Very high yields can mean the price fell or the payout may be cut.';
}

// ─────────────────────────────────────────────
//  RISK
// ─────────────────────────────────────────────
const LEVELS = [[1, 'Very low', '#1A7F37', '#E3F5E8'], [8, 'Low', '#2F6F3E', '#E8F3E2'], [20, 'Moderate', '#8A6100', '#FFF4D6'], [35, 'High', '#B54708', '#FFE9D6'], [Infinity, 'Very high', '#B42318', '#FDE6E4']];
const levelOf = v => LEVELS.find(l => v < l[0]);
function riskStats(series, bench) {
  if (!series || series.length < 30) return null;
  const rets = [];
  for (let i = 1; i < series.length; i++) if (series[i - 1] && series[i]) rets.push(series[i] / series[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) * Math.sqrt(252) * 100;
  let peak = series[0], dd = 0;
  series.forEach(v => { if (v > peak) peak = v; dd = Math.min(dd, v / peak - 1); });
  let beta = null;
  if (bench && bench.length === series.length) {
    const br = []; for (let i = 1; i < bench.length; i++) br.push(bench[i] / bench[i - 1] - 1);
    const bm = br.reduce((a, b) => a + b, 0) / br.length;
    let cov = 0, varb = 0; for (let i = 0; i < Math.min(br.length, rets.length); i++) { cov += (rets[i] - mean) * (br[i] - bm); varb += (br[i] - bm) ** 2; }
    beta = varb ? cov / varb : null;
  }
  return {vol, dd: dd * 100, beta, ret: (series[series.length - 1] / series[0] - 1) * 100};
}
function closesOn(t, days) {
  const m = new Map((hist1y[t] || []).map(p => [dayOf(p[0]), p[1]]));
  let last = null;
  return days.map(d => (m.has(d) ? (last = m.get(d)) : last));
}
async function loadRisk() {
  const box = $('risk-list');
  const ladder = [['SGOV', 'T-bills (via SGOV)'], ['BND', 'Total bond market'], ['LQD', 'Corporate bonds'], ['HYG', 'High-yield bonds'], ['AOK', 'Conservative 30/70 portfolio'], ['AOR', 'Balanced 60/40 portfolio'], ['SCHD', 'Dividend stocks (SCHD)'], ['VOO', 'S&P 500'], ['QQQ', 'Nasdaq 100'], ['TLT', 'Long-term Treasuries']];
  const mine = stocks().map(h => h.ticker);
  try { await ensureHistory(['VOO', ...ladder.map(x => x[0]), ...mine]); }
  catch (e) { box.innerHTML = '<div class="empty">Price history is unavailable right now.</div>'; return; }
  const days = (hist1y.VOO || []).map(p => dayOf(p[0]));
  if (!days.length) { box.innerHTML = '<div class="empty">Price history is unavailable right now.</div>'; return; }
  const bench = closesOn('VOO', days);
  const rows = [{name: 'Cash, savings, money market', sub: 'Price never moves; interest only', stats: {vol: 0, dd: 0, beta: 0}}];
  ladder.forEach(([t, n]) => { const st = riskStats(closesOn(t, days), bench); if (st) rows.push({t, name: n, stats: st}); });
  const own = mine.map(t => ({t, name: t, stats: riskStats(closesOn(t, days), bench), you: true})).filter(x => x.stats);
  const all = [...rows, ...own].sort((a, b) => a.stats.vol - b.stats.vol);
  const maxVol = Math.max(40, ...all.map(x => x.stats.vol));
  box.innerHTML = all.map(x => { const [, lvl, fg, bg] = levelOf(x.stats.vol);
    return `<div class="risk-row"><div><div class="n" style="font-size:15px;font-weight:600">${x.t ? `<button type="button" class="tk-link" data-tk="${esc(x.t)}">${esc(x.t)}</button> ` : ''}${x.t && x.name !== x.t ? `<span style="font-weight:400">${esc(x.name)}</span>` : x.t ? '' : esc(x.name)}${x.you ? '<span class="tag you">You own</span>' : ''}<span class="lvl" style="background:${bg};color:${fg}">${lvl}</span></div>
      <div class="p" style="font-size:13px;color:var(--dark-3)">${x.sub || `Swings ${x.stats.vol.toFixed(1)}% a year · worst drop ${x.stats.dd.toFixed(1)}%${x.stats.beta !== null ? ` · moves ${x.stats.beta.toFixed(2)}x the market` : ''}`}</div></div>
      <div class="num" style="text-align:right;font-weight:600">${x.stats.vol.toFixed(1)}%</div>
      <div class="risk-bar"><span style="width:${Math.max(1.5, x.stats.vol / maxVol * 100)}%;background:${fg}"></span></div></div>`; }).join('');
  // Your portfolio as a whole
  const me = $('risk-me');
  const held = stocks().filter(h => hist1y[h.ticker] && hist1y[h.ticker].length);
  if (!held.length) { me.innerHTML = '<div class="fine" style="padding-bottom:12px">Add your portfolio to see its overall risk level.</div>'; return; }
  const cash = myPortfolio.filter(h => h.isCash).reduce((s, h) => s + (h.marketValue || 0), 0);
  const cl = held.map(h => closesOn(h.ticker, days));
  const series = days.map((_, i) => cash + held.reduce((s, h, j) => s + h.shares * (cl[j][i] || 0), 0));
  const start = series.findIndex((v, i) => cl.every(c => c[i]));
  const st = riskStats(series.slice(start), bench.slice(start));
  if (!st) { me.innerHTML = ''; return; }
  const [, lvl, fg, bg] = levelOf(st.vol);
  const total = series[series.length - 1];
  me.innerHTML = `<div class="risk-me">
      <div><div class="fine">Your portfolio</div><div class="big-l"><span class="lvl" style="background:${bg};color:${fg};font-size:15px;margin:0;padding:4px 12px">${lvl} risk</span></div></div>
      <div><div class="fine">Typical yearly swing</div><div class="big-l num">±${st.vol.toFixed(1)}%</div><div class="fine num">about ±${usd(total * st.vol / 100, 0)}</div></div>
      <div><div class="fine">Worst drop, past year</div><div class="big-l num down">${st.dd.toFixed(1)}%</div></div>
      <div><div class="fine">If the market fell 10%</div><div class="big-l num">${st.beta !== null ? `${(-10 * st.beta).toFixed(1)}%` : 'n/a'}</div><div class="fine num">${st.beta !== null ? `about ${usd(total * st.beta * 0.1, 0)}` : ''}</div></div>
    </div>`;
}

// ─────────────────────────────────────────────
//  PORTFOLIO REVIEW (what a brokerage statement shows, but live)
// ─────────────────────────────────────────────
const GOLD = new Set(['GLD', 'IAU', 'SLV', 'GLDM', 'SGOL', 'PPLT', 'BAR', 'AAAU', 'PHYS']);
const BONDS = new Set(['BND', 'AGG', 'TLT', 'SHY', 'IEF', 'VGIT', 'VGSH', 'VCIT', 'VCSH', 'LQD', 'HYG', 'JNK', 'MUB', 'SGOV', 'BIL', 'TIP', 'SCHZ', 'BNDX', 'GOVT', 'USFR', 'TFLO', 'VTEB']);
const CLASS_COLORS = {'Cash & money market': '#9DBBE0', 'Equities': '#0A84FF', 'Fixed income': '#30A46C', 'Alternatives': '#E8A33D'};
const SNAP_KEY = 'pi.snapshots.v1';
function loadSnaps() { try { return JSON.parse(vget(SNAP_KEY)) || []; } catch (e) { return []; } }
let snapshots = loadSnaps();
function saveSnap(d, v, src) {
  if (!(v > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
  // A statement value for a date beats a live reading for the same date
  const old = snapshots.find(x => x.d === d);
  if (old && old.src === 'statement' && src === 'live') return;
  snapshots = snapshots.filter(x => x.d !== d);
  snapshots.push({d, v: Math.round(v * 100) / 100, src});
  snapshots.sort((a, b) => a.d.localeCompare(b.d));
  snapshots = snapshots.slice(-400);
  vset(SNAP_KEY, JSON.stringify(snapshots));
}
function classOf(h) {
  if (h.isCash) return 'Cash & money market';
  if (GOLD.has(h.ticker)) return 'Alternatives';
  if (BONDS.has(h.ticker) || (rates && rates.bond_etfs.some(b => b.ticker === h.ticker))) return 'Fixed income';
  return 'Equities';
}
function valueOf(h) { return h.isCash ? (h.marketValue || 0) : h.shares * priceOf(h.ticker, h.currentPrice || h.avgCost || 0); }
function incomeOf(h) {
  if (h.isCash) return h.apy ? (h.marketValue || 0) * h.apy / 100 : 0;
  const d = divData[h.ticker];
  return d ? h.shares * (d.ttm_dividend || 0) : 0;
}
async function ensureDivs(tks) {
  const need = tks.filter(t => !divData[t] || !divData[t].history);
  if (!need.length) return;
  try { Object.assign(divData, (await getJSON(`${BACKEND_URL}/api/dividends/${need.join(',')}`)).dividends || {}); } catch (e) {}
}
let prChart = null, prRun = 0;
async function renderReviewSec() {
  const run = ++prRun;
  const has = myPortfolio.length > 0;
  $('pr-empty').style.display = has ? 'none' : 'block';
  $('pr-body').style.display = has ? 'block' : 'none';
  if (!has) return;
  const st = stocks();
  await ensureDivs(st.map(h => h.ticker));
  if (run !== prRun) return;
  const rows = myPortfolio.map(h => ({h, v: valueOf(h), inc: incomeOf(h), cls: classOf(h)}));
  const total = rows.reduce((s, r) => s + r.v, 0);
  if (!total) return;
  const income = rows.reduce((s, r) => s + r.inc, 0);
  const withCost = st.filter(h => h.avgCost > 0);
  const cost = withCost.reduce((s, h) => s + h.shares * h.avgCost, 0);
  const gain = cost ? withCost.reduce((s, h) => s + valueOf(h), 0) - cost : null;
  const today = new Date().toISOString().slice(0, 10);
  if (Object.keys(prices).length) saveSnap(today, total, 'live');

  // Price history for "today's holdings over the past year"
  let series = null;
  try { await ensureHistory(['VOO', ...st.map(h => h.ticker)]); } catch (e) {}
  if (run !== prRun) return;
  const days = (hist1y.VOO || []).map(p => dayOf(p[0]));
  const cashTotal = rows.filter(r => r.h.isCash).reduce((s, r) => s + r.v, 0);
  if (days.length) {
    const cl = st.map(h => closesOn(h.ticker, days));
    series = days.map((d, i) => ({time: hist1y.VOO[i][0], d, value: cashTotal + st.reduce((s, h, j) => s + h.shares * (cl[j][i] || priceOf(h.ticker, h.avgCost || 0)), 0)}));
  }

  // Month comparison: a saved value from 20 to 45 days ago, else today's holdings priced a month ago
  const iso = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const monthAgo = iso(30);
  // Prefer your latest uploaded statement (at least a week old), then a saved value from 20 to 45 days ago
  const snap = snapshots.filter(x => x.src === 'statement' && x.d <= iso(7) && x.d >= iso(70)).pop() || snapshots.filter(x => x.d <= iso(20) && x.d >= iso(45)).pop();
  const ref = snap ? {d: snap.d, v: snap.v, est: false, stmt: snap.src === 'statement'}
    : (series ? (() => { const p = series.filter(x => x.d <= monthAgo).pop() || series[0]; return {d: p.d, v: p.value, est: true}; })() : null);
  // Income over the same period: dividends actually paid on today's shares, plus cash interest for those days
  const since = ref ? ref.d : monthAgo;
  const periodDays = Math.max(1, Math.round((Date.now() - new Date(since + 'T12:00:00')) / 864e5));
  const cashAnnual = rows.filter(r => r.h.isCash).reduce((s, r) => s + r.inc, 0);
  const cashMonth = cashAnnual / 12;
  const divPeriod = st.reduce((s, h) => s + ((divData[h.ticker] || {}).history || []).filter(([d]) => d > since).reduce((a, [, amt]) => a + amt * h.shares, 0), 0);
  const incMonth = divPeriod + cashAnnual * periodDays / 365;
  const chg = ref ? total - ref.v : null;
  // The estimate holds cash flat and ignores dividends, so its change is market movement only
  const market = chg === null ? null : ref.est ? chg : chg - incMonth;
  const earned = chg === null ? null : ref.est ? chg + incMonth : chg;
  const fmtD = d => new Date(d + 'T12:00:00').toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
  const sign = v => (v >= 0 ? '+' : '-') + usd(Math.abs(v));
  $('pr-sum').innerHTML = `
    <div><div class="pr-k">Net portfolio value</div><div class="pr-v">${usd(total)}</div><div class="pr-s">${rows.length} position${rows.length === 1 ? '' : 's'}</div></div>
    <div><div class="pr-k">Change since ${ref ? fmtD(ref.d) : 'last month'}</div><div class="pr-v ${chg === null ? '' : chg >= 0 ? 'up' : 'down'}">${chg === null ? '–' : sign(chg)}</div><div class="pr-s">${ref ? pct(chg / ref.v * 100, 2) + (ref.est ? ' · estimated from today\'s holdings' : ref.stmt ? ' · vs your statement' : ' · vs your saved value') : ''}</div></div>
    <div><div class="pr-k">Estimated annual income</div><div class="pr-v">${usd(income, 0)}</div><div class="pr-s">${(income / total * 100).toFixed(2)}% yield on the whole portfolio</div></div>
    <div><div class="pr-k">Unrealized gain / loss</div><div class="pr-v ${gain === null ? '' : gain >= 0 ? 'up' : 'down'}">${gain === null ? '–' : sign(gain)}</div><div class="pr-s">${gain === null ? 'Add cost basis to see this' : pct(gain / cost * 100, 2) + ' on invested positions'}</div></div>`;
  $('pr-earn').innerHTML = chg === null ? '' : `<span>Earnings since ${ref ? fmtD(ref.d) : 'last month'}</span><span>Income <b>${usd(incMonth)}</b></span><span>Market gains <b class="${market >= 0 ? 'up' : 'down'}">${sign(market)}</b></span><span>Total <b class="${earned >= 0 ? 'up' : 'down'}">${sign(earned)}</b></span>`;

  // Allocation by asset class
  const cls = {};
  rows.forEach(r => { cls[r.cls] = (cls[r.cls] || 0) + r.v; });
  const parts = Object.entries(cls).sort((a, b) => b[1] - a[1]);
  const R = 70, C = 2 * Math.PI * R;
  let off = 0;
  $('pr-donut').innerHTML = parts.map(([k, v]) => {
    const len = v / total * C;
    const el = `<circle cx="100" cy="100" r="${R}" fill="none" stroke="${CLASS_COLORS[k]}" stroke-width="34" stroke-dasharray="${Math.max(0, len - (parts.length > 1 ? 1.2 : 0))} ${C}" stroke-dashoffset="${-off}"><title>${esc(k)} ${(v / total * 100).toFixed(1)}%</title></circle>`;
    off += len;
    return el;
  }).join('');
  $('pr-alloc-legend').innerHTML = parts.map(([k, v]) => `<div class="pr-leg"><span class="sw" style="background:${CLASS_COLORS[k]}"></span><span>${esc(k)}</span><span class="muted-l">${compact(v)}</span><b>${(v / total * 100).toFixed(2)}%</b></div>`).join('');

  // Income by month over the last 12 months, if you had held today's positions
  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 15); months.push(d.toISOString().slice(0, 7)); }
  const divByM = Object.fromEntries(months.map(m => [m, 0]));
  st.forEach(h => ((divData[h.ticker] || {}).history || []).forEach(([d, amt]) => { const m = d.slice(0, 7); if (m in divByM) divByM[m] += amt * h.shares; }));
  const max = Math.max(1, ...months.map(m => divByM[m] + cashMonth));
  const ytd = months.filter(m => m.startsWith(String(now.getFullYear()))).reduce((s, m) => s + divByM[m] + cashMonth, 0);
  const missingApy = rows.filter(r => r.h.isCash && !r.h.apy).length;
  $('pr-income').innerHTML = `<div class="pr-bars" role="img" aria-label="Estimated income by month">${months.map(m => { const dv = divByM[m]; return `<div class="pr-bar" title="${m}: ${usd(dv + cashMonth)}"><span class="top" style="height:${dv / max * 100}%"></span><span class="cash${dv ? '' : ' top'}" style="height:${cashMonth / max * 100}%"></span></div>`; }).join('')}</div>
    <div class="pr-ml">${months.map(m => `<span>${new Date(m + '-15T12:00:00').toLocaleDateString('en-US', {month: 'narrow'})}</span>`).join('')}</div>
    <div class="pr-earn" style="margin-top:12px"><span>This year <b>${usd(ytd)}</b></span><span>Est. annual <b>${usd(income)}</b></span><span><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--accent)"></span> Dividends <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:#9DBBE0;margin-left:8px"></span> Cash interest</span></div>
    <p class="fine" style="margin-top:8px">Dividends actually paid per share over the past year, times the shares you hold today. Cash interest uses each cash position's yield${missingApy ? `. <b>${missingApy} cash position${missingApy > 1 ? 's have' : ' has'} no yield yet:</b> add it under Edit holdings` : ''}.</p>`;

  // Value over the past year
  const msg = $('pr-chart-msg');
  if (series && window.LightweightCharts) {
    msg.style.display = 'none';
    if (!prChart) {
      prChart = LightweightCharts.createChart($('pr-chart'), {autoSize: true, layout: {background: {type: 'solid', color: 'transparent'}, textColor: '#5A6B85', fontSize: 11},
        grid: {vertLines: {visible: false}, horzLines: {color: '#E3EAF3'}}, rightPriceScale: {borderVisible: false}, timeScale: {borderVisible: false, fixLeftEdge: true, fixRightEdge: true},
        crosshair: {mode: 0, horzLine: {visible: false, labelVisible: false}}, localization: {locale: 'en-US', priceFormatter: v => compact(v)}, handleScroll: false, handleScale: false});
      prChart.line = prChart.addAreaSeries({lineColor: '#0A84FF', topColor: 'rgba(10,132,255,.22)', bottomColor: 'rgba(10,132,255,0)', lineWidth: 2, priceLineVisible: false, lastValueVisible: false});
      prChart.snaps = prChart.addLineSeries({color: '#0B1A33', lineWidth: 1, lineStyle: 2, pointMarkersVisible: true, priceLineVisible: false, lastValueVisible: false});
    }
    prChart.line.setData(series.map(({time, value}) => ({time, value})));
    const pts = snapshots.filter(x => x.src === 'statement').map(x => ({time: Math.floor(new Date(x.d + 'T20:00:00Z').getTime() / 1000), value: x.v})).filter(x => x.time >= series[0].time);
    if (pts.length) pts.push({time: series[series.length - 1].time, value: total});
    prChart.snaps.setData(pts.length > 1 ? pts : []);
    prChart.timeScale().fitContent();
    const n = snapshots.filter(x => x.src === 'statement').length;
    $('pr-chart-note').textContent = `Blue: today's holdings priced over the past year, with cash held constant. ${n ? `Dashed: your actual values from ${n} uploaded statement${n > 1 ? 's' : ''}.` : 'Upload monthly statements to plot your actual values too.'}`;
  } else msg.textContent = 'Price history is unavailable right now.';

  // Top five holdings
  $('pr-top').innerHTML = rows.slice().sort((a, b) => b.v - a.v).slice(0, 5).map(r => `<div class="pr-top"><div><b>${r.h.isCash ? esc(r.h.ticker) : `<button type="button" class="tk-link" data-tk="${esc(r.h.ticker)}">${esc(r.h.ticker)}</button>`}</b> <span class="muted-l">${esc((r.h.company || '').slice(0, 32))}</span></div><span>${usd(r.v, 0)}</span><b>${(r.v / total * 100).toFixed(2)}%</b></div>`).join('');
  renderIndicators();
}
async function renderIndicators() {
  const body = $('pr-ind');
  const out = [];
  try { await ensureHistory(['^GSPC', '^IXIC']); } catch (e) {}
  const yEnd = `${new Date().getFullYear() - 1}-12-31`;
  const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  [['S&P 500', '^GSPC'], ['Nasdaq', '^IXIC']].forEach(([n, t]) => {
    const h = (hist1y[t] || []).map(p => [dayOf(p[0]), p[1]]);
    if (!h.length) return;
    const at = d => (h.filter(x => x[0] <= d).pop() || [])[1];
    const f = v => v ? v.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '–';
    out.push([n, f(h[h.length - 1][1]), f(at(monthAgo)), f(at(yEnd))]);
  });
  if (yields && yields.curve) {
    const y = k => [yields.curve[k], yields.month_ago && yields.month_ago.curve[k], yields.year_end && yields.year_end.curve[k]].map(v => v !== undefined && v !== null ? v.toFixed(2) + '%' : '–');
    out.push(['3-month Treasury bills', ...y('3 Mo')], ['10-year Treasury', ...y('10 Yr')], ['30-year Treasury bonds', ...y('30 Yr')]);
    if (yields.sofr && yields.sofr.now) out.push(['SOFR (overnight)', ...[yields.sofr.now, yields.sofr.month_ago, yields.sofr.year_end].map(x => x ? x.rate.toFixed(2) + '%' : '–')]);
  }
  body.innerHTML = out.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="4" class="muted-l">Loading…</td></tr>';
  $('pr-ind-note').textContent = yields ? `Treasury yields as of ${yields.date}. Indexes at the latest close.` : '';
}

// ─────────────────────────────────────────────
//  LEADERBOARD
// ─────────────────────────────────────────────
let lbTab = 'active', bestCache = null;
const LB_TABS = [['active', 'Most active'], ['buyers', 'Biggest buyers'], ['best', 'Best to copy'], ['late', 'Slowest filers'], ['committee', 'Committee overlaps']];
const lowerBound = a => { const m = String(a || '').match(/\$([\d,]+)/); return m ? +m[1].replace(/,/g, '') : 0; };
function lbRow(i, rep, main, sub, right, rightSub, click) {
  return `<button type="button" class="lb-row" data-rep="${esc(rep)}"${click ? '' : ' data-noclick="1"'}>
    <span class="lb-rank num">${i + 1}</span>
    <span class="lb-main"><span class="lb-name">${esc(main)}</span><span class="lb-sub">${sub}</span></span>
    <span class="lb-right"><span class="lb-val num">${right}</span><span class="lb-sub">${rightSub}</span></span>
  </button>`;
}
function groupBy(list) { const g = {}; list.forEach(t => (g[t.representative] = g[t.representative] || []).push(t)); return g; }
async function renderLeaderboard() {
  $('lb-tabs').innerHTML = LB_TABS.map(([k, l]) => `<button type="button" aria-pressed="${k === lbTab}" data-k="${k}">${l}</button>`).join('');
  $('lb-tabs').querySelectorAll('button').forEach(b => b.onclick = () => { lbTab = b.dataset.k; renderLeaderboard(); });
  const box = $('lb-list'), note = $('lb-note');
  if (!trades.length) { box.innerHTML = '<div class="chart-msg" style="position:static;padding:28px">Loading disclosures…</div>'; return; }
  const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const recent = trades.filter(t => (t.filed || t.date) >= yearAgo);
  const g = groupBy(recent);
  let html = '';
  if (lbTab === 'active') {
    note.textContent = 'Trades filed in the past 12 months.';
    html = Object.entries(g).sort((a, b) => b[1].length - a[1].length).slice(0, 10).map(([rep, ts], i) => {
      const buys = ts.filter(t => /purchase/i.test(t.type)).length;
      return lbRow(i, rep, nameOf(rep), `${buys} buys · ${ts.length - buys} sells`, ts.length, 'trades', true);
    }).join('');
  } else if (lbTab === 'buyers') {
    note.textContent = 'Sum of the low end of each purchase range, past 12 months. Disclosures only give ranges.';
    html = Object.entries(g).map(([rep, ts]) => [rep, ts.filter(t => /purchase/i.test(t.type)).reduce((s, t) => s + lowerBound(t.amount), 0), ts]).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([rep, v, ts], i) => { const top = Object.entries(ts.filter(t => /purchase/i.test(t.type) && t.ticker).reduce((m, t) => (m[t.ticker] = (m[t.ticker] || 0) + lowerBound(t.amount), m), {})).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]).join(', ');
        return lbRow(i, rep, nameOf(rep), top ? 'Top buys: ' + esc(top) : 'Mostly bonds or private assets', compact(v) + '+', 'bought', true); }).join('');
  } else if (lbTab === 'late') {
    note.textContent = `The STOCK Act gives members ${LATE_DAYS} days to file. Average delay and late filings, past 12 months.`;
    html = Object.entries(g).map(([rep, ts]) => { const lags = ts.map(lagOf).filter(x => x !== null && x >= 0); return [rep, lags.length ? lags.reduce((a, b) => a + b, 0) / lags.length : 0, lags.filter(x => x > LATE_DAYS).length, Math.max(0, ...lags)]; })
      .filter(x => x[1] > 0).sort((a, b) => b[2] - a[2] || b[1] - a[1]).slice(0, 10)
      .map(([rep, avg, late, max], i) => lbRow(i, rep, nameOf(rep), late ? `<span class="late-txt">${late} late filing${late > 1 ? 's' : ''}</span> · longest ${max} days` : `Longest ${max} days`, Math.round(avg) + 'd', 'avg delay', true)).join('');
  } else if (lbTab === 'committee') {
    note.textContent = 'Trades in industries overseen by a committee the member sits on. Overlap is not wrongdoing, it is context.';
    html = Object.entries(g).map(([rep, ts]) => [rep, ts.filter(t => t.committees && t.committees.length)]).filter(x => x[1].length).sort((a, b) => b[1].length - a[1].length).slice(0, 10)
      .map(([rep, ts], i) => { const cs = [...new Set(ts.flatMap(t => t.committees))].slice(0, 2).join(', '); const tk = [...new Set(ts.map(t => t.ticker))].slice(0, 4).join(', ');
        return lbRow(i, rep, nameOf(rep), esc(cs) + ' · ' + esc(tk), ts.length, 'overlaps', true); }).join('')
      || '<div class="chart-msg" style="position:static;padding:28px">Committee data appears after the next daily update.</div>';
  } else if (lbTab === 'best') {
    note.textContent = '$10,000 following the 12 most active members and 6 famous investors, from their first filing in the past year. Return vs buying VOO on the same day.';
    if (!bestCache) {
      box.innerHTML = '<div class="chart-msg" style="position:static;padding:28px">Testing the 12 most active members…</div>';
      try {
        const cands = [...copyCandidates().slice(0, 12), ...smart.investors.map(x => 'inv:' + x.id)];
        await ensureHistory(['VOO', ...cands.flatMap(r => (planFor(r) || {}).tickers || [])]);
        bestCache = cands.map(r => [r, simulate(r)]).filter(x => x[1]).sort((a, b) => (b[1].r - b[1].vr) - (a[1].r - a[1].vr));
      } catch (e) { box.innerHTML = '<div class="chart-msg" style="position:static;padding:28px">Price history is unavailable right now. Try again in a minute.</div>'; return; }
      if (lbTab !== 'best') return;
    }
    html = bestCache.map(([rep, res], i) => lbRow(i, rep, keyName(rep) + (rep.startsWith('inv:') ? ' · investor' : ''), `${res.filings} filings · vs VOO <span class="${res.r - res.vr >= 0 ? 'up' : 'down'}">${res.r - res.vr >= 0 ? '+' : ''}${(res.r - res.vr).toFixed(1)} pts</span>`, `<span class="${res.r >= 0 ? 'up' : 'down'}">${pct(res.r)}</span>`, usd(res.end, 0), true)).join('');
  }
  box.innerHTML = html || '<div class="chart-msg" style="position:static;padding:28px">Nothing to show yet.</div>';
  box.querySelectorAll('.lb-row:not([data-noclick])').forEach(b => b.onclick = () => { runCopyTest(b.dataset.rep); $('copy').scrollIntoView({behavior: reduced ? 'auto' : 'smooth'}); });
}

function wireNavHighlight() {
  const links = [...document.querySelectorAll('.navlinks a')];
  const map = new Map(links.map(a => [a.getAttribute('href').slice(1), a]));
  if (!('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver(entries => entries.forEach(en => {
    if (!en.isIntersecting) return;
    const a = map.get(en.target.id); if (!a) return;
    links.forEach(l => l.classList.toggle('active', l === a));
    const row = a.parentElement;
    if (row.scrollWidth > row.clientWidth) row.scrollTo({left: a.offsetLeft - 14, behavior: reduced ? 'auto' : 'smooth'});
  }), {rootMargin: '-45% 0px -50% 0px'});
  map.forEach((a, id) => { const sec = document.getElementById(id); if (sec) io.observe(sec); });
}
function wireReveal() {
  const els = document.querySelectorAll('.reveal');
  if (reduced || !('IntersectionObserver' in window)) { els.forEach(e => e.classList.add('in')); return; }
  const io = new IntersectionObserver(entries => entries.forEach(en => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), {rootMargin: '0px 0px -8% 0px'});
  els.forEach(e => io.observe(e));
}

// ─────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────
function refreshAll() {
  renderReviewSec();
  renderCash(); renderDividends(); loadRisk();
  renderAlerts();
  newsCache = {}; loadNews();
  renderHero(); renderHoldings(); renderFeed(); renderCompareSubs(); renderSignals(); renderTicker(); renderMix();
  loadPrices(); loadHistory(); loadSectors();
}
function init() {
  wireReveal(); wireNavHighlight(); wireImport(); wireAsk(); buildChart();
  $('feed-more').onclick = () => { feedLimit += 12; renderFeed(); };
  $('copy-member').onchange = e => runCopyTest(e.target.value);
  wireLock(); wireAssist(); wirePlaid();
  wireTickerLinks(); renderWatch(); renderAlerts(); wireCopyButtons(); wireCash(); loadYieldData(); wireFeedFilters();
  $('cmp-member').onchange = e => { cmpMember = e.target.value; renderAnyMember(); };
  $('share-copy').onclick = shareCopy;
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
  $('watch-form').onsubmit = e => { e.preventDefault(); toggleWatch($('watch-in').value, true); $('watch-in').value = ''; };
  renderHero(); renderHoldings(); renderFeed(); renderSignals(); renderTicker(); renderMix();
  loadPrices(); loadHistory(); loadTrades(); loadNews(); loadSectors();
  setInterval(() => { if (!document.hidden) loadPrices(); }, 60 * 1000);
  setInterval(loadHistory, 10 * 60 * 1000);
  setInterval(loadNews, 15 * 60 * 1000);
  setInterval(loadTrades, 60 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadPrices(); });
}
openVault().then(() => { myPortfolio = loadPortfolio(); snapshots = loadSnaps(); init(); });
