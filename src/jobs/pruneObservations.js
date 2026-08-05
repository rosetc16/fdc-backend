// JOB: keep the harvested ADP-observation pool from growing without bound.
//
// The problem it solves: harvestSleeperDrafts records EVERY pick of EVERY newly-discovered completed draft
// as a row in adp_observations (~180-300 rows/draft). Nothing ever deleted them, so the table grew forever
// and eventually filled the database's disk (the outage). The consensus the board actually uses is computed
// and stored SEPARATELY (adp_consensus), so the raw per-pick rows are only needed to RECOMPUTE consensus on
// a trailing window — old raw picks past that window carry no signal we use.
//
// Retention rule (matches the product owner's intent):
//   • Keep every harvested observation newer than KEEP_DAYS (default 21).
//   • BUT don't blindly delete older rows for a format that would then have too small a sample — a niche
//     format (e.g. a rare SF|TEP|DYNASTY bucket) might only get a few drafts a month, and we'd rather keep
//     its older picks than leave it with near-zero data. So for each format_key we keep older rows until the
//     format has at least MIN_SAMPLE recent rows; formats above that threshold get trimmed to the window.
//   • Published observations (source='sleeper_published') are NOT harvested picks — they're the clean market
//     baseline and are cheap + overwritten each refresh, so we leave them alone.
//
// This runs at the END of refreshAll (after consensus is recomputed from the full pool), so a prune never
// starves the consensus that just ran. It's a plain DELETE (no VACUUM FULL) — routine deletes keep the table
// flat by reusing freed pages, and autovacuum handles the rest; the heavy VACUUM FULL stays a manual admin
// action for the rare deep-compaction. Safe to run every refresh.
import { q } from '../lib/db.js';
import { log } from '../lib/log.js';

const KEEP_DAYS = Number(process.env.ADP_KEEP_DAYS || 21);   // trailing window to always keep
const MIN_SAMPLE = Number(process.env.ADP_MIN_SAMPLE || 400); // per-format floor of recent rows before trimming older ones

export async function pruneObservations({ keepDays = KEEP_DAYS, minSample = MIN_SAMPLE } = {}) {
  const started = Date.now();
  try {
    const before = (await q(
      `SELECT count(*)::bigint AS n FROM adp_observations WHERE source='sleeper_harvest'`
    )).rows[0].n;

    // Formats that ALREADY have enough recent rows can be trimmed to the window. A format below the floor
    // is left fully intact (we keep its older rows) so a niche bucket never loses its already-thin sample.
    const healthy = (await q(
      `SELECT format_key
         FROM adp_observations
        WHERE source='sleeper_harvest'
          AND observed_at >= now() - ($1 || ' days')::interval
        GROUP BY format_key
       HAVING count(*) >= $2`,
      [String(keepDays), minSample]
    )).rows.map((r) => r.format_key);

    let deleted = 0;
    if (healthy.length) {
      // Delete OLD rows only for well-covered formats.
      const r = await q(
        `DELETE FROM adp_observations
          WHERE source='sleeper_harvest'
            AND observed_at < now() - ($1 || ' days')::interval
            AND format_key = ANY($2)`,
        [String(keepDays), healthy]
      );
      deleted = r.rowCount || 0;
    }

    // Drop harvested_drafts bookkeeping rows whose format no longer has any observations, so a future
    // harvest of the same draft id stays blocked but we don't keep dead format bookkeeping around.
    await q(
      `DELETE FROM harvested_drafts hd
        WHERE NOT EXISTS (SELECT 1 FROM adp_observations o
                           WHERE o.source='sleeper_harvest' AND o.format_key = hd.format_key)`
    ).catch(() => {});

    const after = (await q(
      `SELECT count(*)::bigint AS n FROM adp_observations WHERE source='sleeper_harvest'`
    )).rows[0].n;

    const result = {
      keepDays, minSample,
      harvestRowsBefore: Number(before),
      harvestRowsAfter: Number(after),
      deleted,
      formatsTrimmed: healthy.length,
      ms: Date.now() - started,
    };
    log.info(result, 'pruneObservations complete');
    return result;
  } catch (e) {
    log.error(e, 'pruneObservations failed');
    return { error: e.message };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  pruneObservations().then((r) => { console.log(r); process.exit(0); }).catch((e) => { log.error(e); process.exit(1); });
}
