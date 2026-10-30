// Mode selection (plan section 5), code only. thin | collaborate | debate.
// Social items (r/*) weigh half and are not counted as publishers, so they never decide the mode alone.

export function chooseMode(pack) {
  const items = (pack && Array.isArray(pack.items)) ? pack.items : [];
  let P = 0, N = 0, n = 0;
  const pos = new Set(), neg = new Set();
  for (const it of items) {
    if (!it.tone) continue;
    n++;
    const w = it.social ? 0.5 : 1;
    if (it.tone > 0) { P += w; if (!it.social) pos.add(it.source); } else { N += w; if (!it.social) neg.add(it.source); }
  }
  const basis = {P, N, n, pubs_pos: pos.size, pubs_neg: neg.size};
  // Thin means too little news (under 3 headlines), not too little tone.
  if (items.length < 3) return {mode: 'thin', ...basis};
  // Plenty of news but the word list can't read its tone: let both sides argue it.
  if (n < 2) return {mode: 'debate', ...basis};
  const dominantPubs = P >= N ? pos.size : neg.size;
  // "Every toned headline has the same sign" is ratio 1. Both paths still need two distinct
  // publishers on the dominant side, so one site flooding one tone cannot force collaborate.
  if (Math.max(P, N) / (P + N) >= 0.75 && dominantPubs >= 2) return {mode: 'collaborate', ...basis};
  return {mode: 'debate', ...basis};
}

// Confidence cap (V17), from the pack and mode.
export function confidenceCap(pack, mode) {
  const items = (pack && pack.items) || [];
  const pubs = new Set(items.filter(i => !i.social).map(i => i.source)).size;
  const m = typeof mode === 'string' ? mode : mode && mode.mode;
  if (items.length < 4 || pubs <= 1) return 'low';
  if (m === 'collaborate' && pubs >= 3) return 'high';
  return 'medium';
}
