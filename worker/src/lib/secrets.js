// Reads secrets whether they are plain Worker secrets (strings) or linked from the
// Cloudflare Secrets Store (objects with an async get()). Returns a copy of env with strings.
const NAMES = ['GROQ_API_KEY', 'PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_TOKEN_KEY', 'PLAID_REDIRECT_URI'];

export async function resolveSecrets(env) {
  const out = {...env};
  await Promise.all(NAMES.map(async n => {
    const v = env[n];
    if (v && typeof v === 'object' && typeof v.get === 'function') {
      try { out[n] = await v.get(); } catch (e) { out[n] = undefined; console.log('Secrets Store read failed for', n); }
    }
  }));
  return out;
}
