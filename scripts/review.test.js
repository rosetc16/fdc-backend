/* THE WEEKLY REVIEW'S ARITHMETIC — b133.
 *
 * Trey: "should you have started someone else? Was there a FA? Was it good luck or bad luck that you won
 * or lost? Give weekly trends not just for your matchup, but also compare it to the league."
 *
 * ⚠ EVERY NUMBER ON THIS PAGE IS AN ACCUSATION OR AN EXCUSE, so every one of them has to be right.
 *   "You left 18 points on your bench" that is really 4 teaches the wrong lesson and costs trust the first
 *   time he checks it by hand — and he will check it by hand, because the whole page is second-guessing.
 *   The examples below are worked out on paper in the comments so a future change has something to argue
 *   with that is not the code itself.
 *
 * ⚠ THE GREEDY IS THE INTERESTING PART. "Highest scorer first" is wrong; "fussiest slot first" is right
 *   for nested eligibility and admits it is approximate otherwise. §2 is the case that separates them.
 */
import assert from 'assert';
import { optimalLineup, lineupMisses, allPlay, median, verdictFor, seasonLedger, pointRanks, eligibleFor, isLineupSlot, playedGate, weekCompleteness } from '../src/lib/review.js';

let n = 0;
const ok = (m) => { n++; console.log('  PASS  ' + m); };

// A tiny roster we can reason about in our heads.
//   QB  Goff      18      RB  Kyren    6      WR  Chase   22     TE  Kincaid  4
//   QB  Mayfield  25      RB  Irving  22      WR  Nacua   19     TE  Ferguson 11
//                         RB  Corum    3      WR  Ferrand  8
const POS = { goff: 'QB', mayfield: 'QB', kyren: 'RB', irving: 'RB', corum: 'RB',
  chase: 'WR', nacua: 'WR', ferrand: 'WR', kincaid: 'TE', ferguson: 'TE', karty: 'K', den: 'DEF' };
const PTS = { goff: 18, mayfield: 25, kyren: 6, irving: 22, corum: 3,
  chase: 22, nacua: 19, ferrand: 8, kincaid: 4, ferguson: 11, karty: 9, den: 7 };
const ALL = Object.keys(POS);
const ptsOf = (s) => (PTS[s] == null ? null : PTS[s]);
const posOf = (s) => POS[s] || null;
const nameOf = (s) => s;

// 1 ── the slot vocabulary
{
  assert.deepStrictEqual(eligibleFor('FLEX').sort(), ['RB', 'TE', 'WR']);
  assert.deepStrictEqual(eligibleFor('SUPER_FLEX').sort(), ['QB', 'RB', 'TE', 'WR']);
  assert.ok(eligibleFor('DEF').includes('DST'), 'DEF and DST are the same slot under two spellings');
  assert.ok(isLineupSlot('FLEX') && isLineupSlot('QB'));
  assert.ok(!isLineupSlot('BN') && !isLineupSlot('IR') && !isLineupSlot('TAXI'),
    'bench, IR and taxi are not lineup slots — counting them would invent slots you never had');
  ok('1 · ⭐⭐ lineup slots are told apart from bench/IR, and flex eligibility is right');
}

// 2 ── ⭐⭐⭐⭐⭐ THE CASE THAT BREAKS "HIGHEST SCORER FIRST"
{
  /* One RB slot, one FLEX. Highest-first gives FLEX to Irving (22), leaving the RB slot to Kyren (6):
       22 + 6 = 28.
     Fussiest-slot-first gives RB to Irving (22), then FLEX takes the best remaining of RB/WR/TE, which is
     Chase (22):
       22 + 22 = 44.
     Sixteen points, on a two-slot lineup. */
  const rp = ['RB', 'FLEX'];
  const o = optimalLineup(rp, ['kyren', 'irving', 'chase'], ptsOf, posOf);
  assert.strictEqual(o.total, 44, 'the fussy slot must be served before the permissive one');
  assert.ok(o.exact, 'RB ⊂ FLEX is nested, so this answer is exact');
  ok('2 · ⭐⭐⭐⭐⭐ the restrictive slot is filled first — greedy-by-points would be 16 points wrong here');
}

