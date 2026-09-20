/* READING A YAHOO LEAGUE, AND JOINING IT TO OUR OWN PLAYERS — b161.
 *
 * Trey: "I want to build Yahoo so that you can also get live roster recommendations, free agents, league
 * trends, etc. like we have for the in-season view for Sleeper."
 *
 * ⚠⚠⚠⚠⚠ THIS FILE EXISTS BECAUSE THE APP CANNOT REACH YAHOO FROM ANYWHERE IT IS TESTED. The sandbox has
 *   no route to Yahoo's API and the developer application is not provisioned yet, so there is no
 *   end-to-end path that would catch a parser reading the wrong node. Every shape below is a RECORDED
 *   Yahoo payload: the fixtures are the only instrument this feature has, and a fixture that is shaped
 *   the way I *assume* Yahoo replies would prove nothing at all.
 *
 * ⭐⭐⭐⭐⭐ AND THE FAILURE MODE IS SILENCE, TWICE OVER.
 *   · A PARSER THAT MISSES A NODE returns an empty list, and an empty list renders as a league where
 *     nobody has a roster — which looks like a league that has not drafted, not like a bug.
 *   · AN IDENTITY MISS IS WORSE. Every in-season screen is keyed by Sleeper player id. A Yahoo roster
 *     that arrives with real names and no ids joins to nothing: the hub renders, the rosters look
 *     populated, and every projection, lineup solve, trade value and free-agent comparison quietly reads
 *     zero. "It looks connected right up until you notice" — lib/playerIds.js's own warning, about the
 *     one platform it did not cover.
 *
 * ⚠ §1 IS A REAL SHIPPED BUG, NOT A NEW FEATURE'S TEST. `yahooLeague` set `name: null` on every draft
 *   pick and nothing filled it in, so a completed Yahoo league imported as 180 unresolvable picks.
 */
import assert from 'assert';
import { parsePlayerBag, parseRosters, parseScoreboard, parseStandings } from '../src/lib/yahoo.js';
import { buildYahooIndex, toSleeperId, resolveRoster } from '../src/lib/yahooIds.js';

let n = 0;
const ok = (m, x) => { n++; console.log('  PASS  ' + m + (x ? `   [${x}]` : '')); };

/* ── RECORDED SHAPES ─────────────────────────────────────────────────────────────────────────────
   ⚠ YAHOO'S JSON IS AN ARRAY PRETENDING TO BE AN OBJECT: a resource is a numerically-keyed bag whose
   entries are sometimes objects and sometimes arrays of single-key objects, and the useful fields are
   scattered across both. These fixtures keep that ugliness exactly as Yahoo sends it — flattening them
   for readability would test a parser against a payload it will never receive. */
const PLAYERS_JSON = {
  fantasy_content: {
    league: [
      { league_key: 'nfl.l.1' },
      { players: {
        0: { player: [[
          { player_key: 'nfl.p.30977' }, { player_id: '30977' },
          { name: { full: 'Patrick Mahomes', first: 'Patrick', last: 'Mahomes' } },
          { editorial_team_abbr: 'kc' }, { display_position: 'QB' },
        ]] },
        1: { player: [[
          { player_key: 'nfl.p.100014' }, { player_id: '100014' },
          { name: { full: 'Pittsburgh', first: 'Pittsburgh', last: '' } },
          { editorial_team_abbr: 'pit' }, { display_position: 'DEF' },
        ]] },
        count: 2,
      } },
    ],
  },
};

const ROSTERS_JSON = {
  fantasy_content: {
    league: [
      { league_key: 'nfl.l.1' },
      { teams: {
        0: { team: [
          [{ team_key: 'nfl.l.1.t.3' }, { name: 'Allegheny Anchors' }, { is_owned_by_current_login: 1 }],
          { roster: { 0: { players: {
            0: { player: [
              [{ player_key: 'nfl.p.30977' }, { name: { full: 'Patrick Mahomes' } }, { display_position: 'QB' }, { editorial_team_abbr: 'kc' }],
              { selected_position: [{ coverage_type: 'week' }, { position: 'QB' }] },
            ] },
            1: { player: [
              [{ player_key: 'nfl.p.32671' }, { name: { full: 'Jahmyr Gibbs' } }, { display_position: 'RB' }, { editorial_team_abbr: 'det' }, { status: 'Q' }],
              { selected_position: [{ coverage_type: 'week' }, { position: 'BN' }] },
            ] },
            2: { player: [
              [{ player_key: 'nfl.p.99999' }, { name: { full: 'Nobody Weknow' } }, { display_position: 'WR' }, { editorial_team_abbr: 'fa' }],
              { selected_position: [{ coverage_type: 'week' }, { position: 'IR' }] },
            ] },
            count: 3,
          } } } },
        ] },
        1: { team: [
          [{ team_key: 'nfl.l.1.t.7' }, { name: 'Steel City' }],
          { roster: { 0: { players: {
            0: { player: [
              [{ player_key: 'nfl.p.100014' }, { name: { full: 'Pittsburgh' } }, { display_position: 'DEF' }, { editorial_team_abbr: 'pit' }],
              { selected_position: [{ coverage_type: 'week' }, { position: 'DEF' }] },
            ] },
            count: 1,
          } } } },
        ] },
        count: 2,
      } },
    ],
  },
};

