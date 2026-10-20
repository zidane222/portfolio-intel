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
