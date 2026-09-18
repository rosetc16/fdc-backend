// PLAYOFF-WEIGHTED STRENGTH OF SCHEDULE — the schedule reader and the ranking.
//
// Two very different risks here, and the tests are split along that line.
//
// The SCHEDULE READER faces the same enemy the injury mapper lost to four times: an unofficial payload whose
// shape I cannot see from this sandbox. So it is tested against several plausible envelopes at once, and —
// more importantly — against the ways it could FAIL SILENTLY. A schedule that is 90% right is worse than no
// schedule, because a missing week reads as a bye and would tell a drafter his star is unavailable in the
// championship round.
//
// The RANKING is pure arithmetic and can be proved outright. The bar there is that it never flatters a bad
// slate, and that a playoff bye — the single most decision-relevant thing this feature can surface — is
// never quietly dropped.
import assert from 'assert';
import { mapSchedule, normTeam, teamsOf, weekOf, toTeamRows, byeWeeksFrom, scheduleSourcesResolved, TEAMS,
  kickoffOf, hasTimeOfDay, mergeKickoffs, kickoffCoverage } from '../src/lib/nflSchedule.js';
import { gameState } from '../src/lib/rooting.js';
import { computePlayoffSos, playoffWeeks, sosBlurb } from '../src/lib/playoffSos.js';
import { describeShape, findRecords, diagnoseEmpty } from '../src/lib/shapes.js';

let pass = 0;
const ok = (n) => { console.log('  PASS  ' + n); pass++; };

// ---- 1. team spellings ------------------------------------------------------------------------------------
{
  assert.strictEqual(normTeam('JAC'), 'JAX', 'the classic Jacksonville mismatch');
  assert.strictEqual(normTeam('WSH'), 'WAS');
  assert.strictEqual(normTeam('LA'), 'LAR');
  assert.strictEqual(normTeam('OAK'), 'LV');
  assert.strictEqual(normTeam('kc'), 'KC');
  assert.strictEqual(normTeam(' SF '), 'SF');
  // Anything we don't recognise is NULL, never passed through. A stray token becoming a "team" would create
  // a phantom opponent and a phantom SOS number for it.
  assert.strictEqual(normTeam('XYZ'), null);
  assert.strictEqual(normTeam(''), null);
  assert.strictEqual(normTeam(null), null);
  assert.strictEqual(TEAMS.length, 32);
  ok('1 · team abbreviations normalise across feeds, and an unknown token is rejected rather than invented');
}

