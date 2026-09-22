/* FUTURE DRAFT PICK OWNERSHIP — b166. Recorded shapes of Sleeper's /league/{id}/traded_picks. */
import assert from 'assert';
import { futurePicks } from '../src/lib/futurePicks.js';

let n = 0;
const ok = (m, x) => { n++; console.log('  PASS  ' + m + (x ? `   [${x}]` : '')); };
const rosters = [1, 2, 3, 4].map((roster_id) => ({ roster_id }));

// ---- redraft with nothing traded: no picks at all ----------------------------------------------------
const r0 = futurePicks({ league: { settings: { type: 0, draft_rounds: 15 } }, rosters, traded: [], season: '2026' });
assert.equal(r0.enabled, false); assert.equal(r0.picks.length, 0);
ok('a redraft league with no traded picks offers none');

// ---- dynasty: every team owns its own, three seasons ------------------------------------------------
const d = futurePicks({ league: { settings: { type: 2, draft_rounds: 4 } }, rosters, traded: [], season: '2026' });
assert.equal(d.enabled, true);
assert.deepEqual(d.seasons, ['2027', '2028', '2029']);
assert.equal(d.picks.length, 3 * 4 * 4);
assert.ok(d.picks.every((p) => p.ownerRosterId === p.originalRosterId));
ok('dynasty: 3 seasons × 4 rounds × 4 teams, each team holding its own', `${d.picks.length} picks`);

// ---- a startup-sized draft_rounds in dynasty is capped ------------------------------------------------
const d2 = futurePicks({ league: { settings: { type: 2, draft_rounds: 25 } }, rosters, traded: [], season: '2026' });
assert.equal(d2.rounds, 5);
ok('a dynasty league reporting 25 rounds (its startup) is capped at 5 rookie rounds');

// ---- traded picks move, keyed by ORIGINAL owner -------------------------------------------------------
const traded = [
  { season: '2027', round: 1, roster_id: 4, owner_id: 1, previous_owner_id: 4 },   // I own team 4's 1st
  { season: '2028', round: 2, roster_id: 1, owner_id: 3, previous_owner_id: 1 },   // team 3 owns my 2028 2nd
];
const t = futurePicks({ league: { settings: { type: 2, draft_rounds: 3 } }, rosters, traded, season: '2026' });
const find = (yr, rd, orig) => t.picks.find((p) => p.season === yr && p.round === rd && p.originalRosterId === orig);
assert.equal(find('2027', 1, 4).ownerRosterId, 1);
assert.equal(find('2027', 1, 1).ownerRosterId, 1);
assert.equal(find('2028', 2, 1).ownerRosterId, 3);
ok('⭐⭐⭐⭐⭐ roster_id is WHOSE pick it is, owner_id who has it — team 4\'s 1st is mine, and keeps team 4\'s name');
assert.equal(t.picks.filter((p) => p.ownerRosterId === 1).length, 3 * 3 + 1 - 1);
ok('I hold 9 own picks + 1 acquired − 1 traded away = 9', String(t.picks.filter((p) => p.ownerRosterId === 1).length));

// ---- a redraft league WITH a traded pick is proof picks trade ----------------------------------------
const r1 = futurePicks({ league: { settings: { type: 0, draft_rounds: 15 } }, rosters, traded: [traded[0]], season: '2026' });
assert.equal(r1.enabled, true);
ok('a league with any traded pick has pick trading, whatever its type says');

// ---- b167: a redraft league whose only traded pick is THIS season's (already drafted) has no pick trading
const r2 = futurePicks({ league: { settings: { type: 0, draft_rounds: 15 } }, rosters, traded: [{ season: '2026', round: 3, roster_id: 2, owner_id: 4 }], season: '2026' });
assert.equal(r2.enabled, false); assert.equal(r2.picks.length, 0);
ok('⭐⭐⭐⭐⭐ a redraft league whose traded pick is from a draft already held offers no picks (Trey\'s redraft league)');

// ---- junk is ignored ------------------------------------------------------------------------------------
const j = futurePicks({ league: { settings: { type: 1, draft_rounds: 2 } }, rosters, traded: [null, { season: '2031', round: 1, roster_id: 2, owner_id: 3 }], season: '2026' });
assert.equal(j.picks.length, 3 * 2 * 4);
ok('rows outside the window and nulls are ignored rather than crashing');

console.log(`\n${n} passed`);
