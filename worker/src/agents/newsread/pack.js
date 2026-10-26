// Evidence pack (contract 6.1 pack). Pure code: cleans, drops old items, clusters syndicated
// copies (one story counts once), caps at 8 and gives stable ids e1..e8, newest first.
import {cleanText, TICKER_RE} from '../case.js';
import {tone} from './lexicon.js';

export const WINDOW_DAYS = 7;
export const MAX_ITEMS = 8;
const DAY = 86400000;

// Headline text is attacker controlled. Fold look-alike characters, drop zero-width and other
// format characters, URLs and anything that could break the <headlines> tag or the [[eN]] cites.
export function cleanTitle(s) {
  const t = String(s == null ? '' : s).normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[–—]/g, ',')
    .replace(/\bhttps?:\/\/\S+/gi, ' ').replace(/\bwww\.\S+/gi, ' ').replace(/\|/g, ' ');
  return cleanText(t, 160);
}
const cleanSource = s => cleanTitle(s).replace(/[^\w &.'/-]/g, '').trim().slice(0, 40) || 'Unknown';
const key = t => new Set(String(t).toLowerCase().match(/[a-z0-9]+/g) || []);
function similar(a, b) {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 && inter / union >= 0.6;
}

export function buildPack(ticker, headlines, now = Date.now()) {
  const t = String(ticker || '').toUpperCase();
  if (!TICKER_RE.test(t)) throw new Error('bad ticker');
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
  const rows = [];
  for (const h of Array.isArray(headlines) ? headlines : []) {
    if (!h || typeof h !== 'object') continue;
    const title = cleanTitle(h.title);
    if (title.length < 8) continue;
    const when = new Date(h.published || h.date || '').getTime();
    if (!Number.isFinite(when) || when < nowMs - WINDOW_DAYS * DAY || when > nowMs + DAY) continue;
    const link = String(h.link || h.url || '');
    const source = cleanSource(h.source);
    rows.push({title, source, when, url: /^https:\/\/[^\s<>"']+$/.test(link) ? link.slice(0, 500) : null,
      social: h.social === true || /^r\//i.test(source)});
  }
  rows.sort((a, b) => b.when - a.when);
  const clusters = [];
  const items = [];
  for (const r of rows) {
    const k = key(r.title);
    if (clusters.some(c => similar(c, k))) continue; // syndicated copy of a story already in the pack
    clusters.push(k);
    items.push({id: `e${items.length + 1}`, title: r.title, source: r.source, date: new Date(r.when).toISOString().slice(0, 10),
      url: r.url, tone: tone(r.title), cluster: clusters.length, social: r.social});
    if (items.length >= MAX_ITEMS) break;
  }
  return {ticker: t, asof: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z'), window_days: WINDOW_DAYS, items};
}
