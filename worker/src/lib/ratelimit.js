// Per-visitor rate limits. Counts live in each Worker instance, which is enough to stop
// casual abuse of the AI key. (A shared store can replace this later without changing callers.)
const LIMITS = {
  ai: [[8, 60], [60, 3600], [200, 86400]],
  api: [[120, 60]],
  ask: [[6, 60], [40, 3600], [150, 86400]], // POST /api/ask, checked in the gateway before the supervisor
  private: [[30, 60]], // pi-private
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