// 3 ── a full, ordinary lineup
{
  /* QB RB RB WR WR TE FLEX K DEF, from the roster above.
       QB   Mayfield 25
       RB   Irving   22   RB Kyren 6
       WR   Chase    22   WR Nacua 19
       TE   Ferguson 11
       FLEX best remaining of RB/WR/TE: Ferrand 8 (Corum 3, Kincaid 4)
       K    Karty     9
       DEF  DEN       7
     = 25+22+6+22+19+11+8+9+7 = 129 */
  const rp = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN', 'BN'];
  const o = optimalLineup(rp, ALL, ptsOf, posOf);
  assert.strictEqual(o.total, 129);
  assert.strictEqual(o.slots.filter((s) => s.sid).length, 9, 'nine slots, nine players — BN is not a slot');
  ok('3 · ⭐⭐⭐ a full lineup totals what it totals by hand (129)');
}

// 4 ── ⭐⭐⭐⭐ WHAT IT COST, AS A SWAP HE CAN ACT ON
{
  const rp = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF'];
  // What he ACTUALLY started: Goff over Mayfield, Corum over Irving, Kincaid over Ferguson.
  const started = ['goff', 'kyren', 'corum', 'chase', 'nacua', 'kincaid', 'ferrand', 'karty', 'den'];
  //  actual = 18+6+3+22+19+4+8+9+7 = 96 ; optimal 129 ; left 33
  const r = lineupMisses(rp, started, ALL, ptsOf, posOf, nameOf);
  assert.strictEqual(r.actual, 96);
  assert.strictEqual(r.optimal, 129);
  assert.strictEqual(r.left, 33);
  // ⭐ The swaps must be POSITIONALLY LEGAL — a QB may not be offered as the fix for a TE slot.
  for (const m of r.misses) {
    const elig = eligibleFor(m.slot);
    assert.ok(elig.includes(m.inPos), `${m.in} (${m.inPos}) is not eligible at ${m.slot}`);
    assert.ok(elig.includes(m.outPos), `${m.out} (${m.outPos}) could not have been in ${m.slot}`);
  }
  const byIn = Object.fromEntries(r.misses.map((m) => [m.in, m]));
  assert.ok(byIn.irving && byIn.irving.out === 'corum', 'Irving in for Corum');
  assert.strictEqual(byIn.irving.gain, 19);
  assert.ok(byIn.mayfield && byIn.mayfield.out === 'goff', 'Mayfield in for Goff');
  assert.ok(byIn.ferguson && byIn.ferguson.out === 'kincaid', 'Ferguson in for Kincaid');
  // ⭐ Biggest regret first — the list is read top-down and stops being read quickly.
  assert.deepStrictEqual(r.misses.map((m) => m.gain), [...r.misses.map((m) => m.gain)].sort((a, b) => b - a));
  ok('4 · ⭐⭐⭐⭐ misses are real, legal, position-matched swaps, biggest regret first');
}

// 5 ── a perfect week accuses nobody
{
  const rp = ['QB', 'RB', 'FLEX'];
  const r = lineupMisses(rp, ['mayfield', 'irving', 'chase'], ['mayfield', 'irving', 'chase', 'corum'], ptsOf, posOf, nameOf);
  assert.strictEqual(r.left, 0);
  assert.deepStrictEqual(r.misses, []);
  ok('5 · ⭐⭐⭐ a lineup that was already optimal produces no regrets and zero left on the bench');
}

// 6 ── ⭐⭐⭐ THE APPROXIMATION IS DECLARED, NOT HIDDEN
{
  // WRRB_FLEX (RB/WR) and REC_FLEX (WR/TE) overlap on WR without either containing the other.
  const odd = optimalLineup(['WRRB_FLEX', 'REC_FLEX'], ALL, ptsOf, posOf);
  assert.strictEqual(odd.exact, false, 'overlapping-but-not-nested slots must flag the answer approximate');
  const normal = optimalLineup(['QB', 'RB', 'WR', 'FLEX', 'SUPER_FLEX'], ALL, ptsOf, posOf);
  assert.strictEqual(normal.exact, true, 'nested flex families are exact');
  ok('6 · ⭐⭐⭐ an unusual slot combination reports itself approximate rather than asserting a wrong regret');
}

