/* SHARED UPSTREAM CACHE FOR LIVE DRAFTS — turn per-USER load into per-DRAFT load.
 *
 * THE PROBLEM, MEASURED (adpfix/loadrig.mjs, 12 users on one draft):
 *   upstream Sleeper calls per user-minute ... 60.5
 *   concurrent drafters before the app-wide ceiling ... 16
 *
 * The client polls /api/connect/sleeper/picks every 2 seconds while a draft is live, and each poll made two
 * uncached Sleeper calls (draft meta + picks). So ten people in the SAME twelve-team league each triggered
 * their own pair of fetches for the same twenty picks, twenty times a minute. Sleeper's rate limit is
 * ~1000 calls/minute for the WHOLE APPLICATION — not per user — so this does not degrade gracefully: past
 * about sixteen simultaneous drafters, Sleeper starts refusing the app's traffic and live sync fails for
 * EVERYONE at once, including people whose own draft is quiet.
 *
 * That is a cliff, and it sits at a number Trey can reach today on a busy Sunday with 62 accounts.
 *
 * THE FIX: one upstream fetch per DRAFT per interval, shared by everyone watching it.
 *   · TTL cache keyed by draft id, so the tenth viewer costs nothing.
 *   · SINGLE-FLIGHT: concurrent misses await one shared promise instead of stampeding on expiry. Without
 *     this the cache would help in the steady state and then let twelve simultaneous requests through the
 *     instant it expires — which is exactly when everyone is polling, since they all started together.
 *   · SEPARATE TTLs for the two payloads. Picks change every few minutes at most but are what users are
 *     waiting to see, so they stay fast. Draft META (status, pick timer, teams) barely changes at all, so
 *     it refreshes far more slowly — that alone halves upstream traffic.
 *   · ADAPTIVE BACKOFF. A meter tracks the real upstream rate; as it approaches the ceiling the TTLs
 *     stretch automatically. The app gets a little less instant under extreme load instead of failing
 *     completely, and recovers on its own when the surge passes. Degrading is a feature; a cliff is not.
 *
 * Deliberately in-process rather than Redis: it needs no new infrastructure, and it already removes the
 * cliff. With several web instances each keeps its own copy, so upstream load scales with INSTANCES, not
 * users — a constant a deployment controls, unlike traffic. If that ever becomes the binding limit, this
 * module is the one place to swap in a shared store.
 */
import { log } from './log.js';

// Base freshness windows. Picks stay snappy; meta is nearly static during a draft.
const PICKS_TTL_MS = Number(process.env.DRAFT_PICKS_TTL_MS || 2000);
const META_TTL_MS = Number(process.env.DRAFT_META_TTL_MS || 10000);
// League -> drafts resolution changes once a season, not once a poll.
const DRAFTS_TTL_MS = Number(process.env.LEAGUE_DRAFTS_TTL_MS || 60000);

// Sleeper's app-wide ceiling. We aim to stay well under it and start stretching TTLs before we get there.
const CEILING_PER_MIN = Number(process.env.SLEEPER_CEILING_PER_MIN || 900);
const SOFT_START = 0.5;   // begin stretching once we're at half the ceiling
const MAX_STRETCH = 8;    // never stretch more than 8x (a 2s poll becomes 16s at the very worst)

// ---- upstream rate meter (sliding one-minute window, bucketed per second) ----------------------------
const buckets = new Array(60).fill(0);
let lastSec = Math.floor(Date.now() / 1000);
function noteUpstream(n = 1) {
  const now = Math.floor(Date.now() / 1000);
  if (now !== lastSec) {
    const gap = Math.min(60, now - lastSec);
    for (let i = 1; i <= gap; i++) buckets[(lastSec + i) % 60] = 0;
    lastSec = now;
  }
  buckets[now % 60] += n;
}
export function upstreamPerMin() {
  const now = Math.floor(Date.now() / 1000);
  if (now - lastSec >= 60) return 0;
  return buckets.reduce((a, b) => a + b, 0);
}
// How much to stretch every TTL right now, given current pressure. 1 = no stretch.
export function currentStretch() {
  const rate = upstreamPerMin();
  const soft = CEILING_PER_MIN * SOFT_START;
  if (rate <= soft) return 1;
  // Linear from 1x at the soft start to MAX_STRETCH at the ceiling, then held.
  const over = Math.min(1, (rate - soft) / Math.max(1, CEILING_PER_MIN - soft));
  return 1 + over * (MAX_STRETCH - 1);
}

// ---- the cache ----------------------------------------------------------------------------------------
const store = new Map(); // key -> { at, value, inflight }
let hits = 0, misses = 0, coalesced = 0;

/* Fetch `key` through the cache. `ttlMs` is the base freshness window; the adaptive stretch is applied on
 * top. `fetcher` is only ever called once per (key, window) no matter how many callers arrive together. */
export async function cached(key, ttlMs, fetcher, upstreamCalls = 1) {
  const ttl = ttlMs * currentStretch();
  const e = store.get(key);
  const now = Date.now();
  if (e && e.value !== undefined && now - e.at < ttl) { hits++; return e.value; }
  if (e && e.inflight) { coalesced++; return e.inflight; }   // ⭐ single-flight: join the in-progress fetch
  misses++;
  const p = (async () => {
    try {
      noteUpstream(upstreamCalls);
      const v = await fetcher();
      store.set(key, { at: Date.now(), value: v, inflight: null });
      return v;
    } catch (err) {
      // On failure keep serving the last good value if we have one — a blip upstream should not blank the
      // board mid-draft. Only propagate when there is nothing to fall back to.
      const prev = store.get(key);
      store.set(key, { at: prev && prev.value !== undefined ? prev.at : 0, value: prev ? prev.value : undefined, inflight: null });
      if (prev && prev.value !== undefined) {
        log.warn({ key, err: err && err.message }, 'draftCache: upstream failed, serving last good value');
        return prev.value;
      }
      throw err;
    }
  })();
  store.set(key, { at: e ? e.at : 0, value: e ? e.value : undefined, inflight: p });
  return p;
}

export const picksKey = (draftId) => `picks:${draftId}`;
export const metaKey = (draftId) => `meta:${draftId}`;
export const draftsKey = (leagueId) => `drafts:${leagueId}`;
export const TTL = { picks: PICKS_TTL_MS, meta: META_TTL_MS, drafts: DRAFTS_TTL_MS };

// Evict entries nothing has touched for a while, so a season of finished drafts doesn't sit in memory.
const IDLE_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) if (!v.inflight && now - v.at > IDLE_MS) store.delete(k);
}, 60000).unref();

export function draftCacheStats() {
  const total = hits + misses;
  return {
    entries: store.size, hits, misses, coalesced,
    hitRate: total ? Math.round((hits / total) * 100) / 100 : null,
    upstreamPerMin: upstreamPerMin(), stretch: Math.round(currentStretch() * 100) / 100,
    ttlMs: { ...TTL }, ceilingPerMin: CEILING_PER_MIN,
  };
}
