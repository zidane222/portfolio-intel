// ─────────────────────────────────────────────
//  PASSKEYS (sign in + unlock)
// ─────────────────────────────────────────────
// A passkey signs in through Supabase Auth and, where the device supports the WebAuthn PRF
// extension, also unlocks the encrypted vault. PRF gives a secret that only this passkey can
// produce; it wraps the vault key, so the passcode isn't needed. The PRF output never leaves the
// device. Only the wrapped key is stored: in the lock settings here and in the user's account
// metadata, so a synced passkey can unlock the data on a new device. The passcode stays as backup.
const PK_HOST = 'portfolio-intel-279.pages.dev'; // passkeys are tied to this address (the RP ID)
const pkOn = () => !!window.PublicKeyCredential && (location.hostname === PK_HOST || location.hostname === 'localhost');
const b64u = buf => vb64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => vunb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
let pkSalt = null;
async function pkPrfSalt() {
  return pkSalt || (pkSalt = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('portfolio-intel/vault/v1'))));
}
async function pkWrapKey(prf) {
  const base = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('pi-vault-wrap')},
    base, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}
async function pkWrap(prf) {
  const raw = await crypto.subtle.exportKey('raw', VAULT.key), iv = crypto.getRandomValues(new Uint8Array(12));
  return vb64(iv) + ':' + vb64(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, await pkWrapKey(prf), raw));
}
async function pkUnwrap(prf, wrap) {
  const [iv, ct] = wrap.split(':');
  const raw = await crypto.subtle.decrypt({name: 'AES-GCM', iv: vunb64(iv)}, await pkWrapKey(prf), vunb64(ct));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
}
const pkPrf = cred => { const r = cred.getClientExtensionResults().prf; return r && r.results && r.results.first || null; };

