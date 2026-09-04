/* Positional coverage backstop — the fix for "Washington has no TE's listed".
 *
 * The pack's inclusion gate keeps retired players off the board by requiring a projection or a published ADP.
 * A current starter whose projection has not landed looks identical to a retired player from inside that
 * test, and the two failures cost very different amounts: a stale row is scrolled past, a missing player is a
 * pick that cannot be recorded when somebody in the league drafts him.
 *
 * These checks pin the shape of the answer: fill holes that provably cannot be empty, and do not otherwise
 * relax the gate by a single player.
 */
import assert from 'assert';
import { positionGapsToFill, MAX_BACKSTOP_PER_GAP } from '../src/lib/coverage.js';

let n = 0;
const ok = (m) => { n++; console.log('  PASS  ' + m); };
const P = (team, pos) => ({ team, pos });

// 1 ── the report, in miniature
{
  const included = [P('WAS', 'QB'), P('WAS', 'RB'), P('WAS', 'WR'), P('KC', 'TE')];
  const dropped = [P('WAS', 'TE')];                       // Okonkwo
  const fill = positionGapsToFill(included, dropped);
  assert.deepStrictEqual(fill, [0], 'the only TE on a team with no TE must be readmitted');
  ok('1 · ⭐⭐⭐ a team with no tight end at all gets its tight end back');
}

// 2 ── and the gate is NOT otherwise relaxed
{
  // Kansas City already has a tight end on merit. A second one who failed the gate stays out — otherwise this
  // becomes "anybody with a team", which is the retired-player hole the gate exists to close.
  const included = [P('KC', 'TE')];
  const dropped = [P('KC', 'TE')];
  assert.deepStrictEqual(positionGapsToFill(included, dropped), [],
    'a position that already has somebody must not be topped up');
  ok('2 · ⭐⭐⭐ a position that is already represented is left alone — this is not a looser gate');
}

// 3 ── free agents and unknown teams are not a "team gap"
{
  // The retired players this gate was built to exclude carry team FA or null. They belong to no roster, so
  // they can never be evidence that a roster is missing somebody.
  const dropped = [P(null, 'RB'), P('FA', 'RB'), P('', 'TE')];
  assert.deepStrictEqual(positionGapsToFill([], dropped), [],
    'a player with no real team cannot fill a team-position gap');
  ok('3 · ⭐⭐⭐ a player with no NFL team is never readmitted — that is exactly the retired-player shape');
}

// 4 ── capped, so a feed outage cannot flood the board through this door
{
  const dropped = Array.from({ length: 9 }, () => P('WAS', 'TE'));
  const fill = positionGapsToFill([], dropped);
  assert.strictEqual(fill.length, MAX_BACKSTOP_PER_GAP,
    `expected at most ${MAX_BACKSTOP_PER_GAP} per gap, got ${fill.length}`);
  ok(`4 · ⭐⭐ at most ${MAX_BACKSTOP_PER_GAP} players fill any one gap, so a whole-feed outage cannot flood the board`);
}

// 5 ── only positions this league actually drafts
{
  // A league without kickers must not have kickers readmitted on its behalf; and the core list is the four
  // positions every NFL team fields, so K/DST are outside this mechanism entirely.
  const dropped = [P('WAS', 'K'), P('WAS', 'DST'), P('WAS', 'TE')];
  const fill = positionGapsToFill([], dropped, (pos) => ['QB', 'RB', 'WR', 'TE'].includes(pos));
  assert.deepStrictEqual(fill, [2], 'only the TE should come back');
  ok('5 · ⭐⭐ only positions the league drafts are considered');
}

// 6 ── a gap is per team AND per position, not per team
{
  const included = [P('WAS', 'QB'), P('WAS', 'RB'), P('WAS', 'WR')];
  const dropped = [P('WAS', 'TE'), P('CHI', 'TE'), P('WAS', 'QB')];
  const fill = positionGapsToFill(included, dropped);
  // WAS is missing only TE (its QB is covered); CHI is missing TE.
  assert.deepStrictEqual(fill, [0, 1], `expected both TEs and neither QB, got ${JSON.stringify(fill)}`);
  ok('6 · ⭐⭐ holes are counted per team AND per position — a covered QB does not excuse a missing TE');
}

// 7 ── nothing dropped, nothing added
{
  assert.deepStrictEqual(positionGapsToFill([P('WAS', 'TE')], []), []);
  assert.deepStrictEqual(positionGapsToFill([], []), []);
  ok('7 · a healthy pack readmits nobody, and an empty one does not throw');
}

console.log(`\n${n}/${n} coverage-backstop checks passed`);
