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
import { clearPlayerPackCache } from '../lib/packCache.js';
import { recordJob } from '../lib/jobs.js';

// Team-size buckets we publish ADP into. Sleeper's published ADP is not team-size specific, so we apply
// it to every common bucket; the harvested/real-draft observations (which ARE size-specific) refine it.
const TEAM_BUCKETS = ['8-10', '12', '14+'];

// ⭐⭐⭐ SLEEPER'S "NO ADP" SENTINEL.
// Sleeper does not omit an ADP field it has no value for — it sends 999.0. Verified against the live
// payload on 2026-09-01: `adp_dynasty` and `adp_rookie` are 999.0 for EVERY player sampled (all 20 QBs,
// all 12 TEs), while the real dynasty signal lives in adp_dynasty_ppr/_half_ppr/_std/_2qb.
// The old guard was `!(v > 0)`, which 999 sails straight through. The result was every player in a 1QB
// dynasty league being served a published ADP of 999 — and served it with sampleN 999, the code's marker
// for "absolute confidence". There is no 999th pick in a 12-team 16-round draft; the number was never a
// draft position at all. A sentinel wearing an answer's clothes, which is the same failure as a
// placeholder rendering as a real value.
const NO_ADP_SENTINEL = 900; // anything at/above this is a marker, not a pick

// ⭐ DETERMINISTIC PRIORITY. Several fields legitimately map to the SAME format key (adp_dynasty and
// adp_dynasty_ppr both describe 1QB PPR dynasty). Previously each wrote its own observation row and the
// pack's `Map.set` let whichever row the database happened to return LAST win — so a dynasty player's ADP
// was nondeterministic between the real number and the sentinel. Now each (player, format) keeps exactly
// one value: the lowest `prio` wins, ties broken by first-seen.
const PRIO = { exact: 0, alias: 1 };

// Map a Sleeper projection ADP field -> the partial format it implies. We then expand across the
// dimensions the field doesn't pin down (e.g. redraft PPR ADP applies to both TE-std and TE-premium,
// 1QB only). Each entry: { field, scoring, qb, pool }. TE is left to expand to STD+TEP unless implied.
// Field list verified against the live payload on 2026-09-01. The twelve fields below are the ones
// Sleeper actually publishes, and they live inside `stats`, never at top level.
//
// ⚠ THE `adp_dd_*` FAMILY DOES NOT EXIST. Four entries used to head this list claiming to be "the
//   confirmed names… what populate the board everyone sees", with the real fields demoted beneath them as
//   "legacy/alternate names kept as fallbacks". It is the other way round: `adp_dd_ppr` and friends are
//   absent from every projection object, and `adp_ppr` is the number in the Sleeper draft room. They were
//   harmless (an absent field is skipped) but they inverted the priority order in the reader's head, so
//   they are gone. Anything added here in future should be checked against a live payload first.
//
// `pools` lists every pool this field is the right market for. KEEPER is deliberately fed from the REDRAFT
// fields: a keeper league drafts out of the ordinary redraft pool minus the players already kept, and
// Sleeper's own keeper draft rooms show exactly these redraft numbers. See the KEEPER note below.
const ADP_FIELDS = [
  // ---- Redraft (and keeper, which shares the redraft market) ----
  { field: 'adp_ppr',              scoring: 'PPR',  qb: '1QB', pools: ['REDRAFT', 'KEEPER', 'BESTBALL'], prio: PRIO.exact },
  { field: 'adp_half_ppr',         scoring: 'HALF', qb: '1QB', pools: ['REDRAFT', 'KEEPER', 'BESTBALL'], prio: PRIO.exact },
  { field: 'adp_std',              scoring: 'STD',  qb: '1QB', pools: ['REDRAFT', 'KEEPER', 'BESTBALL'], prio: PRIO.exact },
  /* ⭐⭐⭐⭐ SLEEPER'S ONLY MULTI-QB FIELD IS LITERALLY THE 2QB MARKET, AND IT WAS FILED UNDER SUPERFLEX.
     The field is `adp_2qb`. Now that 2QB has its own format key it goes there as the EXACT source — it is
     the market it names — and into SF at alias priority, because it is also the best published proxy for a
     superflex room and superflex has no published field of its own. Alias priority means any real harvested
     superflex data outranks it in that bucket while it still fills gaps. */
  { field: 'adp_2qb',              scoring: 'PPR',  qb: '2QB', pools: ['REDRAFT', 'KEEPER', 'BESTBALL'], prio: PRIO.exact },
  { field: 'adp_2qb',              scoring: 'PPR',  qb: 'SF',  pools: ['REDRAFT', 'KEEPER', 'BESTBALL'], prio: PRIO.alias },
  // ---- Dynasty ----
  { field: 'adp_dynasty_ppr',      scoring: 'PPR',  qb: '1QB', pools: ['DYNASTY'], prio: PRIO.exact },
  { field: 'adp_dynasty_half_ppr', scoring: 'HALF', qb: '1QB', pools: ['DYNASTY'], prio: PRIO.exact },
  { field: 'adp_dynasty_std',      scoring: 'STD',  qb: '1QB', pools: ['DYNASTY'], prio: PRIO.exact },
  { field: 'adp_dynasty_2qb',      scoring: 'PPR',  qb: '2QB', pools: ['DYNASTY'], prio: PRIO.exact },
  { field: 'adp_dynasty_2qb',      scoring: 'PPR',  qb: 'SF',  pools: ['DYNASTY'], prio: PRIO.alias },
  // `adp_dynasty` is an unscoped alias for 1QB dynasty. It reads 999 for every player we have ever
  // sampled, so in practice the sentinel filter drops it entirely — but it is kept at ALIAS priority so
  // that if Sleeper ever populates it, it can fill a gap without outranking the scoped fields.
  { field: 'adp_dynasty',          scoring: 'PPR',  qb: '1QB', pools: ['DYNASTY'], prio: PRIO.alias },
  // ---- Rookie (also 999 across the board for veterans; real only for incoming rookies) ----
  { field: 'adp_rookie',           scoring: 'PPR',  qb: '1QB', pools: ['ROOKIE'], prio: PRIO.exact },
];

