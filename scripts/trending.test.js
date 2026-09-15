/* WHO IS ABOUT TO BE GOOD — b142.
 *
 * Trey asked for a "trending up" signal on free agents and named three inputs himself: usage stats, the
 * injury-makes-him-the-starter case, and something like percent-owned. This suite is organised around the
 * two ways a signal like this fails, because they are both much likelier than an arithmetic mistake:
 *
 * ⚠⚠ FAILURE ONE — IT FIRES FOR EVERYBODY. This project has produced that twice: the early-plan "still
 *   there at your next pick" flag fired for NOBODY across two fixtures, and the positional-run detector
 *   fired for all four positions in 100% of mocks. Both passed every check anyone had written, because
 *   "does this separate the field" is a question you only ask deliberately. §5 is that question, asked of
 *   every signal, against a field built so that the right answer is known and is neither all nor none.
 *
 * ⚠⚠ FAILURE TWO — IT GOES SILENT AND NOBODY NOTICES. The sandbox these signals were written in cannot
 *   reach Sleeper, so `off_snp` is a well-reasoned guess. If it is wrong, `roleTrend` returns null for
 *   every player forever and the page just looks calm. §4 pins that a missing field produces NULL rather
 *   than a confident `false`, and §6 pins that the audit says so out loud.
 */
import assert from 'assert';
import {
  usageTrend, roleTrend, opportunityChange, ownershipSurge, trendFor, auditFields,
  opportunityOf, snapShareOf, isUnavailable, SIGNAL_ORDER,
} from '../src/lib/trending.js';

let n = 0;
const ok = (m) => { n++; console.log('  PASS  ' + m); };

// A week of stats for a player: targets, carries, and optionally his snaps out of the team's.
const W = (tgt, att, snp, tm) => {
  const o = {};
  if (tgt != null) o.rec_tgt = tgt;
  if (att != null) o.rush_att = att;
  if (snp != null) o.off_snp = snp;
  if (tm != null) o.tm_off_snp = tm;
  return o;
};
const P = (id, extra = {}) => ({ player_id: String(id), full_name: `Player ${id}`, position: 'RB', ...extra });

// 1 ── the two raw readings, and what they do with a gap
{
  assert.strictEqual(opportunityOf(W(5, 3)), 8, 'targets and carries are both opportunities');
  assert.strictEqual(opportunityOf(W(5, null)), 5, 'a receiver with no carries still has opportunity');
  assert.strictEqual(opportunityOf(W(null, null)), null, 'no usage fields at all is NOT zero opportunity');
  assert.strictEqual(opportunityOf(null), null);
  assert.strictEqual(snapShareOf(W(0, 0, 40, 80)), 0.5);
  assert.strictEqual(snapShareOf(W(0, 0, 40, null)), null, 'no team total means no share, not a share of zero');
  assert.strictEqual(snapShareOf(W(0, 0, null, 80)), null);
  assert.strictEqual(snapShareOf(W(0, 0, 40, 0)), null, 'a team with zero snaps is bad data, not 100%');
  ok('1 · ⭐⭐⭐⭐ a missing field reads as UNKNOWN, never as a zero — the whole file rests on this');
}

