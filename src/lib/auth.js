// Authentication + authorization. JWT-based. The SERVER is the real authority on admin and
// paid status — never trust the client. (The front-end gates are just UX.)
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config, isAdminEmail } from './config.js';
import { q } from './db.js';

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}
export async function checkPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

export function signToken(user) {
  return jwt.sign(
    { uid: user.id, email: user.email, admin: !!user.is_admin },
    config.jwtSecret,
    { expiresIn: config.jwtExpires }
  );
}

export function verifyToken(token) {
  try { return jwt.verify(token, config.jwtSecret); }
  catch { return null; }
}

// Express middleware: attach req.user (full row) if a valid token is present. Does not block, and never
// throws — a transient DB hiccup on the lookup must not 500 an otherwise-anonymous-safe request.
export async function attachUser(req, _res, next) {
  try {
    const hdr = req.headers.authorization || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
    const payload = token ? verifyToken(token) : null;
    if (payload?.uid) {
      const { rows } = await q('SELECT * FROM users WHERE id=$1', [payload.uid]);
      if (rows[0]) req.user = rows[0];
    }
  } catch (e) {
    // Leave req.user unset; downstream requireAuth will handle it as unauthenticated rather than crashing.
  }
  next();
}

// Require a logged-in user.
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  next();
}

// Require admin — checked against the DB row AND the server allowlist (defense in depth).
export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  if (!req.user.is_admin || !isAdminEmail(req.user.email)) {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

// Require an active paid (or comped) subscription. Admins always pass (for testing/support).
export function requirePaid(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  const isAdmin = req.user.is_admin || isAdminEmail(req.user.email);
  const active = isAdmin || req.user.comp || (req.user.paid_until && new Date(req.user.paid_until) > new Date());
  if (!active) return res.status(402).json({ error: 'Season pass required' });
  next();
}
