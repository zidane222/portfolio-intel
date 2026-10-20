// Fernet (AES-128-CBC + HMAC-SHA256), compatible with Python's cryptography.fernet.
// Lets connections made on the old Python server keep working after the move.
const te = new TextEncoder(), td = new TextDecoder();
const b64u = {
  enc: bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_'),
  dec: s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)),
};

export async function fernetKey(env) {
  if (env.PLAID_TOKEN_KEY) return b64u.dec(env.PLAID_TOKEN_KEY);
  const seed = te.encode(String(env.PLAID_SECRET || '').trim().replace(/^["']|["']$/g, '') + ':portfolio-intel-token');
  return new Uint8Array(await crypto.subtle.digest('SHA-256', seed));
}

async function keys(raw) {
  const sign = await crypto.subtle.importKey('raw', raw.slice(0, 16), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign', 'verify']);
  const enc = await crypto.subtle.importKey('raw', raw.slice(16, 32), {name: 'AES-CBC'}, false, ['encrypt', 'decrypt']);
  return {sign, enc};
}

export async function fernetEncrypt(raw, text) {
  const {sign, enc} = await keys(raw);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ct = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-CBC', iv}, enc, te.encode(text)));
  const ts = new Uint8Array(8);
  new DataView(ts.buffer).setBigUint64(0, BigInt(Math.floor(Date.now() / 1000)));
  const body = new Uint8Array([0x80, ...ts, ...iv, ...ct]);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', sign, body));
  return b64u.enc(new Uint8Array([...body, ...mac]));
}

export async function fernetDecrypt(raw, token) {
  const {sign, enc} = await keys(raw);
  const all = b64u.dec(token);
  if (all.length < 57 || all[0] !== 0x80) throw new Error('bad token');
  const body = all.slice(0, -32), mac = all.slice(-32);
  if (!(await crypto.subtle.verify('HMAC', sign, mac, body))) throw new Error('bad token');
  const iv = body.slice(9, 25), ct = body.slice(25);
  return td.decode(await crypto.subtle.decrypt({name: 'AES-CBC', iv}, enc, ct));
}