// 2 ── usage: the slow, certain signal
{
  // Climbing hard: 3,4 → 11,13. Real jump, real volume.
  const rising = usageTrend([W(2, 1), W(3, 1), W(7, 4), W(9, 4)]);
  assert.strictEqual(rising.fired, true);
  assert.ok(/up from/.test(rising.why), 'the sentence names both numbers so a reader can check it');
  /* ⭐⭐⭐⭐⭐ THE FLOOR IS THE POINT. A man going from one opportunity to three has TRIPLED his usage —
     a ratio that beats every genuine breakout on the board — and has told you precisely nothing. Without
     an absolute floor this signal ranks the deepest bench scrubs in football at the top of the page. */
  const noise = usageTrend([W(0, 1), W(1, 0), W(2, 1), W(1, 2)]);
  assert.strictEqual(noise.fired, false, 'one target to three is a tripling and is still nothing');
  // Busy but flat — the every-week starter. Must NOT fire, or every good player is "trending".
  const steady = usageTrend([W(8, 6), W(9, 5), W(7, 7), W(8, 6)]);
  assert.strictEqual(steady.fired, false, 'a high but flat workload is not a trend');
  // Falling.
  assert.strictEqual(usageTrend([W(10, 8), W(9, 7), W(3, 1), W(2, 2)]).fired, false);
  ok('2 · ⭐⭐⭐⭐⭐ usage needs BOTH a ratio and a volume — a tripling from nothing is still nothing');

  // Too little history to have a baseline at all is NO DATA, not "flat".
  assert.strictEqual(usageTrend([W(9, 4), W(9, 4)]), null, 'two weeks cannot produce a baseline AND a window');
  assert.strictEqual(usageTrend([]), null);
  assert.strictEqual(usageTrend(null), null);
  /* ⚠ AND A FULL SET OF UNREADABLE WEEKS IS ALSO NO DATA. This is the case that catches a wrong field
     name: four weeks arrive, every one of them is missing rec_tgt and rush_att, and a careless
     implementation reports a confident "usage flat". */
  assert.strictEqual(usageTrend([W(null, null), W(null, null), W(null, null), W(null, null)]), null,
    'four unreadable weeks is missing data, not a flat trend');
  ok('2b · ⭐⭐⭐⭐⭐ …and weeks it cannot read produce NULL, which is how a wrong field name stays visible');
}

// 3 ── role: the same question asked of snaps, which catches what usage misses
{
  /* ⭐⭐⭐⭐ THE CASE THIS EXISTS FOR: a committee back who takes over the early-down work. His snap share
     doubles and the ball has not found him yet, so USAGE says nothing and ROLE says everything. That gap
     is the entire reason both signals ship instead of one. */
  const promoted = roleTrend([W(2, 3, 20, 70), W(2, 4, 22, 70), W(3, 5, 52, 70)]);
  assert.strictEqual(promoted.fired, true, '30% of snaps to 74% is a role change');
  assert.ok(/up from/.test(promoted.why));
  const bellcow = roleTrend([W(6, 14, 60, 70), W(7, 15, 62, 70), W(6, 16, 61, 70)]);
  assert.strictEqual(bellcow.fired, false, 'a man who always plays is not newly playing');
  const backup = roleTrend([W(0, 1, 8, 70), W(1, 1, 10, 70), W(1, 2, 18, 70)]);
  assert.strictEqual(backup.fired, false, 'doubling from 11% to 26% is still a backup');
  assert.strictEqual(roleTrend([W(2, 3), W(2, 4)]), null, 'no snap fields at all is NO DATA');
  ok('3 · ⭐⭐⭐⭐ role catches the man on the field whom the ball has not found yet');
}