// 7 ── players with no recorded score are not zeros
{
  // A player who did not play at all has no entry in players_points. Treating that as 0 is harmless for
  // the total but would let him be "picked" for an empty slot and printed as a recommendation.
  const o = optimalLineup(['QB'], ['ghost'], () => null, () => 'QB');
  assert.strictEqual(o.slots[0].sid, null, 'a player with no score is never the optimal pick');
  assert.strictEqual(o.total, 0);
  ok('7 · ⭐⭐ a player with no recorded score is skipped rather than counted as zero points');
}

// 8 ── ⭐⭐⭐⭐ ALL-PLAY, INCLUDING THE SELF-EXCLUSION THAT IS EASY TO GET WRONG
{
  //          me     others
  const week = [118, 131, 95, 140, 102, 118];    // twelve-team shape trimmed to six for arithmetic
  const ap = allPlay(118, week);
  // Against 131, 95, 140, 102, 118 → beat 95 and 102 (2), lost to 131 and 140 (2), tied 118 (1).
  assert.deepStrictEqual({ w: ap.w, l: ap.l, t: ap.t }, { w: 2, l: 2, t: 1 });
  assert.strictEqual(ap.of, 6);
  assert.strictEqual(ap.rank, 3, 'two teams scored more, so third');
  // ⚠ The tie at 118 is ANOTHER TEAM, not a duplicate of me — dropping every equal score would erase it.
  assert.strictEqual(ap.w + ap.l + ap.t, 5, 'five opponents from six scores');
  ok('8 · ⭐⭐⭐⭐ all-play excludes exactly one copy of your own score and keeps genuine ties');
}

// 9 ── the median, on both parities
{
  assert.strictEqual(median([1, 2, 3]), 2);
  assert.strictEqual(median([1, 2, 3, 4]), 2.5);
  assert.strictEqual(median([]), null);
  ok('9 · ⭐⭐ the median handles odd and even fields and an empty one');
}

// 10 ── ⭐⭐⭐⭐⭐ THE FOUR VERDICTS, AND THE ONE THAT BLAMES HIM
{
  const field = [140, 131, 128, 118, 102, 95];

  // Lost with the second-best score in the league.
  const robbed = verdictFor({ won: false, myPts: 131, allPtsThisWeek: field, optimalPts: 135, oppPts: 140, oppAvg: 112 });
  assert.strictEqual(robbed.key, 'robbed');
  assert.match(robbed.text, /28/, 'names how far over their average the opponent went');

  // Won with a below-median score.
  const lucky = verdictFor({ won: true, myPts: 102, allPtsThisWeek: field, optimalPts: 110, oppPts: 95, oppAvg: 118 });
  assert.strictEqual(lucky.key, 'lucky');

  /* ⭐⭐⭐⭐⭐ THE ONE THE PAGE EXISTS FOR. A middling score, a loss — and the lineup he COULD have set
     beats the opponent. Any review that cannot say this out loud is a comfort blanket. */
  const blown = verdictFor({ won: false, myPts: 118, allPtsThisWeek: field, optimalPts: 136, oppPts: 128, oppAvg: 126 });
  assert.strictEqual(blown.key, 'blown');
  assert.match(blown.text, /lineup/i);

  // An ordinary, deserved loss is not dressed up as either.
  const earned = verdictFor({ won: false, myPts: 95, allPtsThisWeek: field, optimalPts: 99, oppPts: 128, oppAvg: 126 });
  assert.strictEqual(earned.key, 'earned');
  ok('10 · ⭐⭐⭐⭐⭐ robbed / lucky / blown / earned are told apart — including the one that says it was his fault');
}

