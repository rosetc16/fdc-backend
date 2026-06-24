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

  let written = 0;
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
    const rec = buildConsensusRecord(obs);
    if (rec.consensus == null) continue;
    await q(
      `INSERT INTO adp_consensus (player_id, format_key, season, consensus, lo, hi, stdev, sample_n, trend, sources, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (player_id, format_key, season) DO UPDATE SET
         consensus=EXCLUDED.consensus, lo=EXCLUDED.lo, hi=EXCLUDED.hi, stdev=EXCLUDED.stdev,
         sample_n=EXCLUDED.sample_n, trend=EXCLUDED.trend, sources=EXCLUDED.sources, computed_at=now()`,
      [player_id, format_key, season, rec.consensus, rec.lo, rec.hi, rec.stdev,
       rec.sampleN, rec.trend, JSON.stringify(rec.sources)]
    );
    written++;
  }

  // staleness cleanup: delete observations older than the prior season once a new season is active
  await q(`DELETE FROM adp_observations WHERE season < $1 - 1`, [season]);

  const detail = { combos: combos.length, written, ms: Date.now() - started };
  log.info(detail, 'refreshConsensus done');
  await recordJob('refreshConsensus', true, detail);
  return detail;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  refreshConsensus().then(() => process.exit(0)).catch((e) => { log.error(e); process.exit(1); });
}
