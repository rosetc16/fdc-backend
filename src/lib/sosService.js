// PLAYOFF SOS, ASSEMBLED — the impure half: read the schedule, read the defensive ranks, memoize.
//
// Kept apart from playoffSos.js on purpose. The arithmetic there is fully unit-tested because it touches
// nothing; everything that can fail at runtime — a table that does not exist, a season with no games played,
// a source that never ran — lives here, where the answer to every failure is the same: return null and let
// the feature disappear rather than print a number we cannot stand behind.
import { q } from './db.js';
import { getDefVsPos, warmDefVsPos } from './defVsPos.js';
import { computePlayoffSos, playoffWeeks } from './playoffSos.js';
import { clearPlayerPackCache } from './packCache.js';

// The table is identical for every user in a league shape, and rebuilding it per request would mean a
// database read plus a 32x4 ranking on every board load.
const memo = new Map();                 // `${season}:${playoffStart}` -> { at, table }
const MEMO_MS = 30 * 60 * 1000;
// ⚠ A NEGATIVE ANSWER GETS A SHORT LEASH. Caching "no SOS available" for half an hour means that after the
// admin finally runs the two jobs, the feature stays dark for another 30 minutes and looks like it failed.
const MEMO_NULL_MS = 45 * 1000;

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
  if (hit && Date.now() - hit.at < (hit.value ? MEMO_MS : MEMO_NULL_MS)) return hit.value;

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

// ⭐⭐ THE INSTRUMENT. Both jobs reported success — 544 schedule rows, 32 defences — and every row on the board
// still showed a dash. That is the fourth time in this codebase that two green numbers have failed to add up
// to a working feature, and the lesson each time was the same: stop reasoning about the gap and print it.
//
// This reports every link in the chain, and in particular the ONE number that a summary can never show you:
// how many schedule teams actually find a match in the defence table. A join that matches nothing looks
// exactly like a feature with no data.
export async function sosDiagnose(season, playoffStartWeek = 15) {
  const out = { season, playoffStartWeek };
  const schedule = await loadSchedule(season);
  out.scheduleRows = schedule.length;
  const schedTeams = [...new Set(schedule.map((r) => r.team))].sort();
  const schedWeeks = [...new Set(schedule.map((r) => r.week))].sort((a, b) => a - b);
  out.scheduleTeams = schedTeams.length;
  out.scheduleWeeks = schedWeeks.length;
  if (!schedule.length) {
    out.verdict = `No schedule stored for ${season}. Run "Pull schedule" — and check it reported the SAME season the board is asking for.`;
    return out;
  }

  const { table: defTable, basis } = await loadDefTable(season, null);
  out.defBasis = basis;
  out.defTeams = defTable ? Object.keys(defTable).length : 0;
  if (!defTable) {
    out.verdict = 'No defence-vs-position table. Run "Build defense ranks" — it needs the PREVIOUS season, and caches under (season, throughWeek).';
    return out;
  }

  // ⭐ THE JOIN. Two feeds, two sets of abbreviations, and nothing anywhere says when they disagree.
  const defKeys = new Set(Object.keys(defTable));
  const missing = schedTeams.filter((t) => !defKeys.has(t));
  out.teamsMatched = schedTeams.length - missing.length;
  if (missing.length) out.teamsMissingFromDefTable = missing.slice(0, 12);
  const defOnly = Object.keys(defTable).filter((t) => !schedTeams.includes(t));
  if (defOnly.length) out.teamsOnlyInDefTable = defOnly.slice(0, 12);

  const weeks = playoffWeeks(Number(playoffStartWeek) || 15, 3);
  out.weeksUsed = weeks;
  const inWeeks = schedule.filter((r) => weeks.includes(r.week)).length;
  out.scheduleRowsInPlayoffWeeks = inWeeks;

  const table = computePlayoffSos(schedule, defTable, weeks);
  out.teamsRated = Object.keys(table).length;
  const sampleTeam = Object.keys(table)[0];
  if (sampleTeam) out.sample = { team: sampleTeam, RB: table[sampleTeam].RB };

  out.verdict = out.teamsRated > 0
    ? `Working: ${out.teamsRated} teams rated. If the board still shows dashes, it is a CACHE — the pack is cached for 10 minutes and this table for 30.`
    : (missing.length >= schedTeams.length
      ? `The schedule and the defence table use DIFFERENT team abbreviations, so the join matched nothing. Schedule has ${schedTeams.slice(0, 4).join(',')}…; defences have ${Object.keys(defTable).slice(0, 4).join(',')}…`
      : `Both inputs are present and the codes match, but no team came out rated — check that the playoff weeks (${weeks.join(',')}) exist in the schedule (${out.scheduleRowsInPlayoffWeeks} rows there).`);
  return out;
}
