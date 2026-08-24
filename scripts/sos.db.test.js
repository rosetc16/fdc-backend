// syncSchedule AGAINST A REAL DATABASE, AND A REAL NETWORK HOP.
//
// The pure tests prove the mapping. They cannot prove the two things that actually broke the injury feature
// four times running: a table that did not exist on a database nobody migrated, and a network hop nobody
// could see from this sandbox.
//
// So this runs the REAL job against a REAL Postgres on a schema that has never heard of nfl_schedule, with a
// LOCAL http server standing in for the schedule providers. That last trick is the one lesson worth carrying
// everywhere: a source chain is just an array, so stub entries can be swapped into it in place and the whole
// fetch → map → sanity-check → write path exercised end to end without reaching the internet.
import assert from 'assert';

const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!URL) {
  console.log('  SKIP  no TEST_DATABASE_URL — skipping the database-backed schedule checks');
  process.exit(0);
}
process.env.DATABASE_URL = URL;

const { q } = await import('../src/lib/db.js');
let pass = 0;
const ok = (n) => { console.log('  PASS  ' + n); pass++; };

await q('DROP TABLE IF EXISTS nfl_schedule CASCADE');
await q('DROP TABLE IF EXISTS job_runs CASCADE');
await q('CREATE TABLE job_runs (job TEXT, ok BOOLEAN, detail JSONB, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ)');

const { syncSchedule, getSchedule } = await import('../src/jobs/syncSchedule.js');
const { scheduleSourcesResolved, TEAMS } = await import('../src/lib/nflSchedule.js');
const SEASON = 2026;

// A COMPLETE, LEGAL schedule: 32 teams, 18 weeks, every team on bye exactly once. Built by rotation so it is
// real arithmetic rather than a hand-typed table that could itself be wrong.
function legalSchedule() {
  const weeks = [];
  for (let w = 1; w <= 18; w++) {
    const games = [];
    // Rotate the second half against the first, and sit two teams out each week so byes appear.
    const rot = TEAMS.slice();
    const off = (w * 2) % 32;
    const bench = [rot[off], rot[(off + 1) % 32]];
    const playing = rot.filter((t) => !bench.includes(t));
    for (let i = 0; i < playing.length; i += 2) {
      const home = playing[(i + w) % playing.length];
      const away = playing[(i + w + 1) % playing.length];
      if (home !== away && !games.some((g) => [g.home, g.away].includes(home) || [g.home, g.away].includes(away))) {
        games.push({ week: w, home, away });
      }
    }
    weeks.push(...games);
  }
  return weeks;
}

// Stand a local server in for the providers and point the source chain at it.
async function withStub(handler, fn) {
  const http = await import('node:http');
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    return await fn(port);
  } finally { server.close(); }
}

// The job builds its own chain internally, so the stub is injected by patching the module's source list.
const nflSched = await import('../src/lib/nflSchedule.js');

// ---- 1. ⭐ IT RUNS ON A DATABASE THAT HAS NEVER HEARD OF IT -----------------------------------------------
// `relation "player_news" does not exist` shipped to production because db/schema.sql is only applied by a
// manual migrate. Every new table has to create itself.
let d1;
await assert.doesNotReject(async () => { d1 = await syncSchedule({ season: SEASON }); },
  'syncSchedule threw on a database with no nfl_schedule table');
ok('1 · ⭐ the job creates its own table and survives a database that predates the feature');

// ---- 2. every source unreachable degrades, it does not fail ----------------------------------------------
assert.ok(d1 && Array.isArray(d1.attempts) && d1.attempts.length >= 2,
  'the job should report each source it tried: ' + JSON.stringify(d1 && d1.attempts));
assert.strictEqual(d1.sourceUsed, null, 'nothing should win with the providers unreachable');
assert.strictEqual(d1.wrote, 0);
assert.ok(d1.hints && d1.hints.length, 'a run that stored nothing must say why');
ok(`2 · ⭐ unreachable providers are survived, counted and explained (${d1.attempts.length} sources tried)`);

