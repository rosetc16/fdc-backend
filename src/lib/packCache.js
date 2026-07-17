// In-memory cache for the /api/player-pack response.
//
// WHY THIS EXISTS
// The player-pack endpoint is the most expensive thing the server does: several DB queries plus a ~3,000-player
// payload, rebuilt on every draft open. Its result depends ONLY on the query params (season/format/k/dst/idp) —
// there's no auth and nothing user-specific — so two people in the same format get a byte-identical response.
// Without a cache, a traffic spike means N requests × several queries each for answers we already computed.
//
// The underlying ADP moves only when the refresh jobs run (a few times a day), so a short TTL is safe. The jobs
// call clear() when new data lands, which means fresh ADP is visible immediately rather than up to a TTL later.
//
// This lives in lib/ (not in the route) so background jobs can invalidate the cache without importing the HTTP
// layer — a standalone job shouldn't have to pull in Express just to clear a Map.
const TTL_MS = 10 * 60 * 1000; // 10 minutes — well inside the refresh cadence, long enough to absorb a spike
const MAX_ENTRIES = 120;       // a few dozen real format keys; the cap just guards against unbounded growth

const cache = new Map(); // key -> { at, body }

export function packCacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) { cache.delete(key); return null; }
  // Re-insert to mark most-recently-used (Map preserves insertion order, which the LRU eviction below relies on)
  cache.delete(key); cache.set(key, hit);
  return hit.body;
}

export function packCacheSet(key, body) {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value; // least-recently-used
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), body });
}

// Called by the refresh jobs the moment new ADP is written.
export function clearPlayerPackCache() { cache.clear(); }

// Small introspection helper for admin/debugging — how much is actually being served from memory.
export function packCacheStats() { return { entries: cache.size, ttlMs: TTL_MS, max: MAX_ENTRIES }; }