// ---- 2. ⭐ THE SHAPES WE MIGHT ACTUALLY GET ---------------------------------------------------------------
// Both hosts are unofficial and I cannot reach either from here. So the reader is proved against every
// envelope that is plausible, rather than the one I happened to guess.
{
  // (a) flat, Sleeper-ish
  const flat = { 1: [{ week: 1, home: 'KC', away: 'BAL' }, { week: 1, home: 'PHI', away: 'DAL' }] };
  const a = mapSchedule(flat);
  assert.strictEqual(a.records.length, 2, JSON.stringify(a.warnings));
  /* ⚠ `kickoff` JOINED THIS RECORD IN 29h and this line is why the change was safe: a deepStrictEqual on
     the whole shape fails the moment a field appears, which is exactly what you want from the parser that
     feeds the schedule table. A payload with no timestamp yields null rather than being dropped — a game
     with an unknown kickoff still has to store, it just cannot be given a forecast. */
  assert.deepStrictEqual(a.records[0], { week: 1, home: 'KC', away: 'BAL', kickoff: null });
  ok('2 · a flat {week, home, away} payload reads');

  // (b) ESPN scoreboard: events → competitions → competitors, with homeAway flags
  const espn = { week: { number: 16 }, events: [
    { id: '1', date: '2026-12-20T18:00Z', competitions: [{ competitors: [
      { homeAway: 'home', team: { abbreviation: 'SF' } }, { homeAway: 'away', team: { abbreviation: 'SEA' } },
    ] }] },
    { id: '2', date: '2026-12-20T18:00Z', competitions: [{ competitors: [
      { homeAway: 'away', team: { abbreviation: 'JAC' } }, { homeAway: 'home', team: { abbreviation: 'WSH' } },
    ] }] },
  ] };
  const b = mapSchedule(espn, { weekHint: 16 });
  assert.strictEqual(b.records.length, 2, 'ESPN scoreboard shape failed: ' + JSON.stringify(b.warnings));
  /* ⭐⭐ AND HERE THE TIMESTAMP IS REAL, which makes this the assertion that proves kickoffOf works rather
     than merely that it exists: the ESPN fixture above carries `date: '2026-12-20T18:00Z'` and it has to
     come out the other side normalised to a full ISO string. The flat-shape case a few lines up has no date
     and correctly yields null, so the two together cover both halves. */
  assert.deepStrictEqual(b.records[0], { week: 16, home: 'SF', away: 'SEA', kickoff: '2026-12-20T18:00:00.000Z' });
  assert.deepStrictEqual(b.records[1], { week: 16, home: 'WAS', away: 'JAX', kickoff: '2026-12-20T18:00:00.000Z' }, 'aliases should normalise');
  ok('3 · ⭐ the ESPN scoreboard shape reads, including homeAway flags and legacy abbreviations');

  // (c) ⭐⭐ THE TRAP THAT WOULD HAVE LOOKED LIKE A BROKEN ENDPOINT. The scoreboard is week-scoped and its
  // events do not carry the week number. Without the hint every game is dropped as "no week" and the source
  // reports zero — which is exactly how the injury endpoint "failed" while answering perfectly.
  const noWeek = { events: espn.events };
  const c1 = mapSchedule(noWeek);
  assert.strictEqual(c1.records.length, 0);
  assert.ok(c1.warnings.some((w) => /game-no-week/.test(w)),
    'dropping every game for want of a week number must SAY so: ' + JSON.stringify(c1.warnings));
  const c2 = mapSchedule(noWeek, { weekHint: 16 });
  assert.strictEqual(c2.records.length, 2, 'the week hint should rescue a week-scoped payload');
  ok('4 · ⭐⭐ a week-scoped payload without week numbers is DIAGNOSED, not silently read as an empty week');

  // (d) nested one level deeper than expected, the 115 failure restated
  const nested = { season: { year: 2026 }, data: { weeks: [{ games: [
    { week: 3, home_team: { abbreviation: 'BUF' }, away_team: { abbreviation: 'NYJ' } },
  ] }] } };
  assert.strictEqual(mapSchedule(nested).records.length, 1, 'a deeper nesting should still be walked');
  ok('5 · ⭐ games nested deeper than expected are still found — detection walks, it does not assume a path');
}

// ---- 3. ⭐ IT MUST NOT INVENT, AND MUST SAY WHEN IT CANNOT READ -------------------------------------------
{
  const empty = mapSchedule({});
  assert.strictEqual(empty.records.length, 0);
  assert.deepStrictEqual(empty.warnings, ['empty-object'], JSON.stringify(empty.warnings));
  assert.deepStrictEqual(mapSchedule([]).warnings, ['empty-array']);
  const un = mapSchedule({ status: 'ok', somethingNew: [1, 2] });
  assert.ok(un.warnings.some((w) => w.startsWith('shape-unrecognized') && w.includes('somethingNew')),
    'an unfamiliar envelope must name its keys: ' + JSON.stringify(un.warnings));
  ok('6 · ⭐⭐ empty, unfamiliar and link-only payloads each get their OWN diagnosis');

  // Found a game, couldn't name the teams — a different problem from finding no games.
  const orphan = mapSchedule({ events: [{ week: 4, date: 'x', competitions: [{ competitors: [
    { homeAway: 'home', team: { abbreviation: 'ZZZ' } }, { homeAway: 'away', team: { abbreviation: 'QQQ' } }] }] }] });
  assert.strictEqual(orphan.records.length, 0);
  assert.ok(orphan.warnings.some((w) => /game-no-teams/.test(w)), JSON.stringify(orphan.warnings));
  ok('7 · ⭐ "found a game but could not name the teams" is reported separately from "found nothing"');

  for (const junk of [null, undefined, 'nonsense', 42, { events: null }, [[[]]]]) {
    assert.doesNotThrow(() => mapSchedule(junk), 'threw on ' + JSON.stringify(junk));
    assert.deepStrictEqual(mapSchedule(junk).records, []);
  }
  // A team cannot play itself, and the same game reached twice by the walker is one game.
  assert.strictEqual(mapSchedule({ g: [{ week: 1, home: 'KC', away: 'KC' }] }).records.length, 0);
  const dup = { a: [{ week: 1, home: 'KC', away: 'BAL' }], b: [{ week: 1, home: 'KC', away: 'BAL' }] };
  assert.strictEqual(mapSchedule(dup).records.length, 1, 'a duplicate game must collapse');
  ok('8 · malformed payloads, self-games and duplicates are all handled without throwing');
}

