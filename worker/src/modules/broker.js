// Broker module: Plaid investments sync. The access token is encrypted (Fernet, same as the old
// server) and returned to the device; nothing is stored on the server.
import {json, originOk} from '../lib/http.js';
import {rateLimited} from '../lib/ratelimit.js';
import {fernetKey, fernetEncrypt, fernetDecrypt} from '../lib/fernet.js';

const trim = s => String(s || '').trim().replace(/^["']|["']$/g, '');
const base = env => trim(env.PLAID_ENV).toLowerCase() === 'production' ? 'https://production.plaid.com' : 'https://sandbox.plaid.com';

async function plaid(env, path, body) {
  const cid = trim(env.PLAID_CLIENT_ID), sec = trim(env.PLAID_SECRET);
  if (!cid || !sec) throw new Error('Plaid is not set up on the server yet.');
  const r = await fetch(base(env) + path, {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({client_id: cid, secret: sec, ...body}), signal: AbortSignal.timeout(30000)});
  const d = await r.json();
  if (!r.ok) {
    console.log('Plaid error', path, d.error_code, d.error_message);
    throw new Error(`${d.display_message || d.error_message || 'Plaid request failed.'} [${d.error_type || ''} ${d.error_code || ''}, ${base(env).split('//')[1].split('.')[0]}]`);
  }
  return d;
}

function guard(req, env) {
  if (!originOk(req, env)) return json({error: 'Not allowed'}, 403);
  if (rateLimited(req, 'ai')) return json({error: 'Too many requests. Try again later.'}, 429);
  return null;
}

async function openToken(env, tok) {
  try { return await fernetDecrypt(await fernetKey(env), String(tok || '')); }
  catch (e) { throw new Error('This connection is no longer valid. Connect again.'); }
}

const body = async req => { try { return await req.json(); } catch (e) { return {}; } };

export function status(req, env) {
  const cid = trim(env.PLAID_CLIENT_ID), sec = trim(env.PLAID_SECRET);
  return json({configured: !!(cid && sec), env: base(env).includes('production') ? 'production' : 'sandbox',
    client_id_length: cid.length, client_id_starts: cid.slice(0, 4), secret_length: sec.length, expected: 'client_id 24, secret 30'});
}

export async function linkToken(req, env) {
  const g = guard(req, env); if (g) return g;
  try {
    const user = [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('');
    const d = await plaid(env, '/link/token/create', {client_name: 'Portfolio Intel', language: 'en', country_codes: ['US'],
      user: {client_user_id: user}, products: ['investments'], ...(env.PLAID_REDIRECT_URI ? {redirect_uri: env.PLAID_REDIRECT_URI} : {})});
    return json({link_token: d.link_token});
  } catch (e) { return json({error: e.message}, 502); }
}

export async function exchange(req, env) {
  const g = guard(req, env); if (g) return g;
  const b = await body(req);
  try {
    const d = await plaid(env, '/item/public_token/exchange', {public_token: String(b.public_token || '')});
    return json({token: await fernetEncrypt(await fernetKey(env), d.access_token)});
  } catch (e) { return json({error: e.message}, 502); }
}

export function mapHoldings(d) {
  const secs = Object.fromEntries((d.securities || []).map(s => [s.security_id, s]));
  const merged = {};
  for (const h of d.holdings || []) {
    const s = secs[h.security_id] || {};
    const cash = !!s.is_cash_equivalent || s.type === 'cash';
    const tk = String(s.ticker_symbol || (cash ? 'CASH' : '')).toUpperCase();
    if (!tk) continue;
    const m = merged[tk] ||= {ticker: tk, name: s.name || tk, shares: 0, cost: 0, value: 0, isCash: cash};
    m.shares += +h.quantity || 0; m.cost += +h.cost_basis || 0; m.value += +h.institution_value || 0;
  }
  const holdings = Object.values(merged).map(m => ({ticker: m.ticker, name: m.name, shares: Math.round(m.shares * 1e6) / 1e6, isCash: m.isCash,
    avgCost: m.shares && m.cost ? Math.round(m.cost / m.shares * 1e4) / 1e4 : null, marketValue: Math.round(m.value * 100) / 100}));
  const accounts = [...new Set((d.accounts || []).filter(a => a.type === 'investment').map(a => a.name || ''))].sort().join(', ') || null;
  return {holdings, accounts, as_of: new Date().toISOString().slice(0, 10)};
}

export async function holdings(req, env) {
  const g = guard(req, env); if (g) return g;
  const b = await body(req);
  try {
    return json(mapHoldings(await plaid(env, '/investments/holdings/get', {access_token: await openToken(env, b.token)})));
  } catch (e) { return json({error: e.message}, 502); }
}

export async function remove(req, env) {
  const g = guard(req, env); if (g) return g;
  const b = await body(req);
  try { await plaid(env, '/item/remove', {access_token: await openToken(env, b.token)}); } catch (e) { console.log('Plaid remove', e.message); }
  return json({ok: true});
}
