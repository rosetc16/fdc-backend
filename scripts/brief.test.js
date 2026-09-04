/* THE WEEKLY BRIEF: WHO IT MAILS, AND THE TWO CONTENT BUGS.
 *
 * This job has been scheduled since 29e (Tuesdays, 13:00 UTC) and has never sent a single email, because
 * RESEND_API_KEY was never set. It is set now, so it fires for real — and an email cannot be recalled,
 * which makes this the last moment its logic is cheap to be wrong about.
 *
 * ⭐⭐⭐⭐ IT IS OPT-IN. Trey: "I don't think I want to send automated emails unless someone subscribes to
 * them." The job was written to mail every linked paying user and offer a way out; it now mails only
 * `brief_opt_in = TRUE`, a column defaulting to FALSE, so it sends to NOBODY until somebody asks. §0 is
 * that rule, stated as an executable check so it cannot quietly drift back.
 *
 * Three more things it got wrong, all invisible while the job was a no-op:
 *   1. the only opt-out it offered was "reply to this email", with no column, no link and no handler
 *      behind it — so anyone who asked to stop would have been mailed again seven days later;
 *   2. an empty set lineup made `sum([]) === 0`, so `gain` became the WHOLE optimal total and the first
 *      brief anybody ever received would have opened "94.6 points are sitting on your bench";
 *   3. `bits` almost always held "lineup looks optimal", so every user got a message every week whether
 *      or not anything needed doing.
 *
 * ⚠ WHAT IS TESTED HERE IS THE REASONING, NOT THE SENDING. Resend is unreachable from this sandbox and
 *   Sleeper is too, so the pure pieces — the unsubscribe token and the two content rules — are pulled out
 *   and exercised directly, and the network is left to the dry run (`npm run brief:dry`).
 */
import assert from 'assert';
import fs from 'fs';
import { unsubToken, unsubLink } from '../src/routes/brief.js';

let n = 0;
const ok = (m) => { n++; console.log('  PASS  ' + m); };

// ---- 0 · ⭐⭐⭐⭐ nobody is mailed who did not ask ---------------------------------------------------
{
  /* Read the shipped query rather than restating the rule, because the rule IS the query — a test that
     asserts a copy of it would go on passing after somebody widened the real one. The three shapes this
     rejects are the three ways opt-in silently becomes opt-out: naming the column the other way round,
     tolerating NULL, or folding consent into the subscription check. */
  const src = fs.readFileSync(new URL('../src/jobs/weeklyBrief.js', import.meta.url), 'utf8');
  const sel = (src.match(/SELECT id, email, sleeper_user_id FROM users[\s\S]*?LIMIT \$1/) || [''])[0];
  assert.ok(sel, 'could not find the recipient query — has it moved?');
  assert.match(sel, /brief_opt_in IS TRUE/, 'the recipient list must require an explicit opt-in');
  assert.ok(!/brief_opt_out/.test(sel), 'an opt-OUT column would mail everyone by default');
  assert.ok(!/brief_opt_in IS NOT FALSE/.test(sel), 'NULL-tolerant means every existing row is subscribed');
  ok('0 · ⭐⭐⭐⭐ the recipient query requires an explicit opt-in — paying is not asking for email');
}

// ---- 1 · the unsubscribe token ---------------------------------------------------------------------
{
  const a = unsubToken('42');
  assert.strictEqual(a, unsubToken('42'), 'must be stable — the link has to work from a folder in February');
  assert.notStrictEqual(a, unsubToken('43'), "one user's link must not unsubscribe another");
  assert.ok(a.length >= 32 && /^[0-9a-f]+$/.test(a), 'not guessable by hand');
  ok('1 · ⭐⭐⭐ the token is stable per user, different between users, and unguessable');
}

// ---- 2 · the link is absolute and carries both halves ----------------------------------------------
{
  const link = unsubLink('42', 'https://www.fantasydraftcompass.com/');
  assert.match(link, /^https:\/\/www\.fantasydraftcompass\.com\/api\/brief\/unsubscribe\?u=42&t=[0-9a-f]{32}$/);
  // ⚠ A trailing slash on APP_URL must not produce a double slash — some mail clients mangle those, and a
  //   broken unsubscribe link is worse than none: it reads as ignoring the request.
  assert.ok(!link.includes('.com//'), 'no double slash from a trailing-slash APP_URL');
  ok('2 · ⭐⭐ the link is absolute, complete, and survives a trailing slash on APP_URL');
}

/* The two content rules, lifted verbatim in shape from weeklyBrief.js. They are re-stated here rather
   than imported because they live inside a 130-line per-league loop that needs Sleeper to run; the rules
   themselves are two lines and this pins both of them. ⚠ If that loop changes, change these together —
   they are a copy, and a copy that drifts is worse than no test. */
const gainOf = (optimalPts, setPts, optimalCount, setCount) => {
  const lineupKnown = setCount >= optimalCount && optimalCount > 0;
  return lineupKnown ? Math.round((optimalPts - setPts) * 10) / 10 : null;
};

// ---- 3 · ⭐⭐⭐ the "94.6 points on your bench" email that must never go out --------------------------
{
  // Tuesday morning: the coming week's lineup is not set, so the feed returns no starters at all.
  assert.strictEqual(gainOf(94.6, 0, 9, 0), null, 'no set lineup means we know nothing, not that all is benched');
  // The same bug in miniature: three starters reported where the league starts nine.
  assert.strictEqual(gainOf(94.6, 31.2, 9, 3), null, 'a partial lineup cannot be compared either');
  // And when the lineup IS known, the number is the real one.
  assert.strictEqual(gainOf(94.6, 88.1, 9, 9), 6.5);
  ok('3 · ⭐⭐⭐ an unset or partial lineup yields NO claim; a known one yields the real gap');
}

// ---- 4 · ⭐⭐ nothing to say means no email ----------------------------------------------------------
{
  const actionableOf = (gain, swapCount, byeCount) =>
    (gain != null && gain >= 1 && swapCount > 0) || byeCount > 0;
  assert.strictEqual(actionableOf(6.5, 2, 0), true, 'points on the bench is worth an email');
  assert.strictEqual(actionableOf(0.2, 0, 1), true, 'a bye crunch ahead is worth an email');
  assert.strictEqual(actionableOf(0.2, 0, 0), false, '"lineup looks optimal" is not');
  assert.strictEqual(actionableOf(null, 0, 0), false, 'and neither is knowing nothing at all');
  /* ⚠ THE ONE THAT KEEPS THIS HONEST: a threshold that fires on everything is the same failure as one
     that fires on nothing. A weekly email saying "all good" is what teaches people to delete it unread,
     and then they miss the week their lineup IS wrong. */
  ok('4 · ⭐⭐ only a real finding earns an email — "all good" does not');
}

// ---- 5 · a gain below the threshold is not reported as a finding -----------------------------------
{
  // 0.4 points is noise from a projection source, not advice worth mailing somebody about.
  const gain = gainOf(94.6, 94.2, 9, 9);
  assert.ok(gain != null && gain < 1, `expected a sub-point gap, got ${gain}`);
  ok('5 · a sub-point difference stays out of the email');
}

console.log(`\n${n}/${n} weekly-brief checks passed`);
