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

console.log(`\n${n} passed`);
