// ADP read API. Powers the front-end ADP Intelligence view: consensus, per-source breakdown,
// spread, and trend — by format, with graceful fallback to a richer profile when a format is thin.
import { Router } from 'express';
import { config } from '../lib/config.js';
import { q } from '../lib/db.js';
import { formatFallbacks } from '../lib/formatKey.js';

export const adpRouter = Router();

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