// Expand a partial format into the concrete format keys it should populate (TE std + premium, all team
// buckets). SF ADP also seeds the SF/TEP variant. We keep this generous: published ADP is a base signal
// and real harvested drafts (size + TE-premium specific) refine the exact bucket the user is in.
// ⭐⭐ TE PREMIUM: WE WRITE STD KEYS ONLY, ON PURPOSE.
// Sleeper publishes NO TE-premium ADP — there is no such field in the payload, verified. This function
// used to write every published number into the TEP key as well as the STD one, which made a TE-premium
// league's request resolve "exactly" and be stamped sampleN 999 (absolute confidence). It was a standard-TE
// number wearing a TE-premium label: in a TEP league an elite TE goes materially earlier than this, and
// the board asserted otherwise with total confidence.
// Writing STD only is what makes the rest of the system work as designed. A TEP request now falls through
// the pack's chain to the STD number, is correctly flagged `adpDegraded`, and — crucially — becomes
// eligible to be overridden by format-correct harvested drafts, which ARE TE-premium aware. The number a
// TEP league sees is the same as before; what changes is that the app now knows it is an approximation.
function expandFormatKeys({ scoring, qb, pool }) {
  const keys = [];
  for (const teams of TEAM_BUCKETS) keys.push(`${scoring}|${qb}|STD|${pool}|${teams}`);
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

  // (player, format) -> { pick, prio }. One winning value per cell, chosen by priority rather than by
  // whatever order the database happens to return rows in later.
  const cell = new Map();
  let players = 0, fieldsFound = 0, sentinelsDropped = 0;
  const byField = {};
  const sentinelByField = {};
  // DIAGNOSTIC: capture the keys present on the first projection object so we can see where Sleeper puts
  // the adp_* fields (top-level vs nested in stats). Surfaced in the job detail + logs.
  let sampleKeys = null, sampleStatsKeys = null;
  for (const r of rows || []) {
    const sid = r.player_id;
    if (!sid || !have.has(sid)) continue;
    const stats = r.stats || {};
    if (sampleKeys == null) { sampleKeys = Object.keys(r).slice(0, 40); sampleStatsKeys = Object.keys(stats).filter((k) => k.includes('adp')).slice(0, 40); }
    let any = false;
    for (const def of ADP_FIELDS) {
      // Sleeper has placed published ADP at the TOP LEVEL of the projection object in some payloads and
      // inside `stats` in others — check both so we don't silently miss it (the cause of published.n=0).
      const raw = (r[def.field] != null ? r[def.field] : stats[def.field]);
      if (raw == null || !(raw > 0)) continue;
      const v = Number(raw);
      // ⭐ THE SENTINEL DROP. 999 means "Sleeper has no ADP here", not "he goes 999th".
      if (v >= NO_ADP_SENTINEL) {
        sentinelsDropped++;
        sentinelByField[def.field] = (sentinelByField[def.field] || 0) + 1;
        continue;
      }
      any = true; fieldsFound++;
      byField[def.field] = (byField[def.field] || 0) + 1;
      for (const pool of def.pools) {
        for (const fkey of expandFormatKeys({ scoring: def.scoring, qb: def.qb, pool })) {
          const k = `${sid} ${fkey}`;
          const prev = cell.get(k);
          if (!prev || def.prio < prev.prio) cell.set(k, { sid, fkey, pick: v, prio: def.prio });
        }
      }
    }
    if (any) players++;
  }
  const values = [...cell.values()].map((c) => [c.sid, c.fkey, season, 'sleeper_published', 'platform_adp', c.pick, 6]);

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

  const detail = { season, projectionRowsSeen: (rows || []).length, players, fieldsFound, observationsWritten: written, byField,
    // Surfaced so the admin job view can SEE the sentinel being dropped rather than taking it on trust —
    // if Sleeper ever changes the marker, these counts move and the change is visible instead of silent.
    sentinelsDropped, sentinelByField,
    sampleObjectKeys: sampleKeys, sampleAdpKeysInStats: sampleStatsKeys, ms: Date.now() - started };
  // New ADP has landed — drop the cached packs so the next request rebuilds from fresh data
  // instead of serving a stale pack until the TTL expires.
  try { clearPlayerPackCache(); } catch (e) { /* cache is best-effort; never fail the job for it */ }
  log.info(detail, 'syncPublishedAdp done');
  await recordJob('syncPublishedAdp', true, detail);
  return detail;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncPublishedAdp().then((d) => { console.log(JSON.stringify(d, null, 2)); process.exit(0); }).catch((e) => { log.error(e); process.exit(1); });
}
