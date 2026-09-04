/* PLATFORM PLAYER-ID → NAME.
 *
 * The live MFL and Fantrax draft feeds answer with platform player IDs and nothing else. The draft room
 * places every incoming pick by looking its NAME up in the pool, so without this translation a live poll
 * returns a well-formed list of picks that the board silently cannot place — a sync that reports healthy
 * while the board fills with holes, which is worse than having no sync at all.
 *
 * Everything below is a shape the two feeds actually produce. No network: the parse and apply steps are
 * separated from the fetch precisely so these can run.
 */
import assert from 'assert';
import { parseMflDirectory, parseFantraxDirectory, applyDirectory, _internals } from '../src/lib/playerIds.js';

let n = 0;
const ok = (m) => { n++; console.log('  PASS  ' + m); };

// 1 ── MFL writes every name back to front
{
  assert.strictEqual(_internals.flipName('Gibbs, Jahmyr'), 'Jahmyr Gibbs');
  assert.strictEqual(_internals.flipName('Bears, Chicago'), 'Chicago Bears');
  assert.strictEqual(_internals.flipName('St. Brown, Amon-Ra'), 'Amon-Ra St. Brown');
  // Not every record has a comma, and one that doesn't must pass through rather than come back blank.
  assert.strictEqual(_internals.flipName('Justin Jefferson'), 'Justin Jefferson');
  assert.strictEqual(_internals.flipName(''), '');
  ok('1 · ⭐⭐⭐ "Last, First" becomes "First Last" — every MFL name is stored this way');
}

// 2 ── the MFL directory, in the shape MFL sends it
{
  const dir = parseMflDirectory({ players: { player: [
    { id: '13593', name: 'Gibbs, Jahmyr', position: 'RB', team: 'DET' },
    { id: '9999', name: 'Kicker, Some', position: 'PK', team: 'KC' },
    { id: '0001', name: '', position: 'WR', team: 'BUF' },        // nameless: unusable, must be skipped
  ] } });
  assert.strictEqual(dir.get('13593').name, 'Jahmyr Gibbs');
  assert.strictEqual(dir.get('13593').pos, 'RB');
  assert.strictEqual(dir.get('9999').pos, 'K', 'MFL calls kickers PK');
  assert.ok(!dir.has('0001'), 'a record with no name cannot resolve anything');
  ok('2 · ⭐⭐ the MFL directory parses, and PK maps to K');
}

// 3 ── MFL wraps a one-element list as a bare object, everywhere, silently
{
  const dir = parseMflDirectory({ players: { player: { id: '7', name: 'Hall, Breece', position: 'RB', team: 'NYJ' } } });
  assert.strictEqual(dir.get('7').name, 'Breece Hall');
  ok('3 · ⭐⭐ a single-player payload is not mistaken for an empty one');
}

// 4 ── Fantrax answers in two different shapes and neither is documented
{
  const asMap = parseFantraxDirectory({ '04xk9': { name: 'Puka Nacua', position: 'WR', team: 'LAR' } });
  const asList = parseFantraxDirectory([{ fantraxId: '04xk9', name: 'Puka Nacua', position: 'WR', team: 'LAR' }]);
  assert.strictEqual(asMap.get('04xk9').name, 'Puka Nacua');
  assert.deepStrictEqual(asList.get('04xk9'), asMap.get('04xk9'), 'both shapes must yield the same directory');
  ok('4 · ⭐⭐ both Fantrax payload shapes parse identically');
}

// 5 ── ⭐⭐⭐ the thing the whole file exists for
{
  const dir = parseMflDirectory({ players: { player: [{ id: '13593', name: 'Gibbs, Jahmyr', position: 'RB', team: 'DET' }] } });
  const [pick] = applyDirectory([{ overall: 3, player_id: '13593', name: null }], dir);
  assert.strictEqual(pick.name, 'Jahmyr Gibbs', 'a live pick must arrive with a name the board can place');
  ok('5 · ⭐⭐⭐ a live pick carrying only an id comes back with a name');
}

// 6 ── ⭐⭐⭐ a Fantrax pick's `team` is a FANTRAX TEAM, not an NFL club
{
  // Getting this wrong misattributes the pick to another roster — much worse than a blank field, and
  // invisible, because the pick still lands on the board.
  const dir = parseFantraxDirectory({ p1: { name: 'Puka Nacua', position: 'WR', team: 'LAR' } });
  const [pick] = applyDirectory([{ overall: 5, player_id: 'p1', name: null, team: 'fxTeam7' }], dir);
  assert.strictEqual(pick.name, 'Puka Nacua');
  assert.strictEqual(pick.team, 'fxTeam7', 'the drafting team must survive the lookup untouched');
  const [empty] = applyDirectory([{ overall: 6, player_id: 'p1', name: null, team: '' }], dir);
  assert.strictEqual(empty.team, '', 'even an empty team field belongs to the feed, not the directory');
  ok('6 · ⭐⭐⭐ the drafting team is never overwritten with the player\'s NFL club');
}

// 7 ── what the feed says about its own draft beats the directory
{
  const dir = parseFantraxDirectory({ p1: { name: 'Wrong Person', position: 'WR', team: 'LAR' } });
  const [pick] = applyDirectory([{ overall: 5, player_id: 'p1', name: 'Puka Nacua' }], dir);
  assert.strictEqual(pick.name, 'Puka Nacua');
  ok('7 · ⭐⭐ a name the feed already supplied is not overwritten');
}

// 8 ── ⭐⭐ a directory outage degrades, it does not break
{
  const rows = [{ overall: 1, player_id: '13593', name: null }];
  const out = applyDirectory(rows, new Map());
  assert.deepStrictEqual(out, rows, 'no directory means name-less picks, not a failed poll');
  assert.deepStrictEqual(applyDirectory([], new Map()), []);
  ok('8 · ⭐⭐ an unavailable directory leaves the picks alone rather than failing the request');
}

// 9 ── an id with no match is left alone, not blanked or invented
{
  const dir = parseMflDirectory({ players: { player: [{ id: '1', name: 'Gibbs, Jahmyr', position: 'RB' }] } });
  const [pick] = applyDirectory([{ overall: 1, player_id: '404', name: null }], dir);
  assert.strictEqual(pick.name, null);
  ok('9 · an unknown id stays unknown');
}

console.log(`\n${n}/${n} player-id checks passed`);