// 4 ── opportunity: the only one that beats your league to a player
{
  const ahead1 = P(1, { depth_chart_position: 'RB', depth_chart_order: 1, injury_status: 'IR' });
  const ahead2 = P(2, { depth_chart_position: 'RB', depth_chart_order: 2, injury_status: null });
  const me = P(3, { depth_chart_position: 'RB', depth_chart_order: 3 });

  // Only one of the two ahead of him is out — he has not inherited anything.
  const partial = opportunityChange(me, [ahead1, ahead2]);
  assert.strictEqual(partial.fired, false);
  assert.ok(/still ahead/.test(partial.why), 'and it says what is still in his way');
  // Both out — the job is his.
  const clear = opportunityChange(me, [ahead1, { ...ahead2, injury_status: 'Out' }]);
  assert.strictEqual(clear.fired, true);
  assert.ok(/out/i.test(clear.why) && /Player/.test(clear.why), 'the sentence names who is out');
  ok('4 · ⭐⭐⭐⭐⭐ a promotion needs EVERY man ahead of him gone, not just one');

  /* ⭐⭐⭐⭐⭐ "QUESTIONABLE" IS NOT AN ABSENCE. It is the most common tag in football — a large share of
     the league carries it every Friday — and counting it as a promotion would fire this signal for half
     the player pool, which is the fires-for-everybody failure this suite exists to prevent. */
  assert.strictEqual(isUnavailable('Questionable'), false);
  assert.strictEqual(isUnavailable('Probable'), false);
  assert.strictEqual(isUnavailable(null), false);
  assert.strictEqual(isUnavailable('Out'), true);
  assert.strictEqual(isUnavailable('IR'), true);
  assert.strictEqual(isUnavailable('doubtful'), true, 'case does not matter; the feed is inconsistent about it');
  const qOnly = opportunityChange(me, [{ ...ahead1, injury_status: 'Questionable' }, { ...ahead2, injury_status: 'Questionable' }]);
  assert.strictEqual(qOnly.fired, false, 'two questionable men ahead of him is a normal Friday');
  ok('4b · ⭐⭐⭐⭐⭐ …and "questionable" is a normal Friday, not a promotion');

  // No depth chart for him at all: NO DATA. Must never read as "nobody ahead of him, he is the starter".
  assert.strictEqual(opportunityChange(P(9, { depth_chart_order: null }), [ahead1]), null);
  assert.strictEqual(opportunityChange(null, []), null);
  // Genuinely the starter already — a fact, but not a change, and not a reason to add him.
  const starter = opportunityChange(P(4, { depth_chart_position: 'RB', depth_chart_order: 1 }), [ahead2]);
  assert.strictEqual(starter.fired, false);
  assert.ok(/already/.test(starter.why));
  ok('4c · ⭐⭐⭐⭐⭐ a missing depth chart is UNKNOWN, never "he must be the starter"');
}

