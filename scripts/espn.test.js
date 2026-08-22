// ESPN import tests. ESPN is not reachable from CI/sandboxes, so fetchEspnLeague's network hop is NOT
// covered here — the mapping is, and the mapping is where the risk lives. Fixtures are built to the
// shapes ESPN's v3 mSettings/mTeam views actually return.
// Run: node scripts/espn.test.js
import assert from 'node:assert';
import { mapEspnLeague, startFromLineupSlots, scoringFromItems } from '../src/lib/espn.js';

let pass = 0;
const ok = (n) => { console.log('  PASS  ' + n); pass++; };

// A standard 10-team ESPN roster: 1QB 2RB 2WR 1TE 1FLEX 1DST 1K + 7 bench.
const STD_SLOTS = { 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 16: 1, 17: 1, 20: 7, 21: 1 };
const item = (statId, points, pointsOverrides) => (pointsOverrides ? { statId, points, pointsOverrides } : { statId, points });
const PPR_ITEMS = [
  item(3, 0.04), item(4, 4), item(20, -2),
  item(24, 0.1), item(25, 6),
  item(53, 1), item(42, 0.1), item(43, 6),
  item(72, -2),
];
const league = (over = {}) => ({
  seasonId: 2026,
  settings: {
    name: 'Test League', size: 10,
    rosterSettings: { lineupSlotCounts: STD_SLOTS },
    scoringSettings: { scoringItems: PPR_ITEMS },
    draftSettings: { type: 'SNAKE', pickOrder: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    scheduleSettings: { playoffTeamCount: 4, matchupPeriodCount: 14 },
    ...over.settings,
  },
  teams: over.teams !== undefined ? over.teams
    : Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `Team ${i + 1}`, abbrev: `T${i + 1}` })),
  ...over.root,
});

// ---- 1 · the everyday case -----------------------------------------------------------------------
{
  const r = mapEspnLeague(league(), { season: 2026 });
  assert.strictEqual(r.cfg.teams, 10);
  assert.deepStrictEqual(r.cfg.start, { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER: 0, K: 1, DST: 1, DL: 0, LB: 0, DB: 0, IDPFLEX: 0 });
  // 9 starters + 7 bench = 16 rounds. IR is NOT drafted and must not add a round.
  assert.strictEqual(r.cfg.rounds, 16, 'rounds should be starters+bench, excluding IR');
  assert.strictEqual(r.cfg.scoringType, 'ppr');
  assert.strictEqual(r.cfg.order, 'snake');
  assert.strictEqual(r.cfg.type, 'redraft');
  assert.strictEqual(r.cfg.sf, false);
  assert.strictEqual(r.canSyncPicks, false, 'the response must never imply ESPN picks can sync');
  assert.deepStrictEqual(r.warnings, [], 'a clean league should produce no warnings: ' + JSON.stringify(r.warnings));
  ok('1 · a standard 10-team PPR ESPN league maps cleanly, and IR does not become a draft round');
}

