// projDiagnose AGAINST A REAL DATABASE.
//
// WHY THIS EXISTS: I shipped this diagnostic with `SELECT p.pos` when the column is `p.position`, and the
// admin button answered `column p.pos does not exist`. The unit tests all passed, because none of them ran
// the SQL — and an instrument that cannot run is worse than no instrument, since it was built precisely to
// be trusted when something else looks wrong.
//
// THE RULE THIS ENCODES: any function that writes SQL gets one test that EXECUTES it against a real schema
// built from db/schema.sql. Not a mock, not a shape assertion — the actual statement, on the actual columns.
//
// Skips cleanly when there's no database, the same as the other db tests.
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!URL) {
  console.log('  SKIP  no TEST_DATABASE_URL — skipping the database-backed projection-diagnostic checks');
  process.exit(0);
}
process.env.DATABASE_URL = URL;

const here = path.dirname(fileURLToPath(import.meta.url));
const { q } = await import('../src/lib/db.js');
const { projDiagnose } = await import('../src/lib/projDiag.js');
const { mapStatsForDiag } = await import('../src/routes/playerPack.js');

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { console.log('  PASS  ' + n + (d ? `   [${d}]` : '')); pass++; } else { console.log('  FAIL  ' + n + (d ? `   [${d}]` : '')); fail++; } };

// ⭐ THE SCHEMA COMES FROM db/schema.sql VERBATIM. A hand-written CREATE TABLE in the test would be a second
// source of truth, and the bug this file exists for is exactly a disagreement between two sources of truth.
const schema = fs.readFileSync(path.join(here, '..', 'db', 'schema.sql'), 'utf8');
await q(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
await q(`CREATE EXTENSION IF NOT EXISTS citext`);   // schema.sql assumes it, Render's Postgres has it
await q(schema);

const SEASON = 2026;
const players = [
  ['p1', 'Josh Allen', 'QB', 'BUF'],
  ['p2', 'Bijan Robinson', 'RB', 'ATL'],
  ['p3', 'Cameron Dicker', 'K', 'LAC'],
  ['p4', 'Denver Broncos', 'DST', 'DEN'],
];
for (const [id, name, pos, team] of players) {
  await q(`INSERT INTO players (player_id, sleeper_id, full_name, norm_name, position, team, active)
           VALUES ($1,$1,$2,$3,$4,$5,true)`, [id, name, name.toLowerCase(), pos, team]);
}
// A quarterback and a back with real projections; the kicker gets ONLY extra points (the shape Trey
// reported), and the defense gets none at all (the shape that produced 0.0 across the board).
await q(`INSERT INTO projections (player_id, season, source, stats) VALUES ($1,$2,'sleeper',$3)`,
  ['p1', SEASON, JSON.stringify({ pass_yd: 4200, pass_td: 30, pass_int: 12, rush_yd: 520, rush_td: 7, fum_lost: 4 })]);
await q(`INSERT INTO projections (player_id, season, source, stats) VALUES ($1,$2,'sleeper',$3)`,
  ['p2', SEASON, JSON.stringify({ rush_yd: 1300, rush_td: 11, rec: 60, rec_yd: 480, rec_td: 3 })]);
await q(`INSERT INTO projections (player_id, season, source, stats) VALUES ($1,$2,'sleeper',$3)`,
  ['p3', SEASON, JSON.stringify({ xpm: 40 })]);

console.log('\n== the diagnostic actually runs ==');
// ⭐⭐ THE FAILABLE HALF: before the fix this threw `column p.pos does not exist`, which is what the admin
// button showed Trey. A test that only checked the returned shape would have passed on the broken build
// because it would never have got a returned shape at all — it has to run the statement.
let out = null, threw = null;
try { out = await projDiagnose(SEASON, mapStatsForDiag); } catch (e) { threw = e; }
ok('⭐⭐⭐ projDiagnose executes its SQL against the real schema', !threw, threw ? threw.message : 'no error');
if (threw) { console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(1); }

ok('it reports every position that has players', ['QB', 'RB', 'K', 'DST'].every((p) => out.positions[p]),
  Object.keys(out.positions).join(','));
ok('and counts them', out.positions.QB.players === 1 && out.positions.RB.players === 1,
  `QB ${out.positions.QB.players} · RB ${out.positions.RB.players}`);

console.log('\n== it names the two failures Trey actually hit ==');
// ⭐ A DEFENSE WITH NO PROJECTION ROW AT ALL is the DST-scores-zero shape. The hint has to say so in words,
// because "0.0" on the board is indistinguishable from a defense that is genuinely worthless.
ok('⭐⭐ a position with players and NOT ONE projection row is called out by name',
  out.hints.some((h) => /^DST:/.test(h) && /NOT ONE projection/i.test(h)),
  (out.hints.find((h) => /^DST:/.test(h)) || 'no DST hint').slice(0, 80));
ok('⭐⭐ and the extra-points-only kicker is reported as missing its field-goal keys',
  out.hints.some((h) => /^K:/.test(h) && /fg/i.test(h)),
  (out.hints.find((h) => /^K:/.test(h)) || 'no K hint').slice(0, 90));
ok('⭐ a position whose stats all map cleanly raises no hint', !out.hints.some((h) => /^QB:/.test(h)),
  out.hints.filter((h) => /^QB:/.test(h)).join(' ') || 'QB clean');
// The raw keys have to reach the report, or the operator cannot tell a RENAMED key from an ABSENT one —
// which was the actual distinction behind the kicker bug (Sleeper sends fgm_40_49, the engine read fg40).
ok('⭐ and every report carries the RAW feed keys, so a rename is distinguishable from an absence',
  Array.isArray(out.positions.K.rawKeys) && out.positions.K.rawKeys.length > 0,
  JSON.stringify(out.positions.K.rawKeys).slice(0, 60));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
