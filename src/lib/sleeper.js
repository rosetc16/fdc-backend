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

// ---- Projections (season). Sleeper stats API host differs from the v1 base. ----
const STATS_BASE = 'https://api.sleeper.app';
export async function getSeasonProjections(season, { positions } = {}) {
  // returns array of { player_id, stats: {...}, ... }
  const posQ = (positions || ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB']).map((p) => `position[]=${p}`).join('&');
  await pace();
  const url = `${STATS_BASE}/projections/nfl/${season}?season_type=regular&${posQ}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) { if (res.status === 404) return []; throw new Error(`Sleeper projections ${res.status}`); }
  return res.json();
}

// ---- Drafts ----
export const getDraft = (draftId) => getJson(`/draft/${draftId}`);
export const getDraftPicks = (draftId) => getJson(`/draft/${draftId}/picks`);
export const getLeagueDrafts = (leagueId) => getJson(`/league/${leagueId}/drafts`);
export const getUser = (username) => getJson(`/user/${username}`);
export const getUserDrafts = (userId, season) => getJson(`/user/${userId}/drafts/nfl/${season}`);
export const getUserLeagues = (userId, season) => getJson(`/user/${userId}/leagues/nfl/${season}`);
export const getLeagueUsers = (leagueId) => getJson(`/league/${leagueId}/users`);
export const getLeague = (leagueId) => getJson(`/league/${leagueId}`);
export const getLeagueRosters = (leagueId) => getJson(`/league/${leagueId}/rosters`);
