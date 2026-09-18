/* WHO TO ROOT FOR, ACROSS FIFTEEN LEAGUES AT ONCE — b134.
 *
 * Trey: "have this be my hub for what should I be rooting for (especially if you have a lot of leagues and
 * you have stakes in a ton of players, so it would basically show you who you have the most shares in and
 * who you have the most shares to root against."
 *
 * ⚠ THE FEATURE IS THE SUBTRACTION. Every fantasy site can tell you how many of your teams a player is on.
 *   The number that decides whether to cheer is that MINUS the number of your opponents he is on, and
 *   §2 is entirely about not losing the minus sign — including the case that proves it matters, a player
 *   you own in three leagues and face in four, where the naive "you have 3 shares!" is advice pointing
 *   exactly the wrong way.
 *
 * ⚠ AND HIS POINTS ARE NOT ONE NUMBER. Six leagues, six scoring systems, up to six totals for one
 *   afternoon. §4 pins that the spread survives instead of being averaged into something true nowhere.
 */
import assert from 'assert';
import { rootingBoard, dayTotals, sideOf, gameState, weekStateFrom, playerPhase, playedFromStatLine,
  gameProgress, remainingFor, GAME_WALL_MS } from '../src/lib/rooting.js';

let n = 0;
const ok = (m) => { n++; console.log('  PASS  ' + m); };

const NAMES = { jacobs: 'Josh Jacobs', chase: "Ja'Marr Chase", kelce: 'Travis Kelce', goff: 'Jared Goff', hill: 'Tyreek Hill' };
const POS = { jacobs: 'RB', chase: 'WR', kelce: 'TE', goff: 'QB', hill: 'WR' };
const TEAM = { jacobs: 'GB', chase: 'CIN', kelce: 'KC', goff: 'DET', hill: 'MIA' };
const helpers = (stateMap = {}) => ({
  nameOf: (s) => NAMES[s] || `Player ${s}`,
  posOf: (s) => POS[s] || null,
  teamOf: (s) => TEAM[s] || null,
  stateOf: (s) => stateMap[s] || 'pre',
  oppOf: () => null,
});

// A league row as the route builds it: my side and my opponent's side, each a list of started players.
const side = (rosterId, teamName, players, points) => ({ rosterId, teamName, players, pts: points,
  yetToPlay: players.filter((p) => p.state === 'pre').length,
  playing: players.filter((p) => p.state === 'live').length,
  played: players.filter((p) => p.state === 'done').length });
const P = (sid, pts, state = 'pre') => ({ sid, pts, state });

// 1 ── game state, the column that decides how to read a scoreline
{
  const KICK = '2026-09-14T17:00:00Z';
  const t = Date.parse(KICK);
  assert.strictEqual(gameState(KICK, t - 60000), 'pre', 'before kickoff is certain');
  assert.strictEqual(gameState(KICK, t + 60 * 60 * 1000), 'live');
  assert.strictEqual(gameState(KICK, t + 5 * 60 * 60 * 1000), 'done');
  assert.strictEqual(gameState(null), 'unknown', 'no kickoff time is unknown, not "done"');
  assert.strictEqual(gameState('not a date'), 'unknown');
  ok('1 · ⭐⭐⭐ kickoff windows classify pre/live/done, and a missing time is unknown rather than assumed');
}

// 2 ── ⭐⭐⭐⭐⭐ THE SUBTRACTION, INCLUDING THE CASE THAT REVERSES THE ADVICE
{
  /* Jacobs: started by me in 3 leagues (a, b, c), faced in 4 (b, d, e, f).  net −1  → root AGAINST
     Chase:   started by me in 4 (a, b, c, d), faced in 1 (e).               net +3  → root FOR
     Kelce:   me in 1 (d), opponent in 1 (a).                                net  0  → indifferent */
  const L = (id, mine, theirs) => ({ leagueId: id, leagueName: `League ${id}`,
    me: side(1, 'Me', mine.map((s) => P(s, 10))), opp: side(2, 'Them', theirs.map((s) => P(s, 10))) });
  const rows = [
    L('a', ['jacobs', 'chase'], ['kelce']),
    L('b', ['jacobs', 'chase'], ['jacobs']),      // he is on BOTH sides in league b — legal and common
    L('c', ['jacobs', 'chase'], []),
    L('d', ['chase', 'kelce'], ['jacobs']),
    L('e', [], ['jacobs', 'jacobs', 'chase']),    // ⚠ the duplicate id must count as ONE league, not two
    L('f', [], ['jacobs']),
  ];
  const board = rootingBoard(rows, helpers());
  const by = Object.fromEntries(board.map((b) => [b.sid, b]));

  assert.strictEqual(by.jacobs.for, 3, 'started by me in a, b, c');
  /* ⭐⭐⭐⭐ THREE, NOT FOUR. League e lists him twice; one league is one share however many times the
     lineup repeats him, and the alternative inflates the exact number this board exists to report. */
  assert.strictEqual(by.jacobs.against, 4, 'faced in b, d, e and f — e counts once despite listing him twice');
  assert.deepStrictEqual(by.jacobs.againstLeagues.map((l) => l.leagueId), ['b', 'd', 'e', 'f']);
  assert.strictEqual(by.jacobs.net, -1);
  assert.strictEqual(by.chase.for, 4);
  assert.strictEqual(by.chase.against, 1);
  assert.strictEqual(by.chase.net, 3);
  assert.strictEqual(by.kelce.net, 0);
  /* ⭐⭐⭐⭐⭐ The advice a raw share count would have given here is backwards: three of your teams start
     Jacobs, so "3 shares" reads as good news, and in fact you want him to have a quiet day. */
  assert.ok(by.jacobs.for > 0 && by.jacobs.net < 0,
    'a player can be on several of your teams and still be someone to root against');
  ok('2 · ⭐⭐⭐⭐⭐ net = for − against, and it correctly reverses the advice on a player you mostly own');
}

