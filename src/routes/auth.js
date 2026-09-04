// Auth routes: sign up, sign in, "who am I", and password reset. Server sets admin from the allowlist —
// never from anything the client sends.
import { Router } from 'express';
import { z } from 'zod';
import { q } from '../lib/db.js';
import { config, isAdminEmail } from '../lib/config.js';
import { hashPassword, checkPassword, signToken, requireAuth } from '../lib/auth.js';
import crypto from 'node:crypto';

export const authRouter = Router();

const cred = z.object({ email: z.string().email(), password: z.string().min(6) });

authRouter.post('/signup', async (req, res) => {
  const parsed = cred.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Valid email and 6+ char password required' });
  const email = parsed.data.email.trim().toLowerCase();
  const { rows: existing } = await q('SELECT id FROM users WHERE email=$1', [email]);
  /* A CODE, NOT JUST A SENTENCE. The client needs to offer the two things that actually help here — sign in
     instead, or reset the password — and keying that off English prose would break the moment the wording
     changed. This is the exact case a beta user hit: an account had been created FOR him, so signing up was
     always going to collide, and "already exists" on its own leaves him nowhere to go. */
  if (existing[0]) return res.status(409).json({ error: 'An account with that email already exists', code: 'EMAIL_EXISTS' });
  const hash = await hashPassword(parsed.data.password);
  const admin = isAdminEmail(email); // SERVER decides admin
  // Apply a pending free-access invite, if one exists for this email.
  const { rows: inv } = await q('SELECT scope FROM comp_invites WHERE email=$1', [email]);
  let paidUntil = null, comp = false;
  if (inv[0]) {
    comp = true;
    paidUntil = inv[0].scope === 'forever' ? new Date('9999-01-01') : new Date(config.leagueYearCutoff);
  }
  const { rows } = await q(
    `INSERT INTO users (email, password_hash, is_admin, comp, paid_until) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [email, hash, admin, comp, paidUntil]
  );
  if (inv[0]) await q('DELETE FROM comp_invites WHERE email=$1', [email]); // consume the invite
  const user = rows[0];
  res.json({ token: signToken(user), user: publicUser(user) });
});

authRouter.post('/signin', async (req, res) => {
  const parsed = cred.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid credentials' });
  const email = parsed.data.email.trim().toLowerCase();
  const { rows } = await q('SELECT * FROM users WHERE email=$1', [email]);
  const user = rows[0];
  if (!user || !(await checkPassword(parsed.data.password, user.password_hash))) {
    return res.status(401).json({ error: 'Email or password is incorrect' });
  }
  // re-sync admin flag in case the allowlist changed
  if (user.is_admin !== isAdminEmail(email)) {
    await q('UPDATE users SET is_admin=$1 WHERE id=$2', [isAdminEmail(email), user.id]);
    user.is_admin = isAdminEmail(email);
  }
  res.json({ token: signToken(user), user: publicUser(user) });
});

// ---- PASSWORD RESET -----------------------------------------------------------------------------
// This existed as a button in the app that set a local flag and told the user "a reset link is on its
// way". No request was made and no email was ever sent, so anyone who forgot their password was locked
// out of a paid account with no way back in. This is the real thing.
//
// Design notes:
//  · The token is random, and only its SHA-256 hash is stored. A leaked database row cannot be replayed.
//  · /forgot always answers 200 with the same body whether or not the address exists — otherwise the
//    endpoint doubles as a "does this person have an account here" oracle.
//  · Tokens are single-use and expire in 30 minutes (the app already promises 30 minutes).
//  · If mail isn't configured the endpoint says so plainly instead of claiming an email was sent. A
//    silent no-op here is exactly the bug being fixed.
const RESET_TTL_MIN = 30;
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

let resetTableEnsured = false;
async function ensureResetTable() {
  if (resetTableEnsured) return;
  await q(`CREATE TABLE IF NOT EXISTS password_resets (
    token_hash  TEXT PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT now()
  );`);
  await q('CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets(user_id);');
  resetTableEnsured = true;
}

async function sendResetEmail(to, link) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.BRIEF_FROM || process.env.FEEDBACK_FROM;
  if (!key || !from) return false;
  const text = [
    'Someone asked to reset the Fantasy Draft Compass password for this address.',
    '',
    link,
    '',
    `This link works once and expires in ${RESET_TTL_MIN} minutes.`,
    "If it wasn't you, ignore this email — nothing has changed and your password still works.",
  ].join('\n');
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject: 'Reset your Fantasy Draft Compass password', text }),
    });
    return res.ok;
  } catch { return false; }
}

authRouter.post('/forgot', async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'A valid email is required' });
  // Mail unconfigured: say so rather than pretending. The user can then reach a human instead of waiting
  // for an email that is never coming.
  if (!process.env.RESEND_API_KEY || !(process.env.BRIEF_FROM || process.env.FEEDBACK_FROM)) {
    return res.status(503).json({ error: 'Password reset email is not configured yet. Use "Report a bug" to reach us and we will reset it by hand.', code: 'MAIL_UNCONFIGURED' });
  }
  try {
    await ensureResetTable();
    const { rows } = await q('SELECT id, email FROM users WHERE email=$1', [email]);
    const user = rows[0];
    if (user) {
      // One live token per person: asking again invalidates the previous link.
      await q('DELETE FROM password_resets WHERE user_id=$1', [user.id]);
      const token = crypto.randomBytes(32).toString('hex');
      await q(
        `INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1,$2, now() + ($3 || ' minutes')::interval)`,
        [hashToken(token), user.id, String(RESET_TTL_MIN)]
      );
      const base = process.env.APP_URL || 'https://www.fantasydraftcompass.com';
      await sendResetEmail(user.email, `${base}/?reset=${token}`);
    }
    // Same answer either way — never confirm or deny that an account exists.
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not start a password reset. Try again in a moment.' });
  }
});

authRouter.post('/reset', async (req, res) => {
  const token = String((req.body && req.body.token) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (!token) return res.status(400).json({ error: 'Missing reset token' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    await ensureResetTable();
    const { rows } = await q(
      `SELECT pr.token_hash, pr.user_id, pr.expires_at, pr.used_at, u.*
         FROM password_resets pr JOIN users u ON u.id = pr.user_id
        WHERE pr.token_hash=$1`, [hashToken(token)]);
    const row = rows[0];
    // One message for every failure mode: unknown, already used, expired. Distinguishing them tells an
    // attacker which of their guesses was once a real token.
    if (!row || row.used_at || new Date(row.expires_at) <= new Date()) {
      return res.status(400).json({ error: 'That reset link is invalid or has expired. Request a new one.' });
    }
    const hash = await hashPassword(password);
    await q('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, row.user_id]);
    await q('UPDATE password_resets SET used_at=now() WHERE token_hash=$1', [hashToken(token)]);
    // Sign them straight in — a reset that dumps you back at a login form is a worse experience for no gain.
    const { rows: fresh } = await q('SELECT * FROM users WHERE id=$1', [row.user_id]);
    const user = fresh[0];
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (e) {
    res.status(500).json({ error: 'Could not reset the password. Try again in a moment.' });
  }
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// Persist the user's personal ranking sets (their custom boards). Stored on the user row so they
// survive across sessions/devices.
authRouter.post('/rank-sets', requireAuth, async (req, res) => {
  const sets = Array.isArray(req.body.rankSets) ? req.body.rankSets : [];
  // basic guard: cap size so a runaway payload can't bloat the row
  const json = JSON.stringify(sets);
  if (json.length > 2_000_000) return res.status(413).json({ error: 'rankings too large' });

  // ⭐ PLATFORM RANKS RIDE ALONG. They had NO server home at all — they lived only on the browser's copy of
  // the user record, which every page load then overwrote with the server's copy. So a user's hand-entered
  // league ADP was destroyed on reload and there was nowhere for it to come back from. Same jsonb treatment
  // as rank sets, and the column creates itself because db/schema.sql is only applied by a manual migrate.
  const hasPr = req.body.platformRanks && typeof req.body.platformRanks === 'object';
  if (hasPr) {
    try { await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_ranks jsonb;`); } catch { /* reported below */ }
  }
  let rows;
  if (hasPr) {
    const prJson = JSON.stringify(req.body.platformRanks);
    if (prJson.length > 2_000_000) return res.status(413).json({ error: 'platform ranks too large' });
    ({ rows } = await q(
      `UPDATE users SET rank_sets=$1::jsonb, platform_ranks=$2::jsonb WHERE id=$3 RETURNING *`,
      [json, prJson, req.user.id]
    ));
  } else {
    ({ rows } = await q(`UPDATE users SET rank_sets=$1::jsonb WHERE id=$2 RETURNING *`, [json, req.user.id]));
  }
  res.json({ user: publicUser(rows[0]) });
});

function publicUser(u) {
  const disabled = !!u.disabled;
  const paidActive = !disabled && (u.comp || (u.paid_until && new Date(u.paid_until) > new Date()));
  return {
    id: u.id, email: u.email, admin: !!u.is_admin && !disabled,
    paid: !!paidActive, paidUntil: u.paid_until, comp: !!u.comp, disabled,
    rankSets: u.rank_sets || [],
    platformRanks: u.platform_ranks || {},
    sleeperUserId: u.sleeper_user_id || null,
    sleeperUsername: u.sleeper_username || null,
  };
}
