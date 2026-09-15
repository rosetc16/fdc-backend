/* WHICH WEEK THE APP OPENS ON — b143.
 *
 * Trey: "Right now, it's still defaulted to week 1 with all games done. I do want flip it to the next week
 * (week 2) starting on Tuesday. You can still flip back and forth."
 *
 * ⚠ THE INTERESTING CASES ARE THE ONES WHERE IT MUST *NOT* ROLL. Rolling forward is easy; rolling forward
 *   when a game is still to be played would hide the lineup the user came to set, and rolling forward with
 *   no schedule at all would move everybody a week on no evidence whatsoever. Both are worse than the bug.
 */
import assert from 'assert';
import { weekFinished, defaultWeek } from '../src/lib/weekpick.js';

let n = 0;
const ok = (m) => { n++; console.log('  PASS  ' + m); };

const H = (h) => new Date(Date.parse('2026-09-13T17:00:00Z') + h * 3600e3).toISOString();
const NOW = Date.parse('2026-09-13T17:00:00Z');

// 1 ── an ordinary week, walked through its own Sunday
{
  // Sunday 1pm, 4pm, Sunday night, Monday night — the real shape of a week.
  const wk = [H(0), H(3), H(7), H(31)];
  assert.strictEqual(weekFinished(wk, NOW), false, 'nothing has even kicked off yet');
  assert.strictEqual(weekFinished(wk, NOW + 8 * 3600e3), false, 'Sunday night is on; the week is not over');
  /* ⭐⭐⭐⭐⭐ THE ONE THAT MATTERS: Monday night is still to play. A day-of-week rule would already have
     rolled by now on the East Coast in some timezones, and it would be wrong — there is a lineup to set. */
  assert.strictEqual(weekFinished(wk, NOW + 30 * 3600e3), false, 'Monday night has not kicked off');
  assert.strictEqual(weekFinished(wk, NOW + 32 * 3600e3), false, 'Monday night is in progress');
  // Four hours after the last kickoff, the week is done. That is the small hours of Tuesday UTC.
  assert.strictEqual(weekFinished(wk, NOW + 35.5 * 3600e3), true, 'the last game is over');
  ok('1 · ⭐⭐⭐⭐⭐ a week is finished when its LAST game is, not when the calendar says Tuesday');
}

// 2 ── and that decides the default
{
  const wk = [H(0), H(31)];
  assert.strictEqual(defaultWeek(1, wk, { now: NOW }), 1, 'mid-week, stay put');
  assert.strictEqual(defaultWeek(1, wk, { now: NOW + 35.5 * 3600e3 }), 2, 'once it is over, open on week 2');
  /* ⚠ EXACTLY ONE WEEK. Somebody returning after a fortnight still wants the next unplayed week, and
     walking further would need every intervening week's schedule to answer a question nobody asked. */
  assert.strictEqual(defaultWeek(1, wk, { now: NOW + 400 * 3600e3 }), 2, 'it rolls by one, never further');
  assert.strictEqual(defaultWeek(18, wk, { now: NOW + 400 * 3600e3 }), 18, 'and never past the last week');
  ok('2 · ⭐⭐⭐⭐ the default rolls forward by one week, once, and stops at 18');
}

// 3 ── ⭐⭐⭐⭐⭐ NO SCHEDULE IS NO OPINION
{
  /* The failure this guards is much worse than the bug it fixes: a missing or unsynced schedule silently
     advancing every user a week, on no evidence, with nothing on screen to say why. Same rule byeweeks.js
     follows — an unknown schedule is UNKNOWN, never an assertion. */
  assert.strictEqual(weekFinished([], NOW), null, 'no rows is null, not false');
  assert.strictEqual(weekFinished(null, NOW), null);
  assert.strictEqual(weekFinished([null, 'not a date'], NOW), null, 'unparseable rows are no rows');
  assert.strictEqual(defaultWeek(1, [], { now: NOW }), 1, 'without a schedule the platform week stands');
  assert.strictEqual(defaultWeek(1, null, { now: NOW }), 1);
  ok('3 · ⭐⭐⭐⭐⭐ a missing schedule never rolls anybody forward — unknown is not "finished"');
}

// 4 ── the shapes a real season produces
{
  // A postponed game, still to play, days after the rest of the week. Must NOT roll.
  const postponed = [H(0), H(3), H(31), H(120)];
  assert.strictEqual(weekFinished(postponed, NOW + 40 * 3600e3), false,
    'one game still to play keeps the week open, whatever day it is');
  assert.strictEqual(defaultWeek(1, postponed, { now: NOW + 40 * 3600e3 }), 1);
  // A single-game week (Thursday only, as some late-season weeks effectively are for one team).
  assert.strictEqual(weekFinished([H(0)], NOW + 5 * 3600e3), true);
  // Garbage in the raw week is clamped rather than trusted.
  assert.strictEqual(defaultWeek(0, [], { now: NOW }), 1);
  assert.strictEqual(defaultWeek(99, [], { now: NOW }), 18);
  assert.strictEqual(defaultWeek(null, [], { now: NOW }), 1);
  ok('4 · ⭐⭐⭐⭐ a postponed game holds the week open; a nonsense week number is clamped, not trusted');
}

console.log(`\n${n} passed`);
