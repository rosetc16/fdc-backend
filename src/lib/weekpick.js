/* ⭐⭐⭐⭐⭐ WHICH WEEK THE APP SHOULD OPEN ON — b143.
 * ==================================================================================================
 * Trey: "Right now, it's still defaulted to week 1 with all games done. I do want flip it to the next week
 * (week 2) starting on Tuesday. You can still flip back and forth."
 *
 * The app took its default from Sleeper's `display_week`, and that is the wrong source for this question in
 * a way that only shows up after the last whistle: Sleeper keeps pointing at a week for its own reasons long
 * after every game in it has been played, so the screen that exists to tell you what to FIX opens on a week
 * where nothing can be fixed. Every panel inherits it — availability, lineup changes, free agents, weather —
 * and all four are empty by definition once the week is over, which is exactly what he was looking at.
 *
 * ⚠ THE ROLL IS DECIDED BY FOOTBALL, NOT BY A CALENDAR. "Starting on Tuesday" is what it feels like, but a
 *   day-of-week test is the wrong mechanism: it needs a timezone to be meaningful, it is wrong for anyone
 *   not in the US, and it disagrees with reality in both directions — a Tuesday with a postponed game still
 *   to play should NOT roll, and the minutes after the Monday night final are unambiguously the next week
 *   whatever the clock says. So the rule is: the week rolls forward once every kickoff in it is far enough
 *   in the past that the game must be over. In an ordinary week that lands in the small hours after Monday
 *   night football, which is Tuesday, which is what he asked for.
 *
 * ⚠ AND IT NEVER ROLLS WITHOUT EVIDENCE. No schedule rows means no opinion: the raw week stands. A missing
 *   schedule silently advancing everybody a week would be far worse than the bug being fixed, and this is
 *   the same rule byeweeks.js follows — an unknown schedule is unknown, never an assertion.
 */

/* A game is assumed finished this long after kickoff. Deliberately generous: an overrun is an inconvenience,
   but rolling the week over while a game is still on would hide the lineup you are trying to set. */
const GAME_LEN_MS = 4 * 60 * 60 * 1000;

/* ⭐⭐⭐⭐ Does the schedule say this week is done? Returns null when it cannot tell, which the caller must
   treat as "do not roll" rather than as false — the two mean different things and only one of them is safe. */
export function weekFinished(kickoffs, now = Date.now()) {
  const times = (kickoffs || [])
    .map((k) => (k instanceof Date ? k.getTime() : Date.parse(k)))
    .filter((t) => Number.isFinite(t));
  if (!times.length) return null;               // no schedule → no opinion
  return times.every((t) => now - t >= GAME_LEN_MS);
}

/* ⭐⭐⭐⭐⭐ The week to open on. `raw` is whatever the platform says; `kickoffs` are that week's games.
   Rolls forward by exactly ONE week and never further — if a user has been away a fortnight the right
   answer is still the next unplayed week, and walking forward repeatedly would need every intervening
   week's schedule to say something useful about a question nobody asked. */
export function defaultWeek(raw, kickoffs, { now = Date.now(), maxWeek = 18 } = {}) {
  const base = Math.min(maxWeek, Math.max(1, Number(raw) || 1));
  const done = weekFinished(kickoffs, now);
  if (done !== true) return base;
  return Math.min(maxWeek, base + 1);
}
