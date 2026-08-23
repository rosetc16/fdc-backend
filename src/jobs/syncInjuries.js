// JOB: pull detailed injury reports and store the merged result per player.
//
// Runs after syncPlayers (which already writes Sleeper's designation + body part + note). This adds the
// detail ESPN has and Sleeper doesn't: the side, a return estimate when one exists, and a sentence of
// actual reporting.
//
// 32 requests, one per team, on the site API — an order of magnitude cheaper than the per-athlete calls
// syncPlayerNews makes, and it covers every injured player in the league rather than a top-N slice.
//
// EVERYTHING IS BEST-EFFORT. ESPN is unofficial: it can change shape, rate-limit, or vanish. Every fetch
// is wrapped, failures are counted rather than thrown, and a total failure leaves the Sleeper data that
// was already there untouched. A draft must never depend on this.
import { q } from '../lib/db.js';
import { log } from '../lib/log.js';
import { recordJob } from '../lib/jobs.js';
import { mapEspnInjuries, mergeInjury, ESPN_TEAM_IDS, ESPN_TEAM_INJURIES } from '../lib/injuries.js';

async function getJson(url, ms = 7000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(t); }
}

export async function syncInjuries(opts = {}) {
  const started = Date.now();
  const now = opts.now != null ? opts.now : Date.now();

  // The columns this job writes. Idempotent so a deploy that lands before a migration can't take the
  // whole sync down (the same defence syncPlayers uses for news_updated).
  //
  // ⚠ This ensures the columns it READS as well as the ones it writes. The three injury_* fields below come
  // from syncPlayers (backend 110) — so on a database where the player sync has not run since that deploy,
  // this job's own SELECT referenced columns that did not exist and it died before doing anything. A job
  // must not assume another job has already run; that assumption is invisible until the day it isn't true.
  for (const col of [
    'injury_body_part TEXT',     // read: written by syncPlayers
    'injury_notes TEXT',         // read: written by syncPlayers
    'injury_start_date TEXT',    // read: written by syncPlayers
    'injury_detail TEXT',        // the merged, sourced note
    'injury_part TEXT',          // body part incl. side
    'injury_return TEXT',        // only when a source supplies one
    'injury_at TIMESTAMPTZ',     // when the note was last dated
    'injury_sources TEXT',       // which feeds contributed — shown to nobody, invaluable when debugging
  ]) {
    try { await q(`ALTER TABLE players ADD COLUMN IF NOT EXISTS ${col};`); } catch (e) { log.error(e, 'ensure ' + col); }
  }

  const { rows: players } = await q(
    `SELECT player_id, espn_id, injury_status, injury_body_part, injury_notes, news_updated
       FROM players
      WHERE active = true AND injury_status IS NOT NULL AND injury_status <> ''`
  );
  if (!players.length) {
    await recordJob('syncInjuries', true, { skipped: 'nobody flagged', ms: Date.now() - started });
    return { wrote: 0, flagged: 0 };
  }

  // ---- ESPN, one call per team ----------------------------------------------------------------------
  const byEspnId = new Map();
  let teamsOk = 0, teamsFailed = 0, espnInjuriesSeen = 0;
  const unreadable = [];   // the actual warning strings, so an unrecognised shape names itself
  for (const teamId of ESPN_TEAM_IDS) {
    const j = await getJson(ESPN_TEAM_INJURIES(teamId));
    if (!j) { teamsFailed++; continue; }
    const { injuries, warnings } = mapEspnInjuries(j, { now });
    warnings.forEach((w) => unreadable.push(w));
    espnInjuriesSeen += injuries.length;
    injuries.forEach((inj) => byEspnId.set(String(inj.espnId), inj));
    teamsOk++;
  }

  // ---- merge and write -------------------------------------------------------------------------------
  // Count what each SOURCE actually supplied, not just the total written. The first production run reported
  // "530 flagged, 530 wrote, 32 teams ok" and looked like a success while delivering nothing — because the
  // only number that mattered (how many players ended up with any detail) was zero and nothing said why.
  let wrote = 0, withDetail = 0, sleeperHadDetail = 0, espnMatched = 0;
  for (const p of players) {
    if (p.injury_body_part || p.injury_notes) sleeperHadDetail++;
    const espn = p.espn_id ? byEspnId.get(String(p.espn_id)) || null : null;
    if (espn) espnMatched++;
    const merged = mergeInjury(p, espn, { now });
    if (!merged) continue;
    if (merged.sourced) withDetail++;
    await q(
      `UPDATE players SET injury_detail=$2, injury_part=$3, injury_return=$4, injury_at=$5, injury_sources=$6
        WHERE player_id=$1`,
      [p.player_id, merged.note, merged.part, merged.returnDate,
       merged.at ? new Date(merged.at) : null, merged.sources.join(',')]
    );
    wrote++;
  }

  // A run that understood NOTHING must not read as a clean success. These three lines are what turn the
  // result box from "it worked" into an actual diagnosis.
  const shapeProblem = unreadable.some((w) => String(w).startsWith('shape-unrecognized'));
  const hints = [];
  if (teamsOk > 0 && espnInjuriesSeen === 0) {
    hints.push(shapeProblem
      ? `ESPN answered ${teamsOk} teams but the response shape was not recognised (${[...new Set(unreadable)].slice(0, 3).join(' | ')}) — the mapper needs updating.`
      : `ESPN answered ${teamsOk} teams and reported no injuries at all, which is implausible — treat as a source problem.`);
  }
  if (players.length > 0 && sleeperHadDetail === 0) {
    hints.push('Your platform sent designations but no body part or note for anyone — run "Full refresh" (the player sync) first; that is what fills those fields.');
  }
  const detail = {
    flagged: players.length, wrote, withDetail,
    sleeperHadDetail, espnMatched, espnInjuriesSeen,
    espnTeamsOk: teamsOk, espnTeamsFailed: teamsFailed,
    espnWarnings: [...new Set(unreadable)].slice(0, 6),
    ...(hints.length ? { hints } : {}),
    ms: Date.now() - started,
  };
  // Worth logging loudly: if ESPN starts failing wholesale, the app quietly degrades to Sleeper-only
  // detail and nobody would otherwise notice.
  if (hints.length) log.error(detail, 'syncInjuries: ran, but delivered no detail — see hints');
  else if (teamsFailed > teamsOk) log.error(detail, 'syncInjuries: ESPN mostly unreachable — Sleeper detail only');
  else log.info(detail, 'syncInjuries done');
  await recordJob('syncInjuries', true, detail);
  return detail;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncInjuries().then((d) => { console.log(d); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
}
