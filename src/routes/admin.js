// Admin routes — gated server-side by requireAdmin (DB flag + allowlist). Comp subscriptions and
// a look at recent data-job runs so you can confirm nightly refreshes are succeeding.
import { Router } from 'express';
import { q } from '../lib/db.js';
import { config } from '../lib/config.js';
import { requireAdmin } from '../lib/auth.js';
import { formatKey as buildFormatKey } from '../lib/formatKey.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

// Trigger a data job from the browser (admin only) — so you don't need the Render Shell. Returns the
// job's result detail (observationsWritten, etc.) so you can confirm it actually wrote data.
//   POST /api/admin/run-job  { job: 'adp' | 'published' | 'refresh' | 'byes' | 'players' | 'harvest'
//                              | 'rebuild-trends' | 'harvest-more' | 'prune' | 'news'
//                              | 'weekly-brief-dry' | 'weekly-brief' }
adminRouter.post('/run-job', async (req, res) => {
  const job = String(req.body.job || 'adp');
  try {
    let detail;
    if (job === 'refresh') {
      const { refreshAll } = await import('../jobs/refreshAll.js');
      detail = await refreshAll();
    } else if (job === 'byes') {
      // FAST: set bye_week for every team via ~9 bulk UPDATEs. This is the one to run after a schedule
      // release — it finishes in well under a second, unlike the full player sync which can overrun the
      // request timeout.
      const { syncByeWeeks } = await import('../lib/byeWeeks.js');
      detail = await syncByeWeeks(q);
    } else if (job === 'players') {
      // FULL identity sync (~11k players). Can be slow; prefer the nightly cron or the 'byes' job for byes.
      const { syncPlayers } = await import('../jobs/syncPlayers.js');
      detail = await syncPlayers();
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
    } else if (job === 'prune') {
      // Trim adp_observations by hand. The same job now runs nightly at 4:45; this is here so the table can
      // be brought back under control immediately without waiting for the cron (which is what was needed
      // when the DB filled up and suspended on 2026-08-05).
      const { pruneObservations } = await import('../jobs/pruneObservations.js');
      detail = await pruneObservations();
    } else if (job === 'news') {
      // Player news / injury blurbs from ESPN. DELIBERATELY NOT in the nightly refreshAll yet: this job has
      // never run in production, it makes up to ~120 outbound calls, and draft season is the wrong moment to
      // find out how ESPN rate-limits us. Run it here by hand, watch the numbers, then promote it.
      const { syncPlayerNews } = await import('../jobs/syncPlayerNews.js');
      detail = await syncPlayerNews();
    } else if (job === 'weekly-brief-dry' || job === 'weekly-brief') {
      // Dry run logs what WOULD be sent, to whom, without sending. Use it before turning mail on.
      const { sendWeeklyBriefs } = await import('../jobs/weeklyBrief.js');
      detail = await sendWeeklyBriefs({ dryRun: job === 'weekly-brief-dry' });
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
    const sizeOf = async () => {
      const r = await q(`SELECT pg_size_pretty(pg_database_size(current_database())) AS total,
                                pg_size_pretty(pg_total_relation_size('adp_consensus')) AS consensus,
                                pg_size_pretty(pg_total_relation_size('adp_observations')) AS observations`);
      return r.rows[0];
    };
    const sizeBefore = await sizeOf();
    const before = (await q(`SELECT count(*)::bigint AS n FROM adp_observations WHERE source='sleeper_harvest'`)).rows[0].n;

    // 1) Trim the raw harvest pool to the retention window.
    await q(`DELETE FROM adp_observations
              WHERE source='sleeper_harvest' AND observed_at < now() - ($1 || ' days')::interval`, [String(days)]);
    await q(`DELETE FROM harvested_drafts hd
              WHERE NOT EXISTS (SELECT 1 FROM adp_observations o
                                 WHERE o.source='sleeper_harvest' AND o.format_key = hd.format_key)`);

    // 2) Blank the fat consensus `sources` blob (the board never reads it). This is where most of the
    //    consensus bloat lives — historically ~570 bytes/row of JSON duplicated across ~44 formats per player.
    let consensusTrimmed = 0;
    try { const r = await q(`UPDATE adp_consensus SET sources='[]' WHERE sources IS NOT NULL AND sources::text <> '[]'`); consensusTrimmed = r.rowCount || 0; } catch (e) { /* column may differ */ }
    const season = config.activeSeason;
    await q(`DELETE FROM adp_consensus WHERE season < $1 - 1`, [season]).catch(() => {});

    // 3) RECLAIM DISK. A plain VACUUM only marks space reusable internally — it does NOT return pages to the OS,
    //    so Render's reported size doesn't drop (which is exactly what happened the first time). VACUUM FULL
    //    rewrites the table compactly and returns the freed disk, at the cost of a brief exclusive lock.
    //    IMPORTANT: VACUUM FULL needs free disk ~= the table's size to rewrite. Near a full disk that can fail
    //    for the big table. So we FULL-vacuum adp_consensus FIRST — it's where most reclaimable bloat is (the
    //    sources blob we just blanked), and freeing it creates headroom. Then we attempt the observations
    //    table; if there isn't room it falls back to a plain VACUUM (still frees internally for reuse).
    const vacuumed = [];
    try { await q('VACUUM FULL adp_consensus'); vacuumed.push('adp_consensus (full)'); }
    catch (e) { try { await q('VACUUM adp_consensus'); vacuumed.push('adp_consensus (plain)'); } catch (e2) {} }
    try { await q('VACUUM FULL adp_observations'); vacuumed.push('adp_observations (full)'); }
    catch (e) { try { await q('VACUUM adp_observations'); vacuumed.push('adp_observations (plain)'); } catch (e2) {} }
    try { await q('ANALYZE'); } catch (e) { /* non-fatal */ }

    const after = (await q(`SELECT count(*)::bigint AS n FROM adp_observations WHERE source='sleeper_harvest'`)).rows[0].n;
    const sizeAfter = await sizeOf();
    res.json({
      ok: true, keepDays: days,
      harvestRowsBefore: before, harvestRowsAfter: after, deleted: Number(before) - Number(after),
      consensusSourcesTrimmed: consensusTrimmed, vacuumed,
      sizeBefore, sizeAfter,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------------------------------
// MANUAL RANKINGS (uploaded expert/consensus rankings, e.g. a FantasyPros CSV export)
//
// The frontend parses the CSV in the browser, resolves each row to a player_id (name + position, team as a
// soft tiebreaker), and POSTs a compact list of { player_id, pos, rank } plus the target format selections.
// We convert each rank into an ADP-like observation tagged 'manual_ranking' and let the SAME consensus pipeline
// fold it in — LIGHTLY (see MANUAL_WEIGHT): ~10% nudge where real ADP exists, and the sole signal (gap-fill)
// where it doesn't. Re-uploading the same format replaces the prior ranking. Only rankings within 30 days count.
//
// SCORING TRANSFORM: sources like FantasyPros publish superflex-dynasty rankings in ONE flavor (PPR, standard
// TE). To let those rankings serve a TE-premium / 0.5 / 0 PPR league, we gently adjust the rank of affected
// positions to reflect the target scoring before storing (a subtle TE lift for TEP, light PPR shifts for
// pass-catchers). This is the legitimate inverse of the board's own transform: the source genuinely lacks the
// variant, so we adapt it rather than pretending it matches.

function cfgFromSelections({ type, ppr, tep, qb, teams }) {
  const rec = ppr === 1 || ppr === '1' ? 1 : ppr === 0.5 || ppr === '0.5' ? 0.5 : 0;
  const start = {};
  if (qb === 'SF' || qb === 'superflex') start.SUPER = 1;
  else if (qb === '2QB') start.QB = 2;
  else start.QB = 1;
  return {
    type: type || 'redraft',
    scoring: { rec, recTE: tep ? rec + 0.5 : rec },
    tePremMult: tep ? 0.5 : 0,
    start,
    teams: Number(teams) || 12,
  };
}

// Adjust a PPR-standard-TE source ranking to a target scoring. Ranks are "lower = better", so to move a player
// UP we SUBTRACT from their rank. Subtle by design.
function transformRanks(rows, { tep, ppr }) {
  // Build positional order so we can nudge within a position without scrambling everything.
  const out = rows.map((r) => ({ ...r }));
  // TE-premium: lift the top TEs a little (they gain most from premium), fading down the position.
  if (tep) {
    const tes = out.filter((r) => r.pos === 'TE').sort((a, b) => a.rank - b.rank);
    tes.forEach((r, i) => {
      const lift = Math.max(0, 6 - i * 0.8);   // TE1 ~6 spots, fading, ~0 by TE8 — SUBTLE
      r.rank = Math.max(1, r.rank - lift);
    });
  }
  // PPR level: pass-catchers (WR/TE) gain value with more PPR; RBs relatively lose a touch. Source is PPR(1.0),
  // so for 0.5 and 0 we GENTLY push pass-catchers down and nudge RBs up. Small effects.
  const rec = ppr === 1 || ppr === '1' ? 1 : ppr === 0.5 || ppr === '0.5' ? 0.5 : 0;
  if (rec < 1) {
    const drop = rec === 0 ? 1.0 : 0.5;        // 0 PPR moves more than 0.5 PPR
    for (const r of out) {
      if (r.pos === 'WR') r.rank += 3 * drop;   // WRs slide back a little without full PPR
      else if (r.pos === 'TE') r.rank += 2 * drop;
      else if (r.pos === 'RB') r.rank = Math.max(1, r.rank - 2 * drop); // RBs gain
    }
  }
  return out;
}

async function ensureManualTable() {
  await q(`CREATE TABLE IF NOT EXISTS manual_rankings (
    id           SERIAL PRIMARY KEY,
    format_key   TEXT NOT NULL,
    season       INTEGER NOT NULL,
    label        TEXT,
    source_name  TEXT,
    player_count INTEGER,
    created_by   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (format_key, season)
  )`);
}

// List uploaded rankings (most recent first).
adminRouter.get('/manual-rankings', async (_req, res) => {
  await ensureManualTable();
  const { rows } = await q(
    `SELECT id, format_key, season, label, source_name, player_count, created_by, created_at
       FROM manual_rankings ORDER BY created_at DESC LIMIT 100`
  );
  res.json(rows);
});

// Upload a ranking. Body: { players: [{player_id, pos, rank}], type, ppr, tep, qb, teams, label, sourceName, date }
adminRouter.post('/manual-rankings', async (req, res) => {
  await ensureManualTable();
  const b = req.body || {};
  const players = Array.isArray(b.players) ? b.players : [];
  if (!players.length) return res.status(400).json({ error: 'no players in ranking' });

  const cfg = cfgFromSelections(b);
  const fkey = buildFormatKey(cfg);
  const season = Number(b.season) || config.activeSeason;
  const when = b.date ? new Date(b.date) : new Date();
  if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'invalid date' });

  // Apply the subtle scoring transform for the target format.
  const transformed = transformRanks(
    players.filter((p) => p.player_id && p.rank != null).map((p) => ({ player_id: p.player_id, pos: p.pos, rank: Number(p.rank) })),
    { tep: !!b.tep, ppr: b.ppr }
  );

  // Replace any prior ranking for this exact format: delete its observations, then re-insert.
  await q(`DELETE FROM adp_observations WHERE format_key=$1 AND season=$2 AND source_type='manual_ranking'`, [fkey, season]);
  await q(`DELETE FROM manual_rankings WHERE format_key=$1 AND season=$2`, [fkey, season]);

  const MANUAL_WEIGHT = 4;
  let written = 0;
  for (const p of transformed) {
    await q(
      `INSERT INTO adp_observations (player_id, format_key, season, source, source_type, pick, weight, observed_at)
       VALUES ($1,$2,$3,$4,'manual_ranking',$5,$6,$7)`,
      [p.player_id, fkey, season, `manual:${b.sourceName || 'upload'}`, p.rank, MANUAL_WEIGHT, when.toISOString()]
    );
    written++;
  }
  await q(
    `INSERT INTO manual_rankings (format_key, season, label, source_name, player_count, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [fkey, season, b.label || null, b.sourceName || 'upload', written, req.user?.email || 'admin']
  );
  res.json({ ok: true, formatKey: fkey, season, playersWritten: written, note: 'Run Update Sleeper ADP (or wait for the nightly refresh) to fold this into the board.' });
});

// Delete a ranking (and its observations).
adminRouter.delete('/manual-rankings/:id', async (req, res) => {
  await ensureManualTable();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
  const { rows } = await q(`SELECT format_key, season FROM manual_rankings WHERE id=$1`, [id]);
  if (rows[0]) {
    await q(`DELETE FROM adp_observations WHERE format_key=$1 AND season=$2 AND source_type='manual_ranking'`, [rows[0].format_key, rows[0].season]);
    await q(`DELETE FROM manual_rankings WHERE id=$1`, [id]);
  }
  res.json({ ok: true, note: 'Ranking removed. Run a refresh to update the board.' });
});
