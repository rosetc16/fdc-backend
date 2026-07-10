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
    } else if (job === 'harvest') {
      const { harvestSleeperDrafts } = await import('../jobs/harvestSleeperDrafts.js');
      detail = await harvestSleeperDrafts();
    } else if (job === 'rebuild-trends') {
      // Purge the harvested pool + reset the crawl frontier, then re-harvest. We run it SYNCHRONOUSLY with a
      // bounded batch that fits inside the HTTP timeout — a background promise on a web dyno is unreliable
      // (the instance can recycle and kill it mid-run, which is how a rebuild ended up with only 8 drafts).
      // The nightly cron continues growing the pool from here.
      await q(`DELETE FROM adp_observations WHERE source='sleeper_harvest'`);
      await q(`DELETE FROM harvested_drafts`);
      await q(`UPDATE discovered_users SET crawled_at = NULL`).catch(() => {});
      const { harvestSleeperDrafts } = await import('../jobs/harvestSleeperDrafts.js');
      const r = await harvestSleeperDrafts({ maxDrafts: 120 }); // bounded so it finishes within the request
      detail = { purged: true, crawlReset: true, ...r };
    } else if (job === 'harvest-more') {
      // Run another bounded harvest pass WITHOUT purging — accumulates more drafts onto the existing pool.
      // Click this repeatedly to grow the pool in safe increments.
      const { harvestSleeperDrafts } = await import('../jobs/harvestSleeperDrafts.js');
      detail = await harvestSleeperDrafts({ maxDrafts: 120 });
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

// ---------------------------------------------------------------------------------------------------
// PLAYER EVENTS
//
// A dated, value-changing event for one player (season-ending injury, lost his job, suspension, trade,
// retirement). Drafts that happened BEFORE the date were made under information that is now obsolete, so at
// consensus time we DOWN-WEIGHT those pre-event observations for that player. Drafts after the date already
// price the news in and are untouched. See lib/adpConsensus.js for the weighting and the redraft/dynasty split.
//
// We never invent an ADP — we only reweight real drafts — so a bad entry degrades gracefully and washes out as
// post-event drafts accumulate. Deleting an event fully restores the original number on the next refresh.

async function ensureEventsTable() {
  await q(`CREATE TABLE IF NOT EXISTS player_events (
    id          SERIAL PRIMARY KEY,
    player_id   TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    event_date  TIMESTAMPTZ NOT NULL,
    note        TEXT,
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // One active event per player per date+type; re-submitting is idempotent rather than duplicating.
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS player_events_uniq
           ON player_events (player_id, event_type, event_date)`);
  await q(`CREATE INDEX IF NOT EXISTS player_events_player ON player_events (player_id)`);
}

// The event types the blender understands, for populating the admin dropdown.
adminRouter.get('/event-types', async (_req, res) => {
  const { EVENT_PROFILES } = await import('../lib/adpConsensus.js');
  res.json(Object.entries(EVENT_PROFILES).map(([key, p]) => ({
    key, label: p.label, redraft: p.redraft, dynasty: p.dynasty,
  })));
});

// Player typeahead for the admin picker — never hardcode a player, always look them up.
//   GET /api/admin/player-search?q=mahomes
adminRouter.get('/player-search', async (req, res) => {
  const term = String(req.query.q || '').trim();
  if (term.length < 2) return res.json([]);
  const { rows } = await q(
    `SELECT player_id, full_name, position, team
       FROM players
      WHERE full_name ILIKE $1 AND position = ANY($2)
      ORDER BY full_name LIMIT 20`,
    [`%${term}%`, ['QB', 'RB', 'WR', 'TE']]
  );
  res.json(rows);
});

// List events (most recent first), joined to player names for display.
adminRouter.get('/events', async (_req, res) => {
  await ensureEventsTable();
  const { rows } = await q(
    `SELECT e.id, e.player_id, e.event_type, e.event_date, e.note, e.created_by, e.created_at,
            p.full_name, p.position, p.team
       FROM player_events e
       LEFT JOIN players p ON p.player_id = e.player_id
      ORDER BY e.event_date DESC, e.id DESC
      LIMIT 200`
  );
  res.json(rows);
});

// Create an event.  POST /api/admin/events { player_id, event_type, event_date, note? }
adminRouter.post('/events', async (req, res) => {
  await ensureEventsTable();
  const { player_id, event_type, event_date, note } = req.body || {};
  if (!player_id || !event_type || !event_date) {
    return res.status(400).json({ error: 'player_id, event_type and event_date are required' });
  }
  const { EVENT_PROFILES } = await import('../lib/adpConsensus.js');
  if (!EVENT_PROFILES[event_type]) {
    return res.status(400).json({ error: `unknown event_type: ${event_type}` });
  }
  const when = new Date(event_date);
  if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'event_date is not a valid date' });
  if (when.getTime() > Date.now() + 864e5) return res.status(400).json({ error: 'event_date cannot be in the future' });

  const { rows: known } = await q(`SELECT 1 FROM players WHERE player_id=$1`, [player_id]);
  if (!known.length) return res.status(400).json({ error: 'unknown player_id' });

  const { rows } = await q(
    `INSERT INTO player_events (player_id, event_type, event_date, note, created_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (player_id, event_type, event_date) DO UPDATE SET note = EXCLUDED.note
     RETURNING *`,
    [player_id, event_type, when.toISOString(), note || null, req.user?.email || 'admin']
  );
  res.json({ ok: true, event: rows[0], note: 'Run the ADP refresh job to apply this to consensus.' });
});

