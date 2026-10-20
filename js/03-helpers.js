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
async function fetchJSON(url, opts) {
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
// Calls the Worker; on a network error or server error (not a 4xx answer) tries the backup once
async function getJSON(url, opts) {
  try { return await fetchJSON(url, opts); }
  catch (e) {
    if (!url.startsWith(BACKEND_URL) || (e.status && e.status < 500)) throw e;
    return fetchJSON(FALLBACK_URL + url.slice(BACKEND_URL.length), opts);
  }
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
