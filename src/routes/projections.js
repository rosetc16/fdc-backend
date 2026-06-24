// Projections read API. Returns raw stat projections for a season; the front-end engine converts
// them to fantasy points per the league's scoring (so one projection set serves every format).
import { Router } from 'express';
import { config } from '../lib/config.js';
import { q } from '../lib/db.js';

export const projectionsRouter = Router();

// GET /api/projections?season=2026
projectionsRouter.get('/', async (req, res) => {
  const season = Number(req.query.season || config.activeSeason);
  const { rows } = await q(
    `SELECT pr.player_id, p.full_name, p.position, p.team, p.bye_week,
            pr.stats, pr.floor_pts, pr.ceil_pts
       FROM projections pr JOIN players p ON p.player_id = pr.player_id
      WHERE pr.season=$1 AND pr.source='sleeper'`,
    [season]
  );
  res.json({ season, players: rows });
});