const SCOREBOARD_JSON = {
  fantasy_content: {
    league: [
      { league_key: 'nfl.l.1' },
      { scoreboard: { 0: { matchups: {
        0: { matchup: [
          { week: '9' },
          { teams: {
            0: { team: [
              [{ team_key: 'nfl.l.1.t.3' }, { name: 'Allegheny Anchors' }],
              { team_points: { coverage_type: 'week', week: '9', total: '118.44' } },
              { team_projected_points: { coverage_type: 'week', week: '9', total: '112.10' } },
            ] },
            1: { team: [
              [{ team_key: 'nfl.l.1.t.7' }, { name: 'Steel City' }],
              { team_points: { coverage_type: 'week', week: '9', total: '101.02' } },
              { team_projected_points: { coverage_type: 'week', week: '9', total: '108.77' } },
            ] },
            count: 2,
          } },
        ] },
        count: 1,
      } } } },
    ],
  },
};

const STANDINGS_JSON = {
  fantasy_content: {
    league: [
      { league_key: 'nfl.l.1' },
      { standings: { 0: { teams: {
        0: { team: [
          [{ team_key: 'nfl.l.1.t.3' }, { name: 'Allegheny Anchors' }],
          { team_standings: { rank: 1, outcome_totals: { wins: '7', losses: '2', ties: '0' }, points_for: '982.3', points_against: '940.0' } },
        ] },
        1: { team: [
          [{ team_key: 'nfl.l.1.t.7' }, { name: 'Steel City' }],
          { team_standings: { rank: 4, outcome_totals: { wins: '5', losses: '4', ties: '0' }, points_for: '901.1', points_against: '918.4' } },
        ] },
        count: 2,
      } } } },
    ],
  },
};

/* Sleeper's player map, in its real shape — the document the identity bridge is built from. */
const SLEEPER = {
  4046: { full_name: 'Patrick Mahomes', position: 'QB', team: 'KC', yahoo_id: 30977 },
  8146: { full_name: 'Jahmyr Gibbs', position: 'RB', team: 'DET', yahoo_id: null },
  PIT: { full_name: 'Pittsburgh Steelers', position: 'DEF', team: 'PIT', yahoo_id: null },
  1111: { first_name: 'Michael', last_name: 'Thomas', position: 'WR', team: 'NO', yahoo_id: null },
  2222: { first_name: 'Michael', last_name: 'Thomas', position: 'WR', team: 'HOU', yahoo_id: null },
  3333: { full_name: 'Amon-Ra St. Brown', position: 'WR', team: 'DET', yahoo_id: null },
};

/* ── 1 ── THE DRAFT PICKS HAVE NAMES NOW ─────────────────────────────────────────────────────── */
{
  const m = parsePlayerBag(PLAYERS_JSON);
  assert.ok(m.get('nfl.p.30977'), 'keyed by the full player_key, which is what draftresults hands back');
  assert.ok(m.get('30977'), 'and by the bare id, which is what a roster entry is read for');
  assert.strictEqual(m.get('30977').name, 'Patrick Mahomes');
  assert.strictEqual(m.get('30977').pos, 'QB');
  assert.strictEqual(m.get('30977').team, 'KC', 'the team is upper-cased — Yahoo sends "kc"');
  /* ⚠ DEF BECOMES DST, because that is what this app calls it everywhere else. A defence arriving as
     "DEF" would fail every position filter on every screen. */
  assert.strictEqual(m.get('100014').pos, 'DST');
  ok('1 · ⭐⭐⭐⭐⭐ a Yahoo player bag resolves to name, position and team, keyed both ways',
    `${m.get('30977').name} / ${m.get('100014').pos}`);
}

