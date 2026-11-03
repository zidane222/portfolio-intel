// Provider switch for news reads. chat(provider, env, ...) calls groqChat or geminiChat.
// providerConfig(env) reads NEWS_PROVIDER / NEWS_FALLBACK / NEWS_SHADOW / NEWS_SHADOW_UNTIL and drops any slot
// that names an unknown provider or a Gemini slot without GEMINI_API_KEY and GEMINI_MODEL, so with no Gemini
// key the behavior is the same as Groq alone.
import {groqChat} from './groq.js';
import {geminiChat} from './gemini.js';

export const PROVIDERS = ['groq', 'gemini'];

export function chat(provider, env, system, user, maxTokens, jsonMode = false, opts = {}) {
  if (provider === 'groq') return groqChat(env, system, user, maxTokens, jsonMode, opts);
  if (provider === 'gemini') return geminiChat(env, system, user, maxTokens, jsonMode, opts);
  throw new Error('AI not configured');
}

export function providerReady(env, p) {
  if (p === 'groq') return !!(env && env.GROQ_API_KEY);
  if (p === 'gemini') return !!(env && env.GEMINI_API_KEY && String(env.GEMINI_MODEL || '').trim());
  return false;
}

export function providerConfig(env) {
  const get = (name, dflt) => { const v = env && env[name]; return v === undefined || v === null ? dflt : String(v).trim().toLowerCase(); };
  const ok = p => PROVIDERS.includes(p) && (p !== 'gemini' || providerReady(env, 'gemini'));
  let primary = get('NEWS_PROVIDER', 'groq');
  if (!PROVIDERS.includes(primary)) primary = 'groq';
  if (primary === 'gemini' && !ok('gemini')) primary = 'groq';
  let fallback = get('NEWS_FALLBACK', '');
  fallback = ok(fallback) && fallback !== primary ? fallback : '';
  let shadow = get('NEWS_SHADOW', '');
  shadow = ok(shadow) && shadow !== primary ? shadow : '';
  const until = String((env && env.NEWS_SHADOW_UNTIL) || '').trim();
  const shadowUntil = /^\d{4}-\d{2}-\d{2}$/.test(until) ? until : '';
  return {primary, fallback, shadow, shadowUntil};
}