// ---- 2 · scoring translation ---------------------------------------------------------------------
{
  const r = mapEspnLeague(league(), {});
  assert.strictEqual(r.cfg.scoring.rec, 1);
  assert.strictEqual(r.cfg.scoring.passTD, 4);
  assert.strictEqual(r.cfg.scoring.INT, -2);
  assert.strictEqual(r.cfg.scoring.rushYd, 0.1);
  assert.strictEqual(r.cfg.scoring.recTD, 6);
  assert.strictEqual(r.cfg.scoring.fum, -2);

  // 6-point passing TDs are the single most common non-default, and missing it understates every QB.
  const six = mapEspnLeague(league({ settings: { name: 'x', size: 10, rosterSettings: { lineupSlotCounts: STD_SLOTS }, scoringSettings: { scoringItems: [...PPR_ITEMS.filter((i) => i.statId !== 4), item(4, 6)] }, draftSettings: { type: 'SNAKE', pickOrder: [] } } }), {});
  assert.strictEqual(six.cfg.scoring.passTD, 6, '6pt passing TDs must be imported');

  // Half PPR and standard.
  const half = mapEspnLeague(league({ settings: { size: 10, rosterSettings: { lineupSlotCounts: STD_SLOTS }, scoringSettings: { scoringItems: [...PPR_ITEMS.filter((i) => i.statId !== 53), item(53, 0.5)] }, draftSettings: {} } }), {});
  assert.strictEqual(half.cfg.scoringType, 'half');
  const std = mapEspnLeague(league({ settings: { size: 10, rosterSettings: { lineupSlotCounts: STD_SLOTS }, scoringSettings: { scoringItems: PPR_ITEMS.filter((i) => i.statId !== 53) }, draftSettings: {} } }), {});
  assert.strictEqual(std.cfg.scoringType, 'std', 'no reception item at all means standard scoring');
  assert.strictEqual(std.cfg.scoring.rec, 0);
  ok('2 · scoring translates, including 6pt pass TDs, half-PPR, and standard (no reception item)');
}

// ---- 3 · the duplicate reception stat ids --------------------------------------------------------
// ESPN's stat table decodes 41, 47 and 53 all to "receptions". Whichever one a league happens to use
// must produce the same result — betting on a single id is how PPR silently becomes standard.
{
  [41, 47, 53].forEach((id) => {
    const items = [...PPR_ITEMS.filter((i) => ![41, 47, 53].includes(i.statId)), item(id, 1)];
    const { scoring } = scoringFromItems(items);
    assert.strictEqual(scoring.rec, 1, `statId ${id} must be read as receptions`);
  });
  // Receiving yards and TDs have the same problem (42/48 and 43/49).
  assert.strictEqual(scoringFromItems([item(48, 0.1)]).scoring.recYd, 0.1);
  assert.strictEqual(scoringFromItems([item(49, 6)]).scoring.recTD, 6);
  ok('3 · every alias of the receptions/rec-yards/rec-TD stat ids is read, not just one');
}

// ---- 4 · superflex, 2QB, multi-flex, IDP ---------------------------------------------------------
{
  const sf = mapEspnLeague(league({ settings: { size: 12, rosterSettings: { lineupSlotCounts: { ...STD_SLOTS, 7: 1 } }, scoringSettings: { scoringItems: PPR_ITEMS }, draftSettings: {} } }), {});
  assert.strictEqual(sf.cfg.start.SUPER, 1, 'slot 7 (OP) is ESPN superflex');
  assert.strictEqual(sf.cfg.sf, true);
  assert.strictEqual(sf.cfg.qbType, 'SF');

  const twoQb = mapEspnLeague(league({ settings: { size: 12, rosterSettings: { lineupSlotCounts: { ...STD_SLOTS, 0: 2 } }, scoringSettings: { scoringItems: PPR_ITEMS }, draftSettings: {} } }), {});
  assert.strictEqual(twoQb.cfg.qbType, '2QB');
  assert.strictEqual(twoQb.cfg.sf, false, 'two real QB slots is 2QB, not superflex');

  // RB/WR (3), WR/TE (5) and RB/WR/TE (23) all behave as flex slots.
  const flexy = mapEspnLeague(league({ settings: { size: 12, rosterSettings: { lineupSlotCounts: { 0: 1, 2: 2, 4: 2, 6: 1, 3: 1, 5: 1, 23: 1, 20: 6 } }, scoringSettings: { scoringItems: PPR_ITEMS }, draftSettings: {} } }), {});
  assert.strictEqual(flexy.cfg.start.FLEX, 3, 'slots 3, 5 and 23 all count as flex');

  const idp = mapEspnLeague(league({ settings: { size: 12, rosterSettings: { lineupSlotCounts: { ...STD_SLOTS, 9: 1, 11: 1, 10: 2, 13: 1, 14: 1, 15: 1 } }, scoringSettings: { scoringItems: PPR_ITEMS }, draftSettings: {} } }), {});
  assert.strictEqual(idp.cfg.start.DL, 2, 'DE(9) and DL(11) both roll up to DL');
  assert.strictEqual(idp.cfg.start.LB, 2);
  assert.strictEqual(idp.cfg.start.DB, 2, 'S(13) and DB(14) both roll up to DB');
  assert.strictEqual(idp.cfg.start.IDPFLEX, 1);
  ok('4 · superflex (slot 7), true 2QB, stacked flex slots and IDP slots all map correctly');
}