// 3 ── ⭐⭐⭐⭐ the board leads with whoever swings the most, in EITHER direction
{
  const L = (id, mine, theirs) => ({ leagueId: id, leagueName: id,
    me: side(1, 'Me', mine.map((s) => P(s, 5))), opp: side(2, 'Them', theirs.map((s) => P(s, 5))) });
  const rows = [
    L('1', ['chase'], ['hill']), L('2', ['chase'], ['hill']), L('3', ['chase'], ['hill']),
    L('4', ['chase'], ['hill']), L('5', ['kelce'], ['goff']),
  ];
  const board = rootingBoard(rows, helpers());
  assert.strictEqual(Math.abs(board[0].net), 4);
  assert.strictEqual(Math.abs(board[1].net), 4);
  /* ⭐ A −4 must not sort below a +1. The player you are facing in four leagues is exactly as much of
     your afternoon as the one you own in four. */
  const netsTop2 = board.slice(0, 2).map((b) => b.net).sort((a, b) => a - b);
  assert.deepStrictEqual(netsTop2, [-4, 4]);
  assert.ok(Math.abs(board[2].net) <= 1, 'the ±1 players come after the ±4s');
  ok('3 · ⭐⭐⭐⭐ the board ranks by absolute swing, so root-against players are not buried under root-fors');
}

// 4 ── ⭐⭐⭐⭐ SIX LEAGUES, SIX SCORING SYSTEMS, SIX DIFFERENT TOTALS
{
  const rows = [
    { leagueId: 'ppr', leagueName: 'PPR', me: side(1, 'Me', [P('chase', 22.4, 'done')]), opp: side(2, 'T', []) },
    { leagueId: 'half', leagueName: 'Half', me: side(1, 'Me', [P('chase', 18.9, 'done')]), opp: side(2, 'T', []) },
    { leagueId: 'std', leagueName: 'Std', me: side(1, 'Me', [P('chase', 15.4, 'done')]), opp: side(2, 'T', []) },
  ];
  const [c] = rootingBoard(rows, helpers({ chase: 'done' }));
  assert.strictEqual(c.pts.lo, 15.4);
  assert.strictEqual(c.pts.hi, 22.4);
  assert.strictEqual(c.pts.median, 18.9);
  /* ⭐⭐⭐⭐ The flag that stops one number being printed as though it were true everywhere. */
  assert.strictEqual(c.pts.varies, true, 'a 7-point spread across scoring systems must be declared');
  // …and a player scored identically everywhere does NOT get the noisy range treatment.
  const same = rootingBoard([
    { leagueId: 'a', leagueName: 'a', me: side(1, 'Me', [P('goff', 14.2, 'done')]), opp: side(2, 'T', []) },
    { leagueId: 'b', leagueName: 'b', me: side(1, 'Me', [P('goff', 14.2, 'done')]), opp: side(2, 'T', []) },
  ], helpers());
  assert.strictEqual(same[0].pts.varies, false);
  ok('4 · ⭐⭐⭐⭐ per-league scoring differences survive as a range rather than being averaged into a fiction');
}

// 5 ── which leagues, by name, on each side
{
  const rows = [
    { leagueId: 'x', leagueName: 'Work League', me: side(1, 'Me', [P('hill', 9)]), opp: side(2, 'T', []) },
    { leagueId: 'y', leagueName: 'Dynasty', me: side(1, 'Me', []), opp: side(2, 'T', [P('hill', 9)]) },
  ];
  const [h] = rootingBoard(rows, helpers());
  assert.deepStrictEqual(h.forLeagues.map((l) => l.leagueName), ['Work League']);
  assert.deepStrictEqual(h.againstLeagues.map((l) => l.leagueName), ['Dynasty']);
  // ⚠ Names, not ids — "you are facing him in Dynasty" is actionable; "you are facing him in 8f2a" is not.
  ok('5 · ⭐⭐⭐ each side names the leagues it comes from');
}