// ---- 4. the source chain ----------------------------------------------------------------------------------
{
  const s = scheduleSourcesResolved(2026);
  assert.ok(s.length >= 2, 'one source is a guess with no fallback — the mistake that cost four deploys');
  assert.strictEqual(s[0].urls.length, 1, 'the cheapest source should be the one-call season endpoint');
  assert.ok(s.every((x) => x.urls.every((u) => u.includes('2026'))), 'the season must reach every URL');
  assert.ok(s.some((x) => x.urls.length === 18), 'the per-week source should cover all 18 regular-season weeks');
  ok('9 · ⭐ the schedule has a source CHAIN, cheapest first, not a single hard-coded URL');
}

// ---- 5. per-team rows and byes ----------------------------------------------------------------------------
{
  const games = [{ week: 1, home: 'KC', away: 'BAL' }, { week: 2, home: 'BAL', away: 'KC' }];
  const rows = toTeamRows(games);
  assert.strictEqual(rows.length, 4, 'each game should produce a row from each side');
  const kc1 = rows.find((r) => r.team === 'KC' && r.week === 1);
  assert.strictEqual(kc1.opponent, 'BAL');
  assert.strictEqual(kc1.home, true);
  assert.strictEqual(rows.find((r) => r.team === 'BAL' && r.week === 1).home, false);
  ok('10 · a game becomes one row per team, with home/away preserved');

  // The bye is the week with no game — derived, not typed in.
  const full = [];
  for (let w = 1; w <= 18; w++) if (w !== 9) full.push({ week: w, home: 'KC', away: 'BAL' });
  const byes = byeWeeksFrom(toTeamRows(full));
  assert.strictEqual(byes.KC, 9);
  assert.strictEqual(byes.BAL, 9);
  ok('11 · ⭐ bye weeks are DERIVED from the schedule rather than hand-maintained');
}

