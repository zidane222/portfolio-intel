// ─────────────────────────────────────────────
//  ACCOUNT & SYNC (Supabase)
// ─────────────────────────────────────────────
// Sign in by email link, then the passcode-encrypted vault (holdings, history, cash, Plaid link,
// watchlist) syncs across devices. Data is encrypted on the device with the passcode key before
// upload, so Supabase only ever stores ciphertext. Row level security limits each user to their row.
const SB_SESSION = 'pi.sb.session', SB_SYNCED = 'pi.sync.at';
const SYNC_MIN_PASS = 8;
let syncTimer = null, syncBusy = false, remoteCache = null, remoteChecked = false, justSignedIn = false, pendingEmail = '';

const sbOn = () => !!(SUPABASE_URL && SUPABASE_ANON_KEY);
function sbSession() { try { return JSON.parse(localStorage.getItem(SB_SESSION)); } catch (e) { return null; } }
function sbSave(s) { try { s ? localStorage.setItem(SB_SESSION, JSON.stringify(s)) : localStorage.removeItem(SB_SESSION); } catch (e) {} }

async function sbFetch(path, opts = {}, auth = true) {
  const headers = {apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json', ...(opts.headers || {})};
  if (auth) {
    let s = sbSession();
    if (!s) throw new Error('Not signed in');
    if (Date.now() / 1000 > (s.expires_at || 0) - 60) s = await sbRefresh(s);
    headers.Authorization = 'Bearer ' + s.access_token;
  }
  const r = await fetch(SUPABASE_URL + path, {...opts, headers, signal: AbortSignal.timeout(20000)});
  const text = await r.text();
  let d = null; try { d = text ? JSON.parse(text) : null; } catch (e) {}
  if (!r.ok) { const err = new Error((d && (d.msg || d.message || d.error_description || d.error)) || 'HTTP ' + r.status); err.status = r.status; throw err; }
  return d;
}
async function sbRefresh(s) {
  const d = await sbFetch('/auth/v1/token?grant_type=refresh_token', {method: 'POST', body: JSON.stringify({refresh_token: s.refresh_token})}, false)
    .catch(e => { if (e.status === 400 || e.status === 401) { sbSave(null); syncUI(); } throw e; });
  const next = {...s, access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (d.expires_in || 3600)};
  sbSave(next);
  return next;
}
// Email link lands back here with the session in the URL fragment
function sbTakeRedirect() {
  if (!/access_token=|error_description=/.test(location.hash)) return;
  const p = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  if (p.get('error_description')) { setTimeout(() => syncUI('Sign-in link problem: ' + p.get('error_description')), 0); return; }
  justSignedIn = true;
  sbSave({access_token: p.get('access_token'), refresh_token: p.get('refresh_token'), expires_at: +p.get('expires_at') || Math.floor(Date.now() / 1000) + (+p.get('expires_in') || 3600)});
}

// ── Encrypted payload ──
function syncPayloadPlain() {
  const data = {}; VAULT_KEYS.forEach(k => { data[k] = vget(k); });
  return JSON.stringify({v: 1, data, watch: watchlist});
}
async function syncPush() {
  const c = lockConf();
  if (!sbOn() || !sbSession() || !VAULT.key || !c || !c.encSalt || !c.sync) return;
  if (syncBusy) { syncSoon(); return; }
  syncBusy = true;
  try {
    const at = new Date().toISOString();
    await sbFetch('/rest/v1/synced_data?on_conflict=user_id', {method: 'POST', headers: {Prefer: 'resolution=merge-duplicates,return=minimal'},
      body: JSON.stringify({enc_salt: c.encSalt, payload: await vaultEncrypt(syncPayloadPlain()), updated_at: at})});
    try { localStorage.setItem(SB_SYNCED, at); } catch (e) {}
    syncUI();
  } catch (e) { syncUI('Sync failed: ' + e.message); }
  finally { syncBusy = false; }
}
function syncSoon() { clearTimeout(syncTimer); syncTimer = setTimeout(syncPush, 4000); }

async function syncPull() {
  const rows = await sbFetch('/rest/v1/synced_data?select=enc_salt,payload,updated_at');
  remoteCache = rows && rows[0] || null;
  remoteChecked = true;
  return remoteCache;
}
async function syncApply(remote, key) {
  const plain = new TextDecoder().decode(await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv: vunb64(remote.payload.split(':')[1])}, key, vunb64(remote.payload.split(':')[2])));
  const o = JSON.parse(plain);
  for (const k of VAULT_KEYS) { const v = o.data && o.data[k]; v == null ? (delete VAULT.cache[k], localStorage.removeItem(k)) : vset(k, v); }
  if (Array.isArray(o.watch)) { watchlist = o.watch; saveWatch(); }
  try { localStorage.setItem(SB_SYNCED, remote.updated_at); } catch (e) {}
}