// 6 ── ⭐⭐⭐⭐ YET TO PLAY — the number that says whether a deficit is real
{
  const rows = [{ leagueId: 'a', leagueName: 'a',
    me: side(1, 'Me', [P('chase', 0, 'pre'), P('jacobs', 22, 'done'), P('kelce', 6, 'live')], 28),
    opp: side(2, 'T', [P('hill', 31, 'done'), P('goff', 17, 'done')], 48) }];
  const t = dayTotals(rows);
  assert.strictEqual(t.losing, 1);
  assert.strictEqual(t.yetToPlay, 1, 'one of mine has not kicked off');
  assert.strictEqual(t.oppYetToPlay, 0, 'all of theirs are done');
  /* ⭐⭐⭐⭐ Down 20 with a player left and none for them is a live afternoon; the totals have to carry
     that, because the scoreline alone says the opposite. */
  assert.strictEqual(t.pointsFor, 28);
  assert.strictEqual(t.pointsAgainst, 48);
  ok('6 · ⭐⭐⭐⭐ the day totals count who is still to play on each side, not just the score');
}

// 7 ── the day at a glance, including "close enough to still watch"
{
  const mk = (mine, theirs) => ({ leagueId: `${mine}-${theirs}`, leagueName: 'L',
    me: side(1, 'Me', [P('chase', mine, 'done')], mine), opp: side(2, 'T', [P('hill', theirs, 'done')], theirs) });
  const t = dayTotals([mk(120, 100), mk(100, 120), mk(110, 108), mk(90, 140), mk(105, 105)]);
  // 120-100 W · 100-120 L · 110-108 W · 90-140 L · 105-105 T
  assert.strictEqual(t.leagues, 5);
  assert.strictEqual(t.winning, 2);
  assert.strictEqual(t.losing, 2);
  assert.strictEqual(t.tied, 1);
  // within 15 either way: 120-100 (20, no), 100-120 (20, no), 110-108 (2, yes), 90-140 (50, no), 105-105 (0, yes)
  assert.strictEqual(t.close, 2);
  ok('7 · ⭐⭐⭐ the day totals separate winning/losing/tied and count the matchups still in the balance');
}

// 8 ── a side built straight from a Sleeper matchup entry
{
  const entry = { rosterId: 3, teamName: 'Pylon Pirates', points: 88.4,
    starters: ['chase', null, 'jacobs', '', 'kelce'] };
  const s = sideOf(entry, { ptsOf: (sid) => ({ chase: 20.1, jacobs: 44.3, kelce: 24 })[sid], stateOf: () => 'done' });
  assert.strictEqual(s.players.length, 3, 'empty starter slots are dropped, not rendered as ghosts');
  assert.strictEqual(s.pts, 88.4, "the league's own total wins over re-adding the parts");
  assert.strictEqual(s.played, 3);
  ok('8 · ⭐⭐ a matchup entry becomes a side, empty slots dropped and the platform total trusted');

  /* ⭐⭐⭐⭐⭐ 8b ── "YET TO PLAY" MEANS UNDECIDED HERE TOO — 29u.
     `sideOf` counted only `pre` while the live route's own decorate step counts everything that is not
     `done`, so ONE FIELD NAME carried two definitions depending on which function happened to build the
     row. Nothing was visibly broken, because every caller decorates afterwards and the decorated value
     wins — which is precisely what made it worth fixing rather than leaving: the next caller to use
     `sideOf` on its own would inherit the pre-b140 meaning silently, and the symptom would be a "left"
     column that reads zero during the only games anyone is watching. That is the bug Trey reported, and
     it must not be reachable by a second route.
     `notStarted` is the pre-only count, kept for anywhere that genuinely wants "has not kicked off". */
  const mixed = sideOf(
    { rosterId: 4, teamName: 'Mixed', points: 40, starters: ['chase', 'jacobs', 'kelce', 'goff'] },
    { ptsOf: () => 5, stateOf: (sid) => ({ chase: 'live', jacobs: 'done', kelce: 'pre', goff: 'live' })[sid] });
  assert.strictEqual(mixed.played, 1, 'only the finished game counts as played');
  assert.strictEqual(mixed.playing, 2);
  assert.strictEqual(mixed.notStarted, 1, 'the pre-only count is still available under its own name');
  assert.strictEqual(mixed.yetToPlay, 3, 'two men mid-game plus one yet to kick off are all undecided');
  /* ⚠ AND IT AGREES WITH THE ROUTE'S OWN RULE — `players.filter(p => p.phase !== 'done').length` — for
     every shape, including a player whose state we could not determine at all. An untimed starter is the
     one the Monday night schedule gap produces, and he is emphatically not finished. */
  const unknown = sideOf(
    { rosterId: 5, teamName: 'Untimed', points: 0, starters: ['chase', 'jacobs'] },
    { ptsOf: () => 0, stateOf: (sid) => (sid === 'chase' ? 'unknown' : 'done') });
  assert.strictEqual(unknown.yetToPlay, 1, 'a player we cannot time is undecided, never finished');
  assert.strictEqual(unknown.notStarted, 0, '…but he has not been observed sitting in the pre bucket either');
  ok('8b · ⭐⭐⭐⭐⭐ one definition of "yet to play" — undecided — however the side was built');
}