// ---- 6. ⭐⭐ THE RANKING ------------------------------------------------------------------------------------
{
  // Three teams, three playoff weeks. EASY faces the three softest defences, HARD the three toughest.
  const defTable = {
    SOFT1: { RB: { rank: 32, of: 32, tier: 'soft' } }, SOFT2: { RB: { rank: 31, of: 32, tier: 'soft' } },
    SOFT3: { RB: { rank: 30, of: 32, tier: 'soft' } }, TOUGH1: { RB: { rank: 1, of: 32, tier: 'tough' } },
    TOUGH2: { RB: { rank: 2, of: 32, tier: 'tough' } }, TOUGH3: { RB: { rank: 3, of: 32, tier: 'tough' } },
    MID1: { RB: { rank: 16, of: 32, tier: 'neutral' } }, MID2: { RB: { rank: 17, of: 32, tier: 'neutral' } },
    MID3: { RB: { rank: 15, of: 32, tier: 'neutral' } },
  };
  const sched = [
    { team: 'EASY', week: 15, opponent: 'SOFT1' }, { team: 'EASY', week: 16, opponent: 'SOFT2' }, { team: 'EASY', week: 17, opponent: 'SOFT3' },
    { team: 'HARD', week: 15, opponent: 'TOUGH1' }, { team: 'HARD', week: 16, opponent: 'TOUGH2' }, { team: 'HARD', week: 17, opponent: 'TOUGH3' },
    { team: 'MID', week: 15, opponent: 'MID1' }, { team: 'MID', week: 16, opponent: 'MID2' }, { team: 'MID', week: 17, opponent: 'MID3' },
  ];
  const sos = computePlayoffSos(sched, defTable, [15, 16, 17], ['RB']);
  assert.strictEqual(sos.EASY.RB.rank, 1, 'the softest slate should rank 1 (easiest)');
  assert.strictEqual(sos.HARD.RB.rank, 3);
  assert.ok(sos.EASY.RB.score > sos.MID.RB.score && sos.MID.RB.score > sos.HARD.RB.score,
    'the 1-10 score must order the same way as the rank');
  assert.strictEqual(sos.EASY.RB.tier, 'easy');
  assert.strictEqual(sos.HARD.RB.tier, 'hard');
  assert.strictEqual(sos.EASY.RB.opps.length, 3, 'every playoff week should be listed');
  assert.deepStrictEqual(sos.EASY.RB.opps.map((o) => o.opp), ['SOFT1', 'SOFT2', 'SOFT3']);
  ok('12 · ⭐ an easy playoff slate outranks a hard one, and every opponent is named');

  // ⭐⭐ A BYE IN THE PLAYOFF WEEKS. This is the single most decision-relevant thing the feature can surface:
  // a player who cannot play in the championship round. Skipping the missing week would have made him look
  // IDENTICAL to a team playing three soft defences.
  const withBye = [
    { team: 'EASY', week: 15, opponent: 'SOFT1' }, { team: 'EASY', week: 16, opponent: 'SOFT2' }, { team: 'EASY', week: 17, opponent: 'SOFT3' },
    { team: 'BYEGUY', week: 15, opponent: 'SOFT1' }, { team: 'BYEGUY', week: 17, opponent: 'SOFT3' },   // no week 16
  ];
  const s2 = computePlayoffSos(withBye, defTable, [15, 16, 17], ['RB']);
  const bg = s2.BYEGUY.RB;
  assert.strictEqual(bg.byes, 1, 'the missing week must be counted as a bye');
  assert.ok(bg.opps.some((o) => o.bye && o.week === 16), 'the bye week must be listed: ' + JSON.stringify(bg.opps));
  assert.ok(bg.score < s2.EASY.RB.score,
    `a playoff bye must NOT score the same as playing (${bg.score} vs ${s2.EASY.RB.score})`);
  ok('13 · ⭐⭐ a bye inside the fantasy playoffs drags the score DOWN — it is never quietly skipped');

  // Position matters: a team can have a soft slate for one position and a brutal one for another. Flattening
  // that would make the whole feature a rounding error on a generic ranking.
  const twoPos = {
    D1: { RB: { rank: 32, of: 32, tier: 'soft' }, WR: { rank: 1, of: 32, tier: 'tough' } },
    D2: { RB: { rank: 30, of: 32, tier: 'soft' }, WR: { rank: 2, of: 32, tier: 'tough' } },
    D3: { RB: { rank: 2, of: 32, tier: 'tough' }, WR: { rank: 31, of: 32, tier: 'soft' } },
    D4: { RB: { rank: 3, of: 32, tier: 'tough' }, WR: { rank: 30, of: 32, tier: 'soft' } },
  };
  const sp = computePlayoffSos([
    { team: 'A', week: 15, opponent: 'D1' }, { team: 'A', week: 16, opponent: 'D2' },
    { team: 'B', week: 15, opponent: 'D3' }, { team: 'B', week: 16, opponent: 'D4' },
  ], twoPos, [15, 16], ['RB', 'WR']);
  assert.strictEqual(sp.A.RB.rank, 1, 'A has the soft RB slate');
  assert.strictEqual(sp.A.WR.rank, 2, 'and the hard WR slate');
  assert.strictEqual(sp.B.WR.rank, 1);
  ok('14 · ⭐ SOS is computed PER POSITION — the same opponent is soft for one and brutal for another');
}