// Server options (JSON, base64url) to what the browser API takes
function pkCreateOpts(o) {
  if (PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(o);
  return {...o, challenge: unb64u(o.challenge), user: {...o.user, id: unb64u(o.user.id)},
    excludeCredentials: (o.excludeCredentials || []).map(c => ({...c, id: unb64u(c.id)}))};
}
function pkGetOpts(o) {
  if (PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(o);
  return {...o, challenge: unb64u(o.challenge), allowCredentials: (o.allowCredentials || []).map(c => ({...c, id: unb64u(c.id)}))};
}
// Credential to JSON for the server. Extension results are left out so the PRF secret is never sent.
function pkJSON(cred) {
  const r = cred.response, out = {id: cred.id, rawId: cred.id, type: 'public-key', clientExtensionResults: {},
    authenticatorAttachment: cred.authenticatorAttachment || undefined, response: {clientDataJSON: b64u(r.clientDataJSON)}};
  if (r.attestationObject) { out.response.attestationObject = b64u(r.attestationObject); if (r.getTransports) out.response.transports = r.getTransports(); }
  else { out.response.authenticatorData = b64u(r.authenticatorData); out.response.signature = b64u(r.signature); if (r.userHandle) out.response.userHandle = b64u(r.userHandle); }
  return out;
}
// Ask an existing passkey for its PRF secret (local, no server round trip)
async function pkAskPrf(ids) {
  const cred = await navigator.credentials.get({publicKey: {challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname,
    allowCredentials: ids.map(id => ({type: 'public-key', id: unb64u(id)})), userVerification: 'required',
    extensions: {prf: {eval: {first: await pkPrfSalt()}}}}});
  return {id: cred.id, prf: pkPrf(cred)};
}
async function pkSaveRemoteWrap(id, wrap, encSalt) {
  const u = await sbFetch('/auth/v1/user');
  const pk = {...((u.user_metadata || {}).pk || {})};
  pk[id] = {w: wrap, s: encSalt};
  await sbFetch('/auth/v1/user', {method: 'PUT', body: JSON.stringify({data: {pk}})});
}

// Add a passkey to the signed-in account and let it unlock this data
async function pkAdd() {
  const c = lockConf();
  if (!sbSession()) return syncUI('Sign in first, then add a passkey.');
  if (!VAULT.key || !c || !c.encSalt) return syncUI('Set a passcode and unlock first, then add a passkey.');
  const o = await sbFetch('/auth/v1/passkeys/registration/options', {method: 'POST', body: '{}'});
  const pub = pkCreateOpts(o.options);
  pub.extensions = {...(pub.extensions || {}), prf: {eval: {first: await pkPrfSalt()}}};
  const cred = await navigator.credentials.create({publicKey: pub});
  await sbFetch('/auth/v1/passkeys/registration/verify', {method: 'POST', body: JSON.stringify({challenge_id: o.challenge_id, credential: pkJSON(cred)})});
  let prf = pkPrf(cred);
  if (!prf && cred.getClientExtensionResults().prf && cred.getClientExtensionResults().prf.enabled) {
    syncUI('Passkey added. Confirm once more so it can unlock your data.');
    try { prf = (await pkAskPrf([cred.id])).prf; } catch (e) {}
  }
  if (!prf) return syncUI('Passkey added for sign-in. This device can\'t use it to unlock your data, so you\'ll still enter your passcode here.');
  const wrap = await pkWrap(prf);
  const next = lockConf(); next.pk = {...(next.pk || {}), [cred.id]: wrap}; localStorage.setItem(LOCK_KEY, JSON.stringify(next));
  try { await pkSaveRemoteWrap(cred.id, wrap, next.encSalt); } catch (e) {}
  syncUI('Passkey added. Next time, sign in and unlock with Face ID, Touch ID or your device lock. Keep your passcode as a backup.');
  pkUI();
}

// Sign in with a passkey; also unlock the synced data when the passkey can
async function pkSignIn() {
  const o = await sbFetch('/auth/v1/passkeys/authentication/options', {method: 'POST', body: '{}'}, false);
  const pub = pkGetOpts(o.options);
  pub.extensions = {...(pub.extensions || {}), prf: {eval: {first: await pkPrfSalt()}}};
  const cred = await navigator.credentials.get({publicKey: pub});
  const d = await sbFetch('/auth/v1/passkeys/authentication/verify', {method: 'POST', body: JSON.stringify({challenge_id: o.challenge_id, credential: pkJSON(cred)})}, false);
  const s = d.session || d;
  if (!s.access_token) throw new Error('No session returned');
  const user = s.user || d.user || {};
  sbSave({access_token: s.access_token, refresh_token: s.refresh_token, email: user.email,
    expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600)});
  justSignedIn = true;
  const prf = pkPrf(cred);
  const entry = prf && ((user.user_metadata || {}).pk || {})[cred.id];
  if (entry) {
    const remote = await syncPull().catch(() => null);
    if (remote && remote.enc_salt === entry.s) {
      try {
        const key = await pkUnwrap(prf, entry.w);
        const [, iv, ct] = remote.payload.split(':');
        await crypto.subtle.decrypt({name: 'AES-GCM', iv: vunb64(iv)}, key, vunb64(ct)); // right key before anything is replaced
        await vaultUse(key);
        const check = await vaultEncrypt('pi-ok');
        localStorage.setItem(LOCK_KEY, JSON.stringify({encSalt: remote.enc_salt, sync: true, check, pk: {[cred.id]: entry.w}}));
        try { sessionStorage.setItem('pi.unlocked', String(Date.now())); } catch (e) {}
        await syncApply(remote, key);
        location.reload();
        return;
      } catch (e) {}
    }
  }
  syncUI(); await syncOnStart();
}

// Lock screen: unlock with a passkey saved on this device
async function pkUnlock() {
  const c = lockConf(); if (!c || !c.pk) return;
  const {id, prf} = await pkAskPrf(Object.keys(c.pk));
  if (!prf || !c.pk[id]) { $('lock-err').textContent = 'This passkey can\'t unlock here. Use your passcode.'; return; }
  await vaultUse(await pkUnwrap(prf, c.pk[id]));
  try { sessionStorage.setItem('pi.unlocked', String(Date.now())); } catch (e) {}
  location.reload();
}

function pkUI() {
  const on = pkOn(), c = lockConf();
  const set = (id, show) => { const el = $(id); if (el) el.hidden = !show; };
  set('sync-pk', on);
  set('sync-pk-add', on);
  set('lock-pk', on && !!(c && c.pk && Object.keys(c.pk).length));
}
function pkErr(e, where) {
  if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) return where('Passkey cancelled.');
  where('Passkey problem: ' + (e && e.message || e));
}
function wirePasskeys() {
  pkUI();
  if (!pkOn()) return;
  $('sync-pk').onclick = () => pkSignIn().catch(e => pkErr(e, syncUI));
  $('sync-pk-add').onclick = () => pkAdd().catch(e => pkErr(e, syncUI));
  $('lock-pk').onclick = () => pkUnlock().catch(e => pkErr(e, m => { $('lock-err').textContent = m; }));
}
