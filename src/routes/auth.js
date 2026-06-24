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
  const { rows } = await q(
    `INSERT INTO users (email, password_hash, is_admin) VALUES ($1,$2,$3) RETURNING *`,
    [email, hash, admin]
  );
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

function publicUser(u) {
  const paidActive = u.comp || (u.paid_until && new Date(u.paid_until) > new Date());
  return {
    id: u.id, email: u.email, admin: !!u.is_admin,
    paid: !!paidActive, paidUntil: u.paid_until, comp: !!u.comp,
    rankSets: u.rank_sets || [],
  };
}
