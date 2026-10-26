// ─────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────

// ── Encrypted storage ──
// With a passcode set, holdings, cash and value history are stored encrypted (AES-GCM, key from the passcode via PBKDF2).
// The key lives only in this tab's session storage and is dropped on lock, so the data is unreadable without the passcode.
const VAULT_KEYS = ['pi.portfolio.v2', 'pi.snapshots.v1', 'pi.cash.v1', 'pi.plaid.v1', 'pi.newslist.v1'];
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
    if (typeof syncSoon === 'function') syncSoon();
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
let myPortfolio = []; // filled in 30-init.js once the vault is open
let watchlist = (() => { try { return JSON.parse(localStorage.getItem(WATCH_KEY)) || []; } catch (e) { return []; } })();
function saveWatch() { try { localStorage.setItem(WATCH_KEY, JSON.stringify(watchlist)); } catch (e) {} if (typeof syncSoon === 'function') syncSoon(); }
// ── News read list ──
// The tickers this user wants news reads for. It can hold portfolio tickers, so it is a vault key:
// read and written only through vget/vset, encrypted on the device when a passcode is set, synced as ciphertext.
// Empty or missing means "follow the default": watchlist plus portfolio tickers.
const NEWSLIST_KEY = 'pi.newslist.v1';
const NEWS_TK = /^[A-Z.\-]{1,6}$/;
const NEWSLIST_MAX = 40;
let newsListMem = null; // edits made while the vault is locked stay in this tab only
function defaultNewsList() {
  return [...new Set([...watchlist, ...stocks().map(h => String(h.ticker || '').toUpperCase())])].filter(t => NEWS_TK.test(t)).slice(0, NEWSLIST_MAX);
}
function getNewsList() {
  if (newsListMem) return newsListMem.slice();
  let v = null; try { v = JSON.parse(vget(NEWSLIST_KEY) || 'null'); } catch (e) {}
  return Array.isArray(v) ? v.filter(t => NEWS_TK.test(t)).slice(0, NEWSLIST_MAX) : defaultNewsList();
}
function newsListIsDefault() { return !newsListMem && !vget(NEWSLIST_KEY); }
function saveNewsList(list) {
  const locked = vaultOn() && !VAULT.key;
  if (list == null) { newsListMem = null; if (!locked) vset(NEWSLIST_KEY, ''); }
  else { const clean = [...new Set(list)].filter(t => NEWS_TK.test(t)).slice(0, NEWSLIST_MAX); newsListMem = locked ? clean : null; if (!locked) vset(NEWSLIST_KEY, JSON.stringify(clean)); }
  if (typeof syncSoon === 'function') syncSoon();
}
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
