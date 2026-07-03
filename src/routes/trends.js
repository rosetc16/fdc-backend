// Aggregated Draft Trends API. Turns the pool of HARVESTED real Sleeper drafts (stored as individual
// pick observations in adp_observations, source='sleeper_harvest') into per-player draft-position
// distributions for a given format: average pick, range, median, spread, how often he's drafted, and a
// compact round-by-round histogram. This is what makes the front-end Draft Trends page meaningful across
// *thousands* of drafts instead of just the handful a single user has run.
//
// Why this and not adp_consensus? adp_consensus blends many sources into one number per player. Trends is
// specifically about the DISTRIBUTION across real drafts — the shape (is he a stable pick, or a boom/bust
// swing?), the min/max, and the sample size — which is exactly the "how the field actually drafts" view.
import { Router } from 'express';
import { config } from '../lib/config.js';
import { q } from '../lib/db.js';
import { formatFallbacks } from '../lib/formatKey.js';

export const trendsRouter = Router();

const HARVEST_SOURCE = 'sleeper_harvest';

// Given a format key, walk the fallback chain until we find one with enough harvested drafts to be
// meaningful. Returns { fkey, draftCount } for the first format that clears `minDrafts`, else the richest
// one we saw (so we always return *something*, flagged as thin).
async function pickFormat(season, format, minDrafts) {
  let best = null;
  for (const fkey of formatFallbacks(format)) {
    let n = 0;
    try {
      const r = await q(`SELECT count(*)::int n FROM harvested_drafts WHERE season=$1 AND format_key=$2`, [season, fkey]);
      n = r.rows[0]?.n || 0;
    } catch { n = 0; } // table not migrated yet — treat as empty
    if (best == null || n > best.draftCount) best = { fkey, draftCount: n };
    if (n >= minDrafts) return { fkey, draftCount: n, thin: false, exact: fkey === format };
  }
  return best ? { ...best, thin: best.draftCount < minDrafts, exact: best.fkey === format } : { fkey: format, draftCount: 0, thin: true, exact: true };
}