// On start: bring this device up to date, or upload if it is newer
async function syncOnStart() {
  if (!sbOn() || !sbSession()) return syncUI();
  let remote;
  try { remote = await syncPull(); } catch (e) { remoteChecked = true; return syncUI('Couldn\'t reach sync: ' + e.message); }
  const c = lockConf(), local = (() => { try { return localStorage.getItem(SB_SYNCED); } catch (e) { return null; } })();
  if (!remote) return syncUI();
  if (VAULT.key && c && c.encSalt === remote.enc_salt) {
    if (!local || remote.updated_at > local) {
      try { await syncApply(remote, VAULT.key); location.reload(); } catch (e) { syncUI('Couldn\'t read synced data.'); }
    } else syncUI();
    return;
  }
  syncUI(); // needs the passcode (new device, or passcode changed elsewhere)
}

// ── UI ──
function syncUI(msg) {
  const card = $('sync-card'); if (!card) return;
  card.hidden = !sbOn();
  if (!sbOn()) return;
  const s = sbSession(), c = lockConf();
  const show = id => ['sync-out', 'sync-code', 'sync-create', 'sync-pass', 'sync-in'].forEach(x => $(x).hidden = x !== id);
  $('sync-setpass').hidden = true;
  let text;
  if (!s && pendingEmail) { show('sync-code'); text = `We emailed ${pendingEmail}. Enter the 6-digit code from the email here, or open the link in this same browser.`; }
  else if (!s) { show('sync-out'); text = 'Already use Portfolio Intel on another device? Sign in with the same email and you\'ll unlock your data with your existing passcode. No need to set a new one. Your data is encrypted with your passcode before it leaves the device.'; }
  else if (!remoteChecked) { show(null); text = 'Checking for your synced data…'; }
  else if (remoteCache && !(VAULT.key && c && c.encSalt === remoteCache.enc_salt)) { show('sync-pass'); $('sync-pass-btn').textContent = 'Unlock synced data'; text = 'Your synced data is here. Enter the passcode you use on your other device to load it here.'; }
  else if (!c || !c.encSalt) { show('sync-create'); text = 'You\'re signed in. Last step: create a passcode. It encrypts your portfolio on this device before it syncs, so only you can read it.'; }
  else if (!c || !c.sync) { show('sync-pass'); $('sync-setpass').hidden = false; $('sync-pass-btn').textContent = 'Turn on sync'; text = `Signed in. Enter your passcode to turn on sync. Sync needs a passcode of at least ${SYNC_MIN_PASS} characters. No passcode yet? Tap Set passcode.`; }
  else {
    show('sync-in');
    const at = (() => { try { return localStorage.getItem(SB_SYNCED); } catch (e) { return null; } })();
    text = 'Sync is on' + (s.email ? ' for ' + s.email : '') + (at ? ' · last synced ' + new Date(at).toLocaleString('en-US', {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) : '') + '.';
  }
  $('sync-text').textContent = msg || text;
}

async function syncWithPasscode(pass) {
  const c = lockConf();
  const remote = remoteCache || await syncPull().catch(() => null);
  if (remote && !(VAULT.key && c && c.encSalt === remote.enc_salt)) {
    // Load synced data: derive the key from the passcode and the synced salt
    const key = await vaultDerive(pass, vunb64(remote.enc_salt));
    try { await crypto.subtle.decrypt({name: 'AES-GCM', iv: vunb64(remote.payload.split(':')[1])}, key, vunb64(remote.payload.split(':')[2])); }
    catch (e) { return syncUI('That passcode doesn\'t open your synced data.'); }
    const salt = crypto.getRandomValues(new Uint8Array(16)), iter = 210000;
    localStorage.setItem(LOCK_KEY, JSON.stringify({salt: b64(salt), iter, hash: await hashPass(pass, salt, iter), encSalt: remote.enc_salt, sync: true}));
    await vaultUse(key);
    try { sessionStorage.setItem('pi.unlocked', String(Date.now())); } catch (e) {}
    await syncApply(remote, key);
    location.reload();
    return;
  }
  // Turn on sync from this device
  if (!c || !c.encSalt) return syncUI(`Set a passcode first (at least ${SYNC_MIN_PASS} characters). Tap Set passcode.`);
  if (!c.hash || await hashPass(pass, unb64(c.salt), c.iter) !== c.hash) return syncUI('Wrong passcode.');
  if (pass.length < SYNC_MIN_PASS) return syncUI(`Sync needs a passcode of at least ${SYNC_MIN_PASS} characters. Tap Set passcode to change it, then try again.`);
  localStorage.setItem(LOCK_KEY, JSON.stringify({...c, sync: true}));
  await syncPush();
}

function wireAccount() {
  if (!sbOn()) { const card = $('sync-card'); if (card) card.hidden = true; return; }
  $('sync-out').onsubmit = async e => {
    e.preventDefault();
    const email = $('sync-email').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return syncUI('Enter a valid email address.');
    try {
      await sbFetch('/auth/v1/otp?redirect_to=' + encodeURIComponent(location.origin + location.pathname), {method: 'POST', body: JSON.stringify({email, create_user: true})}, false);
      pendingEmail = email;
      syncUI();
      setTimeout(() => $('sync-code-in').focus(), 50);
    } catch (e) { syncUI('Couldn\'t send the email: ' + e.message); }
  };
  $('sync-code').onsubmit = async e => {
    e.preventDefault();
    const token = $('sync-code-in').value.replace(/\D/g, '');
    if (token.length < 6) return syncUI('Enter the code from the email.');
    try {
      const d = await sbFetch('/auth/v1/verify', {method: 'POST', body: JSON.stringify({type: 'email', email: pendingEmail, token})}, false);
      sbSave({access_token: d.access_token, refresh_token: d.refresh_token, email: d.user && d.user.email || pendingEmail,
        expires_at: Math.floor(Date.now() / 1000) + (d.expires_in || 3600)});
      pendingEmail = ''; $('sync-code-in').value = '';
      syncUI(); await syncOnStart();
    } catch (err) { syncUI('That code didn\'t work (' + err.message + '). Check it, or tap Back and send a new one.'); }
  };
  $('sync-code-back').onclick = () => { pendingEmail = ''; syncUI(); };
  $('sync-pass').onsubmit = async e => {
    e.preventDefault();
    const pass = $('sync-pass-in').value; $('sync-pass-in').value = '';
    try { await syncWithPasscode(pass); } catch (err) { syncUI('Something went wrong: ' + err.message); }
  };
  const meter = () => {
    const v = $('sync-new-1').value, kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(v)).length;
    $('sync-new-meter').textContent = !v ? '' : v.length < SYNC_MIN_PASS ? `Too short: ${v.length}/${SYNC_MIN_PASS} characters.`
      : v.length >= 14 || (v.length >= 10 && kinds >= 3) ? 'Strong.' : 'OK. Longer is stronger, a short phrase works well.';
  };
  $('sync-new-1').oninput = meter;
  $('sync-create').onsubmit = async e => {
    e.preventDefault();
    const a = $('sync-new-1').value, b = $('sync-new-2').value;
    if (a.length < SYNC_MIN_PASS) return syncUI(`Use at least ${SYNC_MIN_PASS} characters.`);
    if (a !== b) return syncUI('Passcodes don\'t match.');
    if (!$('sync-new-ack').checked) return syncUI('Tick the box to confirm you understand the passcode can\'t be reset.');
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16)), iter = 210000, encSalt = await vaultSeal(a);
      localStorage.setItem(LOCK_KEY, JSON.stringify({salt: b64(salt), iter, hash: await hashPass(a, salt, iter), encSalt, sync: true}));
      sessionStorage.setItem('pi.unlocked', String(Date.now()));
      $('sync-new-1').value = $('sync-new-2').value = ''; $('sync-new-meter').textContent = '';
      $('lock-set').textContent = 'Change passcode';
      await syncPush();
      syncUI('All set. Sync is on and your data is encrypted.' + (typeof pkOn === 'function' && pkOn() ? ' Tap Add a passkey to use Face ID or Touch ID next time.' : ''));
    } catch (err) { syncUI('Couldn\'t set up: ' + err.message); }
  };
  $('sync-now').onclick = syncPush;
  $('sync-setpass').onclick = () => $('lock-set').click();
  $('sync-signout').onclick = async () => {
    try { await sbFetch('/auth/v1/logout', {method: 'POST'}); } catch (e) {}
    sbSave(null); remoteCache = null; remoteChecked = false;
    const c = lockConf(); if (c && c.sync) { delete c.sync; localStorage.setItem(LOCK_KEY, JSON.stringify(c)); }
    syncUI('Signed out. Your data stays on this device.');
  };
  $('sync-delete').onclick = async () => {
    if (!confirm('Delete your synced copy from the cloud? Data on this device stays.')) return;
    try {
      await sbFetch('/rest/v1/synced_data?user_id=not.is.null', {method: 'DELETE'});
      remoteCache = null; remoteChecked = true;
      const c = lockConf(); if (c && c.sync) { delete c.sync; localStorage.setItem(LOCK_KEY, JSON.stringify(c)); }
      localStorage.removeItem(SB_SYNCED);
      syncUI('Synced copy deleted.');
    } catch (e) { syncUI('Couldn\'t delete: ' + e.message); }
  };
  const s = sbSession();
  if (s && !s.email) sbFetch('/auth/v1/user').then(u => { sbSave({...sbSession(), email: u.email}); syncUI(); }).catch(() => {});
  syncUI();
  if (typeof wirePasskeys === 'function') wirePasskeys();
  wireWelcome();
  syncOnStart().then(() => {
    if (!justSignedIn) return;
    location.hash = '#import'; // the Portfolio page, where the sync box lives
    setTimeout(() => {
      const card = $('sync-card'); if (!card) return;
      card.scrollIntoView({behavior: 'smooth', block: 'center'});
      card.classList.add('flash');
      const c = lockConf();
      if (c && c.encSalt && !(remoteCache && !(VAULT.key && c.encSalt === remoteCache.enc_salt)) && !c.sync)
        syncUI(`You're signed in. Enter your passcode to start syncing (at least ${SYNC_MIN_PASS} characters; no passcode yet? Tap Set passcode).`);
      setTimeout(() => card.classList.remove('flash'), 2500);
    }, 400);
  });
}

