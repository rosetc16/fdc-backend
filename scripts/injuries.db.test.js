// syncInjuries AGAINST A REAL DATABASE.
//
// The unit tests prove the mapping. They cannot prove the thing that actually broke in production, which
// was a DATABASE SHAPE problem: `relation "player_news" does not exist`, because db/schema.sql is only
// applied by a manual `npm run migrate` that nobody runs on a deploy. Pure functions never touch a table,
// so no amount of mapper testing would have caught it.
//
// So this runs the real job against a real Postgres, on a schema deliberately missing the columns the job
// needs, with ESPN unreachable — which is both the sandbox's situation and the likeliest production one.
//
// Skips cleanly when there's no database, the same as reset.test.js.
import assert from 'assert';

const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!URL) {
  console.log('  SKIP  no TEST_DATABASE_URL — skipping the database-backed injury checks');
  process.exit(0);
}
process.env.DATABASE_URL = URL;

const { q } = await import('../src/lib/db.js');
let pass = 0;
const ok = (n) => { console.log('  PASS  ' + n); pass++; };

// A players table as it existed BEFORE any of the injury columns were added — the exact situation on a
// database that predates the feature, which is what production was.
await q(`DROP TABLE IF EXISTS players CASCADE`);
await q(`DROP TABLE IF EXISTS job_runs CASCADE`);
await q(`CREATE TABLE players (
  player_id TEXT PRIMARY KEY, sleeper_id TEXT, espn_id TEXT, full_name TEXT, norm_name TEXT,
  team TEXT, position TEXT, age INT, years_exp INT, injury_status TEXT, news_updated BIGINT,
  bye_week SMALLINT, active BOOLEAN DEFAULT true, updated_at TIMESTAMPTZ DEFAULT now()
)`);
// The real table is job_runs — recordJob writes there, and it swallows its own errors, so getting this
// name wrong would have silently produced a test that proved nothing about job recording.
await q(`CREATE TABLE job_runs (job TEXT, ok BOOLEAN, detail JSONB, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ)`);

await q(`INSERT INTO players (player_id, espn_id, full_name, position, team, injury_status, injury_body_part, injury_notes, news_updated, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)`.replace(', injury_body_part, injury_notes', '').replace(',$7,$8', ''),
  ['p1', '3117251', 'Christian McCaffrey', 'RB', 'SF', 'Questionable', Date.now(), true].slice(0, 7))
  .catch(async () => {
    // The pre-migration table genuinely has no body-part column, which is the point of this fixture.
    await q(`INSERT INTO players (player_id, espn_id, full_name, position, team, injury_status, news_updated, active)
             VALUES ('p1','3117251','Christian McCaffrey','RB','SF','Questionable',$1,true)`, [Date.now()]);
  });
await q(`INSERT INTO players (player_id, espn_id, full_name, position, team, injury_status, active)
         VALUES ('p2','4241457','Healthy Guy','WR','KC',NULL,true)`);

const { syncInjuries } = await import('../src/jobs/syncInjuries.js');

// ---- 1. it runs at all on a schema that is missing every column it writes --------------------------------
let detail;
await assert.doesNotReject(async () => { detail = await syncInjuries(); },
  'syncInjuries threw on a database without the injury columns — the exact class of failure reported');
ok('1 · ⭐ the job runs on a pre-migration schema, adding the columns it needs itself');

// ---- 2. ESPN being unreachable degrades, it does not fail ------------------------------------------------
assert.ok(detail, 'no detail returned');
assert.strictEqual(typeof detail.espnTeamsFailed, 'number');
assert.ok(detail.espnTeamsOk + detail.espnTeamsFailed > 0, 'it should have attempted every team');
ok(`2 · ⭐ ESPN unreachable is survived and COUNTED (${detail.espnTeamsOk} ok / ${detail.espnTeamsFailed} failed)`);

// ---- 3. it wrote what it could from the platform data alone ----------------------------------------------
const { rows } = await q(`SELECT player_id, injury_detail, injury_part, injury_at, injury_sources FROM players ORDER BY player_id`);
const p1 = rows.find((r) => r.player_id === 'p1');
const p2 = rows.find((r) => r.player_id === 'p2');
assert.ok(p1, 'the flagged player row vanished');
assert.strictEqual(p1.injury_sources, 'sleeper', 'with ESPN down the only source should be the platform');
ok('3 · the flagged player gets what the platform knows, attributed to the platform');

// ---- 4. ⭐ it must never invent. With no note available, no note is written -------------------------------
assert.strictEqual(p1.injury_detail, null, 'a note appeared from nowhere: ' + p1.injury_detail);
ok('4 · ⭐ no source, no note — nothing is fabricated to fill the gap');

// ---- 5. a healthy player is left completely alone --------------------------------------------------------
assert.strictEqual(p2.injury_detail, null);
assert.strictEqual(p2.injury_part, null);
assert.strictEqual(p2.injury_sources, null);
ok('5 · a healthy player is not touched');

// ---- 6. running it twice is safe (the nightly will do exactly this) --------------------------------------
await assert.doesNotReject(async () => { await syncInjuries(); }, 'a second run threw');
const { rows: again } = await q(`SELECT count(*)::int AS n FROM players`);
assert.strictEqual(again[0].n, 2, 'a re-run changed the row count');
ok('6 · ⭐ it is idempotent — the nightly can run it every day without drift');

// ---- 7. it records itself, so a silent failure is visible in the jobs table -------------------------------
const { rows: jobs } = await q(`SELECT job, ok FROM job_runs WHERE job='syncInjuries'`);
assert.ok(jobs.length >= 2, 'the job did not record its runs');
assert.ok(jobs.every((j) => j.ok), 'a run recorded itself as failed');
ok('7 · every run is recorded, so a job that quietly stops is visible');

console.log(`\n${pass}/7 database-backed injury checks passed`);
process.exit(0);
