// Per-user app-state blob. Mirrors the client's local "gs-state" (leagues, picks, preds, priority
// queues, mocks, feedback) so a user's data follows them across devices and survives sign-out.
//
// Design notes:
//  - One row per user, a single JSONB blob. This intentionally mirrors the client's existing
//    local-first shape rather than re-modeling leagues/drafts relationally, so the change is small
//    and low-risk: the client keeps working exactly as before, we just also sync the blob.
//  - Last-write-wins. The client merges against the freshest stored copy before writing, so normal
//    single-user usage across devices is safe. We expose updated_at so the client can prefer the
//    newer of {server, local} on load.
//  - The table is created lazily here (idempotent) so a fresh deploy doesn't require a manual
//    migration step before this endpoint works.
import { Router } from 'express';
import { q } from '../lib/db.js';
import { requireAuth, requirePaid } from '../lib/auth.js';

export const stateRouter = Router();
stateRouter.use(requireAuth);
stateRouter.use(requirePaid); // cross-device state sync requires a pass or comp

let ensured = false;
async function ensureTable() {
  if (ensured) return;
  await q(`CREATE TABLE IF NOT EXISTS user_state (
    user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    state       JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ DEFAULT now()
  )`);
  ensured = true;
}

// GET /api/state -> { state, updatedAt } (state may be {} for a new user)
stateRouter.get('/', async (req, res) => {
  try {
    await ensureTable();
    const { rows } = await q('SELECT state, updated_at FROM user_state WHERE user_id=$1', [req.user.id]);
    if (!rows[0]) return res.json({ state: {}, updatedAt: null });
    res.json({ state: rows[0].state || {}, updatedAt: rows[0].updated_at });
  } catch (e) {
    res.status(500).json({ error: 'Could not load state' });
  }
});

// PUT /api/state { state, baseUpdatedAt? } -> { ok, updatedAt } | 409 { error, serverUpdatedAt, state }
// Stores the whole blob (upsert) with two safety guards against DATA LOSS:
//   1) Optimistic concurrency: if the client sends baseUpdatedAt (the updated_at it last loaded) and the
//      stored row is NEWER, we reject with 409 and return the server's current state so the client can
//      merge and retry — this prevents a stale second device from silently clobbering fresher data.
//   2) Empty-overwrite guard: we never let a materially-empty blob overwrite a populated one (a common
//      "lost all my leagues" failure when a client boots blank and auto-saves before hydrating).
stateRouter.put('/', async (req, res) => {
  try {
    await ensureTable();
    const state = (req.body && typeof req.body.state === 'object' && req.body.state) ? req.body.state : {};
    const baseUpdatedAt = req.body && req.body.baseUpdatedAt ? new Date(req.body.baseUpdatedAt) : null;
    const json = JSON.stringify(state);
    if (json.length > 4 * 1024 * 1024) return res.status(413).json({ error: 'State too large' });

    // Read the current stored row once so we can run both guards.
    const cur = await q('SELECT state, updated_at FROM user_state WHERE user_id=$1', [req.user.id]);
    const existing = cur.rows[0];

    if (existing) {
      // Guard 1: reject stale writes (client's base is older than what's stored).
      if (baseUpdatedAt && existing.updated_at && new Date(existing.updated_at) > baseUpdatedAt) {
        return res.status(409).json({
          error: 'Newer data on server',
          serverUpdatedAt: existing.updated_at,
          state: existing.state || {},
        });
      }
      // Guard 2: don't let an essentially-empty incoming blob wipe a populated stored one.
      const incomingLeagues = Array.isArray(state.leagues) ? state.leagues.length : 0;
      const storedLeagues = existing.state && Array.isArray(existing.state.leagues) ? existing.state.leagues.length : 0;
      const incomingEmpty = incomingLeagues === 0 && (!state.funMocks || state.funMocks.length === 0);
      if (incomingEmpty && storedLeagues > 0) {
        // Nothing meaningful to save and we'd be destroying data — treat as a no-op success so the client
        // doesn't error, but keep the good stored copy and hand it back.
        return res.json({ ok: true, updatedAt: existing.updated_at, state: existing.state, kept: true });
      }
    }

    const { rows } = await q(
      `INSERT INTO user_state (user_id, state, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (user_id) DO UPDATE SET state=EXCLUDED.state, updated_at=now()
       RETURNING updated_at`,
      [req.user.id, json]
    );
    res.json({ ok: true, updatedAt: rows[0].updated_at });
  } catch (e) {
    res.status(500).json({ error: 'Could not save state' });
  }
});
