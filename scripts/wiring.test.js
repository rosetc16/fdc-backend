/* ⭐⭐⭐⭐⭐ EVERY TEST FILE IS ACTUALLY RUN — b142.
 * ==================================================================================================
 * This has now happened TWICE on this project, and both times the symptom was a number that looked fine.
 *
 *   First: review, rooting, winprob, byeweeks and weather existed, held 69 assertions between them, and
 *   were not named in the `test` script. `npm test` reported 111 passing checks and everybody believed it.
 *   Wiring them in took the real number to 180 — meaning a third of the suite had never run, including
 *   the file that covers the lineup-review gate a user bug had just been filed against.
 *
 *   Second: trending.test.js, written minutes ago in this very build, with twelve checks including the one
 *   that proves the new signals separate the field. Same omission, same silence.
 *
 * ⚠ THE FAILURE IS INVISIBLE BY CONSTRUCTION. An unwired test file does not fail — it does not run, so it
 *   cannot fail, and a green suite with a missing third of its checks is indistinguishable from a green
 *   suite. Nothing in the tooling was ever going to notice: the coverage backstop is about football
 *   positions, and lint does not read package.json.
 *
 * ⚠ AND THE FIX IS NOT "REMEMBER TO WIRE IT IN". That was the fix last time. This is the same class as
 *   `icons-check` (a glyph that renders as nothing looks exactly like a feature that failed to load) and
 *   `css-check` (a stray backtick that silently swallows a rule): a mechanical check for a mistake a
 *   careful person makes anyway, run as part of the suite so it cannot be skipped.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

let n = 0;
const ok = (m) => { n++; console.log('  PASS  ' + m); };

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const script = String((pkg.scripts && pkg.scripts.test) || '');

// 1 ── every *.test.js beside this one is named in the `test` script
{
  const files = fs.readdirSync(here).filter((f) => f.endsWith('.test.js')).sort();
  assert.ok(files.length > 5, `expected a real suite, found ${files.length} test files`);

  const missing = files.filter((f) => !script.includes(`scripts/${f}`));
  assert.deepStrictEqual(missing, [],
    missing.length
      ? `${missing.length} test file(s) exist but never run: ${missing.join(', ')} — add them to the "test" script in package.json`
      : '');
  ok(`1 · ⭐⭐⭐⭐⭐ all ${files.length} test files are wired into \`npm test\` — none can exist and never run`);
}

// 2 ── and the script does not name a file that is gone
{
  /* The opposite mistake, and it fails loudly rather than silently (node exits non-zero on a missing
     module) — but it fails the WHOLE suite at whatever point the missing file sits, hiding every check
     after it. Cheaper to catch here, on the first file that runs. */
  const named = [...script.matchAll(/scripts\/([\w.-]+\.test\.js)/g)].map((m) => m[1]);
  const orphans = [...new Set(named)].filter((f) => !fs.existsSync(path.join(here, f)));
  assert.deepStrictEqual(orphans, [],
    orphans.length ? `the test script names ${orphans.join(', ')}, which no longer exist` : '');
  ok(`2 · ⭐⭐⭐ …and every file the script names still exists (${[...new Set(named)].length} named)`);
}

// 3 ── this file is itself wired in, which is the one that cannot be assumed
{
  /* ⚠ A WIRING CHECK THAT IS NOT WIRED IN IS A COMMENT. If somebody adds this file and forgets the
     package.json line, every guarantee above evaporates and nothing says so — so it asserts its own
     presence. This is trivially true whenever it runs, which is exactly the point: the only way it is
     false is the way in which it never executes at all, and then the FIRST check above catches it on the
     next person's machine. */
  assert.ok(script.includes('scripts/wiring.test.js'),
    'wiring.test.js must itself appear in the test script, or it guarantees nothing');
  ok('3 · ⭐⭐⭐⭐ …including this one, which would otherwise be a comment');
}

/* ⭐⭐⭐⭐⭐ §4 — EVERY WEEK-AWARE ROUTE APPLIES THE TUESDAY ROLL — b148.
   ==================================================================================================
   b143 established that Sleeper's `display_week` keeps pointing at a week long after its last whistle, and
   that the cure is `defaultWeek`. /sleeper/team-hub got it. /sleeper/live did NOT, and nothing noticed for
   five builds, because a route that is one week behind does not throw — it returns a complete, confident,
   well-formed payload describing the wrong week. The home strip read the FINISHED week (every kickoff past,
   every starter `done`, "left to play" zero) while My Week, on the same screen, had already rolled forward.

   ⚠ THIS IS A MECHANICAL CHECK FOR A MISTAKE A CAREFUL PERSON MAKES ANYWAY — the same reasoning as the
     unwired-test-file check above it, as icons-check and as css-check. "Remember to call defaultWeek in the
     next week-aware route" is not a fix; this is. Any handler that derives a default from `display_week`
     must pass it through `defaultWeek`, and a new one that forgets fails here rather than shipping. */
{
  const src = fs.readFileSync(path.join(here, '..', 'src/routes/connect.js'), 'utf8');
  // Split the file into handler bodies so the two calls have to live in the SAME route, not merely in the
  // same file — which is exactly the check that would have caught this, since the file already had one.
  const parts = src.split(/connectRouter\.(?:get|post)\(/).slice(1);
  const named = parts.map((b) => ({ name: (b.match(/^\s*'([^']+)'/) || [])[1] || '?', body: b }));
  /* ⚠ THE RULE IS ABOUT ROUTES THAT PICK A WEEK TO SHOW, NOT EVERY ROUTE THAT MENTIONS ONE, and the first
     cut of this check got that wrong — it flagged /sleeper/season-review, which reads `display_week` and is
     CORRECT not to roll it: that route does not serve one chosen week, it walks every finished week and
     decides whether the current one is reviewable with its own stricter `allDone` test (b135). Rolling
     there would be meaningless at best. The routes this rule is for are the ones where the CALLER can pick
     a week — they honour `?week=` when asked, so their no-week default is a display decision and must be
     the rolled week. That is the discriminator, and it is the feature that makes the bug possible. */
  const weekAware = named.filter((h) => h.body.includes('display_week') && h.body.includes('req.query.week'));
  assert.ok(weekAware.length >= 2,
    `expected at least two week-picking handlers, found ${weekAware.length} — has the parse drifted?`);
  const missing = weekAware.filter((h) => !h.body.includes('defaultWeek('));
  assert.deepStrictEqual(missing.map((h) => h.name), [],
    `these routes take Sleeper's display_week without the b143 roll: ${missing.map((h) => h.name).join(', ')}`);
  ok(`4 · ⭐⭐⭐⭐⭐ both week-picking routes apply the Tuesday roll [${weekAware.map((h) => h.name).join(', ')}]`);
}


console.log(`\n${n} passed`);