// First visit: offer sign-up / sign-in once, with a skip
const WELCOME_KEY = 'pi.welcome.v1';
function wireWelcome() {
  const dlg = $('welcome-dlg'); if (!dlg) return;
  const seen = (() => { try { return localStorage.getItem(WELCOME_KEY); } catch (e) { return '1'; } })();
  const done = () => { try { localStorage.setItem(WELCOME_KEY, '1'); } catch (e) {} dlg.close(); };
  const toCard = focusId => {
    done(); location.hash = '#import';
    setTimeout(() => { const c = $('sync-card'); if (!c) return; c.scrollIntoView({behavior: 'smooth', block: 'center'}); c.classList.add('flash');
      setTimeout(() => c.classList.remove('flash'), 2500); focusId && $(focusId) && $(focusId).focus(); }, 400);
  };
  $('welcome-email').onclick = () => toCard('sync-email');
  $('welcome-skip').onclick = done;
  const pk = $('welcome-pk');
  if (typeof pkOn === 'function' && pkOn()) { pk.hidden = false; pk.onclick = () => { toCard(); pkSignIn().catch(e => pkErr(e, syncUI)); }; }
  dlg.addEventListener('cancel', () => { try { localStorage.setItem(WELCOME_KEY, '1'); } catch (e) {} });
  const c = lockConf();
  if (!seen && !sbSession() && !justSignedIn && !(c && c.encSalt) && !document.body.classList.contains('locked')) dlg.showModal();
}