/* ── 2 ── THE ROSTERS ───────────────────────────────────────────────────────────────────────── */
{
  const t = parseRosters(ROSTERS_JSON);
  assert.strictEqual(t.length, 2, `expected two teams, got ${t.length}`);
  const mine = t.find((x) => x.isMine);
  assert.ok(mine, 'the signed-in user\'s team is marked — without this every personalised screen is dark');
  assert.strictEqual(mine.teamKey, 'nfl.l.1.t.3');
  assert.strictEqual(mine.players.length, 3);
  /* ⭐⭐⭐⭐⭐ A STARTER IS A SLOT, NOT A POSITION. Yahoo puts every player in a `selected_position`, and
     BN and IR are slots like any other — reading the position he PLAYS would start the whole roster. */
  const starting = mine.players.filter((p) => p.starting).map((p) => p.name);
  assert.deepStrictEqual(starting, ['Patrick Mahomes'], `only the QB is starting, got ${starting.join(',')}`);
  assert.strictEqual(mine.players.find((p) => p.name === 'Jahmyr Gibbs').slot, 'BN');
  assert.strictEqual(mine.players.find((p) => p.name === 'Nobody Weknow').slot, 'IR');
  ok('2 · ⭐⭐⭐⭐⭐ rosters parse with the right team marked as mine, and BN/IR are not starters',
    `${mine.teamName}: ${starting.join(', ')} starting of ${mine.players.length}`);

  /* Yahoo's own designation survives — it is what the manager sees in his own app. */
  assert.strictEqual(mine.players.find((p) => p.name === 'Jahmyr Gibbs').status, 'Q');
  ok('2b · ⭐⭐⭐⭐ …and Yahoo\'s own injury designation rides along');
}

/* ── 3 ── THE SCOREBOARD, AND THE TWO NODES THAT LOOK IDENTICAL ─────────────────────────────── */
{
  const m = parseScoreboard(SCOREBOARD_JSON);
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].week, 9);
  const me = m[0].teams.find((x) => x.teamKey === 'nfl.l.1.t.3');
  /* ⭐⭐⭐⭐⭐ `team_points` AND `team_projected_points` HAVE THE SAME INNER SHAPE — both are
     `{coverage_type, week, total}` — so a flattener that walks the whole team node puts one on top of
     the other and the screen prints the projection as the live score, or the other way round. Every
     number on Game Day would be plausible and wrong. They are read off their own nodes for that reason
     and this check is the only thing that would notice. */
  assert.strictEqual(me.points, 118.44, `points read ${me.points}`);
  assert.strictEqual(me.projected, 112.10, `projected read ${me.projected}`);
  assert.notStrictEqual(me.points, me.projected, 'the two must not collapse into one another');
  ok('3 · ⭐⭐⭐⭐⭐ live points and projected points stay apart, though their nodes are identical in shape',
    `${me.points} scored · ${me.projected} projected`);
}

/* ── 4 ── THE STANDINGS ─────────────────────────────────────────────────────────────────────── */
{
  const s = parseStandings(STANDINGS_JSON);
  assert.strictEqual(s.length, 2);
  const top = s.find((x) => x.rank === 1);
  assert.strictEqual(top.wins, 7);
  assert.strictEqual(top.losses, 2);
  assert.strictEqual(top.pointsFor, 982.3);
  ok('4 · ⭐⭐⭐⭐ records and season points come through, from a nested outcome_totals',
    `${top.teamName} ${top.wins}-${top.losses}, ${top.pointsFor} PF`);
}