// GET /api/trends/board?format=PPR|SF|TEP|DYNASTY|12&season=2026&limit=250&minDrafts=5
// The whole board for a format: every player with enough harvested picks, sorted by average draft
// position, with distribution stats. Powers the Draft Trends table & search.
trendsRouter.get('/board', async (req, res) => {
  const season = Number(req.query.season || config.activeSeason);
  const format = String(req.query.format || 'PPR|1QB|STD|REDRAFT|12');
  const limit = Math.min(600, Number(req.query.limit || 250));
  const minDrafts = Math.max(1, Number(req.query.minDrafts || 5));
  const minPicks = Math.max(2, Number(req.query.minPicks || 2)); // a player must appear in >= this many drafts
  try {
    const chosen = await pickFormat(season, format, minDrafts);
    if (!chosen.draftCount) {
      const [, , , poolClass] = chosen.fkey.split('|');
      const seasonal = poolClass === 'REDRAFT'
        ? 'Few redraft drafts happen in the offseason — most drafts right now are rookie and dynasty. This fills up as redraft season approaches.'
        : 'No harvested drafts for this format yet — the pool fills automatically as more of these drafts happen.';
      return res.json({ format, usedFormat: chosen.fkey, fallback: false, thin: true, season, draftCount: 0, players: [], note: seasonal });
    }
    // Aggregate the raw pick observations into a per-player distribution. percentile_cont for the median,
    // stddev_samp for spread. We compute everything in SQL so it scales to large pools.
    const { rows } = await q(
      `SELECT o.player_id,
              p.full_name, p.position, p.team, p.bye_week,
              count(*)::int                                  AS n,
              round(avg(o.pick)::numeric, 1)                 AS avg_pick,
              min(o.pick)::numeric                           AS min_pick,
              max(o.pick)::numeric                           AS max_pick,
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY o.pick)::numeric, 1) AS median_pick,
              round(coalesce(stddev_samp(o.pick), 0)::numeric, 1) AS stdev,
              array_agg(o.pick ORDER BY o.pick)              AS picks
         FROM adp_observations o
         JOIN players p ON p.player_id = o.player_id
        WHERE o.season = $1 AND o.source = $2 AND o.format_key = $3
        GROUP BY o.player_id, p.full_name, p.position, p.team, p.bye_week
       HAVING count(*) >= $4
        ORDER BY avg(o.pick) ASC
        LIMIT $5`,
      [season, HARVEST_SOURCE, chosen.fkey, minPicks, limit]
    );
    const players = rows.map((r) => shapePlayer(r, chosen.draftCount));
    res.json({
      format, usedFormat: chosen.fkey, fallback: chosen.fkey !== format, thin: chosen.thin,
      season, draftCount: chosen.draftCount, count: players.length, players,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/trends/player/:playerId?format=...&season=...
// One player's full distribution + a round histogram, for the detail panel.
trendsRouter.get('/player/:playerId', async (req, res) => {
  const season = Number(req.query.season || config.activeSeason);
  const format = String(req.query.format || 'PPR|1QB|STD|REDRAFT|12');
  const teams = Math.max(4, Math.min(32, Number(req.query.teams || 12)));
  const playerId = req.params.playerId;
  try {
    const chosen = await pickFormat(season, format, 3);
    const { rows } = await q(
      `SELECT o.player_id, p.full_name, p.position, p.team, p.bye_week,
              count(*)::int AS n,
              round(avg(o.pick)::numeric,1) AS avg_pick,
              min(o.pick)::numeric AS min_pick, max(o.pick)::numeric AS max_pick,
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY o.pick)::numeric,1) AS median_pick,
              round(coalesce(stddev_samp(o.pick),0)::numeric,1) AS stdev,
              array_agg(o.pick ORDER BY o.pick) AS picks
         FROM adp_observations o JOIN players p ON p.player_id=o.player_id
        WHERE o.season=$1 AND o.source=$2 AND o.format_key=$3 AND o.player_id=$4
        GROUP BY o.player_id, p.full_name, p.position, p.team, p.bye_week`,
      [season, HARVEST_SOURCE, chosen.fkey, playerId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'No harvested picks for that player/format yet' });
    const base = shapePlayer(rows[0], chosen.draftCount);
    // round histogram: how many times he went in each round (round = ceil(pick/teams))
    const picks = rows[0].picks.map(Number);
    const byRound = {};
    for (const pk of picks) { const rd = Math.max(1, Math.ceil(pk / teams)); byRound[rd] = (byRound[rd] || 0) + 1; }
    const histogram = Object.entries(byRound).map(([rd, n]) => ({ round: Number(rd), n })).sort((a, b) => a.round - b.round);
    res.json({
      format, usedFormat: chosen.fkey, fallback: chosen.fkey !== format, thin: chosen.thin,
      season, draftCount: chosen.draftCount, teams,
      player: base, histogram,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/trends/diag?season=2026 — coverage health: how many harvested drafts exist per format, and a
// couple of sample players, so you can SEE the pool depth without guessing whether the harvester ran.
trendsRouter.get('/diag', async (req, res) => {
  const season = Number(req.query.season || config.activeSeason);
  try {
    // Resilient to a not-yet-migrated DB: if a table is missing, report 0 rather than 500ing.
    const safe = async (sql, params, fallback) => { try { return (await q(sql, params)).rows; } catch { return fallback; } };
    const totalDrafts = (await safe(`SELECT count(*)::int n FROM harvested_drafts WHERE season=$1`, [season], [{ n: 0 }]))[0];
    const byFormat = await safe(
      `SELECT format_key, count(*)::int drafts, sum(pick_count)::int picks
         FROM harvested_drafts WHERE season=$1 GROUP BY format_key ORDER BY drafts DESC LIMIT 30`,
      [season], []
    );
    const obs = (await safe(
      `SELECT count(*)::int n, count(DISTINCT player_id)::int players, count(DISTINCT format_key)::int formats
         FROM adp_observations WHERE season=$1 AND source=$2`,
      [season, HARVEST_SOURCE], [{ n: 0, players: 0, formats: 0 }]
    ))[0];
    const lastHarvest = (await safe(`SELECT max(harvested_at) t FROM harvested_drafts WHERE season=$1`, [season], [{ t: null }]))[0];
    res.json({
      season,
      harvestedDrafts: totalDrafts?.n || 0,
      lastHarvestedAt: lastHarvest?.t || null,
      harvestObservations: obs,
      draftsByFormat: byFormat,
      hint: (totalDrafts?.n || 0) === 0
        ? 'No harvested drafts yet — run the harvester (npm run harvest, or the scheduled job) to build the pool.'
        : `Pool: ${totalDrafts.n} drafts across ${byFormat.length} formats. Board/player endpoints will fall back to a richer profile when an exact format is thin.`,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Shape a raw aggregate row into the API's player object. `poolDrafts` = number of drafts in this format,
// used to compute how often he's drafted (drafted-in rate) — a proxy for how universally rostered he is.
function shapePlayer(r, poolDrafts) {
  const picks = (r.picks || []).map(Number);
  const n = r.n;
  // Interquartile range gives a robust "typical range" that ignores the odd outlier draft.
  const p25 = percentile(picks, 0.25);
  const p75 = percentile(picks, 0.75);
  return {
    id: r.player_id,
    name: r.full_name,
    position: r.position,
    team: r.team,
    bye: r.bye_week,
    n,                                        // number of drafts he appears in
    draftedRate: poolDrafts ? Math.round((n / poolDrafts) * 100) : null, // % of drafts he was taken in
    avg: Number(r.avg_pick),
    median: Number(r.median_pick),
    min: Number(r.min_pick),
    max: Number(r.max_pick),
    stdev: Number(r.stdev),
    p25, p75,                                 // typical range (middle 50% of drafts)
  };
}

// Simple linear-interpolation percentile over an already-ascending array.
function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = p * (sortedAsc.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return Math.round((sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo)) * 10) / 10;
}
