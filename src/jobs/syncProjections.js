// JOB: sync season projections from Sleeper into the projections table (raw stats; the engine
// converts to points per league scoring). Current-season enforced. Run daily.
import { config } from '../lib/config.js';
import { getSeasonProjections } from '../lib/sleeper.js';
import { q } from '../lib/db.js';
import { log } from '../lib/log.js';
import { recordJob } from '../lib/jobs.js';

export async function syncProjections({ season = config.activeSeason } = {}) {
  const started = Date.now();
  const rows = await getSeasonProjections(season);
  let written = 0, skipped = 0;

  // only keep projections for players we already have canonical rows for
  const { rows: known } = await q('SELECT player_id FROM players');
  const have = new Set(known.map((r) => r.player_id));

  for (const r of rows || []) {
    const sid = r.player_id;
    if (!sid || !have.has(sid)) { skipped++; continue; }
    const stats = r.stats || {};
    // floor/ceiling: Sleeper sometimes provides pts; otherwise leave null for the engine to derive
    const floor = stats.pts_std != null ? Math.round(stats.pts_std * 0.85) : null;
    const ceil = stats.pts_ppr != null ? Math.round(stats.pts_ppr * 1.15) : null;
    await q(
      `INSERT INTO projections (player_id, season, source, stats, floor_pts, ceil_pts, updated_at)
       VALUES ($1,$2,'sleeper',$3,$4,$5, now())
       ON CONFLICT (player_id, season, source) DO UPDATE SET
         stats=EXCLUDED.stats, floor_pts=EXCLUDED.floor_pts, ceil_pts=EXCLUDED.ceil_pts, updated_at=now()`,
      [sid, season, JSON.stringify(stats), floor, ceil]
    );
    written++;
  }

  // guardrail: refuse to leave a wrong-season set as "current" — drop very old projections
  await q(`DELETE FROM projections WHERE season < $1 - 1`, [season]);

  const detail = { season, written, skipped, ms: Date.now() - started };
  log.info(detail, 'syncProjections done');
  await recordJob('syncProjections', true, detail);
  return detail;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncProjections().then(() => process.exit(0)).catch((e) => { log.error(e); process.exit(1); });
}
