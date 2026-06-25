// JOB: ingest Sleeper's PUBLISHED ADP directly from the season projections payload.
//
// Why: our harvested-draft ADP is thin and rookie-contaminated early in the year (the only Sleeper
// drafts this early are rookie/dynasty mocks), which buries veterans like Tua/Allen. Sleeper, however,
// publishes broad ADP fields on each projection object (adp_ppr, adp_2qb, adp_dynasty, ...). Those cover
// the entire veteran pool and match what every owner sees in the Sleeper draft room — exactly the
// market signal predictions should follow. We map each published ADP field to the format keys it applies
// to and write them as high-weight 'platform_adp' observations, which the consensus blender then folds in.
//
// This is the durable fix for "thin/contaminated ADP": published ADP gives full, clean coverage on day 1.
import { config } from '../lib/config.js';
import { getSeasonProjections } from '../lib/sleeper.js';
import { q } from '../lib/db.js';
import { log } from '../lib/log.js';
import { recordJob } from '../lib/jobs.js';

// Team-size buckets we publish ADP into. Sleeper's published ADP is not team-size specific, so we apply
// it to every common bucket; the harvested/real-draft observations (which ARE size-specific) refine it.
const TEAM_BUCKETS = ['8-10', '12', '14+'];

// Map a Sleeper projection ADP field -> the partial format it implies. We then expand across the
// dimensions the field doesn't pin down (e.g. redraft PPR ADP applies to both TE-std and TE-premium,
// 1QB only). Each entry: { field, scoring, qb, pool }. TE is left to expand to STD+TEP unless implied.
const ADP_FIELDS = [
  // ---- Redraft (no dynasty/rookie qualifier) ----
  { field: 'adp_std',            scoring: 'STD',  qb: '1QB', pool: 'REDRAFT' },
  { field: 'adp_half_ppr',       scoring: 'HALF', qb: '1QB', pool: 'REDRAFT' },
  { field: 'adp_ppr',            scoring: 'PPR',  qb: '1QB', pool: 'REDRAFT' },
  { field: 'adp_2qb',            scoring: 'PPR',  qb: 'SF',  pool: 'REDRAFT' }, // Sleeper's 2QB ADP ~ PPR base
  // ---- Dynasty ----
  { field: 'adp_dynasty',        scoring: 'PPR',  qb: '1QB', pool: 'DYNASTY' },
  { field: 'adp_dynasty_std',    scoring: 'STD',  qb: '1QB', pool: 'DYNASTY' },
  { field: 'adp_dynasty_ppr',    scoring: 'PPR',  qb: '1QB', pool: 'DYNASTY' },
  { field: 'adp_dynasty_half_ppr', scoring: 'HALF', qb: '1QB', pool: 'DYNASTY' },
  { field: 'adp_dynasty_2qb',    scoring: 'PPR',  qb: 'SF',  pool: 'DYNASTY' },
  // ---- Rookie ----
  { field: 'adp_rookie',         scoring: 'PPR',  qb: '1QB', pool: 'ROOKIE' },
];

// Expand a partial format into the concrete format keys it should populate (TE std + premium, all team
// buckets). SF ADP also seeds the SF/TEP variant. We keep this generous: published ADP is a base signal
// and real harvested drafts (size + TE-premium specific) refine the exact bucket the user is in.
function expandFormatKeys({ scoring, qb, pool }) {
  const keys = [];
  for (const te of ['STD', 'TEP']) {
    for (const teams of TEAM_BUCKETS) {
      keys.push(`${scoring}|${qb}|${te}|${pool}|${teams}`);
    }
  }
  return keys;
}

export async function syncPublishedAdp({ season = config.activeSeason } = {}) {
  const started = Date.now();
  const rows = await getSeasonProjections(season);

  // only keep ADP for players we already have canonical rows for
  const { rows: known } = await q('SELECT player_id FROM players');
  const have = new Set(known.map((r) => r.player_id));

  // Clear prior published-ADP observations for this season so we replace (not pile up) each run.
  await q(`DELETE FROM adp_observations WHERE source = 'sleeper_published' AND season = $1`, [season]);

  const values = [];
  let players = 0, fieldsFound = 0;
  const byField = {};
  for (const r of rows || []) {
    const sid = r.player_id;
    if (!sid || !have.has(sid)) continue;
    const stats = r.stats || {};
    let any = false;
    for (const def of ADP_FIELDS) {
      const v = stats[def.field];
      if (v == null || !(v > 0)) continue;
      any = true; fieldsFound++;
      byField[def.field] = (byField[def.field] || 0) + 1;
      for (const fkey of expandFormatKeys(def)) {
        // weight 0.9: published ADP is a strong, broad base signal — high, but real size/TE-specific
        // harvested drafts (weight ~varies) can still pull the consensus toward the exact bucket.
        values.push([sid, fkey, season, 'sleeper_published', 'platform_adp', Number(v), 0.9]);
      }
    }
    if (any) players++;
  }

  // bulk insert in chunks
  let written = 0;
  const CHUNK = 1000;
  for (let i = 0; i < values.length; i += CHUNK) {
    const slice = values.slice(i, i + CHUNK);
    const ph = slice.map((_, j) => {
      const b = j * 7;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`;
    }).join(',');
    await q(
      `INSERT INTO adp_observations (player_id, format_key, season, source, source_type, pick, weight)
       VALUES ${ph}`,
      slice.flat()
    );
    written += slice.length;
  }

  const detail = { season, players, fieldsFound, observationsWritten: written, byField, ms: Date.now() - started };
  log.info(detail, 'syncPublishedAdp done');
  await recordJob('syncPublishedAdp', true, detail);
  return detail;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncPublishedAdp().then((d) => { console.log(JSON.stringify(d, null, 2)); process.exit(0); }).catch((e) => { log.error(e); process.exit(1); });
}