/* ── 5 ── THE IDENTITY BRIDGE, WHICH IS WHERE THIS FEATURE LIVES OR DIES ────────────────────── */
{
  const idx = buildYahooIndex(SLEEPER);
  /* ⭐⭐⭐⭐⭐ THE EXACT ROUTE: Sleeper publishes `yahoo_id` on its own players, so no name matching is
     needed for anyone it covers. This is the whole reason the feature needs no third-party crosswalk. */
  assert.strictEqual(toSleeperId(idx, { yahooId: '30977', name: 'Patrick Mahomes', pos: 'QB' }), '4046');
  ok('5 · ⭐⭐⭐⭐⭐ a player with a yahoo_id maps exactly, with no name matching at all', 'Mahomes → 4046');

  /* The fallback, for the players Sleeper has no yahoo_id on — rookies, practice-squad bodies. */
  assert.strictEqual(toSleeperId(idx, { yahooId: '32671', name: 'Jahmyr Gibbs', pos: 'RB' }), '8146');
  /* ⚠ AND IT FOLDS THE THINGS THAT DIFFER BETWEEN PLATFORMS — accents, punctuation, suffixes. */
  assert.strictEqual(toSleeperId(idx, { name: 'Amon-Ra St Brown', pos: 'WR' }), '3333', 'punctuation must fold');
  ok('5b · ⭐⭐⭐⭐ …and one without falls back to name + position, folding punctuation and accents');

  /* ⭐⭐⭐⭐⭐ AND AN AMBIGUOUS NAME RESOLVES TO NOBODY, WHICH IS THE RIGHT ANSWER. There have been two
     Michael Thomases, two Josh Allens and two Steve Smiths at once. Picking one is a silent wrong
     answer: the reader sees somebody else's projection under a name he recognises, and nothing on the
     screen suggests anything happened. An unresolved player is visibly missing, which is recoverable. */
  assert.strictEqual(toSleeperId(idx, { name: 'Michael Thomas', pos: 'WR' }), null,
    'two active players share this name and position — guessing is worse than missing');
  ok('5c · ⭐⭐⭐⭐⭐ …and a name shared by two active players maps to NOBODY rather than to a guess');

  /* ⚠ A DEFENCE IS ITS TEAM, NEVER ITS NAME. Sleeper keys it "PIT"; Yahoo calls it "Pittsburgh". */
  assert.strictEqual(toSleeperId(idx, { name: 'Pittsburgh', pos: 'DST', team: 'PIT' }), 'PIT');
  assert.strictEqual(toSleeperId(idx, { name: 'Pittsburgh Steelers', pos: 'DST', team: 'PIT' }), 'PIT',
    'the name must not matter for a defence');
  ok('5d · ⭐⭐⭐⭐ a defence maps on its NFL team, which is exact, not on a name that never matches');
}

/* ── 6 ── AND WHAT DID NOT MAP IS COUNTED ───────────────────────────────────────────────────── */
{
  /* ⚠⚠ THE CENSUS IS NOT DECORATION. A bridge that drops a quarter of a league does not look broken on
     screen — the rosters just look short — so the only way anybody finds out is if the numbers are on
     the payload. Same reasoning as `trendAudit` on the Sleeper hub. */
  const idx = buildYahooIndex(SLEEPER);
  const t = parseRosters(ROSTERS_JSON).find((x) => x.isMine);
  const { players, unresolved } = resolveRoster(idx, t.players);
  assert.strictEqual(players.length, 2, `two of three should resolve, got ${players.length}`);
  assert.strictEqual(unresolved.length, 1);
  assert.strictEqual(unresolved[0].name, 'Nobody Weknow', 'the one we cannot place is NAMED, not just counted');
  assert.ok(players.every((p) => p.sid), 'every resolved player carries the id the screens are keyed by');
  ok('6 · ⭐⭐⭐⭐⭐ the ones that do not map are counted AND named, so a thin hub is diagnosable',
    `${players.length} resolved, unresolved: ${unresolved.map((u) => u.name).join(', ')}`);

  /* And the index reports its own coverage, which is the first number to look at when a league is thin. */
  assert.ok(idx.stats.total >= 6 && idx.stats.withYahooId >= 1);
  ok('6b · ⭐⭐⭐ …and the index states how much of the pool carries a yahoo_id at all',
    `${idx.stats.withYahooId} of ${idx.stats.total}`);
}

/* ── 7 ── THE SHAPES WE DO NOT UNDERSTAND ───────────────────────────────────────────────────── */
{
  /* ⚠ A PARSER THAT THROWS TAKES THE WHOLE HUB WITH IT. Yahoo's shapes are undocumented and vary by
     resource; every one of these returns empty rather than raising. */
  [parseRosters, parseScoreboard, parseStandings, parsePlayerBag].forEach((f) => {
    assert.doesNotThrow(() => f(null));
    assert.doesNotThrow(() => f({}));
    assert.doesNotThrow(() => f({ fantasy_content: { league: {} } }));
  });
  assert.deepStrictEqual(parseRosters(null), []);
  assert.deepStrictEqual(parseScoreboard({}), []);
  ok('7 · ⭐⭐⭐⭐ an unexpected payload returns nothing rather than taking the hub down with it');
}

console.log(`\n${n} passed`);
