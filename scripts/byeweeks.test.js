/* WHO IS ON BYE — b132.
 *
 * Trey asked for a weekly page "focused on bye weeks". Before this, a bye was read off `players.bye_week`,
 * a column Sleeper leaves null for long stretches of the year — so for months the honest-looking answer to
 * "who on my roster is out this week" was "nobody", delivered with total confidence across fifteen leagues
 * at once. The schedule cannot be coy: a team either has a game or it does not.
 *
 * ⚠ BUT THE OBVIOUS IMPLEMENTATION FAILS CATASTROPHICALLY, NOT GRACEFULLY. "Teams with no row for week N"
 *   returns ALL THIRTY-TWO TEAMS when week N has not been synced — every player in every league flagged as
 *   on bye, on a page whose entire job is telling you who to bench. Every test below exists to pin the
 *   distinction between "on bye" and "we do not know", because those two are one `if` apart and the wrong
 *   one is worse than the bug it replaced.
 */
import assert from 'assert';
import { byeTeamsForWeek } from '../src/lib/nflSchedule.js';

let n = 0;
const ok = (m) => { n++; console.log('  PASS  ' + m); };

// A small league: eight teams, four games a week, with a rotating pair on bye in weeks 2 and 3.
const TEAMS = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH'];
const rowsFor = (byWeek) => {
  const out = [];
  for (const [w, off] of Object.entries(byWeek)) {
    for (const t of TEAMS) if (!off.includes(t)) out.push({ week: Number(w), team: t, opponent: 'XXX', home: true });
  }
  return out;
};
const SCHEDULE = rowsFor({ 1: [], 2: ['AAA', 'BBB'], 3: ['CCC'], 4: [] });

// 1 ── the ordinary case
{
  assert.deepStrictEqual(byeTeamsForWeek(SCHEDULE, 2), ['AAA', 'BBB']);
  assert.deepStrictEqual(byeTeamsForWeek(SCHEDULE, 3), ['CCC']);
  ok('1 · ⭐⭐⭐ the teams with no game that week are the teams on bye');
}

// 2 ── a full week has nobody on bye, and that is an ANSWER, not a blank
{
  const r = byeTeamsForWeek(SCHEDULE, 1);
  assert.ok(Array.isArray(r) && r.length === 0, 'a full week must return [], not null');
  ok('2 · ⭐⭐⭐ a week where everybody plays returns an empty list, not "unknown"');
}

// 3 ── ⭐⭐⭐⭐⭐ THE ONE THAT WOULD HAVE SHIPPED A DISASTER
{
  // Week 9 was never synced. The naive answer is "all eight teams are on bye".
  const r = byeTeamsForWeek(SCHEDULE, 9);
  assert.strictEqual(r, null, 'an unsynced week must be UNKNOWN, never "everyone is on bye"');
  // …and the caller can tell this apart from case 2, which is the entire point.
  assert.notDeepStrictEqual(r, byeTeamsForWeek(SCHEDULE, 1));
  ok('3 · ⭐⭐⭐⭐⭐ a week with no rows is unknown — it never reports the whole league as on bye');
}

// 4 ── a HALF-loaded week is the same failure wearing a disguise
{
  // Two of the eight teams made it into the table for week 5. That is not "six teams on bye".
  const partial = [...SCHEDULE, { week: 5, team: 'AAA', opponent: 'BBB', home: true }, { week: 5, team: 'BBB', opponent: 'AAA', home: false }];
  assert.strictEqual(byeTeamsForWeek(partial, 5), null,
    'six of eight teams "on bye" is a partial sync, and must be refused rather than published');
  ok('4 · ⭐⭐⭐⭐ an implausibly large bye list is treated as a partial sync, not as a schedule');
}

// 5 ── nothing at all, and the shapes that arrive when a query fails
{
  assert.strictEqual(byeTeamsForWeek([], 3), null);
  assert.strictEqual(byeTeamsForWeek(null, 3), null);
  assert.strictEqual(byeTeamsForWeek(undefined, 3), null);
  assert.strictEqual(byeTeamsForWeek(SCHEDULE, 0), null);
  assert.strictEqual(byeTeamsForWeek(SCHEDULE, null), null);
  ok('5 · ⭐⭐ an empty, missing or unasked-for schedule is unknown rather than an exception');
}

// 6 ── week numbers arrive as strings from the database driver often enough to matter
{
  const strWeeks = SCHEDULE.map((r) => ({ ...r, week: String(r.week) }));
  assert.deepStrictEqual(byeTeamsForWeek(strWeeks, 2), ['AAA', 'BBB']);
  assert.deepStrictEqual(byeTeamsForWeek(SCHEDULE, '2'), ['AAA', 'BBB']);
  ok('6 · ⭐⭐ string and number week values give the same answer');
}

// 7 ── a real-sized week, to prove the plausibility cap does not fire on legitimate data
{
  const NFL = ['ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND',
    'JAX', 'KC', 'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG', 'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS'];
  const off = ['CIN', 'DAL', 'MIA', 'NYJ', 'SF', 'TB'];   // six, the most the NFL has ever run in one week
  const rows = NFL.filter((t) => !off.includes(t)).map((t) => ({ week: 9, team: t, opponent: 'ZZZ', home: true }))
    .concat(NFL.map((t) => ({ week: 10, team: t, opponent: 'ZZZ', home: true })));
  assert.deepStrictEqual(byeTeamsForWeek(rows, 9), [...off].sort());
  ok('7 · ⭐⭐⭐ a real six-team bye week passes the plausibility cap untouched');
}

console.log(`\n${n} passed`);