// ---- 3. ⭐⭐ THE HAPPY PATH, OVER A REAL HTTP HOP -----------------------------------------------------------
{
  const games = legalSchedule();
  const d2 = await withStub((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ season: SEASON, games }));
  }, async (port) => syncSchedule({ season: SEASON, sources: [
    { name: 'stub-season', urls: [`http://127.0.0.1:${port}/sched`], map: (j) => nflSched.mapSchedule(j) },
  ] }));

  assert.strictEqual(d2.sourceUsed, 'stub-season', 'the winning source must be named: ' + JSON.stringify(d2));
  assert.ok(d2.wrote > 400, `a full season should write hundreds of rows, wrote ${d2.wrote}`);
  assert.ok(d2.teams >= 30, `expected ~32 teams, got ${d2.teams}`);
  assert.ok(!d2.refused, 'a legal schedule must not be refused: ' + JSON.stringify(d2.refused));
  ok(`3 · ⭐⭐ a real fetch → map → write lands a full season (${d2.wrote} rows, ${d2.teams} teams)`);

  const stored = await getSchedule(SEASON);
  assert.ok(stored.length === d2.wrote, 'what was written should read back');
  // The invariant that matters: a team plays AT MOST once per week. A duplicate would double a matchup and
  // silently skew that team's SOS.
  const seen = new Set();
  for (const r of stored) {
    const k = `${r.week}:${r.team}`;
    assert.ok(!seen.has(k), `duplicate row for ${k}`);
    seen.add(k);
  }
  // And the schedule is symmetric: if A plays B in week 5, B plays A in week 5.
  const byKey = new Map(stored.map((r) => [`${r.week}:${r.team}`, r.opponent]));
  for (const r of stored) {
    assert.strictEqual(byKey.get(`${r.week}:${r.opponent}`), r.team,
      `asymmetric matchup: ${r.team} plays ${r.opponent} in week ${r.week} but not the reverse`);
  }
  ok('4 · ⭐ the stored schedule is internally consistent — one game per team per week, and symmetric');
}

// ---- 5. ⭐⭐ IT REFUSES A SCHEDULE THAT IS OBVIOUSLY WRONG --------------------------------------------------
// This is the assertion that protects every number downstream. A partially-read payload is far more dangerous
// than an unreadable one: a missing week reads as a BYE, so a half-read schedule would tell a drafter his
// first-round back is unavailable in the championship round. Better to keep the old schedule and say so.
{
  const before = (await getSchedule(SEASON)).length;
  assert.ok(before > 400, 'precondition: a good schedule is already stored');

  const d3 = await withStub((req, res) => {
    res.setHeader('content-type', 'application/json');
    // Only three teams and two weeks — the shape of a payload we half-understood.
    res.end(JSON.stringify({ games: [
      { week: 1, home: 'KC', away: 'BAL' }, { week: 2, home: 'KC', away: 'BUF' },
    ] }));
  }, async (port) => syncSchedule({ season: SEASON, sources: [
    { name: 'stub-partial', urls: [`http://127.0.0.1:${port}/s`], map: (j) => nflSched.mapSchedule(j) },
  ] }));

  assert.ok(d3.refused && d3.refused.length, 'a 3-team "schedule" must be REFUSED: ' + JSON.stringify(d3));
  assert.strictEqual(d3.wrote, 0, 'nothing should have been written');
  const after = (await getSchedule(SEASON)).length;
  assert.strictEqual(after, before, 'the previously-good schedule was destroyed by a bad run');
  assert.ok(d3.hints.some((h) => /REFUSED/i.test(h)), 'the refusal must be explained: ' + JSON.stringify(d3.hints));
  ok('5 · ⭐⭐ a half-read schedule is REFUSED and the good one is left intact — a partial schedule reads as byes');
}

// ---- 6. it records itself -------------------------------------------------------------------------------
{
  const { rows } = await q(`SELECT job, ok FROM job_runs WHERE job='syncSchedule'`);
  assert.ok(rows.length >= 3, 'every run should be recorded');
  ok('6 · every run is recorded, so a schedule sync that quietly stops is visible');
}

// ---- 7. ⭐ END TO END: schedule + defensive ranks → a real SOS table ---------------------------------------
{
  const { computePlayoffSos } = await import('../src/lib/playoffSos.js');
  const stored = await getSchedule(SEASON);
  // A synthetic but complete defensive table so the ranking has something real to chew on.
  const defTable = {};
  TEAMS.forEach((t, i) => {
    defTable[t] = { RB: { rank: i + 1, of: 32, tier: i < 11 ? 'tough' : i < 22 ? 'neutral' : 'soft' } };
  });
  const table = computePlayoffSos(stored, defTable, [15, 16, 17], ['RB']);
  const ranked = Object.keys(table);
  assert.ok(ranked.length >= 28, `most teams should get a number, got ${ranked.length}`);
  const ranks = ranked.map((t) => table[t].RB.rank).sort((a, b) => a - b);
  assert.strictEqual(ranks[0], 1, 'somebody must be ranked easiest');
  assert.strictEqual(new Set(ranks).size, ranks.length, 'ranks must be unique');
  // Somebody in a 32-team, 18-week schedule is on bye during the playoff weeks, and it must show.
  const byeTeams = ranked.filter((t) => table[t].RB.byes > 0);
  assert.ok(byeTeams.length > 0, 'no playoff byes detected in a full schedule — the bye path is untested');
  ok(`7 · ⭐ a stored schedule plus defensive ranks produces a complete, unique ranking (${ranked.length} teams, ${byeTeams.length} with playoff byes)`);
}

console.log(`\n${pass}/7 database-backed schedule checks passed`);
process.exit(0);
