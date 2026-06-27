// Admin routes — gated server-side by requireAdmin (DB flag + allowlist). Comp subscriptions and
// a look at recent data-job runs so you can confirm nightly refreshes are succeeding.
import { Router } from 'express';
import { q } from '../lib/db.js';
import { config } from '../lib/config.js';
import { requireAdmin } from '../lib/auth.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

// Trigger a data job from the browser (admin only) — so you don't need the Render Shell. Returns the
// job's result detail (observationsWritten, etc.) so you can confirm it actually wrote data.
//   POST /api/admin/run-job  { job: 'adp' | 'published' | 'refresh' }
adminRouter.post('/run-job', async (req, res) => {
  const job = String(req.body.job || 'adp');
  try {
    let detail;
    if (job === 'refresh') {
      const { refreshAll } = await import('../jobs/refreshAll.js');
      detail = await refreshAll();
    } else if (job === 'published') {
      const { syncPublishedAdp } = await import('../jobs/syncPublishedAdp.js');
      detail = await syncPublishedAdp();
    } else if (job === 'news') {
      const { syncPlayerNews } = await import('../jobs/syncPlayerNews.js');
      detail = await syncPlayerNews();
    } else {
      const { refreshAdpOnly } = await import('../jobs/refreshAdpOnly.js');
      detail = await refreshAdpOnly();
    }
    res.json({ ok: true, job, detail });
  } catch (e) { res.status(500).json({ ok: false, job, error: e.message, stack: e.stack }); }
});

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

// ---- USER MANAGEMENT ----------------------------------------------------------------------
// List all users with their access status (most recent first). Includes a derived "paid" flag.
adminRouter.get('/users', async (req, res) => {
  const search = String(req.query.search || '').trim().toLowerCase();
  const params = [];
  let where = '';
  if (search) { params.push(`%${search}%`); where = `WHERE email ILIKE $1`; }
  const { rows } = await q(
    `SELECT id, email, is_admin, paid_until, comp, COALESCE(disabled,false) AS disabled, created_at,
            (paid_until IS NOT NULL AND paid_until > now() AND COALESCE(disabled,false)=false) AS active_paid
       FROM users ${where} ORDER BY created_at DESC LIMIT 500`,
    params
  );
  // counts for the dashboard
  const [{ rows: tot }, { rows: paid }, { rows: comp }] = await Promise.all([
    q('SELECT count(*)::int n FROM users'),
    q('SELECT count(*)::int n FROM users WHERE paid_until > now() AND COALESCE(disabled,false)=false'),
    q('SELECT count(*)::int n FROM users WHERE comp=true'),
  ]);
  res.json({ users: rows, totals: { total: tot[0].n, paid: paid[0].n, comp: comp[0].n } });
});

// Enable or disable a user's access entirely (kill switch). disabled=true blocks paid features.
adminRouter.post('/set-disabled', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const disabled = !!req.body.disabled;
  if (!email) return res.status(400).json({ error: 'email required' });
  const { rows } = await q(
    `UPDATE users SET disabled=$1 WHERE email=$2 RETURNING email, disabled`, [disabled, email]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No user with that email' });
  res.json({ user: rows[0] });
});

// ---- FREE INVITES (comp by email, works even before signup) -------------------------------
adminRouter.post('/invite', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const scope = req.body.scope === 'forever' ? 'forever' : 'season';
  if (!email) return res.status(400).json({ error: 'email required' });
  const until = scope === 'forever' ? new Date('9999-01-01') : new Date(config.leagueYearCutoff);
  // If they already have an account, comp it now. Otherwise store an invite that applies at signup.
  const { rows } = await q(
    `UPDATE users SET comp=true, disabled=false, paid_until=$1 WHERE email=$2 RETURNING email`,
    [until, email]
  );
  let applied = !!rows[0];
  if (!applied) {
    await q(
      `INSERT INTO comp_invites (email, scope) VALUES ($1,$2)
       ON CONFLICT (email) DO UPDATE SET scope=EXCLUDED.scope, created_at=now()`,
      [email, scope]
    );
  }
  res.json({ email, scope, applied, pending: !applied });
});

adminRouter.get('/invites', async (_req, res) => {
  const { rows } = await q('SELECT email, scope, created_at FROM comp_invites ORDER BY created_at DESC LIMIT 200');
  res.json({ invites: rows });
});

adminRouter.post('/cancel-invite', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  await q('DELETE FROM comp_invites WHERE email=$1', [email]);
  res.json({ canceled: email });
});

// ---- FEEDBACK INBOX -----------------------------------------------------------------------
adminRouter.get('/feedback', async (_req, res) => {
  const { rows } = await q(
    `SELECT id, email, category, message, status, created_at FROM feedback ORDER BY created_at DESC LIMIT 300`
  );
  const { rows: nu } = await q(`SELECT count(*)::int n FROM feedback WHERE status='new'`);
  res.json({ feedback: rows, newCount: nu[0].n });
});

adminRouter.post('/feedback/:id/status', async (req, res) => {
  const status = ['new', 'read', 'resolved'].includes(req.body.status) ? req.body.status : 'read';
  const { rows } = await q(`UPDATE feedback SET status=$1 WHERE id=$2 RETURNING id, status`, [status, Number(req.params.id)]);
  res.json({ feedback: rows[0] || null });
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