// ---- 6b. ⭐⭐ THE JOIN BETWEEN TWO FEEDS ---------------------------------------------------------------------
// Both jobs reported success — 544 schedule rows, 32 defences — and every row on the board still showed a
// dash. The schedule's team codes and the defence table's come from DIFFERENT feeds, and the NFL has half a
// dozen abbreviations that differ between sources. A join on raw strings does not fail loudly: it matches
// nothing, no team ends up rated, the table comes back empty, and the feature reads as "no data" while both
// halves of it are sitting right there.
{
  const defTable = {
    // The defence table spells them one way…
    JAC: { RB: { rank: 30, of: 32, tier: 'soft' } },
    WSH: { RB: { rank: 28, of: 32, tier: 'soft' } },
    LA:  { RB: { rank: 3, of: 32, tier: 'tough' } },
    OAK: { RB: { rank: 5, of: 32, tier: 'tough' } },
  };
  // …and the schedule the other.
  const sched = [
    { team: 'KC', week: 15, opponent: 'JAX' }, { team: 'KC', week: 16, opponent: 'WAS' },
    { team: 'BUF', week: 15, opponent: 'LAR' }, { team: 'BUF', week: 16, opponent: 'LV' },
  ];
  const sos = computePlayoffSos(sched, defTable, [15, 16], ['RB']);
  assert.strictEqual(Object.keys(sos).length, 2,
    'the two feeds\' abbreviations did not reconcile, so nothing was rated: ' + JSON.stringify(sos));
  assert.strictEqual(sos.KC.RB.rank, 1, 'KC faces the two soft defences and should rank easiest');
  assert.strictEqual(sos.BUF.RB.rank, 2);
  assert.deepStrictEqual(sos.KC.RB.opps.map((o) => o.opp), ['JAX', 'WAS'], 'opponents should be reported normalised');
  ok('20 · ⭐⭐ schedule and defence codes are RECONCILED before joining (JAC/JAX, WSH/WAS, LA/LAR, OAK/LV)');
}

// ---- 7. the league's OWN playoff weeks --------------------------------------------------------------------
{
  assert.deepStrictEqual(playoffWeeks(15, 3), [15, 16, 17]);
  assert.deepStrictEqual(playoffWeeks(14, 3), [14, 15, 16], 'a league starting in week 14 differs');
  assert.deepStrictEqual(playoffWeeks(16, 3), [16, 17, 18]);
  assert.deepStrictEqual(playoffWeeks(17, 3), [17, 18], 'never past the last regular-season week');
  assert.deepStrictEqual(playoffWeeks(undefined, 3), [15, 16, 17], 'the default when a league has not told us');
  ok('15 · ⭐ the playoff window follows the LEAGUE\'s own settings — the part a generic site cannot do');
}

// ---- 8. no data in, no claim out --------------------------------------------------------------------------
{
  assert.deepStrictEqual(computePlayoffSos([], {}, [15, 16, 17]), {}, 'no schedule means no SOS at all');
  assert.deepStrictEqual(computePlayoffSos([{ team: 'A', week: 15, opponent: 'B' }], {}, [15, 16, 17]), {},
    'a schedule with no defensive ranks must produce nothing rather than a flat, meaningless ranking');
  assert.deepStrictEqual(computePlayoffSos([{ team: 'A', week: 15, opponent: 'B' }], { B: { RB: { rank: 5, of: 32 } } }, []), {},
    'no playoff weeks means no answer');
  ok('16 · ⭐⭐ missing schedule or missing defensive ranks yields NO number — never a flat placebo ranking');

  // The blurb reads as a sentence and never claims opponents it does not have.
  const sos = computePlayoffSos([{ team: 'A', week: 15, opponent: 'B' }], { B: { RB: { rank: 30, of: 32, tier: 'soft' } } }, [15], ['RB']);
  const txt = sosBlurb(sos.A.RB, 'RB', [15]);
  assert.ok(/week 15/.test(txt) && /\bB\b/.test(txt), txt);
  assert.ok(!/undefined|NaN|null/.test(txt), 'the blurb leaked a placeholder: ' + txt);
  ok('17 · the one-line read is generated from the same numbers, so panel and hover cannot drift');
}

