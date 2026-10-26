// Text rendering of a news read record (pi/news-verdict/v1) for Ask. Code writes the label,
// stance and confidence wording; cites [[e3]] become "(CNBC, Oct 25)". The front end has its own
// renderer from the same record. Headline titles are not placed in this text (they go to sources).
import {DISCLAIMER} from '../render.js';

export const NEWS_LABEL = 'News read, not a recommendation.';
export const MESSAGES = {
  thin: 'Not enough news in the last 7 days for a news read.',
  limited: "You have used today's news reads. Cached reads still show.",
  busy: "News reads are at today's limit. Try again tomorrow.",
  fallback: 'We could not write a checked read. Here are the headlines.',
  invalid: 'Unknown ticker',
  unavailable: 'News reads are not available right now.',
  no_side: 'No validated argument for this side.',
};
const STANCE_TEXT = {
  positive: 'The news tone looks positive.', negative: 'The news tone looks negative.',
  mixed: 'The news tone looks mixed.', unclear: 'The news tone is unclear.',
};
const CONF_TEXT = {low: 'Confidence is low.', medium: 'Confidence is medium.', high: 'Confidence is high.'};
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function shortDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  return m ? `${MON[+m[2] - 1]} ${+m[3]}` : '';
}

export function citeText(text, evidence) {
  const byId = new Map((evidence || []).map(e => [e.id, e]));
  return String(text || '').replace(/\s*\[\[(e\d{1,2})\]\]/g, (_, id) => {
    const e = byId.get(id);
    return e ? ` (${e.source}${shortDate(e.date) ? ', ' + shortDate(e.date) : ''})` : '';
  }).replace(/\(([^()]*)\)\s*\(\1\)/g, '($1)').replace(/[–—]/g, ',').trim();
}

const points = (list, ev) => (list || []).map(p => '* ' + citeText(p.text, ev));

// record may be null (limited, busy, unavailable); status picks the fixed message then.
export function renderRead(record, status = null) {
  const st = status || (record && record.status) || 'unavailable';
  const lines = [NEWS_LABEL];
  const ticker = record && record.ticker ? record.ticker : null;
  if (record && record.status === 'PASS') {
    const ev = record.evidence;
    lines.push(`${ticker}: ${STANCE_TEXT[record.stance] || STANCE_TEXT.unclear} ${CONF_TEXT[record.confidence] || CONF_TEXT.low}`);
    if (record.summary) lines.push(citeText(record.summary, ev));
    if (record.mode === 'collaborate') {
      lines.push('Joint brief:', ...points(record.joint, ev));
    } else {
      lines.push('Case for:', ...(record.bull && record.bull.length ? points(record.bull, ev) : ['* ' + MESSAGES.no_side]));
      lines.push('Case against:', ...(record.bear && record.bear.length ? points(record.bear, ev) : ['* ' + MESSAGES.no_side]));
    }
  } else {
    const key = st === 'PASS' ? 'unavailable' : (MESSAGES[st] ? st : st === 'skipped' || st === 'error' ? 'fallback' : 'unavailable');
    lines.push((ticker ? ticker + ': ' : '') + MESSAGES[key]);
  }
  const body = lines.join('\n').slice(0, 1400);
  return body + '\n\n' + DISCLAIMER;
}
