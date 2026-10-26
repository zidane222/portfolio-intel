// Per-visitor rate limits. Counts live in each Worker instance, which is enough to stop
// casual abuse of the AI key. (A shared store can replace this later without changing callers.)
const LIMITS = {
  ai: [[8, 60], [60, 3600], [200, 86400]],
  api: [[120, 60]],
  ask: [[6, 60], [40, 3600], [150, 86400]], // POST /api/ask, checked in the gateway before the supervisor
  private: [[30, 60]], // pi-private
  newsread: [[3, 60], [10, 86400]], // uncached news reads; counted with count() only when Groq ran (plan D10)
};
const HITS = new Map();

export function clientIp(req) {
  return req.headers.get('CF-Connecting-IP') || 'unknown';
}

export function rateLimited(req, bucket) {
  const now = Date.now() / 1000;
  const key = bucket + ':' + clientIp(req);
  const longest = Math.max(...LIMITS[bucket].map(([, w]) => w));
  const q = (HITS.get(key) || []).filter(t => t >= now - longest);
  for (const [n, w] of LIMITS[bucket]) {
    if (q.filter(t => t >= now - w).length >= n) { HITS.set(key, q); return true; }
  }
  q.push(now);
  HITS.set(key, q);
  if (HITS.size > 5000) HITS.delete(HITS.keys().next().value);
  return false;
}

// For buckets counted after the fact (newsread): peek reports state without counting, count adds one hit.
// peek -> {minute: true when the shortest window is full, over: true when the longest (daily) window is full, left: hits left in it}
export function peek(req, bucket) {
  const now = Date.now() / 1000;
  const key = bucket + ':' + clientIp(req);
  const rules = LIMITS[bucket];
  const longest = Math.max(...rules.map(([, w]) => w));
  const q = (HITS.get(key) || []).filter(t => t >= now - longest);
  const shortest = rules.reduce((a, b) => (b[1] < a[1] ? b : a));
  const [nLong] = rules.find(([, w]) => w === longest);
  return {
    minute: q.filter(t => t >= now - shortest[1]).length >= shortest[0],
    over: q.length >= nLong,
    left: Math.max(0, nLong - q.length),
  };
}

export function count(req, bucket) {
  const now = Date.now() / 1000;
  const key = bucket + ':' + clientIp(req);
  const longest = Math.max(...LIMITS[bucket].map(([, w]) => w));
  const q = (HITS.get(key) || []).filter(t => t >= now - longest);
  q.push(now);
  HITS.set(key, q);
  if (HITS.size > 5000) HITS.delete(HITS.keys().next().value);
  return peek(req, bucket);
}
