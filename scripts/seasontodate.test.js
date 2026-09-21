/* SEASON-TO-DATE ACTUALS — b164.
 *
 * Trey: "is the projected points of value taking into account what they have already done this season?"
 * This module supplies what a player has actually done. These checks pin the two things that decide
 * whether the resulting per-game rate is honest:
 *   · GAMES PLAYED comes from participation, never from points. An active player who scored zero PLAYED
 *     and must count, or his dud week drops out of his average and flatters it. An inactive row is not a
 *     game, or a man who sat three weeks is averaged over weeks he was not on the field.
 *   · STATS go through the player pack's own `mapStats`, so actual and projected lines are the same keys
 *     scored by the same client scorer.
 * Rows are RECORDED SHAPES of Sleeper's /stats/nfl/{season}/{week} response: `player_id`, `player`,
 * `opponent`, `stats` with Sleeper's own key spellings. The sandbox cannot reach Sleeper.
 */
import assert from 'assert';
import { addWeek, playedIn } from '../src/lib/seasonToDate.js';

let n = 0;
const ok = (m, x) => { n++; console.log('  PASS  ' + m + (x ? `   [${x}]` : '')); };

const row = (id, pos, stats) => ({ player_id: String(id), player: { position: pos }, opponent: 'PIT', stats });

// ---- participation --------------------------------------------------------------------------------
assert.equal(playedIn({ gp: 1, pass_yd: 250 }), true);
ok('gp = 1 is a game played');
assert.equal(playedIn({ gp: 1 }), true);
ok('⭐⭐⭐⭐⭐ an active player with an EMPTY stat line still played — his zero counts against his average');
assert.equal(playedIn({ gp: 0 }), false);
ok('⭐⭐⭐⭐ gp = 0 (inactive, on the report) is not a game');
assert.equal(playedIn({ off_snp: 12 }), true);
ok('with no gp field, snaps decide');
assert.equal(playedIn({ pts_ppr: 0, rank_ppr: 400 }), false);
ok('⚠ a row carrying only points and ranks is NOT treated as a game');
assert.equal(playedIn(null), false);
ok('no stats, no game');

// ---- accumulation through the pack's mapStats -----------------------------------------------------
const acc = {};
addWeek(acc, [
  row(4984, 'QB', { gp: 1, pass_yd: 280, pass_td: 2, pass_int: 1, rush_yd: 30 }),
  row(9509, 'WR', { gp: 1, rec: 7, rec_yd: 95, rec_td: 1, rec_tgt: 9 }),
  row(7777, 'RB', { gp: 0 }),                                  // inactive week 1
]);
addWeek(acc, [
  row(4984, 'QB', { gp: 1, pass_yd: 220, pass_td: 1, pass_int: 0, rush_yd: 12, rush_td: 1 }),
  row(9509, 'WR', { gp: 1 }),                                   // played, caught nothing
  row(7777, 'RB', { gp: 1, rush_att: 15, rush_yd: 70, rec: 2, rec_yd: 11 }),
]);
assert.equal(acc['4984'].gp, 2);
ok('two games for the quarterback', `gp ${acc['4984'].gp}`);
assert.equal(acc['4984'].s.passYd, 500);
assert.equal(acc['4984'].s.passTD, 3);
assert.equal(acc['4984'].s.INT, 1);
assert.equal(acc['4984'].s.rushTD, 1);
ok('⭐⭐⭐⭐⭐ stats are SUMMED under the engine\'s own key names (passYd, passTD, INT) — the pack\'s mapStats, not a second translation',
  JSON.stringify(acc['4984'].s));
assert.equal(acc['9509'].gp, 2);
assert.equal(acc['9509'].s.rec, 7);
ok('⭐⭐⭐⭐⭐ the receiver\'s zero week counts as a game — 7 catches over TWO games, not one', `gp ${acc['9509'].gp}, rec ${acc['9509'].s.rec}`);
assert.equal(acc['7777'].gp, 1);
assert.equal(acc['7777'].s.rushYd, 70);
ok('⭐⭐⭐⭐ the running back\'s inactive week is not a game — 70 yards over ONE game, not two', `gp ${acc['7777'].gp}`);
assert.equal(acc['9509'].s.tgt, 9);
ok('targets carried through (the pack maps rec_tgt → tgt)');

// ---- defensive and kicker keys use the pack's alias handling ----------------------------------------
const d = addWeek({}, [
  row('PIT', 'DEF', { gp: 1, sack: 4, int: 2, fum_rec: 1, def_td: 1, pts_allow: 13 }),
  row(1433, 'K', { gp: 1, fgm: 3, xpm: 2, fgm_50_59: 1 }),
]);
assert.equal(d.PIT.s.sack, 4);
assert.equal(d.PIT.s.dint, 2);
assert.equal(d.PIT.s.pa, 13);
ok('a team defense keeps sacks, INTs and points allowed under the engine\'s keys', JSON.stringify(d.PIT.s));
assert.equal(d['1433'].s.fg, 3);
assert.equal(d['1433'].s.fg50, 1);
assert.equal(d['1433'].s.pat, 2);
ok('a kicker\'s makes and 50+ bucket survive the alias logic');

// ---- robustness -------------------------------------------------------------------------------------
const r = addWeek({}, [null, { stats: { gp: 1 } }, row(1, 'WR', null)]);
assert.equal(Object.keys(r).length, 0);
ok('rows with no id or no stats are skipped rather than crashing the walk');

console.log(`\n${n} passed`);
