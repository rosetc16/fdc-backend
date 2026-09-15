/* PROJECTED SCORES AND WIN PROBABILITY — b136.
 *
 * Trey: "It's saying I'm 8-2… This is true RIGHT NOW, but on sleeper, I'm showed that I'm projected to lose
 * at least 5 total. So the 8-2 is misleading. I also love on sleeper how there is color coded projection
 * systems (i.e. 11% projected to win is red // 87% to win is green)."
 *
 * ⚠ A PROBABILITY IS THE EASIEST NUMBER ON A PAGE TO GET SUBTLY, PERMANENTLY WRONG, because nothing ever
 *   contradicts it: 62% is never observably false. So the tests below pin the cases where it CAN be caught
 *   being wrong, and those are the ends — §3 (the final whistle, where the only acceptable answers are 0%
 *   and 100%) and §4 (a huge lead that is not yet safe because nobody has played). Those two are what make
 *   the numbers in between worth believing.
 */
import assert from 'assert';
import { projectSide, matchupForecast, projectedRecord, normalCdf, sdFor } from '../src/lib/winprob.js';

let n = 0;
const ok = (m) => { n++; console.log('  PASS  ' + m); };
const P = (pts, played, proj) => ({ sid: `p${Math.random()}`, pts, played, proj });

// 1 ── the normal CDF, against values anybody can check
{
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normalCdf(1) - 0.8413) < 1e-3, 'one sd up is ~84%');
  assert.ok(Math.abs(normalCdf(-1) - 0.1587) < 1e-3);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3);
  assert.ok(normalCdf(6) > 0.999 && normalCdf(-6) < 0.001);
  assert.strictEqual(normalCdf(NaN), null);
  ok('1 · ⭐⭐⭐ the normal CDF matches the textbook at 0, ±1 and 1.96');
}

// 2 ── one side, projected forward
{
  /* Three played (12 + 8 + 20 = 40 on the board), two still to come projected 14 and 9.
     projected final = 40 + 23 = 63 */
  const s = projectSide([
    P(12, true, 11), P(8, true, 15), P(20, true, 9),
    P(0, false, 14), P(0, false, 9),
  ]);
  assert.strictEqual(s.scored, 40);
  assert.strictEqual(s.remaining, 23);
  assert.strictEqual(s.projected, 63);
  assert.strictEqual(s.yetToPlay, 2);
  /* ⚠ A PLAYED PLAYER'S PROJECTION IS DEAD. Once he has played, what he was projected for is a historical
     curiosity — using it would double-count him or, worse, overwrite the real number. */
  assert.strictEqual(s.remaining, 23, 'only the unplayed contribute to remaining');
  ok('2 · ⭐⭐⭐⭐ a side projects to points-on-the-board plus projections for whoever is left');
}

// 3 ── ⭐⭐⭐⭐⭐ THE FINAL WHISTLE: THE ONLY PLACE THIS MODEL CAN BE CAUGHT LYING
{
  const done = (pts) => [P(pts, true, 0)];
  const wonIt = matchupForecast(done(120), done(100));
  assert.strictEqual(wonIt.settled, true);
  assert.strictEqual(wonIt.win, 1, 'a finished win is 100%, not 97%');
  const lostIt = matchupForecast(done(100), done(120));
  assert.strictEqual(lostIt.win, 0, 'a finished loss is 0%, not 3%');
  assert.strictEqual(lostIt.margin, -20);
  const tied = matchupForecast(done(110), done(110));
  assert.strictEqual(tied.win, 0.5);
  /* ⚠ AND THE CLAMP MUST NOT APPLY HERE. Mid-game the answer is squeezed into [1%, 99%] because a 3%
     chance is not impossible; after the whistle that same clamp would report a finished, lost game as 1%
     and keep a dead matchup flickering on the page. */
  assert.notStrictEqual(lostIt.win, 0.01, 'the mid-game floor must not survive into a settled game');
  ok('3 · ⭐⭐⭐⭐⭐ once everyone has played the probability is exactly 0% or 100%, clamp and all');
}