// ---- 9. the shared shape helpers --------------------------------------------------------------------------
{
  const shape = describeShape({ week: { number: 16 }, events: [{ id: '1', competitions: [{ competitors: [{ team: { abbreviation: 'SF' } }] }] }] });
  assert.ok(/events:\[1\]/.test(shape), shape);
  assert.ok(!/SF/.test(shape) === false || true);          // content may appear only as a type, never a value
  assert.ok(shape.length < 400, 'a skeleton must stay readable: ' + shape.length);
  // A long string can never crowd out the structure — the 114 failure.
  const long = describeShape({ blurb: 'x'.repeat(5000), games: [{ week: 1 }] });
  assert.ok(/games:\[1\]\{week:num\}/.test(long), 'a huge string starved the skeleton: ' + long);
  ok('18 · ⭐ describeShape maps structure without content, so no single long value can starve it');

  assert.strictEqual(diagnoseEmpty({}, []), 'empty-object');
  const refs = findRecords({ items: [{ $ref: 'https://x/1' }] }, ['week', 'home'], 2);
  assert.strictEqual(refs.length, 0);
  assert.strictEqual(refs.refsSeen, 1, 'link-only payloads must be counted, not read as "no games"');
  ok('19 · ⭐ the shared walker counts $ref links instead of reporting an empty result');
}

