// Sleeper API client. Read-only, no auth needed. We respect their rate limit (<1000/min) with a
// simple token-bucket pacer, and we cache the big player list to disk-less memory per process.
// Endpoints used:
//   GET /players/nfl                       (all players; ~5MB; pull once/day max)
//   GET /draft/{draft_id}                  (draft settings)
//   GET /draft/{draft_id}/picks            (all picks)
//   GET /league/{league_id}/drafts         (drafts for a league)
//   GET /user/{user}/drafts/nfl/{season}   (a user's drafts)
import { config } from './config.js';
import { log } from './log.js';

const BASE = config.sleeperBase;
const MIN_INTERVAL_MS = Math.ceil(60000 / Math.max(1, config.harvest.maxCallsPerMin));
let lastCall = 0;

async function pace() {
  const now = Date.now();
  const wait = lastCall + MIN_INTERVAL_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

async function getJson(path, { retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    await pace();
    try {
      const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
      if (res.status === 429) { // rate limited — back off
        const backoff = 1000 * (attempt + 1);
        log.warn({ path, backoff }, 'sleeper 429, backing off');
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      if (!res.ok) {
        if (res.status === 404) return null;
        throw new Error(`Sleeper ${res.status} on ${path}`);
      }
      return await res.json();
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return null;
}

// ---- Players (the ~5MB master list; carries cross-platform IDs) ----
let _playerCache = null;
let _playerCacheAt = 0;
export async function getAllPlayers({ force = false } = {}) {
  const dayMs = 864e5;
  if (!force && _playerCache && Date.now() - _playerCacheAt < dayMs) return _playerCache;
  const data = await getJson('/players/nfl');
  _playerCache = data || {};
  _playerCacheAt = Date.now();
  return _playerCache;
}

/* ⭐⭐⭐⭐ WHAT THE REST OF THE WORLD IS PICKING UP — b142.
   Trey: "maybe we can pull data from other sources to suggest there's new roster, like… percentage owned."

   Sleeper publishes adds and drops aggregated across every league it hosts. It is the closest thing to a
   free ownership feed that exists, it needs NO API KEY (the same reason Open-Meteo was chosen for weather),
   and it is a rate of change rather than a level — which is arguably the better signal for "who is about to
   matter", but must never be labelled "percent owned" on screen, because it is not that.

   ⚠ FAILURE IS AN EMPTY MAP, NEVER AN EXCEPTION AND NEVER A PARTIAL ONE. The ownership signal treats an
     empty feed as UNKNOWN and says so rather than reporting that nobody in the world wants anybody — see
     ownershipSurge in trending.js. So every error path here returns the same empty map.
   ⚠ AND IT IS CACHED FOR AN HOUR. The window asked for is 24 hours, so the answer genuinely does not move
     minute to minute, and this is called once per hub load across every user. */
let _trendCache = null;
let _trendCacheAt = 0;
export async function getTrendingAdds({ hours = 24, limit = 200, force = false } = {}) {
  const ttl = 36e5;
  if (!force && _trendCache && Date.now() - _trendCacheAt < ttl) return _trendCache;
  const out = new Map();
  try {
    await pace();
    const rows = await getJson(`/players/nfl/trending/add?lookback_hours=${hours}&limit=${limit}`);
    // Documented shape is [{ player_id, count }]. Anything else is treated as no feed rather than guessed at.
    /* ⚠ RANK AS WELL AS COUNT — 29x. The signal used to fire on a raw threshold (1,000 adds), and in a
       real week dozens of players clear that: Sleeper hosts millions of leagues, so a thousand adds is an
       ordinary Tuesday for anyone mildly interesting. Trey's free-agent list came back with 60+ names.
       Rank self-normalises — being the 8th most added player in the country means the same thing whether
       the week's leader had 5,000 or 50,000 — so the feed is stored in order and the consumer asks for a
       position rather than an absolute. */
    if (Array.isArray(rows)) {
      const clean = rows
        .filter((r) => r && r.player_id != null && Number.isFinite(Number(r.count)))
        .map((r) => ({ id: String(r.player_id), count: Number(r.count) }))
        .sort((a, b) => b.count - a.count);
      clean.forEach((r, i) => out.set(r.id, { count: r.count, rank: i + 1 }));
    }
  } catch { /* no feed: an empty map, which every caller reads as UNKNOWN */ }
  // Only cache a real answer, so a transient failure does not blank the signal for an hour.
  if (out.size) { _trendCache = out; _trendCacheAt = Date.now(); return out; }
  return _trendCache && Date.now() - _trendCacheAt < ttl ? _trendCache : out;
}

// ---- Projections (season). Sleeper stats API host differs from the v1 base. ----
const STATS_BASE = config.sleeperStatsBase;
export async function getSeasonProjections(season, { positions } = {}) {
  // returns array of { player_id, stats: {...}, ... }
  const posQ = (positions || ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB']).map((p) => `position[]=${p}`).join('&');
  await pace();
  const url = `${STATS_BASE}/projections/nfl/${season}?season_type=regular&${posQ}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) { if (res.status === 404) return []; throw new Error(`Sleeper projections ${res.status}`); }
  return res.json();
}

// Weekly projections — the per-matchup version of the season projections. Same host + shape, plus `week`,
// `opponent`, `game_id`, and per-week `injury_status` on each row. This is what the in-season hub uses so
// points reflect THIS week's matchup rather than a season total divided by games.
export async function getWeeklyProjections(season, week, { positions } = {}) {
  const posQ = (positions || ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']).map((p) => `position[]=${p}`).join('&');
  await pace();
  const url = `${STATS_BASE}/projections/nfl/${season}/${week}?season_type=regular&${posQ}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) { if (res.status === 404) return []; throw new Error(`Sleeper weekly projections ${res.status}`); }
  return res.json();
}

// Weekly ACTUALS — real points scored each week (same host/shape as projections, but `/stats/` and real
// results). Used to compute season-to-date defense-vs-position difficulty the way the major sites do:
// actual points allowed by each defense, by position, across completed weeks.
export async function getWeeklyStats(season, week, { positions } = {}) {
  const posQ = (positions || ['QB', 'RB', 'WR', 'TE']).map((p) => `position[]=${p}`).join('&');
  await pace();
  const url = `${STATS_BASE}/stats/nfl/${season}/${week}?season_type=regular&${posQ}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) { if (res.status === 404) return []; throw new Error(`Sleeper weekly stats ${res.status}`); }
  return res.json();
}



// ---- Drafts ----
export const getDraft = (draftId) => getJson(`/draft/${draftId}`);
export const getDraftPicks = (draftId) => getJson(`/draft/${draftId}/picks`);
export const getDraftTradedPicks = (draftId) => getJson(`/draft/${draftId}/traded_picks`);
export const getLeagueDrafts = (leagueId) => getJson(`/league/${leagueId}/drafts`);
export const getUser = (username) => getJson(`/user/${username}`);
export const getUserDrafts = (userId, season) => getJson(`/user/${userId}/drafts/nfl/${season}`);
export const getUserLeagues = (userId, season) => getJson(`/user/${userId}/leagues/nfl/${season}`);
export const getLeagueUsers = (leagueId) => getJson(`/league/${leagueId}/users`);
export const getLeague = (leagueId) => getJson(`/league/${leagueId}`);
export const getLeagueRosters = (leagueId) => getJson(`/league/${leagueId}/rosters`);
// Current NFL state (season, week, etc.) — used to know which week's matchups to pull.
export const getNflState = () => getJson(`/state/nfl`);
/* ⭐⭐⭐⭐ EVERY TRANSACTION THAT RESOLVED IN A GIVEN WEEK — b161.
   ⚠⚠ THE PATH SEGMENT IS THE WEEK ("leg"), NOT AN OFFSET OR A PAGE. There is no "recent transactions"
     endpoint: a season's activity is fetched one week at a time and stitched together by the caller.
     ⚠ AND IT ONLY EVER RETURNS RESOLVED ROWS. Nothing here is pending and nothing here was rejected —
       see the long note at the top of lib/transactions.js, which is the whole reason the feature that
       reads this cannot be the feature Trey asked for. */
export const getTransactions = (leagueId, week) => getJson(`/league/${leagueId}/transactions/${week}`);
// A league's matchups for a given week (each roster's starters, points, matchup pairing).
export const getMatchups = (leagueId, week) => getJson(`/league/${leagueId}/matchups/${week}`);