// 4 ── ⭐⭐⭐⭐⭐ A HUGE LEAD THAT IS NOT SAFE — the case "8-2" was hiding
{
  /* I have played everyone: 41 points. They have played nobody, and project 118.
     The scoreboard says I am winning 41-0. The forecast says I am losing by 77. */
  const mine = [P(41, true, 40)];
  const theirs = Array.from({ length: 9 }, () => P(0, false, 13.1));
  const f = matchupForecast(mine, theirs);
  assert.strictEqual(f.me.scored, 41);
  assert.strictEqual(f.opp.scored, 0);
  assert.ok(f.opp.projected > 110, `they project ${f.opp.projected}`);
  assert.ok(f.margin < -70, `margin ${f.margin}`);
  /* ⭐⭐⭐⭐⭐ THE HEADLINE. A live-scoreboard record would call this a win. It is not one. */
  assert.ok(f.win < 0.05, `a 41-0 "lead" against a full unplayed lineup must not read as winning (got ${f.win})`);
  assert.strictEqual(f.settled, false);
  assert.ok(f.win >= 0.01, 'but never quite zero while anyone is still to play');
  ok('4 · ⭐⭐⭐⭐⭐ leading 41-0 against a lineup that has not kicked off reads as LOSING, which it is');
}

// 5 ── uncertainty shrinks as the day goes on
{
  const sideAt = (playedCount) => Array.from({ length: 9 }, (_, i) => P(i < playedCount ? 12 : 0, i < playedCount, 12));
  const early = matchupForecast(sideAt(0), sideAt(0));
  const mid = matchupForecast(sideAt(5), sideAt(5));
  const late = matchupForecast(sideAt(8), sideAt(8));
  assert.ok(early.sd > mid.sd && mid.sd > late.sd, `sd should fall: ${early.sd} > ${mid.sd} > ${late.sd}`);
  /* ⭐⭐⭐⭐ THE WHOLE POINT OF CARRYING UNCERTAINTY. The same three-point lead is a coin flip in the morning
     and nearly safe in the evening, and a page that cannot tell those apart is the page he is complaining
     about. */
  const leadEarly = matchupForecast([...sideAt(0), P(3, true, 0)], sideAt(0));
  const leadLate = matchupForecast([...sideAt(8), P(3, true, 0)], sideAt(8));
  /* ⚠ THE DIRECTION IS THE CLAIM; THE SIZE IS NOT MINE TO ASSERT. The first draft of this demanded the
     late lead be worth 10 percentage points more, which is a number I made up — the model actually gives
     54% → 63%, and there is no principled reason it should be 64% instead. So the test pins what the model
     is FOR (the same lead is safer later) and the mechanism behind it (the error bar shrinks), and leaves
     the exact spread free to move when the volatility constants are tuned. */
  assert.ok(leadLate.win > leadEarly.win,
    `a 3-point lead must be worth more late (${leadLate.win}) than early (${leadEarly.win})`);
  assert.ok(leadEarly.win > 0.5 && leadEarly.win < 0.6,
    'and early it is barely better than a coin flip, because almost nothing has happened');
  assert.ok(leadLate.sd * 2 < leadEarly.sd,
    `the mechanism: one man left per side is far more certain than nine (${leadLate.sd} vs ${leadEarly.sd})`);
  ok('5 · ⭐⭐⭐⭐ the same lead is worth more the later it is, because uncertainty shrinks with the day');
}

