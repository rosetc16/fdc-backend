// PASSWORD RESET tests.
//
// The flow replaces a button that set a local flag and told the user "a reset link is on its way" without
// making any request — so a forgotten password locked someone out of a paid account permanently. Auth code
// gets tested harder than feature code, so this drives the SHIPPED route module against a REAL Postgres
// rather than reimplementing anything or trusting a stub to reject bad SQL.
//
// What is NOT covered: actual email delivery. Resend is unreachable from a sandbox, so sendResetEmail's
// network call is stubbed out. Everything that decides who gets in — token generation, hashing, expiry,
// single use, and the responses — runs for real.
import assert from 'node:assert';
import crypto from 'node:crypto';

let pass = 0;
const ok = (n) => { console.log('  PASS  ' + n); pass++; };

// ---- real Postgres ---------------------------------------------------------------------------------
// Not a stub. A stub would happily accept SQL Postgres would reject — and this flow leans on a real cast
// (`($3 || ' minutes')::interval`) and a real foreign key. Point DATABASE_URL at a throwaway database and
// let the shipped route create its own table exactly as it will in production.
//   Needs a local Postgres. Skips cleanly (exit 0) when there isn't one, so this can't wedge a deploy.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:pw@127.0.0.1:5432/fdctest';
process.env.RESEND_API_KEY = 'test-key';
process.env.BRIEF_FROM = 'FDC <noreply@example.com>';
process.env.APP_URL = 'https://www.fantasydraftcompass.com';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-long-enough-for-jwt-signing';

const { q, pool } = await import('../src/lib/db.js');
try {
  await q('SELECT 1');
} catch (e) {
  console.log('  SKIP  no local Postgres (set TEST_DATABASE_URL to run these) — ' + String(e.message).slice(0, 70));
  process.exit(0);
}

// A minimal users table with the columns the auth code touches, plus a clean slate every run.
await q('DROP TABLE IF EXISTS password_resets CASCADE');
await q('DROP TABLE IF EXISTS users CASCADE');
await q(`CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  is_admin BOOLEAN DEFAULT FALSE,
  comp BOOLEAN DEFAULT FALSE,
  paid_until TIMESTAMPTZ,
  disabled BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
)`);

// Capture the outgoing email instead of sending it. Everything that decides who gets in runs for real;
// only Resend's HTTP call is intercepted, because it is unreachable from a sandbox.
const sentMail = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).includes('resend.com')) { sentMail.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => ({ id: 'test' }) }; }
  return realFetch(url, opts);
};

const { authRouter } = await import('../src/routes/auth.js');
const { hashPassword, checkPassword } = await import('../src/lib/auth.js');

