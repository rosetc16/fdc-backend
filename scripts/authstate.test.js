/* THE FOUR REASONS YOU CAN LOOK SIGNED OUT, AND WHY THEY MUST NOT SHARE A MESSAGE.
 *
 * Trey: "It's not letting me add free / comp users to the site from the admin side. It's saying I must
 * sign in, but I'm signed in."
 *
 * Both halves of that sentence were true. The admin screen renders off locally persisted state (the
 * `admin` flag is recomputed from the email allowlist in the browser, with no token involved), so the app
 * can be perfectly certain you are signed in while the SERVER has no idea who you are. And the server had
 * exactly one sentence for four situations, one of which — the database not answering — is not about the
 * user at all. Told "sign in", you sign in; if the lookup is what's broken, that fails too, and now two
 * things are lying to you at once.
 *
 * ⚠ THE TEST THAT MATTERS IS §4. Everything else here is bookkeeping; the bug was that a THROWN lookup
 *   produced the same 401 as a missing token. A 401 tells the client to throw its credentials away, which
 *   is the one irreversible thing to do when the truth is "ask again in five seconds."
 */
import assert from 'assert';
import { makeAttachUser, authProblem, requireAuth, requireAdmin, requirePaid, AUTH, signToken } from '../src/lib/auth.js';

let n = 0;
const ok = (m) => { n++; console.log('  PASS  ' + m); };

