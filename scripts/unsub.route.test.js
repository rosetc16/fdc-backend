/* THE UNSUBSCRIBE ROUTES, DRIVEN FOR REAL OVER HTTP.
 *
 * A link that looks right and answers 400 is worse than no link at all: it reads as ignoring the request,
 * from the one person already asking to be left alone. So the router is mounted and actually called.
 *
 * ⚠ WHAT THIS PROVES AND WHAT IT DOES NOT. There is no Postgres in this sandbox, so the UPDATE cannot be
 *   observed (ES module exports are read-only, so `q` cannot be stubbed either without loader hooks that
 *   would cost more than they are worth here). The distinction the checks lean on instead is REJECTED vs
 *   ACCEPTED: a bad token is turned away at the door with 400 and never reaches the database, while a good
 *   one gets past validation and fails at the write with 500. That pins every routing and auth decision in
 *   the file. The write itself is one line of SQL against a column created beside it, and the dry run
 *   (`npm run brief:dry`) is what exercises the whole path against a real database.
 */
import express from 'express';
import assert from 'assert';
import { briefRouter, unsubToken } from '../src/routes/brief.js';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use('/api/brief', briefRouter);
const srv = app.listen(8123);
const base = 'http://localhost:8123/api/brief/unsubscribe';
const T = unsubToken('42');

let n = 0;
const ok = (m) => { n++; console.log('  PASS  ' + m); };
const form = { 'content-type': 'application/x-www-form-urlencoded' };

// 1 ── ⭐⭐⭐ a mail scanner fetching the link must not unsubscribe anybody
{
  const r = await fetch(`${base}?u=42&t=${T}`);
  const body = await r.text();
  assert.strictEqual(r.status, 200);
  assert.match(body, /Stop the weekly brief\?/);
  // The tell that it changed nothing: with no database available, a route that WROTE would have 500'd.
  assert.match(body, /<form method="POST"/, 'the state change must be behind a POST');
  ok('1 · ⭐⭐⭐ GET renders a confirm page and writes nothing — corporate mail scanners fetch every link');
}

// 2 ── the confirm button gets past validation and reaches the write
{
  const r = await fetch(base, { method: 'POST', headers: form, body: `u=42&t=${T}` });
  assert.strictEqual(r.status, 500, `expected to reach the DB write and fail there, got ${r.status}`);
  const body = await r.text();
  assert.match(body, /couldn't save that just now/i, 'and it must say so in a sentence, not a stack trace');
  assert.match(body, /Report a bug/, 'with another way out');
  ok('2 · ⭐⭐ a valid POST is accepted and reaches the write (and fails legibly with no database)');
}

// 3 ── ⭐⭐ Gmail/Yahoo one-click posts an EMPTY body to the URL
{
  const r = await fetch(`${base}?u=42&t=${T}`, { method: 'POST', headers: form, body: '' });
  assert.strictEqual(r.status, 500, 'must be accepted (and only fail at the write), not rejected as malformed');
  const ct = r.headers.get('content-type') || '';
  // ⚠ RFC 8058 wants a machine answer here, not an HTML page — the mail client is the caller, not a person.
  assert.match(ct, /json/, `one-click must answer JSON, got ${ct}`);
  ok('3 · ⭐⭐⭐ the one-click (RFC 8058) POST — empty body, query-string token — is accepted and answers JSON');
}

// 4 ── tampered, foreign and truncated tokens are all turned away before the database
{
  for (const [url, why] of [
    [`${base}?u=42&t=${T.slice(0, -1)}0`, 'a tampered token'],
    [`${base}?u=99&t=${T}`, "another user's token"],
    [`${base}?u=42&t=short`, 'a truncated token'],
    [`${base}?u=42`, 'no token at all'],
  ]) {
    const g = await fetch(url);
    assert.strictEqual(g.status, 400, `${why} should be rejected, got ${g.status}`);
    const p = await fetch(url, { method: 'POST', headers: form, body: '' });
    assert.strictEqual(p.status, 400, `${why} should be rejected on POST too, got ${p.status}`);
  }
  ok('4 · ⭐⭐⭐ tampered, foreign, truncated and missing tokens never reach the database, on either verb');
}

// 5 ── and the rejection tells them what to do instead
{
  const r = await fetch(`${base}?u=42&t=bad`);
  const body = await r.text();
  assert.match(body, /Nothing has been changed/);
  assert.match(body, /Report a bug/, 'a dead end here means they simply keep getting the email');
  ok('5 · ⭐⭐ a broken link says nothing changed, and how else to stop the email');
}

srv.close();
console.log(`\n${n}/${n} unsubscribe-route checks passed`);