// 11 ── ⭐⭐⭐⭐ THE LEDGER: "you are 3-4 and deserve to be 5-2"
{
  const mk = (week, pts, oppPts, result, apw, apl, key) => ({
    week, pointsByRoster: {}, opponentByRoster: {},
    me: { pts, oppPts, result, left: 5, allPlay: { w: apw, l: apl, t: 0 }, verdict: { key } },
  });
  const weeks = [
    mk(1, 130, 140, 'L', 9, 2, 'robbed'),
    mk(2, 120, 110, 'W', 7, 4, 'earned'),
    mk(3, 100, 125, 'L', 3, 8, 'earned'),
    mk(4, 135, 120, 'W', 10, 1, 'earned'),
    mk(5, 115, 118, 'L', 6, 5, 'blown'),
    mk(6, 128, 100, 'W', 8, 3, 'earned'),
    mk(7, 108, 131, 'L', 4, 7, 'robbed'),
  ];
  const L = seasonLedger(weeks);
  assert.strictEqual(L.games, 7);
  assert.strictEqual(L.actualW, 3);
  assert.strictEqual(L.actualL, 4);
  // all-play 47-30 → .610 over 7 games → 4.27 → 4
  assert.strictEqual(L.deservedW, 4);
  assert.strictEqual(L.luck, -1, 'a win short of what the scores say he earned');
  assert.strictEqual(L.pointsFor, 836);
  assert.strictEqual(L.pointsAgainst, 844);
  assert.strictEqual(L.leftOnBench, 35);
  assert.deepStrictEqual(L.robbedWeeks, [1, 7]);
  assert.deepStrictEqual(L.blownWeeks, [5]);
  ok('11 · ⭐⭐⭐⭐ the season ledger totals the record, the deserved record, the luck gap and the weeks behind it');
}

// 12 ── ⭐⭐⭐ POINTS AGAINST — bad luck you cannot see in one week
{
  const weeks = [
    { week: 1, pointsByRoster: { 1: 100, 2: 120, 3: 90 }, opponentByRoster: { 1: '2', 2: '1', 3: '3' } },
    { week: 2, pointsByRoster: { 1: 110, 2: 80, 3: 130 }, opponentByRoster: { 1: '3', 2: '1', 3: '1' } },
  ];
  const r = pointRanks(weeks, [1, 2, 3]);
  assert.strictEqual(r.pointsFor['1'], 210);
  assert.strictEqual(r.pointsFor['3'], 220);
  assert.strictEqual(r.pointsForRank['3'], 1, 'most points scored ranks first');
  // Roster 1 faced roster 2 (120) then roster 3 (130) = 250, the most in this tiny league.
  assert.strictEqual(r.pointsAgainst['1'], 250);
  assert.strictEqual(r.pointsAgainstRank['1'], 1);
  ok('12 · ⭐⭐⭐ points for and points against are accumulated and ranked across the season');
}