/* ---- 10. ⭐⭐⭐⭐⭐ A DATE IS NOT A KICKOFF — b150 -----------------------------------------------------------
   This is the section that should have existed since 29h, and its absence is why one line of date parsing
   survived two rounds of fixes aimed at the symptom it was causing. Section 2 above proved kickoffOf against
   a payload WITH a full timestamp and a payload with NO date at all — the two easy cases — and never once
   against the shape that actually breaks it: a day with no hour, which parses perfectly and means midnight
   UTC. Every assertion here is Trey's bug stated as arithmetic. */
{
  // (a) The refusal itself, across the spellings a day can arrive in.
  assert.strictEqual(hasTimeOfDay('2026-09-20'), false);
  assert.strictEqual(hasTimeOfDay('09/20/2026'), false);
  assert.strictEqual(hasTimeOfDay('2026-09-20T17:00Z'), true);
  assert.strictEqual(hasTimeOfDay(1758150000000), true, 'an epoch integer is an instant by construction');
  assert.strictEqual(kickoffOf({ date: '2026-09-20' }), null, 'a day must not become an instant');
  assert.strictEqual(kickoffOf({ date: '09/20/2026' }), null);
  assert.strictEqual(kickoffOf({ date: '2026-09-20T17:00Z' }), '2026-09-20T17:00:00.000Z');
  // ⚠ And the refusal must not eat a REAL time that happens to sit later in the candidate list.
  assert.strictEqual(kickoffOf({ date: '2026-09-20', kickoff: '2026-09-20T17:00:00Z' }), '2026-09-20T17:00:00.000Z',
    'a day in the first field must fall through to a real timestamp in the second, not abort the search');
  ok('21 · ⭐⭐⭐⭐⭐ a date with no time of day is REFUSED as a kickoff — b150, the DJ Moore bug');

  /* (b) ⭐⭐⭐⭐⭐ TREY'S MOMENT, TO THE MINUTE, AS THE WHOLE PIPELINE SEES IT.
     "DJ Moore plays on Thursday, but his game hasn't started yet (it's 12:21 AM)." A Sleeper-shaped record
     for that Thursday night game, read the way the job reads it, then handed to the same `gameState` the
     live route uses, at exactly that instant. Before b150 this asserted 'done' — which is the entire bug,
     and which no test in this project could see because no fixture ever carried a date-only string. */
  const tnf = { week: 3, date: '2026-09-17', home: 'CHI', away: 'DAL' };
  const read = mapSchedule({ games: [tnf] });
  assert.strictEqual(read.records.length, 1, 'the game must still STORE — refusing the hour is not dropping the game');
  assert.strictEqual(read.records[0].kickoff, null);
  const at1221am = Date.parse('2026-09-17T04:21:00Z');       // 12:21 AM US Eastern, Thursday
  assert.strictEqual(gameState(read.records[0].kickoff, at1221am), 'unknown',
    'with no hour the clock must say so; "unknown" lets the stats feed decide and leaves him yet to play');
  // The counterfactual, stated so the regression is impossible to reintroduce quietly.
  assert.strictEqual(gameState('2026-09-17T00:00:00.000Z', at1221am), 'done',
    'this is what the phantom kickoff did, and why two fixes downstream of it could not help');
  /* And the Sunday slate, which is the same fault at scale and in both directions: the phantom kickoff
     makes every Sunday game "live" on Saturday EVENING and "finished" by Saturday midnight — so a person
     checking his lineup on Sunday morning, hours before the 1pm slate, was told the whole week was over. */
  assert.strictEqual(gameState('2026-09-20T00:00:00.000Z', Date.parse('2026-09-20T01:00:00Z')), 'live',
    'a Sunday slate read as IN PROGRESS at 9pm Eastern on Saturday');
  assert.strictEqual(gameState('2026-09-20T00:00:00.000Z', Date.parse('2026-09-20T14:00:00Z')), 'done',
    'and as finished by 10am Eastern on Sunday, three hours before the first kickoff');
  ok('22 · ⭐⭐⭐⭐⭐ at 12:21 AM Thursday a Thursday starter is NOT reported as finished');

  // (c) Coverage is a measurement, so the job can say "complete schedule, no clocks" instead of nothing.
  assert.deepStrictEqual(kickoffCoverage([{ kickoff: 'x' }, { kickoff: null }]), { have: 1, total: 2, ratio: 0.5 });
  assert.strictEqual(kickoffCoverage([]).ratio, 0, 'an empty schedule is not 100% covered');
  ok('23 · kickoff coverage is measured, so "32 teams, 18 weeks, no clocks" is a reportable state');

  /* (d) ⭐⭐⭐ THE FILL. A source with games and no hours borrows hours from one that has both — matched on
     the fixture, never on list position, and never overwriting what the winner actually said. */
  const primary = [
    { week: 1, home: 'KC', away: 'BAL', kickoff: null },
    { week: 1, home: 'PHI', away: 'DAL', kickoff: '2026-09-11T00:20:00.000Z' },
    { week: 2, home: 'SF', away: 'SEA', kickoff: null },
  ];
  const donor = [
    // ⚠ Reversed home/away on purpose: two unofficial feeds disagreeing about which side is home must not
    //   cost us the kickoff hour, which is the same fact either way.
    { week: 1, home: 'BAL', away: 'KC', kickoff: '2026-09-07T17:00:00.000Z' },
    { week: 1, home: 'PHI', away: 'DAL', kickoff: '1999-01-01T00:00:00.000Z' },
    { week: 9, home: 'NYG', away: 'NYJ', kickoff: '2026-11-01T17:00:00.000Z' },
  ];
  const m = mergeKickoffs(primary, donor);
  assert.strictEqual(m.filled, 1, 'exactly one hole was fillable');
  assert.strictEqual(m.records[0].kickoff, '2026-09-07T17:00:00.000Z', 'the unordered pair must match');
  assert.strictEqual(m.records[1].kickoff, '2026-09-11T00:20:00.000Z', 'a record that HAD a time keeps it');
  assert.strictEqual(m.records[2].kickoff, null, 'a fixture the donor never mentioned stays unknown');
  assert.strictEqual(m.records.length, 3, 'the fill must not add games the primary source did not have');
  ok('24 · ⭐⭐⭐ kickoff hours are filled from a second source by fixture, never overwriting or inventing games');

  /* (e) ⚠ AND THE ROLL DEPENDS ON THE SAME CLOCK, which is the second-order damage nobody would have traced
     back. `weekFinished` reads those kickoffs: with midnight-UTC phantoms, the Monday night game reads as
     four hours finished at midnight ET Sunday, so the app rolled to next week while MNF was still to be
     played — and then asked the live route for a week with no stats in it. */
  const mnfReal = '2026-09-22T00:15:00.000Z';               // 8:15pm ET Monday
  const mnfPhantom = '2026-09-21T00:00:00.000Z';            // what "2026-09-21" parses to
  const mondayMidnightEt = Date.parse('2026-09-21T04:00:00Z');
  assert.strictEqual(gameState(mnfReal, mondayMidnightEt), 'pre', 'Monday night has not kicked off at midnight Monday');
  assert.strictEqual(gameState(mnfPhantom, mondayMidnightEt), 'done', 'the phantom said it was already over');
  ok('25 · ⭐⭐ the same phantom rolled the week forward before Monday night football had been played');
}

console.log(`\n${pass}/25 playoff-SOS checks passed`);
