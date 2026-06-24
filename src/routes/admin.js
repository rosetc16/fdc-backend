// Admin routes — gated server-side by requireAdmin (DB flag + allowlist). Comp subscriptions and
// a look at recent data-job runs so you can confirm nightly refreshes are succeeding.
import { Router } from 'express';
import { q } from '../lib/db.js';
import { config } from '../lib/config.js';
import { requireAdmin } from '../lib/auth.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

// grant a comp (free) subscription
adminRouter.post('/comp', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const scope = req.body.scope === 'forever' ? 'forever' : 'season';
  if (!email) return res.status(400).json({ error: 'email required' });
  const until = scope === 'forever' ? new Date('9999-01-01') : new Date(config.leagueYearCutoff);
  const { rows } = await q(
    `UPDATE users SET comp=true, paid_until=$1 WHERE email=$2 RETURNING email, paid_until, comp`,
    [until, email]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No user with that email' });
  res.json({ user: rows[0] });
});

adminRouter.post('/revoke-comp', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const { rows } = await q(
    `UPDATE users SET comp=false, paid_until=NULL WHERE email=$1 AND comp=true RETURNING email`,
    [email]
  );
  res.json({ revoked: rows[0]?.email || null });
});

// recent job runs (did the nightly data refresh work?)
adminRouter.get('/jobs', async (_req, res) => {
  const { rows } = await q('SELECT job, ok, detail, started_at FROM job_runs ORDER BY started_at DESC LIMIT 50');
  res.json({ jobs: rows });
});

// quick data-health snapshot
adminRouter.get('/health', async (_req, res) => {
  const [{ rows: pl }, { rows: adp }, { rows: proj }, { rows: hv }] = await Promise.all([
    q('SELECT count(*)::int n FROM players'),
    q('SELECT count(*)::int n FROM adp_consensus'),
    q('SELECT count(*)::int n FROM projections'),
    q('SELECT count(*)::int n FROM harvested_drafts'),
  ]);
  res.json({ players: pl[0].n, adpConsensus: adp[0].n, projections: proj[0].n, harvestedDrafts: hv[0].n });
});
