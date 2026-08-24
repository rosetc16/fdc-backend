// Unit tests for the injury mappers. ESPN is unreachable from the build sandbox, so the mapping is what
// gets proved here and the network hop stays honestly unverified.
//
// The bug these exist to prevent: a CURRENT injury wearing an OLD story. That is what the hand-written
// table did to Christian McCaffrey, and a merge that prefers "richest text" over "freshest text" would
// reintroduce it from a live feed instead of a hardcoded one.
import assert from 'assert';
import { mapEspnInjuries, mergeInjury, normalizeDesignation, NOTE_MAX_AGE_DAYS, ESPN_INJURY_SOURCES, describeShape, refsIn } from '../src/lib/injuries.js';

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

  // ⭐⭐ THE SHAPE PRODUCTION ACTUALLY SENT. All 32 team calls answered HTTP 200 with a literal {} — that
  // URL has no injuries sub-resource at all. The warning printed as a bare "shape-unrecognized:" with an
  // empty key list, which reads like the diagnostic is broken rather than like the endpoint is wrong.
  {
    const e = mapEspnInjuries({}, { now: NOW });
    assert.strictEqual(e.injuries.length, 0);
    assert.deepStrictEqual(e.warnings, ['empty-object'],
      'an empty body must say so by name, not print an empty key list: ' + JSON.stringify(e.warnings));
    assert.deepStrictEqual(mapEspnInjuries([], { now: NOW }).warnings, ['empty-array']);
    ok('4d · ⭐⭐ an EMPTY response is diagnosed as empty, not as an unrecognised shape');
  }

  // The core API hands back the athlete as a $ref URL. The id is in the URL — following the link would be
  // one extra request per injured player for a number we already have.
  {
    const core = mapEspnInjuries({ items: [
      { athlete: { $ref: 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/athletes/3117251?lang=en' },
        status: 'Out', date: daysAgo(2), details: { type: 'Ankle', side: 'Right' },
        longComment: 'Did not practise all week.' },
    ] }, { now: NOW });
    assert.strictEqual(core.injuries.length, 1, 'a $ref athlete was skipped: ' + JSON.stringify(core.warnings));
    assert.strictEqual(core.injuries[0].espnId, '3117251', 'the id should come out of the ref URL');
    assert.strictEqual(core.injuries[0].part, 'Right Ankle');
    ok('4e · ⭐ an athlete given only as a $ref URL is read by parsing the id out of the link');
  }

  // The name is the fallback matching key, because espn_id is blank for a slice of players.
  {
    const named = mapEspnInjuries({ injuries: [{ injuries: [
      { athlete: { id: '5', displayName: 'Rookie Guy' }, status: 'Questionable', date: daysAgo(1),
        details: { type: 'Groin' } },
    ] }] }, { now: NOW });
    assert.strictEqual(named.injuries[0].name, 'Rookie Guy', 'the display name must survive for name matching');
    ok('4f · the athlete display name is carried through, so a player with no espn_id can still match');
  }

  for (const junk of [null, undefined, 'nonsense', 42, { items: null }]) {
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

// ---- 7. ⭐⭐ THE REAL PRODUCTION PAYLOAD -------------------------------------------------------------------
// Reconstructed from what the live endpoint actually returned, key for key: a per-team group under
// `injuries`, records carrying long prose comments, and the athlete arriving as a bare core-API $ref. The
// previous rule ("must have an athlete AND a status, in the shapes I expect") matched NONE of this and the
// job reported the payload as unreadable while it was full of injuries.
{
  const real = {
    timestamp: '2026-08-23T23:12:11Z',
    status: 'success',
    season: { year: 2026, type: 1, name: 'Preseason', displayName: '2026' },
    injuries: [
      { id: '22', displayName: 'Arizona Cardinals', injuries: [
        { id: '634572',
          longComment: "Ryland's one miss was excusable considering the distance, and the fourth-year pro was otherwise perfect on the night.",
          shortComment: 'Ryland made three of four attempts.',
          status: 'Questionable',
          date: daysAgo(1),
          athlete: { $ref: 'http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/athletes/4362081?lang=en&region=us' },
          type: { id: '3', name: 'QUESTIONABLE', description: 'Questionable', abbreviation: 'Q' },
          details: { fantasyStatus: { description: 'GTD', abbreviation: 'GTD' }, type: 'Hip', location: 'Hip', detail: 'Flexor', side: 'Left', returnDate: '2026-09-07' } },
      ] },
      { id: '33', displayName: 'Baltimore Ravens', injuries: [
        { id: '634573', longComment: 'Placed on injured reserve Tuesday.', status: 'Out', date: daysAgo(2),
          athlete: { id: '3117251', displayName: 'Christian McCaffrey' },
          details: { type: 'Achilles' } },
        // ⭐ THE CASE THAT DEFEATED 114: the person is here, but not under `athlete`. Requiring the athlete
        // to sit where I expected meant a readable record was thrown away AND reported as unreadable.
        // Detection now scores the record's own fields, and finding the player is a separate step that can
        // look around — and that says so when it fails.
        { id: '634574', shortComment: 'Left the game.', status: 'Doubtful', date: daysAgo(1),
          details: { type: 'Shoulder', side: 'Right' },
          participant: { id: '9901', displayName: 'Odd Key Guy', position: { abbreviation: 'WR' } } },
      ] },
    ],
  };
  const { injuries, warnings } = mapEspnInjuries(real, { now: NOW });
  assert.strictEqual(injuries.length, 3,
    'the real payload was read as ' + injuries.length + ' injuries; warnings: ' + JSON.stringify(warnings));
  assert.deepStrictEqual(warnings, [], 'a payload we can read should raise no warnings: ' + warnings);

  const ryland = injuries.find((i) => i.espnId === '4362081');
  assert.ok(ryland, 'the $ref athlete was not identified: ' + JSON.stringify(injuries.map((i) => i.espnId)));
  assert.strictEqual(ryland.part, 'Left Hip', 'side + type should combine');
  assert.strictEqual(ryland.designation, 'Q');
  assert.strictEqual(ryland.returnDate, '2026-09-07');
  ok('12 · ⭐⭐ THE REAL PRODUCTION PAYLOAD reads cleanly — nested team groups, prose comments, $ref athletes');

  // And the objects that must NOT be mistaken for injury records.
  assert.ok(!injuries.some((i) => i.espnId === '2026'), 'the season block was read as an injury');
  ok('13 · the season / type / details blocks are not mistaken for injury records');

  const odd = injuries.find((i) => i.espnId === '9901');
  assert.ok(odd, 'a record whose person sits under an unexpected key was dropped — the 114 failure');
  assert.strictEqual(odd.name, 'Odd Key Guy', 'the name must survive for the fallback match');
  assert.strictEqual(odd.part, 'Right Shoulder');
  ok('13b · ⭐⭐ a record whose athlete is under an UNEXPECTED key is still read and attributed');

  // ⭐ The diagnostic that failed us: 600 raw characters got eaten by one 400-character blurb. A structural
  // map is immune to that — it carries no content at all.
  const map = describeShape(real);
  assert.ok(/injuries:\[2\]\{/.test(map), 'the skeleton should show the nesting: ' + map);
  assert.ok(/athlete:\{\$ref:str\}/.test(map), 'the skeleton should reveal the $ref athlete: ' + map);
  assert.ok(!/Ryland/.test(map), 'the skeleton must carry structure, never content: ' + map);
  assert.ok(map.length < 700, 'a skeleton should stay small enough to read: ' + map.length);
  ok('14 · ⭐ describeShape maps structure without content, so no single long string can crowd it out');
}

// ---- 8. a record we find but cannot attribute is reported as exactly that ---------------------------------
{
  const orphan = mapEspnInjuries({ injuries: [{ injuries: [
    { id: '1', status: 'Out', date: daysAgo(1), longComment: 'Out for the year.', details: { type: 'Knee' } },
  ] }] }, { now: NOW });
  assert.strictEqual(orphan.injuries.length, 0);
  assert.ok(orphan.warnings.some((w) => w.startsWith('record-no-athlete:')),
    '"found it, cannot name the player" must be its own diagnosis: ' + JSON.stringify(orphan.warnings));
  assert.ok(orphan.warnings[0].includes('longComment'), 'the warning should list the record keys it saw');
  ok('15 · ⭐ "found a record but could not name the player" is reported separately from "found nothing"');
}

// ---- 9. the source chain is ordered cheapest-first and the old broken URL is kept LAST ------------------
{
  const names = ESPN_INJURY_SOURCES.map((s) => s.name);
  assert.ok(names.length >= 2, 'a single source is a guess with no fallback — that is what failed');
  assert.strictEqual(ESPN_INJURY_SOURCES[0].urls.length, 1,
    'the first source should be the one-call league-wide endpoint, so the 32-call ones never run when it works');
  // The URL that answered {} 32 times is kept but DEMOTED — it costs nothing once the others have failed,
  // and if ESPN ever fills it in we pick it up for free.
  assert.ok(names.indexOf('site-team') > 0, 'the endpoint that returned {} must not be tried first');
  // ⭐ The expensive ref-following source must be dead LAST: it makes a request per injured player, and it
  // exists only so one path's success does not depend on my guessing an envelope correctly.
  const last = ESPN_INJURY_SOURCES[ESPN_INJURY_SOURCES.length - 1];
  assert.ok(last.expandRefs && last.expandRefs.max > 0 && last.expandRefs.concurrency > 0,
    'the ref-expanding source should be last and bounded');
  assert.ok(!ESPN_INJURY_SOURCES.slice(0, -1).some((s) => s.expandRefs),
    'only the last source may follow refs — the rest must stay cheap');
  for (const s of ESPN_INJURY_SOURCES) {
    assert.ok(s.urls.length && s.urls.every((u) => /^https:\/\//.test(u)), 'bad url in source ' + s.name);
  }
  ok('16 · ⭐ ESPN is a chain: cheapest first, the empty URL demoted, the expensive one last');

  // The ref collector reads a core-API listing without following anything itself.
  assert.deepStrictEqual(refsIn({ count: 2, items: [{ $ref: 'https://x/1' }, { $ref: 'https://x/2' }, { nope: 1 }] }),
    ['https://x/1', 'https://x/2']);
  assert.deepStrictEqual(refsIn({ items: [{ $ref: 'a' }, { $ref: 'b' }] }, 1), ['a'], 'the cap must be honoured');
  assert.deepStrictEqual(refsIn(null), [], 'junk in, empty list out');
  ok('17 · the $ref collector reads a core listing and honours its cap');
}

console.log(`\n${pass}/23 injury checks passed`);
