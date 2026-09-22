/* THE NEXT THREE WEEKS ON THE HUB — b169. Trey: "It might also be helpful to see the next 3 weeks and how
   they project comparatively to ensure it's not just a one week thing... particularly important for defenses
   for matchups." The shaping is pure so it can be checked without Sleeper. */
import assert from 'assert';
import { weeksAfter, packNextWeeks } from '../src/routes/connect.js';

let n = 0;
const ok = (m, x) => { n++; console.log('  PASS  ' + m + (x ? `   [${x}]` : '')); };

assert.deepEqual(weeksAfter(9), [10, 11, 12]);
ok('week 9 asks for weeks 10, 11 and 12');

assert.deepEqual(weeksAfter(17), [18]);
assert.deepEqual(weeksAfter(18), []);
ok('⭐⭐⭐⭐ the window never runs past the last week of the season', 'wk17 → [18], wk18 → []');

assert.deepEqual(weeksAfter(null), []);
ok('a missing week asks for nothing rather than NaN');

const maps = [
  { a: { pts: 12.4, opp: 'KC' }, b: { pts: 8, opp: 'DEN' } },
  { b: { pts: 9.5, opp: '@LV' } },                              // 'a' is on bye: no row at all
  { a: { pts: 15, opp: 'NYJ' }, c: { pts: 4, opp: null } },
];
const packed = packNextWeeks(maps, [10, 11, 12]);
assert.deepEqual(packed.a, [[12.4, 'KC'], null, [15, 'NYJ']]);
ok('⭐⭐⭐⭐⭐ a week a player has no projection in stays null — week 12 never slides into week 11\'s column',
  JSON.stringify(packed.a));
assert.deepEqual(packed.b, [[8, 'DEN'], [9.5, '@LV'], null]);
assert.deepEqual(packed.c, [null, null, [4, null]]);
ok('every player keeps one slot per week, opponent included (null when the feed has none)');

assert.deepEqual(packNextWeeks([], [10, 11, 12]), {});
assert.deepEqual(packNextWeeks(null, null), {});
ok('an unavailable projection feed packs to an empty table rather than throwing');

console.log(`\n${n} passed`);