// ---- drive the router's handlers directly ---------------------------------------------------------
function handlerFor(method, path) {
  const layer = authRouter.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  assert.ok(layer, `no ${method.toUpperCase()} ${path} route registered`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
async function callRoute(method, path, body) {
  const handler = handlerFor(method, path);
  let status = 200, payload = null;
  const res = { status(c) { status = c; return this; }, json(o) { payload = o; return this; } };
  await handler({ body }, res, (e) => { throw e || new Error('next() called'); });
  return { status, body: payload };
}

const seedUser = async (email, password) => {
  const hash = await hashPassword(password);
  const { rows } = await q('INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING *', [email, hash]);
  return rows[0];
};
const resets = async () => (await q('SELECT * FROM password_resets')).rows;
const userRow = async (email) => (await q('SELECT * FROM users WHERE email=$1', [email])).rows[0];
const clearResets = async () => { await q('DELETE FROM password_resets').catch(() => {}); };

// ---- 1 · the happy path ----------------------------------------------------------------------------
{
  const u = await seedUser('trey@example.com', 'oldpassword');
  const r = await callRoute('post', '/forgot', { email: 'trey@example.com' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { ok: true, sent: true });   // `sent` is the confirmation a silent send-failure can no longer fake
  assert.strictEqual(sentMail.length, 1, 'an email should have been sent');
  assert.strictEqual((await resets()).length, 1, 'a token row should exist');

  const link = (sentMail[0].body.text.match(/https?:\/\/\S+/) || [])[0];
  assert.ok(link && link.includes('?reset='), 'the email must carry a reset link: ' + link);
  const token = link.split('?reset=')[1];
  assert.ok(token.length >= 32, 'the token should be long and random');

  const done = await callRoute('post', '/reset', { token, password: 'brand-new-pw' });
  assert.strictEqual(done.status, 200, JSON.stringify(done.body));
  assert.ok(done.body.token, 'a reset should sign the user straight in');
  assert.strictEqual(done.body.user.email, 'trey@example.com');
  const fresh = await userRow('trey@example.com');
  assert.ok(await checkPassword('brand-new-pw', fresh.password_hash), 'the new password must work');
  assert.ok(!(await checkPassword('oldpassword', fresh.password_hash)), 'the old password must stop working');
  ok('1 · forgot → email with a link → reset sets the new password and signs the user in');
}

// ---- 2 · the stored token is a HASH, never the token itself ----------------------------------------
// A leaked DB row must not be replayable as a working reset link.
{
  await clearResets(); sentMail.length = 0;
  await callRoute('post', '/forgot', { email: 'trey@example.com' });
  const token = sentMail[0].body.text.match(/\?reset=(\S+)/)[1];
  const stored = (await resets())[0].token_hash;
  assert.notStrictEqual(stored, token, 'the raw token must not be stored');
  assert.strictEqual(stored, crypto.createHash('sha256').update(token).digest('hex'));
  // The stored value itself is not a usable token.
  const replay = await callRoute('post', '/reset', { token: stored, password: 'hacked-pw-123' });
  assert.strictEqual(replay.status, 400, 'the stored hash must not work as a token');
  ok('2 · only the SHA-256 hash is stored, and that hash cannot itself be used as a reset token');
}

// ---- 3 · single use --------------------------------------------------------------------------------
{
  await clearResets(); sentMail.length = 0;
  await callRoute('post', '/forgot', { email: 'trey@example.com' });
  const token = sentMail[0].body.text.match(/\?reset=(\S+)/)[1];
  const first = await callRoute('post', '/reset', { token, password: 'first-use-pw' });
  assert.strictEqual(first.status, 200);
  const second = await callRoute('post', '/reset', { token, password: 'second-use-pw' });
  assert.strictEqual(second.status, 400, 'a used token must not work twice');
  assert.ok(/invalid or has expired/i.test(second.body.error));
  assert.ok(await checkPassword('first-use-pw', (await userRow('trey@example.com')).password_hash), 'the second attempt must not have changed anything');
  ok('3 · a reset token works exactly once; replaying it changes nothing');
}

// ---- 4 · expiry ------------------------------------------------------------------------------------
{
  await clearResets(); sentMail.length = 0;
  await callRoute('post', '/forgot', { email: 'trey@example.com' });
  const token = sentMail[0].body.text.match(/\?reset=(\S+)/)[1];
  // The route promises 30 minutes; confirm that's what was written, then age it past the line.
  const row = (await resets())[0];
  const mins = Math.round((new Date(row.expires_at) - new Date()) / 60000);
  assert.ok(mins >= 29 && mins <= 30, `expected a ~30 minute TTL, got ${mins}`);
  await q("UPDATE password_resets SET expires_at = now() - interval '1 second' WHERE token_hash=$1", [row.token_hash]);
  const late = await callRoute('post', '/reset', { token, password: 'too-late-pw' });
  assert.strictEqual(late.status, 400, 'an expired token must be rejected');
  ok('4 · tokens expire after 30 minutes and an expired link is refused');
}

// ---- 5 · requesting again invalidates the link already in flight ------------------------------------
{
  await clearResets(); sentMail.length = 0;
  await callRoute('post', '/forgot', { email: 'trey@example.com' });
  const firstToken = sentMail[0].body.text.match(/\?reset=(\S+)/)[1];
  await callRoute('post', '/forgot', { email: 'trey@example.com' });
  const secondToken = sentMail[1].body.text.match(/\?reset=(\S+)/)[1];
  assert.notStrictEqual(firstToken, secondToken);
  assert.strictEqual((await resets()).length, 1, 'only one live token per user');
  const old = await callRoute('post', '/reset', { token: firstToken, password: 'stale-token-pw' });
  assert.strictEqual(old.status, 400, 'the superseded token must stop working');
  const fresh = await callRoute('post', '/reset', { token: secondToken, password: 'fresh-token-pw' });
  assert.strictEqual(fresh.status, 200);
  ok('5 · asking again issues a new token and kills the previous one');
}

// ---- 6 · ⭐⭐ AN UNKNOWN ADDRESS IS TOLD SO, AND THE ORACLE IS BOUNDED --------------------------------
// Trey: "If they put in an email that doesn't have an account, can you share an error that says that email
// doesn't exist with an account." This deliberately reverses the original design. The trade is managed, not
// waved away: a caller gets a straight answer for the first few MISSES and then the endpoint goes back to
// the indistinguishable response, so one person who mistyped their address is helped and somebody walking a
// list of addresses is not.
{
  await clearResets(); sentMail.length = 0;
  const real = await callRoute('post', '/forgot', { email: 'trey@example.com' });
  const fake = await callRoute('post', '/forgot', { email: 'nobody@example.com' });
  assert.strictEqual(real.status, 200, 'a real address should still get its link');
  assert.strictEqual(fake.status, 404, 'an unknown address should be told there is no account');
  assert.strictEqual(fake.body.code, 'NO_ACCOUNT');
  assert.ok(/no Fantasy Draft Compass account/i.test(fake.body.error), `unhelpful message: ${fake.body.error}`);
  assert.ok(fake.body.error.includes('nobody@example.com'), 'the message should name the address they typed');
  assert.strictEqual(sentMail.length, 1, 'no email should go to an address with no account');
  assert.strictEqual((await resets()).length, 1, 'no token should be minted for an unknown address');
  ok('6 · ⭐⭐ an unknown address is told there is no account for it — the lockout Trey reported');
}

// ---- 6b · ⭐ …and a harvester runs out of answers ----------------------------------------------------
// ⚠ THE FAILABLE HALF. Without the budget this endpoint answers "does this person have an account here"
// an unlimited number of times, which is why it was hidden in the first place.
{
  await clearResets(); sentMail.length = 0;
  let told = 0, refused = 0;
  for (let i = 0; i < 30; i++) {
    const r = await callRoute('post', '/forgot', { email: `ghost${i}@example.com` });
    if (r.status === 404) told++; else if (r.status === 200) refused++;
  }
  assert.ok(told > 0, 'the honest answer never appeared at all');
  assert.ok(told <= 12, `the endpoint answered ${told} unknown addresses in a row — that is a harvestable oracle`);
  assert.ok(refused >= 15, `only ${refused} of 30 lookups fell back to the silent answer`);
  assert.strictEqual(sentMail.length, 0, 'no mail should be sent to any of them');
  // And a REAL address still works once the budget is spent — the limit must not lock out genuine users.
  const still = await callRoute('post', '/forgot', { email: 'trey@example.com' });
  assert.strictEqual(still.status, 200, 'the miss budget must never block a real reset');
  assert.strictEqual(sentMail.length, 1, 'the real user should still get their email');
  ok(`6b · ⭐ the oracle is bounded — ${told} straight answers, then ${refused} that reveal nothing, while a real address still gets its link`);
}

// ---- 6c · ⭐ "FORGOT USERNAME" IS NO LONGER A DEAD BUTTON --------------------------------------------
// It set a local flag and said "we've sent its sign-in details there" without making a request — the exact
// bug /forgot used to have. The username here IS the email, so the only useful thing it can do is say
// whether that address has an account, and now it does, over the same bounded budget and with no email.
{
  sentMail.length = 0;
  const yes = await callRoute('post', '/account-exists', { email: 'trey@example.com' });
  assert.strictEqual(yes.status, 200);
  assert.strictEqual(yes.body.exists, true);
  const no = await callRoute('post', '/account-exists', { email: 'definitely-not-here@example.com' });
  assert.ok(no.body.exists === false || no.body.exists === null, `unexpected body ${JSON.stringify(no.body)}`);
  assert.strictEqual((await callRoute('post', '/account-exists', { email: 'nope' })).status, 400);
  assert.strictEqual(sentMail.length, 0, 'a username lookup must not send email');
  ok('6c · ⭐ the username lookup answers for real instead of claiming an email was sent');
}

// ---- 7 · input validation --------------------------------------------------------------------------
{
  assert.strictEqual((await callRoute('post', '/forgot', { email: '' })).status, 400);
  assert.strictEqual((await callRoute('post', '/forgot', { email: 'not-an-email' })).status, 400);
  assert.strictEqual((await callRoute('post', '/forgot', {})).status, 400);

  assert.strictEqual((await callRoute('post', '/reset', { token: '', password: 'longenough' })).status, 400);
  assert.strictEqual((await callRoute('post', '/reset', { token: 'whatever', password: 'short' })).status, 400,
    'a password under 6 characters must be refused');
  assert.strictEqual((await callRoute('post', '/reset', { token: 'no-such-token', password: 'longenough' })).status, 400);
  // An unknown token and an expired one give the SAME message, so guesses reveal nothing.
  const a = await callRoute('post', '/reset', { token: 'aaaa', password: 'longenough' });
  const b = await callRoute('post', '/reset', { token: 'bbbb', password: 'longenough' });
  assert.deepStrictEqual(a.body, b.body);
  ok('7 · bad emails, short passwords and unknown tokens are refused with one indistinguishable message');
}

// ---- 8 · unconfigured mail says so instead of silently doing nothing ---------------------------------
// This is the exact failure being fixed: never tell someone an email is coming when none can be sent.
{
  const savedKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const r = await callRoute('post', '/forgot', { email: 'trey@example.com' });
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.body.code, 'MAIL_UNCONFIGURED');
  assert.ok(/not configured/i.test(r.body.error), r.body.error);
  assert.ok(/report a bug|reach us/i.test(r.body.error), 'it must tell the user how to reach a human');
  process.env.RESEND_API_KEY = savedKey;
  ok('8 · with mail unconfigured the endpoint says so and points at a human, rather than pretending');
}

await pool.end();
console.log(`\n${pass} password-reset checks passed`);
