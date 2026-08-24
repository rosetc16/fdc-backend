// JOB: store the NFL regular-season schedule for a season.
//
// A schedule is FIXED once released, so this is not a nightly-freshness job — it is a "have we got it yet"
// job. It runs in the nightly refresh anyway because it is cheap when the answer is already yes, and because
// the alternative is discovering on the morning of a draft that we never fetched it.
//
// EVERYTHING IS BEST-EFFORT and DIAGNOSED. Both sources are unofficial. If they all fail, the schedule table
// keeps whatever it already had and the SOS feature simply does not appear — which is the correct behaviour
// for a number we cannot source. A wrong week-16 opponent would corrupt every playoff SOS we print, and
// unlike a missing feature nobody would notice.
import { q } from '../lib/db.js';
import { log } from '../lib/log.js';
import { recordJob } from '../lib/jobs.js';
import { fetchSchedule, toTeamRows, byeWeeksFrom, TEAMS } from '../lib/nflSchedule.js';

export async function syncSchedule(opts = {}) {
  const started = Date.now();
  const season = Number(opts.season) || new Date().getUTCFullYear();

  // The job creates its own table. db/schema.sql is applied only by a MANUAL `npm run migrate` that nobody
  // runs on deploy, so a new TABLE is dead on an existing database — that is exactly how the injury feature
  // shipped broken (`relation "player_news" does not exist`).
  try {
    await q(`CREATE TABLE IF NOT EXISTS nfl_schedule (
      season INT NOT NULL, week SMALLINT NOT NULL, team TEXT NOT NULL,
      opponent TEXT NOT NULL, home BOOLEAN, updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (season, week, team)
    );`);
  } catch (e) { log.error(e, 'syncSchedule: ensure table'); }

  const { rows: had } = await q('SELECT count(*)::int AS n FROM nfl_schedule WHERE season=$1', [season]);
  const before = had[0].n;

  const res = await fetchSchedule(season, opts.sources);
  const games = res.records;
  const rows = toTeamRows(games);

  // ---- SANITY, BEFORE WE WRITE ---------------------------------------------------------------------------
  // A schedule is one of the few things we can check against arithmetic: 32 teams, 17 games each across 18
  // weeks. Anything far off that is a misread payload, not a real schedule, and writing it would poison every
  // number downstream. Refuse rather than half-fill.
  const teamsSeen = new Set(rows.map((r) => r.team));
  const weeksSeen = new Set(rows.map((r) => r.week));
  const problems = [];
  if (rows.length && teamsSeen.size < 30) problems.push(`only ${teamsSeen.size} teams in the payload`);
  if (rows.length && weeksSeen.size < 14) problems.push(`only ${weeksSeen.size} weeks in the payload`);
  const perTeam = {};
  rows.forEach((r) => { perTeam[r.team] = (perTeam[r.team] || 0) + 1; });
  const odd = Object.entries(perTeam).filter(([, n]) => n < 14 || n > 18).map(([t, n]) => `${t}:${n}`);
  if (odd.length > 4) problems.push(`games-per-team looks wrong (${odd.slice(0, 4).join(', ')}…)`);

  let wrote = 0;
  const usable = rows.length > 0 && problems.length === 0;
  if (usable) {
    // Replace the season wholesale inside one transaction: a partial schedule is worse than none, because
    // a missing week reads as a bye and would show a player "on bye in week 16" who is not.
    try {
      await q('BEGIN');
      await q('DELETE FROM nfl_schedule WHERE season=$1', [season]);
      for (const r of rows) {
        await q(`INSERT INTO nfl_schedule (season, week, team, opponent, home) VALUES ($1,$2,$3,$4,$5)
                 ON CONFLICT (season, week, team) DO UPDATE SET opponent=EXCLUDED.opponent, home=EXCLUDED.home`,
          [season, r.week, r.team, r.opponent, r.home]);
        wrote++;
      }
      await q('COMMIT');
    } catch (e) {
      await q('ROLLBACK').catch(() => {});
      log.error(e, 'syncSchedule: write failed, previous schedule left intact');
      wrote = 0;
    }
  }

  const byes = usable ? byeWeeksFrom(rows) : {};
  const missing = TEAMS.filter((t) => !teamsSeen.has(t));
  const hints = [];
  if (!res.used) {
    hints.push(res.attempts.some((a) => a.ok > 0)
      ? `Every schedule source answered but none produced readable games. The espnShape field maps what came back.`
      : 'Every schedule request failed outright — network, block or outage.');
  } else if (problems.length) {
    hints.push(`Read ${games.length} games from "${res.used}" but REFUSED to write them: ${problems.join('; ')}. The previous schedule is untouched.`);
  } else if (before > 0 && wrote === 0) {
    hints.push('Nothing was written and a schedule was already stored — the existing one is still in use.');
  }

  const detail = {
    season, games: games.length, rows: rows.length, wrote, hadBefore: before,
    teams: teamsSeen.size, weeks: weeksSeen.size,
    byesFound: Object.keys(byes).length,
    ...(missing.length ? { missingTeams: missing.slice(0, 8) } : {}),
    sourceUsed: res.used,
    attempts: res.attempts,
    warnings: [...new Set(res.attempts.flatMap((a) => a.warnings.map((w) => `${a.source}:${w}`)))].slice(0, 6),
    ...(res.shape ? { shape: res.shape } : {}),
    ...(problems.length ? { refused: problems } : {}),
    ...(hints.length ? { hints } : {}),
    ms: Date.now() - started,
  };
  if (hints.length) log.error(detail, 'syncSchedule: ran, but stored nothing new — see hints');
  else log.info(detail, 'syncSchedule done');
  await recordJob('syncSchedule', true, detail);
  return detail;
}

// Read the stored schedule back. Returns [] when we have none, which every caller treats as "the feature is
// off" rather than filling in a guess.
export async function getSchedule(season) {
  try {
    const { rows } = await q('SELECT week, team, opponent, home FROM nfl_schedule WHERE season=$1', [season]);
    return rows;
  } catch { return []; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncSchedule().then((d) => { console.log(d); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
}