// A request/response pair thin enough to see through.
const mkRes = () => {
  const r = { statusCode: null, body: null };
  r.status = (s) => { r.statusCode = s; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};
const run = async (mw, req) => {
  const res = mkRes();
  let nexted = false;
  await mw(req, res, () => { nexted = true; });
  return { res, nexted };
};

const ADMIN_EMAIL = process.env.ADMIN_EMAILS ? String(process.env.ADMIN_EMAILS).split(',')[0].trim() : null;

// ---- 1 · no token at all ---------------------------------------------------------------------------
{
  const attach = makeAttachUser(async () => { throw new Error('must not be called'); });
  const req = { headers: {} };
  await run(attach, req);
  assert.strictEqual(req.authState, AUTH.ANON);
  const p = authProblem(req);
  assert.strictEqual(p.status, 401);
  assert.strictEqual(p.code || p.body.code, 'NO_SESSION');
  ok('1 · no Authorization header is an anonymous request — 401 NO_SESSION, and no lookup is attempted');
}

// ---- 2 · a token that does not verify ---------------------------------------------------------------
{
  const attach = makeAttachUser(async () => { throw new Error('must not be called'); });
  const req = { headers: { authorization: 'Bearer not.a.jwt' } };
  await run(attach, req);
  assert.strictEqual(req.authState, AUTH.EXPIRED);
  const p = authProblem(req);
  assert.strictEqual(p.status, 401);
  assert.strictEqual(p.body.code, 'SESSION_EXPIRED');
  // ⚠ The wording has to tell the user which of the two things to do. "Sign in required" reads as "you
  //   never signed in", which is precisely the sentence Trey disagreed with — and he was right.
  assert.match(p.body.error, /expired/i, 'an expired session must say it expired');
  ok('2 · ⭐⭐ an unverifiable token reads as EXPIRED, not as "you never signed in"');
}

// ---- 3 · a good token whose account is gone ---------------------------------------------------------
{
  const attach = makeAttachUser(async () => null);   // row genuinely absent
  const req = { headers: { authorization: `Bearer ${signToken({ id: 7, email: 'x@y.com', is_admin: false })}` } };
  await run(attach, req);
  assert.strictEqual(req.authState, AUTH.EXPIRED, 'a deleted account is a dead session, and the client should clear its token');
  assert.strictEqual(authProblem(req).status, 401);
  ok('3 · a verified token with no surviving row is a dead session (401), not a server fault');
}

// ---- 4 · ⭐⭐⭐⭐ THE LOOKUP THREW — we learned nothing, so we accuse nobody ---------------------------
{
  const attach = makeAttachUser(async () => { const e = new Error('terminating connection due to administrator command'); e.code = '57P01'; throw e; });
  const req = { headers: { authorization: `Bearer ${signToken({ id: 7, email: 'x@y.com', is_admin: true })}` } };
  const { nexted } = await run(attach, req);
  assert.ok(nexted, 'an anonymous-safe route must still be reachable — the swallow itself was correct');
  assert.strictEqual(req.authState, AUTH.UNAVAILABLE);

  const p = authProblem(req);
  assert.strictEqual(p.status, 503, 'a database that will not answer is 503, not 401');
  assert.strictEqual(p.body.code, 'AUTH_UNAVAILABLE');
  assert.ok(!/sign in required/i.test(p.body.error), 'must not tell the user to do the one thing that cannot help');
  assert.match(p.body.error, /database/i, 'name the actual thing that failed');

  // And all three guards agree, because a route that gets this wrong signs the user out for a DB blip.
  for (const [name, guard] of [['requireAuth', requireAuth], ['requireAdmin', requireAdmin], ['requirePaid', requirePaid]]) {
    const res = mkRes();
    guard({ ...req }, res, () => { throw new Error(`${name} let an unidentified request through`); });
    assert.strictEqual(res.statusCode, 503, `${name} must answer 503 when identity is unknown`);
    assert.strictEqual(res.body.code, 'AUTH_UNAVAILABLE', `${name} must carry the do-not-sign-out code`);
  }
  ok('4 · ⭐⭐⭐⭐ a failed user lookup is 503 AUTH_UNAVAILABLE from every guard — never "Sign in required"');
}

// ---- 5 · the happy path is untouched ----------------------------------------------------------------
{
  const row = { id: 7, email: 'x@y.com', is_admin: false, comp: true, paid_until: null };
  const attach = makeAttachUser(async (uid) => (uid === 7 ? row : null));
  const req = { headers: { authorization: `Bearer ${signToken(row)}` } };
  await run(attach, req);
  assert.strictEqual(req.user, row);
  assert.strictEqual(authProblem(req), null);
  const { nexted } = await run(requireAuth, req);
  assert.ok(nexted, 'a signed-in request still passes');
  // Comped, so the pass gate opens too — this is the very entitlement the admin screen grants.
  const paid = await run(requirePaid, req);
  assert.ok(paid.nexted, 'a comped account has an active pass');
  ok('5 · a real session still passes every guard, and a comp still counts as a pass');
}

// ---- 6 · signed in but not an admin is a different answer entirely -----------------------------------
{
  const req = { user: { id: 8, email: 'someone@else.com', is_admin: false }, authState: AUTH.OK };
  const res = mkRes();
  requireAdmin(req, res, () => { throw new Error('non-admin reached an admin route'); });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.body.code, 'NOT_ADMIN');
  ok('6 · a signed-in non-admin gets 403 NOT_ADMIN — never a sign-in prompt');
}

// ---- 7 · the allowlist is still the second lock ------------------------------------------------------
{
  if (ADMIN_EMAIL) {
    const req = { user: { id: 9, email: ADMIN_EMAIL, is_admin: true }, authState: AUTH.OK };
    const { nexted } = await run(requireAdmin, req);
    assert.ok(nexted, 'an allowlisted admin row passes');
    // The flag alone is not enough: a stolen or hand-edited row still has to be on the server allowlist.
    const forged = { user: { id: 10, email: 'attacker@example.com', is_admin: true }, authState: AUTH.OK };
    const res = mkRes();
    requireAdmin(forged, res, () => { throw new Error('is_admin alone opened the admin routes'); });
    assert.strictEqual(res.statusCode, 403);
    ok('7 · is_admin AND the server allowlist are both required — the flag alone opens nothing');
  } else {
    ok('7 · (skipped — no ADMIN_EMAILS configured in this environment)');
  }
}

console.log(`\n${n}/${n} auth-state checks passed`);
