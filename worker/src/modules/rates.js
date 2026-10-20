// Rates module: today's top savings rates, read from The Motley Fool's daily article by the AI.
import {json, grab, memGet, memSet, unescapeHtml} from '../lib/http.js';
import {groqChat} from '../lib/groq.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function articleText(html) {
  let t = String(html).slice(0, 1500000)
    .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|li|tr|h\d|div)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const lines = unescapeHtml(t).split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const keep = lines.map((l, i) => (l.includes('APY') || l.includes('%')) ? i : -1).filter(i => i >= 0);
  if (!keep.length) return '';
  return lines.slice(Math.max(0, keep[0] - 5), keep[keep.length - 1] + 5).join('\n').slice(0, 14000);
}

const SYSTEM = 'Extract savings and money market account offers from this article. Return ONLY a JSON array, no prose. '
  + 'Each item: {"institution": string, "product": string, "apy": number, "min_deposit": number|null, '
  + '"balance_cap": number|null, "conditions": string, "credit_union": boolean, "promo": boolean}. '
  + 'balance_cap is the maximum balance that earns the APY (e.g. 5000 for "5% on the first $5,000"), else null. '
  + 'Use only offers the article states with a specific APY. Skip national averages, CDs, checking accounts, and duplicates. '
  + 'conditions is a short phrase about caps, minimum balances, promo periods or fees, or "" if none.';

export async function topRates(req, env) {
  const hit = memGet('rates');
  if (hit) return json(hit);
  if (!env.GROQ_API_KEY) return json({error: 'AI not configured'}, 503);
  for (let back = 0; back < 4; back++) {
    const d = new Date(Date.now() - back * 86400000);
    const url = `https://www.fool.com/money/banks/articles/top-savings-account-rates-today-${MONTHS[d.getUTCMonth()]}-${d.getUTCDate()}-${d.getUTCFullYear()}/`;
    const html = await grab(url, {as: 'text', timeout: 15000});
    if (!html) continue;
    const text = articleText(html);
    if (text.length < 200) continue;
    let arr;
    try {
      const a = await groqChat(env, SYSTEM, text, 2500);
      arr = JSON.parse(a.slice(a.indexOf('['), a.lastIndexOf(']') + 1));
    } catch (e) { console.log('Top rates AI error', String(e)); continue; }
    const rates = (Array.isArray(arr) ? arr : []).map(x => {
      const apy = parseFloat(x.apy);
      if (!(apy >= 0.5 && apy <= 10) || !x.institution) return null;
      const cap = typeof x.balance_cap === 'number' && x.balance_cap > 0 ? x.balance_cap : null;
      return {institution: String(x.institution).slice(0, 80), product: String(x.product || 'Savings').slice(0, 80), apy: Math.round(apy * 100) / 100,
        min_deposit: x.min_deposit ?? null, cap, conditions: String(x.conditions || '').slice(0, 160), credit_union: !!x.credit_union, promo: !!x.promo};
    }).filter(Boolean).sort((a, b) => b.apy - a.apy);
    if (rates.length) {
      const data = {source: 'The Motley Fool', url, date: d.toISOString().slice(0, 10), rates: rates.slice(0, 15)};
      memSet('rates', data, 12 * 3600);
      memSet('rates:last', data, 7 * 86400);
      return json(data);
    }
  }
  const last = memGet('rates:last');
  return last ? json(last) : json({error: 'No rate article could be read today'}, 502);
}
