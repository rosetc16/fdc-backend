// League + draft routes. A user's leagues, their configs, and saved drafts/mocks.
import { Router } from 'express';
import { z } from 'zod';
import { q } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';

export const leaguesRouter = Router();
leaguesRouter.use(requireAuth);

// list my leagues
leaguesRouter.get('/', async (req, res) => {
  const { rows } = await q('SELECT * FROM leagues WHERE user_id=$1 ORDER BY created_at DESC', [req.user.id]);
  res.json({ leagues: rows });
});

// create a league
const leagueSchema = z.object({
  name: z.string().min(1),
  cfg: z.object({}).passthrough(),
  connect: z.any().optional(),
  draftMode: z.string().optional(),
});
leaguesRouter.post('/', async (req, res) => {
  const parsed = leagueSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'name and cfg required' });
  const { name, cfg, connect, draftMode } = parsed.data;
  const { rows } = await q(
    `INSERT INTO leagues (user_id, name, cfg, connect, draft_mode) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.user.id, name, JSON.stringify(cfg), connect ? JSON.stringify(connect) : null, draftMode || null]
  );
  res.json({ league: rows[0] });
});

// update a league (config/connect/mode)
leaguesRouter.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows: own } = await q('SELECT id FROM leagues WHERE id=$1 AND user_id=$2', [id, req.user.id]);
  if (!own[0]) return res.status(404).json({ error: 'Not found' });
  const fields = [];
  const vals = [];
  let i = 1;
  for (const [k, col] of [['name', 'name'], ['cfg', 'cfg'], ['connect', 'connect'], ['draftMode', 'draft_mode']]) {
    if (req.body[k] !== undefined) {
      fields.push(`${col}=$${i++}`);
      vals.push(['cfg', 'connect'].includes(col) ? JSON.stringify(req.body[k]) : req.body[k]);
    }
  }
  if (!fields.length) return res.json({ ok: true });
  vals.push(id);
  const { rows } = await q(`UPDATE leagues SET ${fields.join(', ')} WHERE id=$${i} RETURNING *`, vals);
  res.json({ league: rows[0] });
});

leaguesRouter.delete('/:id', async (req, res) => {
  await q('DELETE FROM leagues WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.user.id]);
  res.json({ ok: true });
});

// ---- drafts (official + mocks) under a league ----
leaguesRouter.get('/:id/drafts', async (req, res) => {
  const { rows } = await q(
    `SELECT d.* FROM drafts d JOIN leagues l ON l.id=d.league_id
      WHERE d.league_id=$1 AND l.user_id=$2 ORDER BY d.ran_at DESC`,
    [Number(req.params.id), req.user.id]
  );
  res.json({ drafts: rows });
});

leaguesRouter.post('/:id/drafts', async (req, res) => {
  const leagueId = Number(req.params.id);
  const { rows: own } = await q('SELECT id FROM leagues WHERE id=$1 AND user_id=$2', [leagueId, req.user.id]);
  if (!own[0]) return res.status(404).json({ error: 'Not found' });
  const { kind = 'mock', picks = [], preds = [], complete = false } = req.body || {};
  const { rows } = await q(
    `INSERT INTO drafts (league_id, kind, picks, preds, complete) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [leagueId, kind, JSON.stringify(picks), JSON.stringify(preds), !!complete]
  );
  res.json({ draft: rows[0] });
});