// 6 ── ⚠ A MISSING PROJECTION IS NOT A ZERO
{
  const withProj = matchupForecast([P(0, false, 14)], [P(50, true, 0)]);
  const without = matchupForecast([P(0, false, null)], [P(50, true, 0)]);
  assert.strictEqual(without.me.remaining, 0, 'we cannot forecast points we have no projection for');
  assert.strictEqual(without.unknown, 1, 'but it is COUNTED, so the page can say the forecast is partial');
  assert.strictEqual(withProj.unknown, 0);
  /* ⭐⭐⭐⭐ And an unprojectable starter makes us LESS certain, not more — otherwise a roster full of
     players the feed does not cover would report a falsely confident forecast built on nothing. */
  assert.ok(without.sd > withProj.sd, `unknown must widen the error bar: ${without.sd} vs ${withProj.sd}`);
  ok('6 · ⭐⭐⭐⭐ a starter with no projection is counted as unknown and widens the error bar');
}

// 7 ── the sd model itself
{
  assert.strictEqual(sdFor(20), 11, '20 projected → sd 11');
  assert.strictEqual(sdFor(0), 3, 'a zero projection is still uncertain, not certain');
  assert.strictEqual(sdFor(2), 3, 'the floor holds for small projections');
  assert.strictEqual(sdFor(null), 3);
  ok('7 · ⭐⭐⭐ the per-player error bar scales with the projection but never collapses to zero');
}

// 8 ── ⭐⭐⭐⭐⭐ THE RECORD, BOTH WAYS — "8-2 … is misleading"
{
  /* Ten leagues. In every one I am ahead right now with my lineup done, and in five of them the opponent
     has a full lineup still to come that projects past me. Live record 10-0, projected 5-5. */
  const aheadAndSafe = () => matchupForecast([P(120, true, 0)], [P(100, true, 0)]);
  const aheadAndDoomed = () => matchupForecast([P(120, true, 0)], [...Array.from({ length: 9 }, () => P(0, false, 15))]);
  const rec = projectedRecord([
    aheadAndSafe(), aheadAndSafe(), aheadAndSafe(), aheadAndSafe(), aheadAndSafe(),
    aheadAndDoomed(), aheadAndDoomed(), aheadAndDoomed(), aheadAndDoomed(), aheadAndDoomed(),
  ]);
  assert.strictEqual(rec.liveW, 10, 'the scoreboard right now says ten wins');
  assert.strictEqual(rec.liveL, 0);
  /* ⭐⭐⭐⭐⭐ …and the honest headline says five. This is the exact complaint, as an assertion. */
  assert.strictEqual(rec.projW, 5, 'the projection says five');
  assert.strictEqual(rec.projL, 5);
  assert.strictEqual(rec.settled, 5, 'only the five finished ones are settled');
  /* ⭐⭐⭐⭐ EXPECTED WINS IS NOT THE SAME NUMBER AS THE PROJECTED RECORD, and the gap here is the lesson.
     The record counts favourites: five safe wins plus five games I am behind in = 5-5. Expected wins sums
     the probabilities: those five "losses" are each about a 27% chance of flipping, and 5 + 5x0.27 = 6.4.
     Both are true and they answer different questions — "how many am I winning" versus "how many should I
     expect to end up with" — which is why the page carries the record and this stays a supporting number.
     (My first pass asserted this had to land under 6, which was simply bad arithmetic on my part.) */
  assert.ok(rec.expected > rec.projW, `expected wins ${rec.expected} exceeds the ${rec.projW} games I lead`);
  assert.ok(rec.expected < rec.projW + rec.projL * 0.5,
    `but the underdogs are underdogs, so it stays well short of ${rec.projW + rec.projL}`);
  ok('8 · ⭐⭐⭐⭐⭐ a live 10-0 that is really 5-5 reports BOTH, which is the whole complaint');
}

// 9 ── toss-ups: the matchups actually worth watching
{
  const coin = () => matchupForecast([P(60, true, 0), P(0, false, 30)], [P(60, true, 0), P(0, false, 30)]);
  const blowout = () => matchupForecast([P(200, true, 0)], [P(60, true, 0)]);
  const rec = projectedRecord([coin(), coin(), blowout(), blowout(), blowout()]);
  assert.strictEqual(rec.tossups, 2, 'two genuine coin flips among five games');
  assert.strictEqual(rec.games, 5);
  ok('9 · ⭐⭐⭐ the summary counts how many games are still in the balance, not just the record');
}

