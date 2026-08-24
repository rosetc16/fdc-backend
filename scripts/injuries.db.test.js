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

// ---- 8. ⭐ THE RUN THAT LOOKED LIKE A SUCCESS -------------------------------------------------------------
// Production reported: 530 flagged, 530 wrote, 32 ESPN teams ok, 0 unreadable — and withDetail: 0. Every
// number said "fine" while the feature delivered nothing. A job that can deliver nothing must be able to
// say WHY, in the result box, without anyone reading server logs.
{
  assert.strictEqual(detail.withDetail, 0, 'fixture has no detail available, so this run should report none');
  assert.ok(Array.isArray(detail.hints) && detail.hints.length, 'a run that delivered nothing gave no hint');
  assert.ok(detail.hints.some((h) => /Full refresh|player sync/i.test(h)),
    'it should name the missing player sync: ' + JSON.stringify(detail.hints));
  assert.strictEqual(detail.sleeperHadDetail, 0, 'it should report how much the platform actually supplied');
  ok('8 · ⭐⭐ a run that delivers no detail explains itself in the result, instead of reporting success');
}

// ---- 9. ⭐ THE SOURCE CHAIN IS ACTUALLY WALKED ------------------------------------------------------------
// The second production run: 32 team calls, 32 successes, zero injuries, warning `shape-unrecognized:` with
// an EMPTY key list — because that URL answers 200 with a literal {}. One hard-coded URL against an
// unofficial API cannot tell "wrong endpoint" from "nobody is hurt". So every source must be attempted and
// every attempt must be reported by name.
{
  assert.ok(Array.isArray(detail.espnAttempts) && detail.espnAttempts.length >= 2,
    'the job should report each source it tried: ' + JSON.stringify(detail.espnAttempts));
  assert.strictEqual(detail.espnSourceUsed, null, 'nothing should win with ESPN unreachable');
  const names = detail.espnAttempts.map((a) => a.source);
  assert.ok(names.includes('site-league'), 'the one-call league-wide source must be attempted: ' + names);
  // The counts must cover the WHOLE sweep, not just the first source — an undercount in a diagnostic is
  // exactly how this bug survived two rounds.
  const totalCalls = detail.espnAttempts.reduce((n, a) => n + a.calls, 0);
  assert.strictEqual(detail.espnTeamsOk + detail.espnTeamsFailed, totalCalls,
    `the reported request count (${detail.espnTeamsOk + detail.espnTeamsFailed}) should cover all ${totalCalls} attempted`);
  ok(`9 · ⭐⭐ every ESPN source is tried and named in the result (${names.join(' → ')})`);
}