// ---- 5 · TE premium via pointsOverrides ----------------------------------------------------------
// ESPN has no TE-premium setting. Leagues do it by overriding the reception value for position id 4.
{
  const items = [...PPR_ITEMS.filter((i) => i.statId !== 53), item(53, 1, { 4: 1.5 })];
  const r = mapEspnLeague(league({ settings: { size: 12, rosterSettings: { lineupSlotCounts: STD_SLOTS }, scoringSettings: { scoringItems: items }, draftSettings: {} } }), {});
  assert.strictEqual(r.cfg.tePrem, true);
  assert.strictEqual(r.cfg.tePremMult, 0.5, 'the premium is the EXTRA over base, not the total');
  assert.strictEqual(r.cfg.scoring.recTE, 1.5, 'recTE is the TOTAL per reception for TEs');

  // An override that is not actually a premium must not flip the flag on.
  const same = scoringFromItems([...PPR_ITEMS.filter((i) => i.statId !== 53), item(53, 1, { 4: 1 })]);
  assert.strictEqual(same.tePremMult, 0);

  // A per-position value we don't model must WARN rather than import silently.
  const rbOverride = scoringFromItems([...PPR_ITEMS.filter((i) => i.statId !== 53), item(53, 1, { 2: 0.5 })]);
  assert.ok(rbOverride.warnings.some((w) => /per-reception values by position/i.test(w)), 'unmodeled positional scoring must warn');
  ok('5 · TE premium is read from pointsOverrides as the extra over base; other positional overrides warn');
}

// ---- 6 · team names, draft order and slots -------------------------------------------------------
{
  const r = mapEspnLeague(league({ settings: { size: 4, rosterSettings: { lineupSlotCounts: STD_SLOTS }, scoringSettings: { scoringItems: PPR_ITEMS }, draftSettings: { type: 'SNAKE', pickOrder: [7, 3, 9, 1] } }, teams: [{ id: 1, name: 'Alpha' }, { id: 3, location: 'Beta', nickname: 'Squad' }, { id: 7, abbrev: 'GMA' }, { id: 9, name: '  ' }] }), {});
  const bySlot = Object.fromEntries(r.teams.map((t) => [t.slot, t.name]));
  assert.strictEqual(bySlot[1], 'GMA', 'team 7 drafts first; falls back to abbrev when unnamed');
  assert.strictEqual(bySlot[2], 'Beta Squad', 'location + nickname is the older ESPN shape');
  assert.strictEqual(bySlot[4], 'Alpha');
  assert.strictEqual(r.cfg.teamNames.length, 4);
  assert.strictEqual(r.cfg.teamNames[1], 'Beta Squad', 'teamNames is indexed by draft slot');
  assert.strictEqual(r.cfg.slot, null, 'a public read cannot know which team is YOURS');
  ok('6 · pickOrder becomes draft slots, team names survive both ESPN shapes, and slot stays unknown');
}