// 9 ── the shapes a Sunday actually produces
{
  assert.deepStrictEqual(rootingBoard([], helpers()), []);
  assert.deepStrictEqual(rootingBoard(null, helpers()), []);
  // A league with no opponent yet (bye week in a 13-team league) must not crash the board or the totals.
  const bye = [{ leagueId: 'a', leagueName: 'a', me: side(1, 'Me', [P('chase', 12)]), opp: null }];
  assert.strictEqual(rootingBoard(bye, helpers())[0].for, 1);
  assert.strictEqual(dayTotals(bye).leagues, 0, 'a matchup with no opponent is not a matchup');
  assert.strictEqual(sideOf(null, { ptsOf: () => 0, stateOf: () => 'pre' }), null);
  ok('9 · ⭐⭐ empty input, and a league with no opponent this week, are handled rather than thrown on');
}

// 10 ── ⭐⭐⭐⭐ WHERE THE WEEK IS UP TO — the badge, the review tab, and the one that gates advice
{
  const SUN = Date.parse('2026-09-20T17:00:00Z');
  const wk = [
    '2026-09-18T00:20:00Z',   // Thursday night
    '2026-09-20T17:00:00Z',   // Sunday 1pm  x3
    '2026-09-20T17:00:00Z',
    '2026-09-20T17:00:00Z',
    '2026-09-20T20:25:00Z',   // Sunday late
    '2026-09-21T00:20:00Z',   // Sunday night
    '2026-09-22T00:15:00Z',   // MONDAY NIGHT — the one that matters
  ];

  // Saturday: nothing has happened. No badge, no review tab.
  const sat = weekStateFrom(wk, Date.parse('2026-09-19T12:00:00Z'));
  assert.deepStrictEqual([sat.anyLive, sat.anyDone, sat.allDone], [false, true, false],
    'Thursday night is already done by Saturday, so the review tab may appear — but nothing is live');
  assert.ok(sat.nextKickoff, 'a quiet page can say when it stops being quiet');

  // Sunday 1pm kickoff: live.
  const live = weekStateFrom(wk, SUN + 30 * 60 * 1000);
  assert.strictEqual(live.anyLive, true, 'the badge is on');
  assert.strictEqual(live.allDone, false);

  /* ⭐⭐⭐⭐⭐ THE ONE THAT PREVENTS BAD ADVICE. Sunday 11pm: every game is over EXCEPT Monday night.
     `anyDone` is true, so the review tab is offered — but `allDone` must be FALSE, because a review
     computed now would build its "best lineup" out of players who have not kicked off and tell him to
     bench the man he is about to watch score thirty. */
  const sundayNight = weekStateFrom(wk, Date.parse('2026-09-21T04:00:00Z'));
  assert.strictEqual(sundayNight.anyDone, true, 'plenty has finished — the tab appears');
  assert.strictEqual(sundayNight.allDone, false, 'but Monday night has not been played, so the week is NOT reviewable');
  assert.strictEqual(sundayNight.live, 0, 'nothing is actually on at 4am UTC Monday');

  // Tuesday: everything is done and the week can be reviewed.
  const tue = weekStateFrom(wk, Date.parse('2026-09-23T12:00:00Z'));
  assert.strictEqual(tue.allDone, true);
  assert.strictEqual(tue.nextKickoff, null);
  /* ⚠ `games` counts distinct KICKOFF SLOTS, not games: the three 1pm games collapse to one. That is the
     right unit for "is anything on / is everything over" and the wrong one for "how many games are left",
     so nothing prints it as a game count. Seven entries, five slots. */
  assert.strictEqual(tue.games, 5, 'three simultaneous 1pm kickoffs are one slot');

  // No schedule at all is UNKNOWN, never "the week is over".
  const none = weekStateFrom([], SUN);
  assert.strictEqual(none.known, false);
  assert.strictEqual(none.allDone, false, 'an unknown week must never read as reviewable');
  assert.strictEqual(weekStateFrom(null, SUN).known, false);
  ok('10 · ⭐⭐⭐⭐⭐ the week state separates "something finished" from "everything finished" — the second gates the review');
}