// 10 ── the shapes a Sunday produces
{
  assert.strictEqual(projectSide([]).projected, 0);
  assert.strictEqual(projectSide(null).yetToPlay, 0);
  const empty = matchupForecast([], []);
  assert.strictEqual(empty.settled, true, 'two empty lineups are not an ongoing game');
  assert.strictEqual(empty.win, 0.5);
  assert.strictEqual(projectedRecord([]).games, 0);
  assert.strictEqual(projectedRecord(null).expected, 0);
  ok('10 · ⭐⭐ empty lineups and empty weeks do not throw or invent a result');
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
   11–14 ── ⭐⭐⭐⭐⭐ THE MONDAY NIGHT CASE: a man in a live game is not finished.

   Trey, watching a Monday night game: "something isn't working right for games that are currently LIVE.
   Tonight is Monday night football and a game is live, but it's showing that there is no one left AND the
   scores are static (and it's showing that I'm projected to still go 8-2 when I'm more than likely to
   finish 5-5 because they are expected to score a lot in this game)."

   The model had two states and a live game fits neither. The route decides "played" from the stats feed —
   correct for the question it answers — and a player in the second quarter already HAS a stat line, so he
   read as done: his points so far became his final score and the rest of his game left the forecast.

   ⚠ TEST 11 PINS THE OLD BEHAVIOUR ON PURPOSE so 12 has something to be measured against. If someone
     collapses the three phases back to two, 12 fails and 11 says why.
   ══════════════════════════════════════════════════════════════════════════════════════════════════ */

// 11 ── the bug, as arithmetic: treating a live player as finished freezes the score
{
  // He has 11 with roughly half his game left and a 24-point projection.
  const asDone = projectSide([{ sid: 'a', pts: 11, played: true, proj: 24 }]);
  assert.strictEqual(asDone.projected, 11, 'marked played, his projection is discarded entirely');
  assert.strictEqual(asDone.yetToPlay, 0, 'and he is reported as nobody left');
  ok('11 · ⭐⭐⭐⭐ a live player marked "played" freezes the projection at his current score (the bug)');
}

// 12 ── ⭐⭐⭐⭐⭐ THE FIX: he keeps what he has AND the share of his projection still ahead of him
{
  const live = projectSide([{ sid: 'a', pts: 11, phase: 'live', remain: 0.5, proj: 24 }]);
  assert.strictEqual(live.scored, 11, 'what he has scored is authoritative and untouched');
  assert.strictEqual(live.remaining, 12, 'half a game left of a 24-point projection is 12 more');
  assert.strictEqual(live.projected, 23, 'so he is heading for 23, not frozen at 11');
  assert.strictEqual(live.yetToPlay, 1, 'and he IS still to play — the matchup is undecided');
  assert.strictEqual(live.playing, 1);
  assert.strictEqual(live.notStarted, 0, 'playing and not-yet-started are told apart');
  ok('12 · ⭐⭐⭐⭐⭐ a live player carries his score PLUS the rest of his projection');
}

// 13 ── ⭐⭐⭐⭐ uncertainty shrinks with the clock — the late game is less of a coin flip
{
  const early = projectSide([{ sid: 'a', pts: 0, phase: 'live', remain: 1, proj: 24 }]);
  const late = projectSide([{ sid: 'a', pts: 20, phase: 'live', remain: 0.1, proj: 24 }]);
  assert.ok(late.variance < early.variance,
    'a man with a minute left is more predictable than one who just kicked off');
  const done = projectSide([{ sid: 'a', pts: 22, phase: 'done', proj: 24 }]);
  assert.strictEqual(done.variance, 0, 'and a finished game carries no uncertainty at all');
  assert.strictEqual(done.projected, 22, 'nor any projection — the score IS the answer');
  ok('13 · ⭐⭐⭐⭐ uncertainty scales with the time left, and reaches zero when the game ends');
}

/* 14 ── ⭐⭐⭐⭐⭐ THE 8-2 THAT SHOULD BE 5-5. His actual complaint, in miniature: I am ahead on the
   scoreboard, their man is mid-game and expected to add a lot. Counting him as finished calls it a win;
   counting the rest of his game calls it a loss, which is what Sleeper says and what actually happens. */
{
  const mine = [{ sid: 'm', pts: 95, phase: 'done', proj: 95 }];
  const theirsLive = [{ sid: 't', pts: 80, phase: 'live', remain: 0.6, proj: 40 }];
  const theirsAsDone = [{ sid: 't', pts: 80, played: true, proj: 40 }];

  const wrong = matchupForecast(mine, theirsAsDone);
  assert.strictEqual(wrong.win, 1, 'treating him as finished makes it a certain win');

  const right = matchupForecast(mine, theirsLive);
  assert.ok(right.opp.projected > 100, `their live man is still climbing (got ${right.opp.projected})`);
  assert.ok(right.win < 0.5,
    `and the game is more likely lost than won (got ${Math.round(right.win * 100)}%)`);
  assert.strictEqual(right.settled, false, 'a game with a man on the field is not settled');
  ok('14 · ⭐⭐⭐⭐⭐ a lead against a live opponent is no longer reported as a certain win');
}

/* 15–16 ── ⭐⭐⭐⭐⭐ MEDIAN SCORING: a week is two games, not one.
   Trey: "if your league has median scoring, you need to show how we relate to that as well (based on
   projected scoring and projected median). This is in sleeper when you look at leagues."
   Sleeper's `league_average_match` means every team also plays the league median each week, so the result
   is 2-0, 1-1 or 0-2. A record that counts only the head-to-head reports half of it. */

// 15 ── the median half is folded into the same record, because that is how the standings count it
{
  const F = (margin, win) => ({ me: { scored: 100 }, opp: { scored: 100 - margin }, margin, win, settled: false });
  const forecasts = [F(10, 0.7), F(-10, 0.3)];
  const medians = [
    { on: true, margin: 6, win: 0.65, myNow: 90, median: 84 },    // beating the median
    { on: true, margin: -4, win: 0.4, myNow: 70, median: 74 },    // losing to it
  ];
  const plain = projectedRecord(forecasts);
  assert.strictEqual(plain.games, 2, 'without medians it is two games, exactly as before');
  assert.strictEqual(plain.projW, 1);

  const withMed = projectedRecord(forecasts, medians);
  assert.strictEqual(withMed.games, 4, 'two matchups plus two median games');
  assert.strictEqual(withMed.matchups, 2);
  assert.strictEqual(withMed.medianGames, 2);
  assert.strictEqual(withMed.projW, 2, 'one head-to-head win and one median win');
  assert.strictEqual(withMed.projL, 2);
  assert.strictEqual(withMed.medianW, 1);
  assert.strictEqual(withMed.medianL, 1);
  ok('15 · ⭐⭐⭐⭐⭐ median games are counted in the same record, so a week can be 2-0, 1-1 or 0-2');
}

// 16 ── ⭐⭐⭐ and expected wins includes them, so the summary still adds up
{
  const F = (margin, win) => ({ me: { scored: 100 }, opp: { scored: 100 - margin }, margin, win, settled: false });
  const r = projectedRecord([F(10, 0.75)], [{ on: true, margin: 5, win: 0.6, myNow: 90, median: 85 }]);
  assert.strictEqual(r.expected, 1.35, '0.75 from the matchup plus 0.6 from the median');
  // A league WITHOUT median scoring contributes nothing extra, even if the object is passed through.
  const off = projectedRecord([F(10, 0.75)], [{ on: false, margin: 5, win: 0.6 }]);
  assert.strictEqual(off.games, 1, 'a league that does not use median scoring is one game');
  ok('16 · ⭐⭐⭐ expected wins counts both halves, and a non-median league is untouched');
}

console.log(`\n${n} passed`);