// ---- 7 · no draft order yet ----------------------------------------------------------------------
// Very common: the league exists but ESPN has not randomized the order. Must not fabricate slots.
{
  const r = mapEspnLeague(league({ settings: { size: 10, rosterSettings: { lineupSlotCounts: STD_SLOTS }, scoringSettings: { scoringItems: PPR_ITEMS }, draftSettings: { type: 'SNAKE' } } }), {});
  assert.ok(r.teams.every((t) => t.slot === null), 'no pickOrder means no slots, not slot=index');
  assert.strictEqual(r.cfg.teamNames, null, 'team names must not be written to arbitrary slots');
  assert.ok(r.warnings.some((w) => /draft order/i.test(w)));
  ok('7 · a league with no draft order set yet warns instead of inventing slot assignments');
}

// ---- 8 · keeper and auction leagues --------------------------------------------------------------
{
  const k = mapEspnLeague(league({ settings: { size: 10, rosterSettings: { lineupSlotCounts: STD_SLOTS }, scoringSettings: { scoringItems: PPR_ITEMS }, draftSettings: { type: 'SNAKE', keeperCount: 2 } } }), {});
  assert.strictEqual(k.cfg.type, 'keeper');
  assert.strictEqual(k.cfg.keeper, true);
  assert.deepStrictEqual(k.cfg.keepers, [], 'a public read gives the keeper COUNT, never the players');

  const a = mapEspnLeague(league({ settings: { size: 10, rosterSettings: { lineupSlotCounts: STD_SLOTS }, scoringSettings: { scoringItems: PPR_ITEMS }, draftSettings: { type: 'AUCTION' } } }), {});
  assert.strictEqual(a.cfg.order, 'snake', 'we have no auction board; fall back rather than fail');
  assert.ok(a.warnings.some((w) => /auction/i.test(w)), 'the auction fallback must be stated, not silent');

  const lin = mapEspnLeague(league({ settings: { size: 10, rosterSettings: { lineupSlotCounts: STD_SLOTS }, scoringSettings: { scoringItems: PPR_ITEMS }, draftSettings: { type: 'LINEAR' } } }), {});
  assert.strictEqual(lin.cfg.order, 'linear');
  ok('8 · keeper count sets keeper mode without inventing keepers; auction degrades loudly; linear maps');
}

// ---- 9 · garbage in -----------------------------------------------------------------------------
// The whole point of the fail-soft design: never throw, always warn, always land on usable defaults.
{
  const empty = mapEspnLeague({}, {});
  assert.ok(empty.cfg.teams > 0 && empty.cfg.rounds > 0);
  assert.deepStrictEqual(empty.cfg.start.QB, 1, 'falls back to a sane default lineup');
  assert.ok(empty.warnings.length >= 2, 'an empty response must warn loudly: ' + JSON.stringify(empty.warnings));

  assert.doesNotThrow(() => mapEspnLeague(null, {}));
  assert.doesNotThrow(() => mapEspnLeague({ settings: { rosterSettings: { lineupSlotCounts: null } } }, {}));
  assert.doesNotThrow(() => mapEspnLeague({ teams: 'nope', settings: { scoringSettings: { scoringItems: 'nope' } } }, {}));

  // An unrecognized slot id is skipped and reported, not silently folded into something else.
  const weird = startFromLineupSlots({ 0: 1, 99: 2, 20: 5 });
  assert.deepStrictEqual(weird.unknown, [99]);
  assert.strictEqual(weird.bench, 5);
  ok('9 · malformed or empty ESPN responses never throw — they fall back to defaults and warn');
}

// ---- 10 · team count disagreement ----------------------------------------------------------------
{
  const r = mapEspnLeague(league({ settings: { size: 12, rosterSettings: { lineupSlotCounts: STD_SLOTS }, scoringSettings: { scoringItems: PPR_ITEMS }, draftSettings: {} } }), {});
  assert.strictEqual(r.cfg.teams, 12, 'settings.size is authoritative');
  assert.ok(r.warnings.some((w) => /12 teams but returned 10/.test(w)), 'the mismatch must be surfaced');
  ok('10 · a size/teams mismatch is surfaced rather than quietly picking one');
}

console.log(`\n${pass}/10 ESPN import checks passed`);
