// Unit tests for the injury mappers. ESPN is unreachable from the build sandbox, so the mapping is what
// gets proved here and the network hop stays honestly unverified.
//
// The bug these exist to prevent: a CURRENT injury wearing an OLD story. That is what the hand-written
// table did to Christian McCaffrey, and a merge that prefers "richest text" over "freshest text" would
// reintroduce it from a live feed instead of a hardcoded one.
import assert from 'assert';
import { mapEspnInjuries, mergeInjury, normalizeDesignation, NOTE_MAX_AGE_DAYS } from '../src/lib/injuries.js';

let pass = 0;
const ok = (n) => { console.log('  PASS  ' + n); pass++; };
const NOW = Date.parse('2026-08-24T12:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();

// ---- 1. designations ------------------------------------------------------------------------------------
{
  assert.strictEqual(normalizeDesignation('Questionable'), 'Q');
  assert.strictEqual(normalizeDesignation('Injury-Reserve'), 'IR');
  assert.strictEqual(normalizeDesignation('physically-unable-to-perform'), 'PUP');
  assert.strictEqual(normalizeDesignation('Suspension'), 'SUSP');
  assert.strictEqual(normalizeDesignation(null), null);
  // Anything we don't recognise passes through rather than being mapped to a plausible guess.
  assert.strictEqual(normalizeDesignation('Wobbly'), 'WOBBLY');
  ok('1 · designations normalise, and an unknown one is passed through rather than guessed');
}

// ---- 2. reading ESPN's shape ------------------------------------------------------------------------------
{
  const payload = { items: [
    { athlete: { id: '3117251' }, status: 'Questionable', date: daysAgo(1),
      details: { type: 'Hamstring', side: 'Right', returnDate: '2026-09-07' },
      shortComment: 'Limited in practice Wednesday.',
      longComment: 'Was limited Wednesday and is considered day to day; the team expects him to play Sunday.' },
    { athlete: { id: '4241457' }, status: 'Out', date: daysAgo(3),
      details: { type: 'Achilles', side: 'N/A' }, shortComment: 'Will not play.' },
  ] };
  const { injuries, warnings } = mapEspnInjuries(payload, { now: NOW });
  assert.strictEqual(injuries.length, 2);
  assert.strictEqual(warnings.length, 0);

  const a = injuries[0];
  assert.strictEqual(a.designation, 'Q');
  assert.strictEqual(a.part, 'Right Hamstring', 'side should be folded into the body part');
  assert.ok(/day to day/.test(a.note), 'the longer comment should win over the short one');
  assert.strictEqual(a.returnDate, '2026-09-07');
  assert.strictEqual(a.stale, false);
  ok('2 · an ESPN injury maps to designation + body part + side + the fuller comment');

  // "N/A" is ESPN's way of saying it has no side. It must not become "N/A Achilles".
  assert.strictEqual(injuries[1].part, 'Achilles');
  ok('3 · a missing side is dropped rather than printed as "N/A"');
}

// ---- 3. it must not invent, and must say when it cannot read --------------------------------------------
{
  const { injuries, warnings } = mapEspnInjuries({ items: [
    { $ref: 'https://sports.core.api.espn.com/v2/…/injuries/1' },      // never expanded
  ] }, { now: NOW });
  assert.strictEqual(injuries.length, 0);
  assert.ok(warnings.includes('unexpanded-ref'), 'links-instead-of-data should be diagnosed: ' + warnings);
  ok('4 · ⭐ being handed $ref links instead of data is diagnosed, not read as "nobody is hurt"');

  // ⭐ THE FAILURE THAT SHIPPED: an envelope we do not recognise returned zero injuries and zero warnings,
  // so the job logged 32 teams read, 0 problems — and nobody could tell it had understood nothing.
  const un = mapEspnInjuries({ timestamp: 'x', status: 'success', season: {}, somethingNew: [] }, { now: NOW });
  assert.strictEqual(un.injuries.length, 0);
  assert.ok(un.warnings.some((w) => w.startsWith('shape-unrecognized')),
    'an unrecognised shape must warn: ' + JSON.stringify(un.warnings));
  assert.ok(un.warnings[0].includes('somethingNew'), 'the warning should name the keys it actually saw');
  ok('4b · ⭐⭐ an unrecognised envelope WARNS and names the keys it saw, instead of reporting success');

  // And the shape that actually broke: records nested inside a per-team group.
  const nested = mapEspnInjuries({ injuries: [
    { id: '25', displayName: 'San Francisco 49ers', injuries: [
      { athlete: { id: '111' }, status: 'Questionable', date: daysAgo(1), details: { type: 'Calf' }, shortComment: 'Limited.' },
    ] },
  ] }, { now: NOW });
  assert.strictEqual(nested.injuries.length, 1, 'nested team groups must be found: ' + JSON.stringify(nested.warnings));
  assert.strictEqual(nested.injuries[0].part, 'Calf');
  ok('4c · ⭐ injury records nested inside a per-team group are found — the shape that returned nothing');

  for (const junk of [null, undefined, {}, [], 'nonsense', 42, { items: null }]) {
    assert.doesNotThrow(() => mapEspnInjuries(junk, { now: NOW }), `threw on ${JSON.stringify(junk)}`);
    assert.deepStrictEqual(mapEspnInjuries(junk, { now: NOW }).injuries, []);
  }
  ok('5 · a malformed or empty payload yields nothing rather than throwing');

  // No returnDate in the payload means no returnDate out. We never estimate one.
  const { injuries: noRet } = mapEspnInjuries({ items: [
    { athlete: { id: '1' }, status: 'Out', date: daysAgo(2), details: { type: 'Knee' } },
  ] }, { now: NOW });
  assert.strictEqual(noRet[0].returnDate, null);
  ok('6 · ⭐ a return date is only ever reported when the source supplies one');
}

// ---- 4. ⭐ THE McCAFFREY CASE: a current injury must not wear an old story ------------------------------
{
  const sleeper = { injury_status: 'Questionable', injury_body_part: 'Calf', injury_notes: null,
    news_updated: NOW - 2 * 86400000 };
  const staleEspn = mapEspnInjuries({ items: [
    { athlete: { id: '9' }, status: 'Out', date: daysAgo(NOTE_MAX_AGE_DAYS + 30),
      details: { type: 'Achilles' }, longComment: 'Season-ending Achilles tear suffered last year.' },
  ] }, { now: NOW }).injuries[0];
  assert.strictEqual(staleEspn.stale, true, 'a note that old must be marked stale');

  const merged = mergeInjury(sleeper, staleEspn, { now: NOW });
  assert.strictEqual(merged.status, 'Q', "the platform's current designation wins");
  assert.strictEqual(merged.part, 'Calf', 'the CURRENT body part, not the old one');
  assert.ok(!/Achilles|last year/i.test(merged.note || ''), 'the stale story leaked through: ' + merged.note);
  ok('7 · ⭐⭐ a stale note is DROPPED rather than shown beside a current designation — the exact bug reported');
}

// ---- 5. the merge, when both sources are healthy ---------------------------------------------------------
{
  const sleeper = { injury_status: 'Questionable', injury_body_part: 'Hamstring', injury_notes: 'Limited.',
    news_updated: Math.floor((NOW - 86400000) / 1000) };     // Sleeper sometimes sends SECONDS
  const espn = mapEspnInjuries({ items: [
    { athlete: { id: '1' }, status: 'Questionable', date: daysAgo(1),
      details: { type: 'Hamstring', side: 'Left' },
      longComment: 'Limited Wednesday and Thursday; the staff is optimistic for Sunday.' },
  ] }, { now: NOW }).injuries[0];

  const m = mergeInjury(sleeper, espn, { now: NOW });
  assert.strictEqual(m.status, 'Q');
  assert.strictEqual(m.part, 'Left Hamstring', 'ESPN supplies the richer body part');
  assert.ok(/optimistic for Sunday/.test(m.note), 'ESPN supplies the fuller note');
  assert.deepStrictEqual(m.sources, ['sleeper', 'espn']);
  assert.ok(m.ageDays != null && m.ageDays <= 1.1, 'freshness should come from the dated source: ' + m.ageDays);
  assert.strictEqual(m.sourced, true);
  ok('8 · Sleeper owns the designation, ESPN owns the detail, and freshness comes from whoever dated it');

  // Seconds-vs-milliseconds is a real trap in Sleeper's feed: read wrong, every note looks 55 years old.
  const solo = mergeInjury(sleeper, null, { now: NOW });
  assert.ok(solo.ageDays >= 0 && solo.ageDays <= 2, 'seconds timestamp misread: ' + solo.ageDays);
  ok('9 · Sleeper timestamps are handled in both seconds and milliseconds');
}

// ---- 6. saying "I don't know" out loud --------------------------------------------------------------------
{
  const bare = mergeInjury({ injury_status: 'Questionable' }, null, { now: NOW });
  assert.strictEqual(bare.status, 'Q');
  assert.strictEqual(bare.note, null);
  assert.strictEqual(bare.part, null);
  assert.strictEqual(bare.sourced, false, 'a designation with no detail must NOT claim to be sourced');
  ok('10 · ⭐ a designation with no detail reports sourced:false, so the UI can admit it has nothing');

  assert.strictEqual(mergeInjury({}, null, { now: NOW }), null);
  assert.strictEqual(mergeInjury({ injury_status: null }, null, { now: NOW }), null);
  ok('11 · a healthy player produces no injury record at all');
}

console.log(`\n${pass}/13 injury checks passed`);