// 5 ── ⭐⭐⭐⭐⭐ DOES ANY OF THIS SEPARATE THE FIELD?
{
  /* THE QUESTION THAT CAUGHT TWO EARLIER DETECTORS ON THIS PROJECT. A flag true for everyone and a flag
     true for no one both pass every assertion above — they are individually correct on each fixture and
     collectively useless. So: a field of ten players built so the right answer is KNOWN, and neither all
     nor none. Four should fire, six should not, and the four should be the four we mean. */
  const team = [];
  const mk = (id, kind) => {
    if (kind === 'blocked') return P(id, { depth_chart_position: 'RB', depth_chart_order: 3 });
    if (kind === 'promoted') return P(id, { depth_chart_position: 'WR', depth_chart_order: 2 });
    return P(id, { depth_chart_position: 'TE', depth_chart_order: 2 });
  };
  const rbAhead = [
    P(90, { depth_chart_position: 'RB', depth_chart_order: 1, injury_status: null }),
    P(91, { depth_chart_position: 'RB', depth_chart_order: 2, injury_status: 'Out' }),
  ];
  const wrAhead = [P(92, { depth_chart_position: 'WR', depth_chart_order: 1, injury_status: 'IR' })];

  const field = [
    // SHOULD FIRE — usage climbing hard and from a real base.
    { id: 'a', weeks: [W(2, 1), W(3, 2), W(8, 5), W(9, 6)], mates: [], want: ['usage'] },
    // SHOULD FIRE — snap share jumped; ball has not arrived yet.
    { id: 'b', weeks: [W(1, 2, 18, 70), W(1, 2, 20, 70), W(2, 3, 50, 70)], mates: [], want: ['role'] },
    // SHOULD FIRE — the only man ahead of him is on IR.
    { id: 'c', weeks: [W(2, 1), W(2, 1), W(2, 2)], mates: wrAhead, kind: 'promoted', want: ['opportunity'] },
    // SHOULD FIRE — being added everywhere and still free here.
    { id: 'd', weeks: [W(3, 1), W(2, 2), W(3, 2)], mates: [], want: ['ownership'] },
    // SHOULD NOT — the established every-week starter. Busy, but nothing is changing.
    { id: 'e', weeks: [W(8, 6), W(9, 5), W(8, 7), W(9, 6)], mates: [], want: [] },
    // SHOULD NOT — a scrub whose tiny usage doubled.
    { id: 'f', weeks: [W(0, 1), W(1, 0), W(1, 1), W(2, 1)], mates: [], want: [] },
    // SHOULD NOT — still stuck behind a healthy starter.
    { id: 'g', weeks: [W(2, 2), W(2, 1), W(3, 2)], mates: rbAhead, kind: 'blocked', want: [] },
    // SHOULD NOT — declining.
    { id: 'h', weeks: [W(9, 7), W(8, 6), W(2, 1), W(1, 1)], mates: [], want: [] },
    // SHOULD NOT — snap share high but unchanged.
    { id: 'i', weeks: [W(5, 5, 60, 70), W(5, 6, 61, 70), W(6, 5, 60, 70)], mates: [], want: [] },
    /* SHOULD NOT — and this is the player who moved a threshold. 2.5 touches a game to 4.5 clears a
       ratio test and a +2 gain test comfortably, and is still nobody you would pick up. He stays in the
       field as a must-NOT-fire case so the floor can never quietly drift back down. */
    { id: 'j', weeks: [W(1, 1), W(2, 1), W(2, 2), W(3, 2)], mates: [], want: [] },
  ];
  // Ranked feed (29x): player 'd' is 5th most added in the country; the others are far down it.
  const adds = new Map([['d', { count: 14000, rank: 5 }]]);
  const results = field.map((f) => {
    const player = f.kind ? mk(f.id, f.kind) : P(f.id);
    const t = trendFor({ player, teammates: f.mates, weeks: f.weeks, addsByPlayer: adds });
    return { id: f.id, want: f.want, got: t.fired.map((s) => s.kind), t };
  });

  const firedIds = results.filter((r) => r.got.length).map((r) => r.id);
  assert.ok(firedIds.length > 0, 'a signal that fires for nobody is not a signal');
  assert.ok(firedIds.length < field.length, 'a signal that fires for everybody is not a signal either');
  assert.deepStrictEqual(firedIds.sort(), ['a', 'b', 'c', 'd'],
    `exactly the four intended players fire — got ${firedIds.join(',')}`);
  ok(`5 · ⭐⭐⭐⭐⭐ the flags separate the field — 4 of 10 fire, and they are the right 4`);

  // And each fires for the RIGHT REASON, which is what makes the sentence on the row trustworthy.
  for (const r of results) {
    assert.deepStrictEqual(r.got.sort(), r.want.slice().sort(),
      `${r.id}: expected [${r.want}] but fired [${r.got}]`);
  }
  ok('5b · ⭐⭐⭐⭐⭐ …each for the reason it was supposed to, not by luck through another signal');

  /* ⭐⭐⭐⭐ AND THE ORDER IS BY HOW EARLY, NOT HOW STRONG. The whole point of the opportunity signal is
     beating your league to a player, so it must lead a row even when a usage trend is better evidence. */
  const both = trendFor({
    player: P(50, { depth_chart_position: 'WR', depth_chart_order: 2 }),
    teammates: wrAhead,
    weeks: [W(2, 1), W(3, 2), W(8, 5), W(9, 6)],
    addsByPlayer: adds,
  });
  assert.ok(both.fired.length >= 2, 'this player fires on both counts');
  assert.strictEqual(both.top.kind, 'opportunity', 'the early signal leads even when usage is better evidence');
  assert.deepStrictEqual(SIGNAL_ORDER, ['opportunity', 'role', 'usage', 'ownership']);
  ok('5c · ⭐⭐⭐⭐ …and the earliest signal leads the row, because early is the point');
}

