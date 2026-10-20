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
  $('lock-set').onclick = () => { $('pass-1').value = ''; $('pass-2').value = ''; $('pass-err').textContent = ''; $('pass-off').style.display = lockConf() ? '' : 'none';
    const hint = $('pass-sync-hint'); if (hint) hint.hidden = !!lockConf() || typeof sbSession !== 'function' || !!sbSession();
    dlg.showModal(); };
  const ps = $('pass-signin'); if (ps) ps.onclick = () => { dlg.close(); setTimeout(() => { const c = $('sync-card'); c && c.scrollIntoView({behavior: 'smooth', block: 'center'}); $('sync-email') && $('sync-email').focus(); }, 300); };
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
