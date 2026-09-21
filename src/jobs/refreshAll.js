// Runs the full daily data refresh in the correct order. Used by the cron job and `npm run refresh`.
//   1) players (identity spine)  2) projections  3) published ADP  4) harvest drafts  5) recompute consensus
import { syncPlayers } from './syncPlayers.js';
import { syncProjections } from './syncProjections.js';
import { syncInjuries } from './syncInjuries.js';
import { syncPublishedAdp } from './syncPublishedAdp.js';
import { harvestSleeperDrafts } from './harvestSleeperDrafts.js';
import { refreshConsensus } from './refreshConsensus.js';
import { pruneObservations } from './pruneObservations.js';
import { log } from '../lib/log.js';

export async function refreshAll() {
  const out = {};
  try { out.players = await syncPlayers(); } catch (e) { out.players = { error: e.message }; log.error(e); }
  try { out.projections = await syncProjections(); } catch (e) { out.projections = { error: e.message }; log.error(e); }
  // Straight after players, so the detail is merged onto designations that were written moments ago.
  // Wrapped like everything else: ESPN being down must never fail the nightly refresh.
  try { out.injuries = await syncInjuries(); } catch (e) { out.injuries = { error: e.message }; log.error(e); }
  // The schedule is fixed once released, so this is cheap when we already have it — and running it
  // nightly is how we avoid discovering on draft morning that we never fetched it at all.
  /* ⚠ THIS STEP USED TO FAIL INVISIBLY, and that is how a missing schedule became a mystery. Every other
     step here records `out.x = { error }` on failure; this one logged and left `out.schedule` undefined, so
     a refresh with a broken schedule sync reported a clean success and the admin panel showed no schedule
     row at all — nothing to notice, nothing to click. Weather went dark for exactly this reason. */
  try { const { syncSchedule } = await import('./syncSchedule.js'); out.schedule = await syncSchedule(); }
  catch (e) { log.error(e, 'refreshAll: schedule'); out.schedule = { error: String((e && e.message) || e) }; }
  /* ⭐⭐⭐⭐⭐ THE TWO JOBS THAT ONLY EVER RAN WHEN SOMEBODY REMEMBERED — b137.
     Trey: "I also don't want to have to click all of these to update things and I hope it's just happening
     automatically behind the scenes."

     Reasonable expectation, and it was true of six of the eight jobs. Byes and defence-vs-position were the
     exceptions: both existed only as admin buttons, so their freshness depended on a person recalling that
     they are a thing. Both are DERIVED from data this function has just refreshed — byes come straight out
     of the schedule two lines above, and defence ranks are recomputed from completed weeks — which makes
     "runs after the thing it derives from" their natural home and an admin button the fallback rather than
     the mechanism.

     ⚠ ORDER MATTERS AND IT IS NOT ARBITRARY: byes read nfl_schedule, so they go directly after the sync
       that writes it. Running them before would derive this week's byes from last week's schedule, which
       is the kind of wrong that looks right.
     ⚠ AND BOTH ARE WRAPPED. Neither is load-bearing enough to fail a nightly refresh that also carries
       players, projections and ADP; a failure is recorded in the result and visible in the admin panel. */
  try { const { syncByeWeeks } = await import('../lib/byeWeeks.js'); const { q } = await import('../lib/db.js');
    out.byes = await syncByeWeeks(q); }
  catch (e) { log.error(e, 'refreshAll: byes'); out.byes = { error: String((e && e.message) || e) }; }
  try {
    const { warmDefVsPos } = await import('../lib/defVsPos.js');
    const { config } = await import('../lib/config.js');
    /* In season the current year's completed weeks are the right basis; before any week has finished there
       are none, and last season is the only honest answer. warmDefVsPos returns an empty table rather than
       throwing when a season has no results, so falling back on an empty result is the test, not the date. */
    const cur = Number(config.activeSeason);
    let table = await warmDefVsPos(cur, 18);
    let used = cur;
    if (!table || Object.keys(table).length < 24) { table = await warmDefVsPos(cur - 1, 19); used = cur - 1; }
    out.defVsPos = { season: used, defenses: Object.keys(table || {}).length };
    try {
      const { clearPlayerPackCache } = await import('../lib/packCache.js');
      const { clearSosMemo } = await import('../lib/sosService.js');
      clearPlayerPackCache(); clearSosMemo();
    } catch { /* the caches expire on their own; this only makes it immediate */ }
  } catch (e) { log.error(e, 'refreshAll: defVsPos'); out.defVsPos = { error: String((e && e.message) || e) }; }
  /* ⭐ b164 — SEASON-TO-DATE ACTUALS, warmed nightly so the first hub load after a week completes already
     has them (the read path is cache-only and would otherwise serve pure projections for one load).
     Wrapped like the two above: not load-bearing enough to fail a refresh. */
  try {
    const { warmSeasonToDate } = await import('../lib/seasonToDate.js');
    const { getNflState } = await import('../lib/sleeper.js');
    const { config } = await import('../lib/config.js');
    const nfl = await getNflState().catch(() => null);
    const season = Number((nfl && nfl.season) || config.activeSeason);
    const week = Number((nfl && (nfl.display_week || nfl.week)) || 1);
    const t = await warmSeasonToDate(season, week);
    out.seasonToDate = { season, throughWeek: Math.max(0, week - 1), players: Object.keys(t || {}).length };
  } catch (e) { log.error(e, 'refreshAll: seasonToDate'); out.seasonToDate = { error: String((e && e.message) || e) }; }
  // Published ADP gives broad, clean veteran coverage immediately; harvested drafts refine specific
  // buckets. Both are observations the consensus step blends — published must land before consensus.
  try { out.publishedAdp = await syncPublishedAdp(); } catch (e) { out.publishedAdp = { error: e.message }; log.error(e); }
  try { out.harvest = await harvestSleeperDrafts(); } catch (e) { out.harvest = { error: e.message }; log.error(e); }
  try { out.consensus = await refreshConsensus(); } catch (e) { out.consensus = { error: e.message }; log.error(e); }
  // Prune AFTER consensus is recomputed from the full pool, so trimming never starves the numbers the board
  // uses. This keeps adp_observations from growing without bound (the cause of the storage outage) — it self-
  // caps every refresh instead of relying on someone remembering to click the manual cleanup button.
  try { out.prune = await pruneObservations(); } catch (e) { out.prune = { error: e.message }; log.error(e); }
  log.info(out, 'refreshAll complete');
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  refreshAll().then(() => process.exit(0)).catch((e) => { log.error(e); process.exit(1); });
}
