/* THE LIVE-PICK-SYNC DIAGNOSTIC'S REASONING.
 *
 * This exists because MyFantasyLeague and Fantrax are unreachable from the sandbox the sync was written
 * in — which is also why the diagnostic itself exists. A diagnostic whose logic can only be exercised by
 * calling the thing it diagnoses is a diagnostic nobody has ever seen run, and the four backend rounds of
 * 112-115 were all lost to instruments that reported clean successes.
 *
 * The distinction every check below turns on: "no picks came back" and "picks came back that nobody can
 * identify" look IDENTICAL on a draft board — both are an empty board under a healthy-looking sync — and
 * only the second means the translation layer is broken. An instrument that blurs those two sends the
 * next hour in the wrong direction.
 */
import assert from 'assert';
import { verdictFor } from '../src/lib/connectDiag.js';

let n = 0;
const ok = (m) => { n++; console.log('  PASS  ' + m); };

// 1 ── the failure the whole feature can die of, silently
{
  const v = verdictFor({ dirSize: 0 });
  assert.strictEqual(v.level, 'broken');
  assert.match(v.text, /directory is empty/i);
  // ⚠ It must point at the file to compare against, or the reader is left knowing only that it is broken.
  assert.match(v.text, /playerIds\.js/);
  ok('1 · ⭐⭐⭐ an empty directory is called broken, and names the parser to compare against');
}

// 2 ── ⭐⭐⭐ the one that must never be confused with "the draft has not started"
{
  const none = verdictFor({ dirSize: 2600, pickCount: 24, named: 0 });
  const empty = verdictFor({ dirSize: 2600, pickCount: 0, named: 0 });
  assert.strictEqual(none.level, 'broken', '24 unidentifiable picks is a broken translation');
  assert.strictEqual(empty.level, 'unknown', 'no picks at all is not evidence of anything');
  assert.notStrictEqual(none.text, empty.text);
  // The broken one has to say what to compare, because the ids are the whole answer.
  assert.match(none.text, /player_id/);
  ok('2 · ⭐⭐⭐ "picks nobody can identify" and "no picks" get different verdicts and different advice');
}

// 3 ── a few unresolved is ordinary, and must not read as an emergency
{
  const v = verdictFor({ dirSize: 2600, pickCount: 24, named: 22 });
  assert.strictEqual(v.level, 'partial');
  assert.match(v.text, /22 of 24/);
  // ⚠ It has to say which way to read the number — a handful is normal, a large share is not — or every
  //   partial result gets escalated identically regardless of size.
  assert.match(v.text, /handful is normal/i);
  ok('3 · ⭐⭐ a partial resolve says how to read its own number');
}

// 4 ── healthy is stated plainly, so a green run is not mistaken for an inconclusive one
{
  const v = verdictFor({ dirSize: 2600, pickCount: 24, named: 24 });
  assert.strictEqual(v.level, 'ok');
  assert.match(v.text, /all 24 picks resolved/i);
  ok('4 · ⭐ a healthy feed says so unambiguously');
}

// 5 ── directory-only, when no league was given
{
  const v = verdictFor({ dirSize: 2600 });
  assert.strictEqual(v.level, 'ok');
  assert.match(v.text, /Pass a league id/i);
  // ⚠ pickCount UNDEFINED means "not checked" and pickCount 0 means "checked, found none". Collapsing
  //   those would report a healthy directory as a broken draft for anyone who ran it without a league.
  assert.notStrictEqual(v.level, verdictFor({ dirSize: 2600, pickCount: 0, named: 0 }).level);
  ok('5 · ⭐⭐ "not checked" and "checked, found nothing" are not the same answer');
}

// 6 ── an empty directory outranks everything else
{
  // With no directory, nothing downstream can be true — reporting "0 of 24 resolved, compare the ids"
  // would send the reader to compare against a list that does not exist.
  const v = verdictFor({ dirSize: 0, pickCount: 24, named: 0 });
  assert.match(v.text, /directory is empty/i);
  ok('6 · ⭐⭐ the first broken link is the one reported, not the last');
}

console.log(`\n${n}/${n} connect-diagnostic checks passed`);
