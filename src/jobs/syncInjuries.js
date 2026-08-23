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
import { mapEspnInjuries, mergeInjury, ESPN_INJURY_SOURCES } from '../lib/injuries.js';
import { normName } from '../lib/names.js';

async function getJson(url, ms = 7000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(t); }
}

// Work down ESPN_INJURY_SOURCES and STOP at the first source that yields actual records.
//
// ⭐ This exists because the previous version had one hard-coded URL, that URL answered 200 with `{}` for
// every team, and the job could not tell "this endpoint is wrong" from "nobody is injured". A chain plus a
// recorded winner turns the next ESPN change into a line in the result box instead of a deploy cycle.
async function fetchEspnInjuries(now) {
  const attempts = [];
  let sample = null;                 // a truncated slice of a real response, kept for the failure case
  for (const src of ESPN_INJURY_SOURCES) {
    let ok = 0, failed = 0, seen = 0;
    const warnings = [];
    const injuries = [];
    for (const url of src.urls) {
      const j = await getJson(url);
      if (!j) { failed++; continue; }
      ok++;
      // ⭐ KEEP THE FIRST REAL RESPONSE. Guessing at a shape twice cost two deploys; a 600-character slice
      // of what ESPN actually sent ends the guessing, and it only ships when the run found nothing.
      if (sample == null) { try { sample = JSON.stringify(j).slice(0, 600); } catch { sample = '<unserializable>'; } }
      const m = mapEspnInjuries(j, { now });
      m.warnings.forEach((w) => warnings.push(w));
      seen += m.injuries.length;
      m.injuries.forEach((inj) => injuries.push(inj));
    }
    attempts.push({ source: src.name, calls: src.urls.length, ok, failed, injuries: seen,
      warnings: [...new Set(warnings)].slice(0, 4) });
    if (seen > 0) return { injuries, attempts, used: src.name, sample: null };
  }
  return { injuries: [], attempts, used: null, sample };
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
    `SELECT player_id, espn_id, full_name, injury_status, injury_body_part, injury_notes, news_updated
       FROM players
      WHERE active = true AND injury_status IS NOT NULL AND injury_status <> ''`
  );
  if (!players.length) {
    await recordJob('syncInjuries', true, { skipped: 'nobody flagged', ms: Date.now() - started });
    return { wrote: 0, flagged: 0 };
  }

  // ---- ESPN, down the source chain until one of them actually answers with records --------------------
  const espnRes = await fetchEspnInjuries(now);
  const byEspnId = new Map();
  const byName = new Map();
  for (const inj of espnRes.injuries) {
    if (inj.espnId) byEspnId.set(String(inj.espnId), inj);
    if (inj.name) byName.set(normName(inj.name), inj);
  }
  const espnInjuriesSeen = espnRes.injuries.length;
  // When a source WINS, these describe that source. When nothing wins they describe the whole sweep —
  // reporting only the first source's numbers would have said "1 failed" after 97 requests, and an
  // undercount in a diagnostic is how the last two rounds of this bug stayed invisible.
  const winner = espnRes.attempts.find((a) => a.source === espnRes.used);
  const teamsOk = winner ? winner.ok : espnRes.attempts.reduce((n, a) => n + a.ok, 0);
  const teamsFailed = winner ? winner.failed : espnRes.attempts.reduce((n, a) => n + a.failed, 0);
  const unreadable = [];   // the actual warning strings, so an unrecognised shape names itself
  espnRes.attempts.forEach((a) => a.warnings.forEach((w) => unreadable.push(`${a.source}:${w}`)));

  // ---- merge and write -------------------------------------------------------------------------------
  // Count what each SOURCE actually supplied, not just the total written. The first production run reported
  // "530 flagged, 530 wrote, 32 teams ok" and looked like a success while delivering nothing — because the
  // only number that mattered (how many players ended up with any detail) was zero and nothing said why.
  let wrote = 0, withDetail = 0, sleeperHadDetail = 0, espnMatched = 0, espnMatchedByName = 0;
  for (const p of players) {
    if (p.injury_body_part || p.injury_notes) sleeperHadDetail++;
    // ID first, name second. espn_id reaches us via Sleeper's player record and is blank for a slice of
    // players — disproportionately rookies, whose injury news is the news people most want.
    let espn = p.espn_id ? byEspnId.get(String(p.espn_id)) || null : null;
    if (!espn && p.full_name) {
      const hit = byName.get(normName(p.full_name));
      if (hit) { espn = hit; espnMatchedByName++; }
    }
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
  const anyOk = espnRes.attempts.some((a) => a.ok > 0);
  const emptyEverywhere = unreadable.some((w) => /:(empty-object|empty-array)$/.test(String(w)));
  const shapeProblem = unreadable.some((w) => /shape-unrecognized/.test(String(w)));
  const hints = [];
  if (!espnRes.used && anyOk) {
    hints.push(
      emptyEverywhere && !shapeProblem
        ? `Every ESPN source answered but returned an empty body — those URLs no longer carry injuries. The raw sample below is what they actually sent.`
        : `ESPN answered but none of the ${espnRes.attempts.length} sources produced readable injury records (${[...new Set(unreadable)].slice(0, 3).join(' | ')}). The raw sample below is what it actually sent.`
    );
  } else if (!anyOk) {
    hints.push('Every ESPN request failed outright — network, block or outage. Platform detail is unaffected.');
  } else if (espnRes.used && espnMatched === 0) {
    hints.push(`ESPN returned ${espnInjuriesSeen} injuries via "${espnRes.used}" but none matched a player on file — an ID/name matching problem, not a source problem.`);
  }
  if (players.length > 0 && sleeperHadDetail === 0) {
    hints.push('Your platform sent designations but no body part or note for anyone — run "Full refresh" (the player sync) first; that is what fills those fields.');
  }
  const detail = {
    flagged: players.length, wrote, withDetail,
    sleeperHadDetail, espnMatched, espnMatchedByName, espnInjuriesSeen,
    espnSourceUsed: espnRes.used,
    espnTeamsOk: teamsOk, espnTeamsFailed: teamsFailed,
    // Every source that was tried and what it gave back — so a failure names itself instead of hiding
    // behind one summary number.
    espnAttempts: espnRes.attempts,
    espnWarnings: [...new Set(unreadable)].slice(0, 6),
    // ⭐ ONLY present when nothing worked. Two deploys were spent guessing at a shape nobody had seen; this
    // is 600 characters of the real thing, and it ends the guessing.
    ...(espnRes.sample ? { espnSample: espnRes.sample } : {}),
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
