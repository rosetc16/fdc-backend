// JOB: recompute the ADP consensus for every (player, format, season) that has observations.
// Uses the tested blender (recency decay + staleness age-out + trend). Run daily after harvest.
import { config } from '../lib/config.js';
import { q } from '../lib/db.js';
import { buildConsensusRecord, BLEND } from '../lib/adpConsensus.js';
import { log } from '../lib/log.js';
import { recordJob } from '../lib/jobs.js';

export async function refreshConsensus({ season = config.activeSeason } = {}) {
  const started = Date.now();
  // all (player, format) combos with at least one recent observation this season
  const { rows: combos } = await q(
    `SELECT DISTINCT player_id, format_key FROM adp_observations WHERE season=$1`,
    [season]
  );

  // Load admin-entered player events once. An event marks the date a player's value changed, so drafts BEFORE
  // it were made under obsolete information and get down-weighted at blend time. Where a player has more than
  // one event we apply only the MOST RECENT — it supersedes anything earlier (the latest news is what the
  // market is pricing). The table may not exist yet on a fresh DB, so this is best-effort.
  const eventByPlayer = new Map();
  try {
    const { rows: evs } = await q(
      `SELECT DISTINCT ON (player_id) player_id, event_type, event_date
         FROM player_events
        ORDER BY player_id, event_date DESC`
    );
    for (const e of evs) eventByPlayer.set(e.player_id, e);
    if (evs.length) log.info(`refreshConsensus: applying ${evs.length} player event(s)`);
  } catch (err) {
    log.info('refreshConsensus: no player_events table yet — skipping event adjustment');
  }

  let written = 0, eventAdjusted = 0;
  for (const { player_id, format_key } of combos) {
    // pull a trailing window of observations (twice the trend window so trend has a prior period)
    const { rows: obs } = await q(
      `SELECT source, source_type, pick, weight, observed_at
         FROM adp_observations
        WHERE player_id=$1 AND format_key=$2 AND season=$3
          AND observed_at > now() - interval '${BLEND.trendWindowDays * 2} days'
        ORDER BY observed_at DESC`,
      [player_id, format_key, season]
    );
    if (!obs.length) continue;
    // The event (if any) and the format both matter: the same injury down-weights pre-event drafts hard for
    // redraft but only mildly for dynasty, and format_key is what tells us which we're computing.
    const event = eventByPlayer.get(player_id) || null;
    const rec = buildConsensusRecord(obs, new Date(), { event, formatKey: format_key });
    if (rec.consensus == null) continue;
    if (rec.eventApplied) eventAdjusted++;
    await q(
      `INSERT INTO adp_consensus (player_id, format_key, season, consensus, lo, hi, stdev, sample_n, trend, sources, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (player_id, format_key, season) DO UPDATE SET
         consensus=EXCLUDED.consensus, lo=EXCLUDED.lo, hi=EXCLUDED.hi, stdev=EXCLUDED.stdev,
         sample_n=EXCLUDED.sample_n, trend=EXCLUDED.trend, sources=EXCLUDED.sources, computed_at=now()`,
      // NOTE: we intentionally DON'T persist the full per-source observation list here. It was stored as a JSON
      // blob on EVERY (player × format × season) row — and with ~44 format keys per player it ballooned the
      // consensus table to hundreds of MB, most of it data the board never reads back (it only needs the
      // number, range, trend, and sample count). Storing an empty array keeps the column/shape intact while
      // eliminating the bloat. The raw observations still live in adp_observations if a recompute is needed.
      [player_id, format_key, season, rec.consensus, rec.lo, rec.hi, rec.stdev,
       rec.sampleN, rec.trend, '[]']
    );
    written++;
  }

  // staleness cleanup: delete observations older than the prior season once a new season is active
  await q(`DELETE FROM adp_observations WHERE season < $1 - 1`, [season]);

  // HARVEST RETENTION. The per-pick harvest rows exist only to RECOMPUTE consensus (which we just did and
  // stored in adp_consensus). Within a season they otherwise accumulate forever — every harvest pass appends
  // more — which is what pushes a tiny-user database toward its storage limit. The consensus blender only
  // looks back a couple of trend-windows anyway, so raw picks past that window carry no remaining signal.
  // Keep a comfortable buffer beyond the window, delete the rest, and reclaim the pages. Published rows are
  // untouched (they're re-synced wholesale, not accumulated). Best-effort; never fail the refresh over it.
  try {
    const keepDays = Math.max(45, BLEND.trendWindowDays * 3);
    const pruned = await q(
      `DELETE FROM adp_observations
        WHERE source = 'sleeper_harvest' AND observed_at < now() - ($1 || ' days')::interval`,
      [String(keepDays)]
    );
    if (pruned.rowCount) {
      log.info({ pruned: pruned.rowCount, keepDays }, 'refreshConsensus: pruned old harvest rows');
      // return freed pages to the OS so the DB size actually shrinks (VACUUM can't run in a txn block)
      await q('VACUUM adp_observations').catch(() => {});
    }
  } catch (e) { log.error(e, 'harvest retention prune failed (non-fatal)'); }

  // Keep the consensus `sources` blob empty going forward (new rows already write '[]'; this catches any that
  // slipped in). Cheap, and prevents the consensus table from ever re-bloating.
  try { await q(`UPDATE adp_consensus SET sources='[]' WHERE sources IS NOT NULL AND sources::text <> '[]'`); } catch (e) { /* non-fatal */ }

  const detail = { combos: combos.length, written, eventAdjusted, events: eventByPlayer.size, ms: Date.now() - started };
  log.info(detail, 'refreshConsensus done');
  await recordJob('refreshConsensus', true, detail);
  return detail;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  refreshConsensus().then(() => process.exit(0)).catch((e) => { log.error(e); process.exit(1); });
}
