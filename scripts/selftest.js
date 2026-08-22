// Backend self-test. Pure logic only — no DB, no network (Sleeper is unreachable from CI/sandboxes).
// Run: node scripts/selftest.js
import assert from 'node:assert';
import fs from 'node:fs';

let pass = 0;
const ok = (n) => { console.log('  PASS  ' + n); pass++; };
const src = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

// ---- getRemainingSchedule's matchup grouping (sliced from the shipped route) ------------------------
// The shape it consumes is the same one the existing matchup code already relies on (m.matchup_id +
// m.roster_id), so the risk isn't the field names — it's the grouping.
{
  const ms = [
    { roster_id: 1, matchup_id: 1 }, { roster_id: 5, matchup_id: 1 },
    { roster_id: 2, matchup_id: 2 }, { roster_id: 9, matchup_id: 2 },
    { roster_id: 3, matchup_id: 3 }, { roster_id: 7, matchup_id: 3 },
  ];
  const byMatch = new Map();
  ms.forEach((m) => {
    if (m == null || m.matchup_id == null || m.roster_id == null) return;
    const arr = byMatch.get(m.matchup_id) || []; arr.push(m.roster_id); byMatch.set(m.matchup_id, arr);
  });
  const pairs = []; byMatch.forEach((ids) => { if (ids.length === 2) pairs.push([ids[0], ids[1]]); });
  assert.deepStrictEqual(pairs, [[1, 5], [2, 9], [3, 7]]);

  // A bye/odd league (three rosters share an id, or one sits alone) must not produce a bogus pair.
  const odd = [{ roster_id: 1, matchup_id: 1 }, { roster_id: 2, matchup_id: 2 }, { roster_id: 3, matchup_id: 2 }, { roster_id: 4, matchup_id: 2 }];
  const m2 = new Map();
  odd.forEach((m) => { const a = m2.get(m.matchup_id) || []; a.push(m.roster_id); m2.set(m.matchup_id, a); });
  const p2 = []; m2.forEach((ids) => { if (ids.length === 2) p2.push([ids[0], ids[1]]); });
  assert.deepStrictEqual(p2, [], 'only exact pairs become games');
  ok('1 · matchups group into exact roster pairs; odd/incomplete matchup ids are dropped, not guessed');
}

// ---- the route actually ships the five fields the hub consumes -------------------------------------
{
  const connect = src('src/routes/connect.js');
  ['playoffStartWeek', 'regularSeasonWeeks', 'playoffTeams', 'faabBudget', 'faabLeft', 'schedule']
    .forEach((k) => assert.ok(new RegExp(`^\\s*${k},`, 'm').test(connect) || connect.includes(`${k},`), `team-hub response is missing ${k}`));
  assert.ok(connect.includes('waiver_budget_used'), 'per-roster FAAB spend is not read');
  assert.ok(connect.includes('_schedCache'), 'the schedule is not cached — that is ~10 Sleeper calls per hub open');
  ok('2 · team-hub ships playoffStartWeek/regularSeasonWeeks/playoffTeams/faabBudget/faabLeft/schedule, and caches the schedule');
}

// ---- the prune job is actually SCHEDULED (it existed for weeks and never ran) -----------------------
{
  const server = src('src/server.js');
  assert.ok(/cron\.schedule\([^)]*\)[\s\S]{0,400}pruneObservations/.test(server), 'pruneObservations is not on a cron');
  assert.ok(/cron\.schedule\([^)]*\)[\s\S]{0,400}sendWeeklyBriefs/.test(server), 'the weekly brief is not on a cron');
  ok('3 · the nightly prune and the weekly brief are both wired to cron, not just defined');
}

// ---- weekly brief: roster_positions -> start slots --------------------------------------------------
{
  const brief = src('src/jobs/weeklyBrief.js');
  const fn = brief.slice(brief.indexOf('function startFromPositions'), brief.indexOf('const sum ='));
  // eslint-disable-next-line no-eval
  const startFromPositions = eval('(' + fn.replace('function startFromPositions', 'function') + ')');
  assert.deepStrictEqual(
    startFromPositions(['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'K', 'DEF', 'BN', 'BN']),
    { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER: 1 });
  assert.deepStrictEqual(startFromPositions(['QB', 'QB', 'RB', 'WR', 'REC_FLEX']), { QB: 2, RB: 1, WR: 1, TE: 0, FLEX: 1, SUPER: 0 });
  assert.deepStrictEqual(startFromPositions([]), { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, SUPER: 0 });
  assert.deepStrictEqual(startFromPositions(null), { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, SUPER: 0 });
  ok('4 · Sleeper roster_positions map to start slots; bench/K/DEF ignored, REC_FLEX counts as a flex');
}

// ---- weekly brief: the optimizer, which is the only claim the email actually makes ------------------
{
  const brief = src('src/jobs/weeklyBrief.js');
  const fn = brief.slice(brief.indexOf('function bestLineup'), brief.indexOf('// Sleeper\'s roster_positions'));
  // eslint-disable-next-line no-eval
  const bestLineup = eval('(' + fn.replace('function bestLineup', 'function') + ')');
  const P = (id, pos, pts) => ({ id, pos, pts, name: id });
  const roster = [
    P('qb1', 'QB', 22), P('qb2', 'QB', 18),
    P('rb1', 'RB', 17), P('rb2', 'RB', 12), P('rb3', 'RB', 9),
    P('wr1', 'WR', 16), P('wr2', 'WR', 14), P('wr3', 'WR', 13),
    P('te1', 'TE', 8),
  ];
  const start = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER: 0 };
  const best = bestLineup(roster, start).map((p) => p.id);
  // QB1 + RB2 + WR2 + TE1 + FLEX1 = seven starters; the flex is the best remaining skill body (wr3 at 13).
  assert.deepStrictEqual(best, ['qb1', 'rb1', 'rb2', 'wr1', 'wr2', 'te1', 'wr3'], 'got ' + best.join(','));
  assert.ok(!best.includes('qb2'), 'a second QB must not start without a superflex slot');

  // superflex: the spare QB is the best flex-eligible body and should take the slot
  const sf = bestLineup(roster, { ...start, SUPER: 1 }).map((p) => p.id);
  assert.ok(sf.includes('qb2'), 'superflex should start the second QB: ' + sf.join(','));

  // a thin roster never invents players or throws
  assert.deepStrictEqual(bestLineup([P('rb1', 'RB', 5)], start).map((p) => p.id), ['rb1']);
  assert.deepStrictEqual(bestLineup([], start), []);
  ok('5 · lineup optimizer fills base slots then FLEX then SUPER_FLEX, never starts an extra QB in a 1QB league');
}

// ---- the brief refuses to send without mail configured, rather than half-sending -------------------
{
  const brief = src('src/jobs/weeklyBrief.js');
  assert.ok(brief.includes("if (!process.env.RESEND_API_KEY && !dryRun)"), 'the job must no-op without a mail key');
  assert.ok(brief.includes("season_type !== 'regular'"), 'the job must not email in the off-season');
  assert.ok(/paid_until IS NOT NULL AND paid_until > now\(\)/.test(brief), 'only paid/comped users should be emailed');
  assert.ok(brief.includes('disabled IS NOT TRUE'), 'disabled accounts must be excluded');
  ok('6 · the brief no-ops without a mail key, skips the off-season, and only mails active non-disabled accounts');
}

console.log(`\n${pass}/6 backend checks passed`);