// Delete an event — removing it fully restores the untouched consensus on the next refresh.
adminRouter.delete('/events/:id', async (req, res) => {
  await ensureEventsTable();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  await q(`DELETE FROM player_events WHERE id=$1`, [id]);
  res.json({ ok: true, note: 'Run the ADP refresh job to restore the original consensus.' });
});

// ---------------------------------------------------------------------------------------------------
// DATABASE SIZE — diagnose what's using disk (Render warns at 90% of the Postgres storage limit).
// With a handful of users, any storage pressure is almost always the harvested-draft ADP pool
// (adp_observations), which grows every harvest pass. This reports total DB size + the biggest tables
// and the harvest row count, so you can decide between a cleanup (usually enough) and an upgrade.
adminRouter.get('/db-size', async (_req, res) => {
  try {
    const total = (await q(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size,
                                   pg_database_size(current_database()) AS bytes`)).rows[0];
    const tables = (await q(`
      SELECT relname AS table,
             pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
             pg_total_relation_size(c.oid) AS bytes,
             (SELECT reltuples::bigint FROM pg_class WHERE oid = c.oid) AS approx_rows
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
       ORDER BY pg_total_relation_size(c.oid) DESC
       LIMIT 12`)).rows;
    let harvest = null;
    try {
      harvest = (await q(`
        SELECT count(*)::bigint AS rows,
               count(*) FILTER (WHERE source = 'sleeper_harvest')::bigint AS harvest_rows,
               count(*) FILTER (WHERE source = 'sleeper_published')::bigint AS published_rows,
               count(DISTINCT season)::int AS seasons
          FROM adp_observations`)).rows[0];
    } catch { /* table may not exist */ }
    res.json({ total, tables, adp_observations: harvest });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// CLEANUP — reclaim space from the harvest pool without losing the market signal you actually use.
// The consensus is already computed and stored separately (adp_consensus), so the RAW per-pick harvest
// rows are only needed to RECOMPUTE it. We keep recent rows (default 45 days) and delete older ones, then
// VACUUM to return the freed pages to the OS. This is safe: the next refresh recomputes consensus from
// what remains, and old picks were already aged out of the trailing window anyway.
adminRouter.post('/db-cleanup', async (req, res) => {
  const days = Math.max(7, Math.min(180, Number(req.body?.keepDays) || 45));
  try {
    const before = (await q(`SELECT count(*)::bigint AS n FROM adp_observations WHERE source='sleeper_harvest'`)).rows[0].n;
    await q(
      `DELETE FROM adp_observations
        WHERE source='sleeper_harvest' AND observed_at < now() - ($1 || ' days')::interval`,
      [String(days)]
    );
    // Drop harvested_drafts rows we no longer have observations for, so re-harvest can re-pull if wanted.
    await q(`DELETE FROM harvested_drafts hd
              WHERE NOT EXISTS (SELECT 1 FROM adp_observations o
                                 WHERE o.source='sleeper_harvest' AND o.format_key = hd.format_key)`);
    // CONSENSUS BLOAT: historically each consensus row stored a fat JSON `sources` blob, duplicated across the
    // ~44 format keys per player — the single biggest space consumer after the raw pool. The board never reads
    // it, so blank it out on every existing row. New rows already write '[]'.
    let consensusTrimmed = 0;
    try { const r = await q(`UPDATE adp_consensus SET sources='[]' WHERE sources IS NOT NULL AND sources::text <> '[]'`); consensusTrimmed = r.rowCount || 0; } catch (e) { /* column may differ */ }
    // Drop consensus rows for the PRIOR seasons (kept only current + last), which otherwise linger.
    const season = config.activeSeason;
    await q(`DELETE FROM adp_consensus WHERE season < $1 - 1`, [season]).catch(() => {});
    // VACUUM cannot run inside a transaction; best-effort in its own statements to return pages to the OS.
    try { await q('VACUUM (ANALYZE) adp_observations'); } catch (e) { /* non-fatal */ }
    try { await q('VACUUM (ANALYZE) adp_consensus'); } catch (e) { /* non-fatal */ }
    const after = (await q(`SELECT count(*)::bigint AS n FROM adp_observations WHERE source='sleeper_harvest'`)).rows[0].n;
    res.json({ ok: true, keepDays: days, harvestRowsBefore: before, harvestRowsAfter: after, deleted: Number(before) - Number(after), consensusSourcesTrimmed: consensusTrimmed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