// 6 ── ownership, and the inversion that makes it worth shipping
{
  /* ⚠ RANK, NOT COUNT — 29x. This used to be `count >= 1000`, and Sleeper hosts millions of leagues, so a
     thousand adds is an ordinary week for anyone mildly interesting: dozens of players fired and the
     free-agent list came back with 60+ names. Rank self-normalises across a quiet week and a wild one. */
  const adds = new Map([['x', { count: 22000, rank: 3 }], ['y', { count: 9000, rank: 90 }]]);
  assert.strictEqual(ownershipSurge('x', adds).fired, true, 'third most added in the country is a real signal');
  assert.ok(/still free in yours/.test(ownershipSurge('x', adds).why),
    'the sentence carries the inversion: the world wants him and your league has not noticed');
  /* ⭐⭐⭐⭐⭐ THE CASE THAT CAUSED THE BUG: a big-looking number that means nothing. Nine thousand adds
     would have sailed past the old threshold; ranked 90th in the country, he is background noise. */
  assert.strictEqual(ownershipSurge('y', adds).fired, false,
    'nine thousand adds is still nothing if ninety players are ahead of him');
  // Not on the list at all is a real answer — the crowd is not moving on him.
  const absent = ownershipSurge('zzz', adds);
  assert.strictEqual(absent.fired, false);
  assert.strictEqual(absent.adds, 0);
  // A bare count from an older cached feed must still be readable rather than throwing.
  const legacy = new Map([['x', 22000]]);
  assert.strictEqual(ownershipSurge('x', legacy).fired, false, 'no rank means no claim, not a false one');
  /* ⚠ BUT NO FEED AT ALL IS NOT "NOBODY IS ADDING HIM". If the endpoint 403s in production — which is
     exactly what it does from the sandbox this was written in — every player must read UNKNOWN, or the
     page quietly asserts that the entire league is uninterested in everybody. */
  assert.strictEqual(ownershipSurge('x', new Map()), null, 'an empty feed is no data, not no interest');
  assert.strictEqual(ownershipSurge('x', null), null);
  ok('6 · ⭐⭐⭐⭐⭐ a dead ownership feed reads as UNKNOWN, never as "nobody wants him"');
}

// 7 ── ⭐⭐⭐⭐⭐ THE INSTRUMENT — what actually arrived
{
  /* The field names in trending.js were read off this codebase's own mappers and Sleeper's documented
     shapes, NOT off a live response, because the sandbox cannot reach Sleeper. If `off_snp` is wrong the
     role signal is dead forever and the page just looks calm. The audit is what makes that loud. */
  const statRows = [
    { player_id: '1', stats: { rec_tgt: 5, rush_att: 2, tm_off_snp: 70 } },
    { player_id: '2', stats: { rec_tgt: 3, tm_off_snp: 70 } },
  ];
  const playerRows = [
    P(1, { depth_chart_order: 1, depth_chart_position: 'RB', injury_status: 'Out' }),
    P(2, { depth_chart_order: null }),
  ];
  const a = auditFields(statRows, playerRows, new Map([['1', 900]]));
  const fieldOf = (k) => a.fields.find((f) => f.field === k);
  assert.strictEqual(fieldOf('rec_tgt').have, 2);
  assert.strictEqual(fieldOf('off_snp').have, 0, 'the fixture deliberately omits it, as production might');
  assert.strictEqual(fieldOf('depth_chart_order').have, 1);
  /* ⭐⭐⭐⭐⭐ AND THE AUDIT NAMES THE DEAD SIGNAL. "role" is dead here because off_snp arrived for nobody
     — which is a completely different statement from "role did not fire this week", and the only one of
     the two that means somebody has to go and change a string. */
  assert.ok(a.dead.includes('role'), 'a field that arrived for NOBODY marks its signal dead');
  assert.ok(!a.dead.includes('usage'), 'usage has its inputs and is merely quiet');
  assert.ok(!a.dead.includes('ownership'), 'the adds feed returned something');
  assert.ok(auditFields([], [], new Map()).dead.length === 4, 'no data at all means every signal is dead');
  ok('7 · ⭐⭐⭐⭐⭐ the audit separates "did not fire" from "never had its input" — by field, with counts');
}

console.log(`\n${n} passed`);
