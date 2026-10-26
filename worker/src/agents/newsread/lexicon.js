// News tone lexicon (plan section 5). Code only, used to pick the mode, never shown as a verdict.
// Stems match the start of a word ("beat" matches "beats", "beating"). Phrases match whole words.

export const POSITIVE = [
  'beat', 'record', 'upgrade', 'surge', 'soar', 'jump', 'rally', 'gain', 'rise', 'rises', 'rising', 'climb',
  'approval', 'approved', 'approves', 'wins', 'won', 'award', 'contract', 'partnership', 'partner',
  'expand', 'expansion', 'growth', 'grow', 'strong', 'robust', 'boost', 'outpace', 'exceed', 'tops', 'topped',
  'profit', 'profitable', 'breakthrough', 'launch', 'milestone', 'buyback', 'repurchase', 'dividend hike',
  'raises dividend', 'raises guidance', 'raises outlook', 'lifts guidance', 'lifts forecast', 'raises forecast',
  'upbeat', 'optimism', 'optimistic', 'rebound', 'recover', 'recovery', 'accelerat', 'demand', 'momentum',
  'all-time high', 'new high', 'tailwind', 'settle', 'cleared', 'clears', 'secures', 'lands', 'deal',
];
export const NEGATIVE = [
  'misses', 'missed', 'downgrade', 'probe', 'lawsuit', 'sues', 'sued', 'recall', 'plunge', 'tumble', 'slump', 'sink', 'sank',
  'drop', 'fall', 'falls', 'fell', 'decline', 'slide', 'slid', 'crash', 'loss', 'losses', 'lose', 'weak',
  'warn', 'warning', 'cut', 'cuts guidance', 'lowers guidance', 'lowers outlook', 'cuts forecast', 'layoff',
  'job cuts', 'fine', 'fined', 'penalty', 'investigation', 'subpoena', 'antitrust', 'bans', 'banned', 'halt',
  'delay', 'delayed', 'shortage', 'default', 'bankrupt', 'fraud', 'scandal', 'resign', 'ousted', 'breach',
  'hack', 'outage', 'headwind', 'concern', 'fear', 'risk', 'pressure', 'selloff', 'sell-off', 'disappoint',
  'slow', 'slowdown', 'struggle', 'tariff', 'short seller', 'strike',
];
const NEGATORS = new Set(['not', 'no', 'never', 'without', "isn't", "wasn't", "won't", "doesn't", "didn't", "can't", 'fails', 'failed', 'fail']);

const words = s => String(s || '').toLowerCase().normalize('NFKC').replace(/\p{Cf}/gu, '').match(/[a-z][a-z'-]*/g) || [];

// Questions ("Is NVDA a buy?") and listicles ("5 stocks to watch") carry no tone.
export function neutralShape(title) {
  const t = String(title || '').trim();
  if (/\?\s*$/.test(t)) return true;
  if (/^(is|are|should|can|will|why|what|how|could|does|do)\b/i.test(t)) return true;
  if (/^\s*(top\s+)?\d+\s+(stocks?|reasons?|things?|ways?|picks?|etfs?)\b/i.test(t) || /\b(stocks?|picks?) to (watch|buy)\b/i.test(t)) return true;
  return false;
}

function hits(ws, list) {
  const out = [];
  for (const entry of list) {
    const parts = entry.split(' ');
    for (let i = 0; i + parts.length <= ws.length; i++) {
      // all words but the last must match exactly; the last is a stem
      const ok = parts.every((p, j) => (j === parts.length - 1 ? ws[i + j].startsWith(p) : ws[i + j] === p));
      if (ok) out.push(i);
    }
  }
  return [...new Set(out)];
}

const negated = (ws, i) => ws.slice(Math.max(0, i - 3), i).some(w => NEGATORS.has(w));

// tone(title) -> 1, -1 or 0. Negation within 3 words before a hit flips it ("fails to beat").
export function tone(title) {
  if (neutralShape(title)) return 0;
  const ws = words(title);
  let score = 0;
  for (const i of hits(ws, POSITIVE)) score += negated(ws, i) ? -1 : 1;
  for (const i of hits(ws, NEGATIVE)) score += negated(ws, i) ? 1 : -1;
  return score > 0 ? 1 : score < 0 ? -1 : 0;
}
