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

/* ⭐⭐⭐⭐ "IT'S SAYING I MUST SIGN IN, BUT I'M SIGNED IN."
 *
 * Trey hit this trying to comp a free user from the Admin screen. Every request that arrives without a
 * usable `req.user` answered with the same four words — "Sign in required" — and there are FOUR quite
 * different reasons that can happen:
 *
 *   1. no token was sent at all              → really is signed out (on this device)
 *   2. the token is expired or unparseable   → was signed in, isn't any more; the client must re-auth
 *   3. the token is fine but the row is gone → the account no longer exists
 *   4. THE LOOKUP THREW                      → the database didn't answer; we have no idea who they are
 *
 * The fourth is the one that made the message a lie. `attachUser` swallowed every error from the user
 * lookup and called next() with no user — so a Postgres hiccup, a cold pool, or the suspended-database
 * state this project has actually been in before came out the other end as "Sign in required," which is
 * an accusation about the USER rather than a report about the SERVER. It sends you to re-enter a
 * password that was never the problem, and if you do re-authenticate, the sign-in fails too — for the
 * same hidden reason, with a different misleading message.
 *
 * So: record WHY identity is missing, and let the guards say the true thing. A failed lookup is now a
 * 503 that names the database; an expired session is a 401 carrying a code the client can act on by
 * clearing its dead token instead of showing an admin screen it can no longer use.
 *
 * ⚠ The swallow itself was right and stays: an anonymous-safe route must not 500 because the user table
 *   was briefly unreachable. What was wrong was throwing the REASON away.
 */
export const AUTH = {
  OK: 'ok',                   // req.user is set
  ANON: 'anon',               // no token presented
  EXPIRED: 'expired',         // token present but expired / invalid / its account is gone
  UNAVAILABLE: 'unavailable', // we could not find out — the lookup failed
};

// Express middleware: attach req.user (full row) if a valid token is present. Does not block, and never
// throws — a transient DB hiccup on the lookup must not 500 an otherwise-anonymous-safe request.
// `lookup` is injectable so the four states above can be tested without a database.
export function makeAttachUser(lookup) {
  return async function attachUser(req, _res, next) {
    const hdr = req.headers.authorization || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
    if (!token) { req.authState = AUTH.ANON; return next(); }
    const payload = verifyToken(token);
    if (!payload?.uid) { req.authState = AUTH.EXPIRED; return next(); }
    try {
      const row = await lookup(payload.uid);
      if (row) { req.user = row; req.authState = AUTH.OK; }
      else req.authState = AUTH.EXPIRED;   // token verifies, account doesn't exist — deleted, or wrong DB
    } catch (e) {
      // ⚠ NOT "expired". We did not learn that this session is dead; we learned nothing at all.
      req.authState = AUTH.UNAVAILABLE;
      req.authError = e;
    }
    next();
  };
}

export const attachUser = makeAttachUser(async (uid) => {
  const { rows } = await q('SELECT * FROM users WHERE id=$1', [uid]);
  return rows[0] || null;
});

/* The one place that turns "no req.user" into an answer. Returns null when the request is authenticated,
   otherwise the exact status and body to send. Every guard goes through it so the four cases can never
   drift apart between them. `code` is for the client: SESSION_EXPIRED means "your token is dead, throw
   it away and ask for a password"; AUTH_UNAVAILABLE means "do NOT sign the user out — try again." */
export function authProblem(req) {
  if (req.user) return null;
  if (req.authState === AUTH.UNAVAILABLE) {
    return {
      status: 503,
      body: {
        error: "We couldn't check your sign-in just now — the account database didn't answer. Nothing is wrong with your account; wait a few seconds and try again.",
        code: 'AUTH_UNAVAILABLE',
      },
    };
  }
  if (req.authState === AUTH.EXPIRED) {
    return {
      status: 401,
      body: { error: 'Your sign-in has expired on this device. Sign in again to continue.', code: 'SESSION_EXPIRED' },
    };
  }
  return { status: 401, body: { error: 'Sign in required', code: 'NO_SESSION' } };
}

const deny = (req, res) => {
  const p = authProblem(req);
  if (!p) return null;
  res.status(p.status).json(p.body);
  return true;
};

// Require a logged-in user.
export function requireAuth(req, res, next) {
  if (deny(req, res)) return;
  next();
}

// Require admin — checked against the DB row AND the server allowlist (defense in depth).
export function requireAdmin(req, res, next) {
  if (deny(req, res)) return;
  if (!req.user.is_admin || !isAdminEmail(req.user.email)) {
    return res.status(403).json({ error: 'Admin only', code: 'NOT_ADMIN' });
  }
  next();
}

// Require an active paid (or comped) subscription. Admins always pass (for testing/support).
export function requirePaid(req, res, next) {
  if (deny(req, res)) return;
  const isAdmin = req.user.is_admin || isAdminEmail(req.user.email);
  const active = isAdmin || req.user.comp || (req.user.paid_until && new Date(req.user.paid_until) > new Date());
  if (!active) return res.status(402).json({ error: 'Season pass required', code: 'PASS_REQUIRED' });
  next();
}
