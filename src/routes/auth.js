// Auth routes: sign up, sign in, and "who am I". Server sets admin from the allowlist — never
// from anything the client sends.
import { Router } from 'express';
import { z } from 'zod';
import { q } from '../lib/db.js';
import { config, isAdminEmail } from '../lib/config.js';
import { hashPassword, checkPassword, signToken, requireAuth } from '../lib/auth.js';

export const authRouter = Router();

const cred = z.object({ email: z.string().email(), password: z.string().min(6) });

authRouter.post('/signup', async (req, res) => {
  const parsed = cred.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Valid email and 6+ char password required' });
  const email = parsed.data.email.trim().toLowerCase();
  const { rows: existing } = await q('SELECT id FROM users WHERE email=$1', [email]);
  if (existing[0]) return res.status(409).json({ error: 'An account with that email already exists' });
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
  const { rows } = await q(
    `UPDATE users SET rank_sets=$1::jsonb WHERE id=$2 RETURNING *`, [json, req.user.id]
  );
  res.json({ user: publicUser(rows[0]) });
});

function publicUser(u) {
  const disabled = !!u.disabled;
  const paidActive = !disabled && (u.comp || (u.paid_until && new Date(u.paid_until) > new Date()));
  return {
    id: u.id, email: u.email, admin: !!u.is_admin && !disabled,
    paid: !!paidActive, paidUntil: u.paid_until, comp: !!u.comp, disabled,
    rankSets: u.rank_sets || [],
  };
}