// ---- 10. ⭐⭐ THE FALLTHROUGH, OVER A REAL HTTP HOP --------------------------------------------------------
// ESPN is unreachable from the build sandbox, so the network hop has been "honestly unverified" through two
// rounds of this bug — and the network hop is where both failures lived. This is as close as I can get: a
// LOCAL server standing in for ESPN, serving the exact response production got (a bare {}) on the first
// source and a real nested payload on the second. It proves the parts that were only ever asserted about:
// that an empty body causes a FALLTHROUGH rather than a reported success, that the winner is recorded, and
// that a matched player actually ends up with detail in the database.
{
  const http = await import('node:http');
  let firstHits = 0, secondHits = 0;
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/empty')) { firstHits++; return res.end('{}'); }
    secondHits++;
    // The per-team-group nesting, with the athlete arriving as a $ref link — both real ESPN shapes.
    res.end(JSON.stringify({ injuries: [{ id: '25', displayName: 'San Francisco 49ers', injuries: [
      { athlete: { $ref: 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/athletes/3117251?lang=en',
                   displayName: 'Christian McCaffrey' },
        status: 'Questionable', date: new Date().toISOString(),
        details: { type: 'Calf', side: 'Right' },
        longComment: 'Limited in practice Wednesday and Thursday; considered day to day.' },
    ] }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const { ESPN_INJURY_SOURCES } = await import('../src/lib/injuries.js');
  const real = ESPN_INJURY_SOURCES.splice(0, ESPN_INJURY_SOURCES.length);
  ESPN_INJURY_SOURCES.push({ name: 'stub-empty', urls: [`${base}/empty`] });
  ESPN_INJURY_SOURCES.push({ name: 'stub-good', urls: [`${base}/good`] });

  const d2 = await syncInjuries();
  server.close();
  ESPN_INJURY_SOURCES.splice(0, ESPN_INJURY_SOURCES.length, ...real);   // put the real chain back

  assert.strictEqual(firstHits, 1, 'the first source should have been tried');
  assert.strictEqual(secondHits, 1, 'an empty body must fall through to the next source, not end the run');
  assert.strictEqual(d2.espnSourceUsed, 'stub-good', 'the winning source must be named: ' + JSON.stringify(d2));
  assert.ok(d2.espnAttempts.some((a) => a.source === 'stub-empty' && a.warnings.includes('empty-object')),
    'the empty source should be recorded as empty: ' + JSON.stringify(d2.espnAttempts));
  assert.strictEqual(d2.espnInjuriesSeen, 1, 'the nested + $ref record should have been read');
  assert.strictEqual(d2.espnMatched, 1, 'it should have matched our player by espn_id 3117251');
  assert.ok(!d2.espnShape, 'no shape map should ship when a source succeeded');
  ok('10 · ⭐⭐ an empty body FALLS THROUGH to the next source, over a real HTTP hop');

  // And the detail must actually be in the row — the whole point of the feature.
  const { rows: after } = await q(`SELECT injury_detail, injury_part, injury_sources FROM players WHERE player_id='p1'`);
  assert.strictEqual(after[0].injury_part, 'Right Calf', 'ESPN should supply the richer body part');
  assert.ok(/day to day/i.test(after[0].injury_detail || ''), 'the note never reached the database: ' + after[0].injury_detail);
  assert.strictEqual(after[0].injury_sources, 'sleeper,espn');
  ok('11 · ⭐ the merged note and body part are written to the player row — end to end');
}

// ---- 12. ⭐⭐ THE REF-EXPANDING FALLBACK, OVER A REAL HTTP HOP ---------------------------------------------
// core-team demonstrably returns real injuries — as `{ items: [{ $ref }] }`, links rather than data. It is
// the one source whose success does not depend on my guessing an envelope right, so it is the safety net
// under every other guess in this file. An untested safety net is not one.
{
  const http = await import('node:http');
  let listHits = 0, refHits = 0;
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/list')) {
      listHits++;
      return res.end(JSON.stringify({ count: 2, items: [{ $ref: `http://127.0.0.1:${port}/ref/1` },
                                                        { $ref: `http://127.0.0.1:${port}/ref/2` }] }));
    }
    refHits++;
    const id = req.url.endsWith('/1') ? '3117251' : '999999';
    res.end(JSON.stringify({
      id: '634999', longComment: 'Missed practice all week and is not expected to play.',
      status: 'Out', date: new Date().toISOString(),
      athlete: { $ref: `http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/athletes/${id}?lang=en` },
      type: { id: '2', description: 'Out', abbreviation: 'O' },
      details: { type: 'Hamstring', side: 'Left' },
    }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const { ESPN_INJURY_SOURCES } = await import('../src/lib/injuries.js');
  const real = ESPN_INJURY_SOURCES.splice(0, ESPN_INJURY_SOURCES.length);
  ESPN_INJURY_SOURCES.push({ name: 'stub-empty', urls: [`http://127.0.0.1:${port}/empty`] });
  ESPN_INJURY_SOURCES.push({ name: 'stub-refs', urls: [`http://127.0.0.1:${port}/list`],
    expandRefs: { max: 50, concurrency: 4 } });

  // The empty source must answer {} so the run genuinely falls through to the ref-expanding one.
  const prev = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    if (req.url.startsWith('/empty')) { res.setHeader('content-type', 'application/json'); return res.end('{}'); }
    return prev(req, res);
  });

  const d3 = await syncInjuries();
  server.close();
  ESPN_INJURY_SOURCES.splice(0, ESPN_INJURY_SOURCES.length, ...real);

  assert.strictEqual(d3.espnSourceUsed, 'stub-refs', 'the ref-expanding source should have won: ' + JSON.stringify(d3));
  assert.strictEqual(listHits, 1, 'the listing should be fetched once');
  assert.strictEqual(refHits, 2, 'BOTH refs should have been followed, not just the first');
  const att = d3.espnAttempts.find((a) => a.source === 'stub-refs');
  assert.strictEqual(att.refsExpanded, 2, 'the job should report how many links it followed: ' + JSON.stringify(att));
  assert.strictEqual(d3.espnInjuriesSeen, 2, 'both expanded records should have been read');
  assert.strictEqual(d3.espnMatched, 1, 'the one whose id we hold should match; the other should not');
  ok('12 · ⭐⭐ the $ref fallback follows its links and delivers — the path that cannot fail on shape');

  const { rows: r3 } = await q(`SELECT injury_part, injury_detail FROM players WHERE player_id='p1'`);
  assert.strictEqual(r3[0].injury_part, 'Left Hamstring');
  assert.ok(/not expected to play/.test(r3[0].injury_detail || ''), 'the expanded note never landed');
  ok('13 · ⭐ detail obtained by following a $ref reaches the player row');
}

console.log(`\n${pass}/13 database-backed injury checks passed`);
process.exit(0);
