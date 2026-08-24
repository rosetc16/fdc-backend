// PLAYOFF SOS, ASSEMBLED — the impure half: read the schedule, read the defensive ranks, memoize.
//
// Kept apart from playoffSos.js on purpose. The arithmetic there is fully unit-tested because it touches
// nothing; everything that can fail at runtime — a table that does not exist, a season with no games played,
// a source that never ran — lives here, where the answer to every failure is the same: return null and let
// the feature disappear rather than print a number we cannot stand behind.
import { q } from './db.js';
import { getDefVsPos, warmDefVsPos } from './defVsPos.js';
import { computePlayoffSos, playoffWeeks } from './playoffSos.js';

// The table is identical for every user in a league shape, and rebuilding it per request would mean a
// database read plus a 32x4 ranking on every board load.
const memo = new Map();                 // `${season}:${playoffStart}` -> { at, table }
const MEMO_MS = 30 * 60 * 1000;

async function loadSchedule(season) {
  try {
    const { rows } = await q('SELECT week, team, opponent FROM nfl_schedule WHERE season=$1', [season]);
    return rows;
  } catch { return []; }               // table missing = the sync has never run = feature off
}

// WHICH SEASON'S DEFENCES? At draft time the current season has no completed weeks, so the only real
// evidence available is LAST season's — which is what every SOS product on the market uses in August, and
// which we label honestly in the UI rather than implying it is current.
//
// Once the season is underway the current year's table (season-to-date) is the better read, so this prefers
// it as soon as there is enough of a sample.
async function loadDefTable(season, currentWeek) {
  if (currentWeek && currentWeek > 4) {
    const cur = await getDefVsPos(season, currentWeek);
    if (cur && Object.keys(cur).length >= 24) return { table: cur, basis: `${season} season to date` };
  }
  const prevSeason = season - 1;
  const prev = await getDefVsPos(prevSeason, 19);          // 19 => through week 18, the full prior season
  if (prev && Object.keys(prev).length >= 24) return { table: prev, basis: `${prevSeason} full season` };
  // Not cached yet. getDefVsPos kicks off a background warm; nudge the prior season explicitly since nothing
  // else in the app ever asks for it, then report honestly that we have nothing YET.
  warmDefVsPos(prevSeason, 19).catch(() => {});
  return { table: null, basis: null };
}

// Returns { table, weeks, basis, teams } or null when any ingredient is missing.
export async function getPlayoffSos(season, playoffStartWeek = 15, currentWeek = null) {
  const start = Number(playoffStartWeek) || 15;
  const key = `${season}:${start}:${currentWeek || 0}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.value;

  const schedule = await loadSchedule(season);
  if (!schedule.length) { memo.set(key, { at: Date.now(), value: null }); return null; }
  const { table: defTable, basis } = await loadDefTable(season, currentWeek);
  if (!defTable) { memo.set(key, { at: Date.now(), value: null }); return null; }

  const weeks = playoffWeeks(start, 3);
  const table = computePlayoffSos(schedule, defTable, weeks);
  const value = Object.keys(table).length ? { table, weeks, basis, teams: Object.keys(table).length } : null;
  memo.set(key, { at: Date.now(), value });
  return value;
}

export function clearSosMemo() { memo.clear(); }