// 13 ── the shapes that arrive when a week has not happened yet
{
  assert.strictEqual(optimalLineup([], ALL, ptsOf, posOf), null);
  assert.strictEqual(optimalLineup(['BN', 'BN'], ALL, ptsOf, posOf), null, 'a bench-only list is not a lineup');
  assert.strictEqual(allPlay(100, [100]), null, 'one score is not a field');
  assert.strictEqual(allPlay(null, [1, 2, 3]), null);
  assert.strictEqual(seasonLedger([]), null);
  assert.strictEqual(seasonLedger([{ week: 1, me: { pts: null } }]), null, 'an unplayed week is not a ledger');
  ok('13 · ⭐⭐ empty and not-yet-played inputs return null rather than a confident zero');
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
   14–18 ── ⭐⭐⭐⭐⭐ THE KENNETH WALKER CASE, reproduced exactly.

   Trey, looking at a live week: "it says 'Worst Call - Started Kenneth Walker 0 over Chubba Hubbard 22.2'
   — Kenneth Walker hasn't played yet."

   The setup below is his, in miniature. Sleeper's players_points carries an entry for every rostered
   player from the moment the week opens, and it is 0 — so a man who has not kicked off is INDISTINGUISHABLE
   from a man who played and scored nothing, unless you consult the stat feed. `walker` starts, sits at 0.0,
   and has no stat line. `hubbard` is on the bench with 22.2.

   ⚠ WITHOUT THE GATE THESE ARE THE NUMBERS THAT PRODUCED THE COMPLAINT: the optimiser sees a 0-point
     starter and a 22.2-point bench player at the same position and reports a 22.2-point regret. Test 14
     asserts the broken behaviour still follows from the raw map, so that this file documents the bug
     itself rather than only its absence — if someone later "simplifies" ptsOf back to Number(raw), 15
     fails and 14 explains why.
   ══════════════════════════════════════════════════════════════════════════════════════════════════ */
const W_POS = { walker: 'RB', hubbard: 'RB', chase2: 'WR', nacua2: 'WR', goff2: 'QB', kelce2: 'TE' };
const W_SLOTS = ['QB', 'RB', 'WR', 'TE', 'BN', 'BN'];
const W_ROSTER = Object.keys(W_POS);
const W_STARTERS = ['goff2', 'walker', 'chase2', 'kelce2'];
// Exactly what Sleeper sends mid-week: a zero for the man who has not played.
const W_PP = { goff2: 19.4, walker: 0, chase2: 15.1, kelce2: 8.2, hubbard: 22.2, nacua2: 3.1 };
const wPos = (s) => W_POS[s] || null;
const wName = (s) => s;

// 14 ── the bug, stated as arithmetic so the fix has something to be measured against
{
  const naive = (sid) => (W_PP[sid] == null ? null : Number(W_PP[sid]));
  const lm = lineupMisses(W_SLOTS, W_STARTERS, W_ROSTER, naive, wPos, wName);
  const miss = lm.misses.find((m) => m.out === 'walker');
  assert.ok(miss, 'reading the raw map, the optimiser blames the unplayed starter');
  assert.strictEqual(miss.in, 'hubbard');
  assert.strictEqual(Math.round(miss.gain * 10) / 10, 22.2, 'and prices the regret at the full bench score');
  ok('14 · ⭐⭐⭐⭐ the raw players_points map DOES produce the bogus 22.2-point regret (the bug, reproduced)');
}

// 15 ── ⭐⭐⭐⭐⭐ THE FIX: a 0 from a man with no stat line is not a score
{
  const played = new Set(['goff2', 'chase2', 'kelce2', 'hubbard', 'nacua2']);   // walker absent: no stat line
  const { ptsOf: gated } = playedGate(W_PP, played);
  assert.strictEqual(gated('walker'), null, 'an unplayed starter has NO score, not zero');
  assert.strictEqual(gated('hubbard'), 22.2, 'a player who did play keeps his points');
  const lm = lineupMisses(W_SLOTS, W_STARTERS, W_ROSTER, gated, wPos, wName);
  assert.ok(!lm.misses.some((m) => m.out === 'walker'),
    'and no regret may be computed from a decision whose outcome does not exist yet');
  ok('15 · ⭐⭐⭐⭐⭐ with the stat feed, the unplayed starter is invisible to the optimiser');
}

// 16 ── ⭐⭐⭐⭐ a REAL zero still counts against you
{
  // Same 0.0, but this time he played — he was targeted twice and dropped both. That IS a bad start.
  const played = new Set(['goff2', 'walker', 'chase2', 'kelce2', 'hubbard', 'nacua2']);
  const { ptsOf: gated } = playedGate(W_PP, played);
  assert.strictEqual(gated('walker'), 0, 'a zero from a man who played is a zero');
  const lm = lineupMisses(W_SLOTS, W_STARTERS, W_ROSTER, gated, wPos, wName);
  assert.ok(lm.misses.some((m) => m.out === 'walker' && m.in === 'hubbard'),
    'and starting him over a 22-point bench player is a genuine mistake worth reporting');
  ok('16 · ⭐⭐⭐⭐ …while a zero from a man who DID play is still held against you');
}

// 17 ── ⭐⭐⭐⭐ no stat feed is a third state, and it must not blank the season
{
  const { ptsOf: gated } = playedGate(W_PP, null);
  assert.strictEqual(gated('walker'), 0, 'with no feed we cannot tell, so the old behaviour stands');
  assert.strictEqual(gated('nobody'), null, 'a player with no entry at all still has no score');
  const c = weekCompleteness(W_STARTERS, ['hubbard'], null, wName);
  assert.strictEqual(c.complete, true, 'and the week is judged exactly as it was before the feed existed');
  ok('17 · ⭐⭐⭐⭐ a missing stat feed degrades to the old behaviour rather than emptying the review');
}

// 17b ── ⭐⭐⭐⭐⭐ A FINISHED WEEK IS FINISHED, WHATEVER THE STATS FEED LEFT OUT — 29ab
{
  /* Trey: "When I go back to review week one it says I have two left to play (DST and K) but week one is
     over." Kickers and team defences are the rows the weekly stats feed omits most often, so a finished
     week with a stat gap presented itself as still in progress — and that suppressed the RESULT, the
     verdict and the ledger entry for the week. One missing row withdrew a whole week's judgement.
     ⚠ THE FIXTURE IS THE BUG: `played` deliberately omits two starters, exactly as the feed did, and the
       first assertion is the OLD behaviour so the difference `weekOver` makes is visible rather than
       assumed. Without the flag the week reads incomplete; with it, complete. */
  const gappy = new Set(['goff2', 'chase2', 'kelce2', 'nacua2']);   // walker + hubbard missing, as K/DST are
  const before = weekCompleteness(W_STARTERS, ['hubbard'], gappy, wName);
  assert.strictEqual(before.complete, false, 'without the flag a stat gap still reads as unfinished');
  assert.ok(before.yetToPlay > 0);

  const after = weekCompleteness(W_STARTERS, ['hubbard'], gappy, wName, { weekOver: true });
  assert.strictEqual(after.complete, true, 'a week the schedule says is over is over');
  assert.strictEqual(after.yetToPlay, 0, 'and nobody in it is "yet to play"');
  assert.strictEqual(after.oppYetToPlay, 0);
  assert.deepStrictEqual(after.waitingOn, []);
  ok('17b · ⭐⭐⭐⭐⭐ a finished week reports nobody left to play, even where the stats feed has holes',
    `was ${before.yetToPlay} left, now ${after.yetToPlay}`);

  /* ⭐⭐⭐⭐ AND THE SAME FLAG MAKES A ZERO REAL. In a finished week a kicker on 0 scored zero; gating him
     to null hides a genuine bad start from the optimiser and from the bench math. */
  const { ptsOf: open } = playedGate(W_PP, gappy);
  const { ptsOf: done } = playedGate(W_PP, gappy, { weekOver: true });
  assert.strictEqual(open('walker'), null, 'mid-week his 0 is not a score');
  assert.strictEqual(done('walker'), 0, 'in a finished week it is');
  ok('17c · ⭐⭐⭐⭐ …and a 0 from a finished week counts, rather than being gated away as "not played"');
}

// 18 ── ⭐⭐⭐⭐⭐ an unfinished week is not a result — the other half of "I'm 8-2 across 10 leagues"
{
  const played = new Set(['goff2', 'chase2', 'kelce2', 'hubbard', 'nacua2']);
  const c = weekCompleteness(W_STARTERS, ['hubbard', 'nacua2'], played, wName);
  assert.strictEqual(c.complete, false);
  assert.strictEqual(c.yetToPlay, 1);
  assert.deepStrictEqual(c.waitingOn, ['walker'], 'and it names who it is waiting on');
  assert.strictEqual(c.oppYetToPlay, 0, 'their side is done; mine is not');

  // A week still being played must not reach the season record.
  const weeks = [
    { week: 1, me: { pts: 120, oppPts: 100, result: 'W', left: 0, complete: true } },
    { week: 2, me: { pts: 42, oppPts: 30, result: 'W', left: 0, complete: false } },  // three starters to come
  ];
  const led = seasonLedger(weeks);
  assert.strictEqual(led.games, 1, 'only the finished week counts');
  assert.strictEqual(led.actualW, 1, 'and the in-progress "win" is not banked');
  ok('18 · ⭐⭐⭐⭐⭐ an unfinished week is excluded from the record — a scoreline is not a result');
}

console.log(`\n${n} passed`);