/* ⭐⭐⭐⭐⭐ 11 ── HOW MUCH OF HIS GAME HAS BEEN PLAYED, ON THE BOARD ROW ITSELF — 29t.
   ==================================================================================================
   Game Day colours each points cell by how unusual the day is for the position. While a game is ON, that
   judgement is meaningless without knowing how far through it he is: Jared Goff on 7.4 points is a poor
   week and a perfectly ordinary first half, and the screen was calling it a poor week — painting every
   live player toward failure, most strongly in the first quarter when the verdict is least earned.

   The client used to derive the share from the payload's `at` stamp minus its kickoff map. Two fields,
   one clock assumed, and the assumption broke the moment anything but the live route produced the
   payload. The share is now computed HERE, from the same `remainOf` the forecast uses, so the colour on
   the board and the projection in the table can never disagree about the same player.

   ⚠ AND `remainOf` IS OPTIONAL. Every caller that predates this passes no such function and must still
     get a usable row — a live player then reads as half-played, which is the least-wrong single guess,
     and the two certain states stay certain. */
{
  const rows = [{ leagueId: 'L1', leagueName: 'One',
    me: side(1, 'Me', [P('chase', 12.1, 'live'), P('hill', 14.1, 'done'), P('kelce', 0, 'pre')], 26.2),
    opp: side(2, 'Them', [P('jacobs', 3.2, 'live')], 3.2) }];

  const withRemain = rootingBoard(rows, { ...helpers({ chase: 'live', hill: 'done', kelce: 'pre', jacobs: 'live' }),
    // Chase is 30% of the way through his game; Jacobs has barely started.
    remainOf: (sid) => (sid === 'chase' ? 0.7 : sid === 'jacobs' ? 0.95 : 1) });
  const by = Object.fromEntries(withRemain.map((p) => [p.sid, p]));

  assert.ok(Math.abs(by.chase.elapsed - 0.3) < 1e-9, 'a live player carries 1 − remaining');
  assert.strictEqual(by.hill.elapsed, 1, 'a finished game is all of it');
  assert.strictEqual(by.kelce.elapsed, null, 'a game that has not kicked off has no share to report');
  ok('11 · ⭐⭐⭐⭐⭐ every board row says how much of the player\'s game has been played');

  /* ⚠ THE FLOOR AND THE CEILING ARE NOT DECORATION. A clock that has run past the nominal game length
     would otherwise report more than 100% played, and the consumer divides by this number. */
  const silly = rootingBoard(rows, { ...helpers({ chase: 'live', hill: 'done', kelce: 'pre', jacobs: 'live' }),
    remainOf: (sid) => (sid === 'chase' ? -0.4 : sid === 'jacobs' ? 1.8 : 0.5) });
  const s2 = Object.fromEntries(silly.map((p) => [p.sid, p]));
  assert.ok(s2.chase.elapsed <= 1 && s2.chase.elapsed >= 0, 'an overrun clock cannot exceed a full game');
  assert.ok(s2.jacobs.elapsed >= 0, 'nor can a nonsensical remainder go negative');
  ok('11b · ⭐⭐⭐⭐ …clamped, because whoever reads it is going to divide by it');

  /* The case that must not regress: no `remainOf` at all, which is every caller written before 29t. */
  const legacy = rootingBoard(rows, helpers({ chase: 'live', hill: 'done', kelce: 'pre', jacobs: 'live' }));
  const l2 = Object.fromEntries(legacy.map((p) => [p.sid, p]));
  assert.strictEqual(l2.chase.elapsed, 0.5, 'a live player with no clock is assumed half-played');
  assert.strictEqual(l2.hill.elapsed, 1);
  assert.strictEqual(l2.kelce.elapsed, null);
  ok('11c · ⭐⭐⭐⭐⭐ a caller that passes no clock still gets a readable row rather than a blank one');
}

