/* WHO HE IS PLAYING, AND WHICH END OF IT — b147.
 *
 * Trey, about Game Day's player hover: "show who his opponent is".
 *
 * ⚠⚠ THE BUG THIS REPLACES WAS NOT A WRONG ANSWER, IT WAS NO ANSWER. `oppOf: () => null` was hardcoded in
 *   the live route from the day the rooting board was written, so `opp` — a field on the board's own
 *   contract, carried all the way to the client — has been null for every player in production ever since.
 *   The query beside it selected `team, kickoff` from a table that also holds `opponent` and `home`.
 *
 * ⚠ AND THE REASON THIS IS A TEST RATHER THAN A GLANCE: inverting `home` produces a string that reads
 *   perfectly plausibly ("CIN @ GB" is a real-looking sentence about the wrong game), nothing else in the
 *   app computes it, and the fixture that feeds the browser suite is a hand-written map — so a browser
 *   assertion would be checking that I wrote what I wrote. The 29x weather-roof lesson: when a decision
 *   lives inline in a route behind a database query, extract it or it cannot be tested.
 */
import assert from 'assert';
import { gameLabel } from '../src/routes/connect.js';

let n = 0;
const ok = (m, x) => { n++; console.log('  PASS  ' + m + (x ? `   [${x}]` : '')); };

// 1 ── ⭐⭐⭐⭐⭐ HOME AND AWAY ARE DIFFERENT STRINGS FOR THE SAME PAIR OF TEAMS
{
  /* The whole point. Both calls describe ONE game; only which side of it you are on differs, and the
     answer must differ with it. A rule that ignored `home` passes any test that only checks "KC is in
     there", which is how an inverted-boolean bug survives.
     BROKEN TO CHECK: returning `vs ${opp}` unconditionally makes these two equal and §1 goes red. */
  const home = gameLabel('KC', true);
  const away = gameLabel('KC', false);
  assert.notStrictEqual(home, away, 'the same opponent must not read the same from both benches');
  assert.strictEqual(home, 'vs KC');
  assert.strictEqual(away, '@ KC');
  ok('1 · ⭐⭐⭐⭐⭐ the same opponent reads "vs KC" at home and "@ KC" away', `${home} / ${away}`);
}

// 2 ── ⭐⭐⭐⭐ THE FLAG IS READ AS A FLAG, not as "anything truthy is home"
{
  /* Postgres hands back a real boolean, but this row has been through a JSON round trip in two of the
     three places it is built (the stub, and any cached payload), and `"false"` is truthy. */
  assert.strictEqual(gameLabel('GB', 1), 'vs GB');
  assert.strictEqual(gameLabel('GB', 0), '@ GB');
  assert.strictEqual(gameLabel('GB', null), '@ GB', 'an unknown side is treated as away, not as home');
  assert.strictEqual(gameLabel('GB', undefined), '@ GB');
  ok('2 · ⭐⭐⭐⭐ 1/0/null all resolve, and an unknown side defaults to away rather than claiming home');
}

// 3 ── it normalises the team code, because the feed does not
{
  assert.strictEqual(gameLabel('kc', true), 'vs KC');
  assert.strictEqual(gameLabel('  det  ', false), '@ DET');
  ok('3 · ⭐⭐⭐ lower case and stray whitespace from the schedule feed are normalised');
}

// 4 ── ⭐⭐⭐⭐ NO OPPONENT IS NULL, NEVER A HALF-SENTENCE
{
  /* A bye week, or a schedule row the sync never filled. "vs " rendered on a player card would look like
     a rendering fault; null is a line the card simply does not draw. */
  assert.strictEqual(gameLabel(null, true), null);
  assert.strictEqual(gameLabel('', false), null);
  assert.strictEqual(gameLabel('   ', true), null, 'whitespace is not an opponent');
  assert.strictEqual(gameLabel(undefined, false), null);
  ok('4 · ⭐⭐⭐⭐ a missing opponent returns null rather than "vs " with nothing after it');
}

console.log(`\n${n}/${n} game-label checks passed`);
