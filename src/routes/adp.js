// ADP read API. Powers the front-end ADP Intelligence view: consensus, per-source breakdown,
// spread, and trend — by format, with graceful fallback to a richer profile when a format is thin.
import { Router } from 'express';
import { config } from '../lib/config.js';
import { q } from '../lib/db.js';
import { formatFallbacks } from '../lib/formatKey.js';

export const adpRouter = Router();

// GET /api/adp/diag?season=2026 — quick data-health check so you can SEE what's in the DB without
// guessing whether the refresh job ran. Reports published-ADP coverage, harvested coverage, sample
// players (Tua, a top rookie), and which published formats exist. Open this in a browser after a deploy.
adpRouter.get('/diag', async (req, res) => {
  const season = Number(req.query.season || config.activeSeason);
  try {
    const pubCount = (await q(`SELECT count(*)::int n, count(DISTINCT player_id)::int players, count(DISTINCT format_key)::int formats FROM adp_observations WHERE season=$1 AND source='sleeper_published'`, [season])).rows[0];
    const pubFormats = (await q(`SELECT format_key, count(*)::int n FROM adp_observations WHERE season=$1 AND source='sleeper_published' GROUP BY format_key ORDER BY n DESC LIMIT 20`, [season])).rows;
    const harvestCount = (await q(`SELECT count(*)::int n FROM adp_observations WHERE season=$1 AND source != 'sleeper_published'`, [season])).rows[0];
    const consensusCount = (await q(`SELECT count(*)::int n, count(DISTINCT format_key)::int formats FROM adp_consensus WHERE season=$1`, [season])).rows[0];
    const projCount = (await q(`SELECT count(*)::int n FROM projections WHERE season=$1`, [season])).rows[0];
    const lastJobs = (await q(`SELECT name, ok, detail, created_at FROM job_runs ORDER BY created_at DESC LIMIT 8`).catch(() => ({ rows: [] }))).rows;
    // sample a couple of players' published ADP across formats
    const sample = async (nameLike) => (await q(
      `SELECT p.full_name, p.position, o.format_key, o.pick FROM adp_observations o JOIN players p ON p.player_id=o.player_id
        WHERE o.season=$1 AND o.source='sleeper_published' AND p.full_name ILIKE $2 ORDER BY o.format_key LIMIT 12`,
      [season, `%${nameLike}%`]
    )).rows;
    res.json({
      season,
      published: pubCount, publishedFormats: pubFormats,
      harvestedObservations: harvestCount, consensus: consensusCount, projections: projCount,
      sampleTua: await sample('Tua'), sampleBrazzell: await sample('Brazzell'),
      recentJobs: lastJobs,
      hint: published_hint(pubCount),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
function published_hint(pub) {
  if (!pub || pub.n === 0) return 'NO published ADP in the DB — run `npm run refresh` (or `npm run published-adp`) in the Render shell. This is almost certainly why ADP looks wrong.';
  return `Published ADP present: ${pub.players} players across ${pub.formats} formats.`;
}


// GET /api/adp/board?format=PPR|1QB|STD|REDRAFT|12&season=2026&limit=300
// Returns the consensus board for a format (sorted by consensus ADP), with fallback.
adpRouter.get('/board', async (req, res) => {
  const season = Number(req.query.season || config.activeSeason);
  const format = String(req.query.format || 'PPR|1QB|STD|REDRAFT|12');
  const limit = Math.min(500, Number(req.query.limit || 300));
  for (const fkey of formatFallbacks(format)) {
    const { rows } = await q(
      `SELECT c.player_id, p.full_name, p.position, p.team, p.bye_week,
              c.consensus, c.lo, c.hi, c.stdev, c.sample_n, c.trend
         FROM adp_consensus c JOIN players p ON p.player_id = c.player_id
        WHERE c.format_key=$1 AND c.season=$2
        ORDER BY c.consensus ASC LIMIT $3`,
      [fkey, season, limit]
    );
    if (rows.length) {
      return res.json({ format: fkey, requestedFormat: format, fallback: fkey !== format, season, players: rows });
    }
  }
  res.json({ format, requestedFormat: format, fallback: false, season, players: [], note: 'No ADP yet for this format — harvest needs to run.' });
});

// GET /api/adp/player/:playerId?format=...&season=...
// Full per-source breakdown for one player (the detail panel).
adpRouter.get('/player/:playerId', async (req, res) => {
  const season = Number(req.query.season || config.activeSeason);
  const format = String(req.query.format || 'PPR|1QB|STD|REDRAFT|12');
  const playerId = req.params.playerId;
  for (const fkey of formatFallbacks(format)) {
    const { rows } = await q(
      `SELECT c.*, p.full_name, p.position, p.team, p.bye_week
         FROM adp_consensus c JOIN players p ON p.player_id=c.player_id
        WHERE c.player_id=$1 AND c.format_key=$2 AND c.season=$3`,
      [playerId, fkey, season]
    );
    if (rows[0]) {
      const r = rows[0];
      return res.json({
        format: fkey, requestedFormat: format, fallback: fkey !== format, season,
        player: { id: r.player_id, name: r.full_name, position: r.position, team: r.team, bye: r.bye_week },
        consensus: r.consensus, lo: r.lo, hi: r.hi, stdev: r.stdev, sampleN: r.sample_n, trend: r.trend,
        sources: r.sources || [],
      });
    }
  }
  res.status(404).json({ error: 'No ADP for that player/format yet' });
});