/* ⭐⭐⭐⭐⭐ §12 — THE THURSDAY STARTER WHO WAS ALREADY FINISHED — b148.
   ==================================================================================================
   Trey, at 12:21 in the morning: "DJ Moore plays on Thursday, but his game hasn't started yet. Because
   of that, he is showing up with a 0 projection AND he isn't listed as left to play."

   This rule lived inline in /sleeper/live as a four-line arrow function between a database call and two
   network calls, and the stub answers that route with CANNED phases — so it had never been executed by a
   test in this project's history, which is why it shipped wrong and stayed wrong. The whole section
   exists because the rule is now somewhere a test can reach it.
   ⚠ THE CLOCK IS REAL, NOT ROUND. 12:21 AM ET Thursday and an 8:15 PM ET kickoff the same evening, so a
     regression that reintroduces any "the calendar date matches, so it has started" shortcut fails here
     rather than looking plausible. */
{
  const NOW = Date.parse('2026-09-17T04:21:00Z');     // 12:21 AM ET Thursday — his moment, to the minute
  const TNF = '2026-09-18T00:15:00Z';                 // 8:15 PM ET the same Thursday: 19.9 hours away
  const SUN = '2026-09-20T17:00:00Z';                 // 1:00 PM ET Sunday
  const OVER = '2026-09-14T00:15:00Z';                // long finished

  assert.strictEqual(gameState(TNF, NOW), 'pre', 'the clock itself must call tonight\'s game unstarted');

  /* THE BUG, EXACTLY. The stats feed claims a line for a man whose game is still 20 hours away — a
     pre-published shell, a stale row, whatever it is — and the old rule let that overrule the schedule. */
  const moore = playerPhase({ kickoff: TNF, hasStat: true, statsKnown: true, now: NOW });
  assert.strictEqual(moore.phase, 'pre',
    'a stat line cannot start a game that has not kicked off');
  assert.strictEqual(moore.statBeforeKickoff, true,
    'and the disagreement is REPORTED rather than silently resolved');
  ok('12 · ⭐⭐⭐⭐⭐ a Thursday starter is not finished on Wednesday night, whatever the feed says');

  /* ⚠ THE CONSEQUENCE ASSERTED IN ITS OWN TERMS, because "phase" is not what he was looking at. Both of
     his symptoms are arithmetic on the phase, so they are checked as arithmetic — a future refactor that
     keeps the phase right and breaks the two derived numbers would otherwise pass §12 untouched. */
  const starters = [
    { sid: 'moore', kickoff: TNF, hasStat: true },     // Thursday night, not kicked off
    { sid: 'sunday1', kickoff: SUN, hasStat: false },
    { sid: 'sunday2', kickoff: SUN, hasStat: false },
  ].map((p) => ({ ...p, ...playerPhase({ ...p, statsKnown: true, now: NOW }) }));
  const yetToPlay = starters.filter((p) => p.phase !== 'done').length;
  assert.strictEqual(yetToPlay, 3, 'all three are still to play — "left" counts him');
  const remainOf = (p) => (p.phase === 'live' ? 0.5 : p.phase === 'pre' ? 1 : 0);
  const projFinal = (p, pts, proj) => Math.round((pts + proj * remainOf(p)) * 10) / 10;
  assert.strictEqual(projFinal(starters[0], 0, 13.4), 13.4,
    'and his projected finish is his projection, not zero');
  ok('12b · ⭐⭐⭐⭐⭐ …so he is counted in "left to play" AND keeps his projection — both symptoms');

  /* ⚠ THE NARROWING IS NARROW. Everything the feed was right about it is still right about. */
  assert.strictEqual(playerPhase({ kickoff: OVER, hasStat: true, statsKnown: true, now: NOW }).phase, 'done',
    'a finished game with a stat line is still finished');
  assert.strictEqual(playerPhase({ kickoff: OVER, hasStat: false, statsKnown: true, now: NOW }).phase, 'done',
    'and a finished game without one is too — he was inactive, or scored nothing (b140)');
  const live = '2026-09-17T03:00:00Z';                // kicked off 81 minutes ago
  assert.strictEqual(playerPhase({ kickoff: live, hasStat: true, statsKnown: true, now: NOW }).phase, 'live',
    'a man in the second quarter is playing, not finished (b140)');
  assert.strictEqual(playerPhase({ kickoff: live, hasStat: false, statsKnown: true, now: NOW }).phase, 'live',
    'and so is one who has not recorded anything yet — kickers often do not (b140)');
  ok('12c · ⭐⭐⭐⭐ the three phases b140 established are untouched by the narrowing');

  /* ⭐⭐⭐ `unknown` IS THE ONE PLACE THE FEED STILL DECIDES, and it must stay that way: with no kickoff
     time there is no clock to believe, and b137's Monday night game depends on this branch. */
  assert.strictEqual(playerPhase({ kickoff: null, hasStat: true, statsKnown: true, now: NOW }).phase, 'done',
    'no clock at all: a stat line is the only evidence there is, so it decides');
  assert.strictEqual(playerPhase({ kickoff: null, hasStat: false, statsKnown: true, now: NOW }).phase, 'pre',
    'and no stat line with no clock is still to play, never quietly filed as played (b137)');
  assert.strictEqual(playerPhase({ kickoff: null, hasStat: false, statsKnown: false, now: NOW }).phase, 'pre');
  ok('12d · ⭐⭐⭐⭐⭐ a team we cannot put a clock on still reaches the feed — b137 is not regressed');

  /* ⚠ AND THE FLAG IS NOT JUST "HE HAS A STAT". It means the two sources genuinely disagree, so it must
     be false everywhere they do not — otherwise the diagnostic counts normal Sundays and means nothing. */
  assert.strictEqual(playerPhase({ kickoff: TNF, hasStat: false, statsKnown: true, now: NOW }).statBeforeKickoff,
    false, 'no stat line before kickoff is the ordinary case, not a disagreement');
  assert.strictEqual(playerPhase({ kickoff: OVER, hasStat: true, statsKnown: true, now: NOW }).statBeforeKickoff,
    false, 'a stat line after the game is the ordinary case too');
  assert.strictEqual(playerPhase({ kickoff: TNF, hasStat: true, statsKnown: false, now: NOW }).statBeforeKickoff,
    false, 'and with no usable stats feed there is nothing to disagree with');
  ok('12e · ⭐⭐⭐⭐ the disagreement flag fires ONLY on a real disagreement');
}


/* ⭐⭐⭐⭐⭐ §13 — A STAT ROW IS NOT PROOF THAT SOMEBODY PLAYED — b149.
   ==================================================================================================
   Trey, a week after the DJ Moore fix: "players that are still scheduled to play today (but haven't
   started) show that they are not on the 'left' column even though they are still left." 94 of his
   starters across eighteen leagues, every scoreline on zero, nothing kicked off.

   b148 made the clock win where it says `pre`. This is the branch it did NOT touch: a player whose team
   has no kickoff row at all reads `unknown`, the feed decides — correctly, that is b137 — and the feed
   was being read as "a row exists" rather than "a row says he played". Sleeper publishes shells ahead of
   kickoff. The two bugs are one sentence apart and took two builds.
   ⚠ THE HARD PART IS NOT BREAKING b137 ON THE WAY. A man who played and scored nothing is the case that
     rule exists for, and he still has gp: 1 — §13b is the check that would go red if this were "fixed"
     by trusting the clock instead. */
{
  assert.strictEqual(playedFromStatLine({ gp: 0 }), false, 'an explicit zero was always rejected');
  /* THE BUG: a pre-published shell — no gp, every number zero. */
  assert.strictEqual(playedFromStatLine({ pts_ppr: 0, rec: 0, rush_att: 0 }), false,
    'an all-zero row with no games-played flag is a placeholder, not evidence');
  assert.strictEqual(playedFromStatLine({}), false, 'and an empty object is not evidence either');
  assert.strictEqual(playedFromStatLine(null), false);
  assert.strictEqual(playedFromStatLine('nonsense'), false);
  ok('13 · ⭐⭐⭐⭐⭐ a shell row published before kickoff does not count as having played');

  /* ⚠ b137 IS THE THING THAT MUST SURVIVE: the man who was on the field and did nothing. */
  assert.strictEqual(playedFromStatLine({ gp: 1, pts_ppr: 0, rec: 0 }), true,
    'he played and scored nothing — the whole reason the feed is trusted over the clock');
  assert.strictEqual(playedFromStatLine({ gp: 1 }), true);
  ok('13b · ⭐⭐⭐⭐⭐ …while a man who played and scored zero still reads as played (b137 intact)');

  /* Without a gp flag, ANY real number is evidence he was in the game — the question is whether he was
     on the field, not whether he was any good. */
  assert.strictEqual(playedFromStatLine({ rec_tgt: 2 }), true, 'two targets is evidence');
  assert.strictEqual(playedFromStatLine({ off_snp: 14 }), true, 'so are snaps');
  assert.strictEqual(playedFromStatLine({ fum_lost: 1 }), true, 'so is a lost fumble');
  assert.strictEqual(playedFromStatLine({ pts_ppr: -1 }), true, 'and so is a negative score');
  ok('13c · ⭐⭐⭐⭐ …and with no flag at all, any non-zero number counts as being on the field');

  /* ⚠ gp WINS OVER THE FALLBACK. A row carrying gp: 0 AND stray non-zero numbers (a leftover from the
     previous week, a projection glued onto the same object) must stay rejected, or the fallback quietly
     re-opens the hole the explicit flag was closing. */
  assert.strictEqual(playedFromStatLine({ gp: 0, pts_ppr: 12.4, rec: 5 }), false,
    'an explicit gp: 0 beats every other number in the row');
  ok('13d · ⭐⭐⭐⭐⭐ …and an explicit games-played of zero outranks the fallback entirely');
}


/* ---- 14. ⭐⭐⭐⭐⭐ HOW MUCH OF THE GAME IS LEFT — b151 -------------------------------------------------
   Trey, watching a live game: "Both Sleeper and the website have the same points currently (18.5). The
   projected points is way different though (Sleeper: 22 / site: 27.4)... There are 3 minutes left in the
   3rd quarter."
   The projected finish is `points + projection × remain`, so with the score agreed, `remain` is the entire
   disagreement. The old rule was a straight line across 3.5 hours; the two things wrong with it both
   pointed the same way, which is why the number was high rather than merely noisy. */
{
  const KICK = '2026-09-14T17:00:00.000Z';                 // a 1:00pm Eastern kickoff
  const at = (min) => Date.parse(KICK) + min * 60000;

  // (a) The window is the length of a broadcast, not a round number.
  assert.strictEqual(GAME_WALL_MS, 183 * 60 * 1000, 'a regulation game runs about 3h03m end to end');
  assert.strictEqual(gameProgress(KICK, at(0)), 0, 'nothing has been played at kickoff');
  assert.strictEqual(gameProgress(KICK, at(-30)), 0, 'and nothing before it either');
  assert.strictEqual(gameProgress(KICK, at(183)), 1);
  assert.strictEqual(gameProgress(KICK, at(400)), 1, 'long past the window it is simply over');
  assert.strictEqual(gameProgress(null, at(60)), null, 'no kickoff means no opinion, NOT zero');
  n++; console.log('  PASS  14 · the progress curve spans a real broadcast and refuses to guess without a kickoff');

  /* (b) ⭐⭐⭐⭐⭐ HALFTIME. Thirteen minutes of wall clock during which no football is played — a straight
     line through it has a man a quarter of the way into the second half while the teams are in the locker
     room. The curve must be FLAT across the break and nowhere else. */
  const atHalf = gameProgress(KICK, at(85));
  assert.strictEqual(atHalf, 0.5, 'two quarters is half the game');
  assert.strictEqual(gameProgress(KICK, at(91)), 0.5, 'and nothing moves during the break');
  assert.strictEqual(gameProgress(KICK, at(98)), 0.5, 'right up to the second-half kickoff');
  assert.ok(gameProgress(KICK, at(99)) > 0.5, 'and then it moves again');
  n++; console.log('  PASS  14b · ⭐⭐⭐⭐⭐ the clock stops at halftime — the curve is flat for those thirteen minutes');

  /* (c) ⭐⭐⭐⭐⭐ TREY'S MOMENT. Three minutes left in the third quarter is 42 of 60 game minutes played,
     which on this broadcast shape lands about 2h13m after kickoff. The old rule and the new one differ by
     a quarter of the projection, and on his running back that is the gap he reported. */
  const HIS_MOMENT = at(133);
  const rem = remainingFor(KICK, HIS_MOMENT);
  const oldRem = Math.max(0, Math.min(1, 1 - (133 * 60000) / (3.5 * 3600000)));   // the rule b151 replaces
  assert.ok(rem > 0.25 && rem < 0.33, `three minutes left in the third should leave under a third: ${rem}`);
  assert.ok(oldRem - rem > 0.06,
    `the old rule must be measurably more generous, or this test is not about the bug: ${oldRem} vs ${rem}`);
  // Stated the way he stated it: the same points on the board, the same projection, two finishes.
  const finish = (r) => Math.round((18.5 + 24 * r) * 10) / 10;
  assert.ok(finish(oldRem) > finish(rem) + 1.5,
    `the two rules must produce visibly different finishes: ${finish(oldRem)} vs ${finish(rem)}`);
  n++; console.log(`  PASS  14c · ⭐⭐⭐⭐⭐ at three minutes left in the third, the finish drops from ${finish(oldRem)} to ${finish(rem)}   [remain ${oldRem.toFixed(2)} → ${rem.toFixed(2)}]`);

  /* (d) ⚠ MONOTONIC AND BOUNDED, ACROSS THE WHOLE WINDOW. A curve assembled from three segments is exactly
     the shape that develops a step or a dip at a join, and either would make a live projection go UP as a
     game goes on. Walk every minute rather than spot-checking the ends. */
  let prev = -1, bad = null;
  for (let m = -10; m <= 200; m++) {
    const v = gameProgress(KICK, at(m));
    if (v < 0 || v > 1) { bad = `out of range at ${m}: ${v}`; break; }
    if (v < prev - 1e-9) { bad = `went backwards at ${m}: ${prev} -> ${v}`; break; }
    prev = v;
  }
  assert.strictEqual(bad, null, String(bad));
  n++; console.log('  PASS  14d · ⭐⭐⭐ the curve never goes backwards and never leaves [0,1] — no step at either join');

  /* (e) ⚠ AND THE NO-CLOCK FALLBACK IS UNCHANGED AT 0.5. A schedule outage must behave exactly as it did
     before this moved, or b150's honest degradation quietly becomes a second bug. */
  assert.strictEqual(remainingFor(null, HIS_MOMENT), 0.5);
  assert.strictEqual(remainingFor('not a date', HIS_MOMENT), 0.5);
  /* ⚠ `gameState` KEEPS ITS 3.5-HOUR WINDOW ON PURPOSE, and this is the assertion that stops a future edit
     from "tidying" the two constants into one. They answer different questions and the right error is in
     opposite directions: calling a game FINISHED early hides a player who can still score, so that window
     should be generous; calling a game more than half REMAINING late inflates every projection on the
     screen, so this one should not be. */
  assert.strictEqual(gameState(KICK, at(190)), 'live', 'the state window is deliberately longer than the scoring curve');
  assert.strictEqual(remainingFor(KICK, at(190)), 0, 'while nothing is left to project by then');
  n++; console.log('  PASS  14e · ⭐⭐⭐⭐ no kickoff still falls back to 0.5, and gameState keeps its own wider window');
}

console.log(`\n${n} passed`);
