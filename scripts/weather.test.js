/* WHAT GETS FLAGGED, AND — MORE IMPORTANTLY — WHAT DOES NOT.
 *
 * Trey drew this line himself and it is the whole specification: "Flag players that could be a concern (i.e.
 * big snow storm... or lots of rain. If it's sunny, then you wouldn't list them. If they are in a dome, don't
 * list them. If it's light rain, don't list them)."
 *
 * ⚠ THE NEGATIVE CASES ARE THE POINT OF THIS FILE. A weather panel that flags everything is not a cautious
 *   weather panel, it is a broken one: the second time it lists a dome game or a drizzle, it stops being
 *   read, and then it does not matter how right it is about the snow. So the sunny / light-rain / indoor
 *   cases below carry the same weight as the blizzard, and there are more of them.
 *
 * Run: node scripts/weather.test.js
 */
import { VENUES, isIndoors, weatherConcern } from '../src/lib/venues.js';
import { reportableGames } from '../src/routes/weather.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { console.log('  PASS  ' + n + (x ? `   [${x}]` : '')); pass++; } else { console.log('  FAIL  ' + n + (x ? `   [${x}]` : '')); fail++; } };

console.log('\n== the venue table ==');
{
  const teams = Object.keys(VENUES);
  ok('all 32 teams have a venue', teams.length === 32, `${teams.length} teams`);
  ok('every venue has coordinates and a roof',
    teams.every((t) => Number.isFinite(VENUES[t].lat) && Number.isFinite(VENUES[t].lon) && ['dome', 'retractable', 'open'].includes(VENUES[t].roof)));
  /* ⚠ A COORDINATE IN THE WRONG HEMISPHERE IS THE FAILURE THIS CATCHES — a transposed sign puts Buffalo in
     the Indian Ocean and the forecast comes back cheerful and completely wrong, with nothing on screen to
     say so. Every NFL stadium is in North America. */
  ok('every venue is plausibly in North America',
    teams.every((t) => VENUES[t].lat > 24 && VENUES[t].lat < 49 && VENUES[t].lon < -70 && VENUES[t].lon > -126),
    teams.filter((t) => !(VENUES[t].lat > 24 && VENUES[t].lat < 49 && VENUES[t].lon < -70 && VENUES[t].lon > -126)).join(',') || 'all in range');
  // The two shared stadiums must actually be the same place, or one of the pair gets a different forecast.
  ok('the Rams and Chargers share one set of coordinates', VENUES.LAR.lat === VENUES.LAC.lat && VENUES.LAR.lon === VENUES.LAC.lon);
  ok('the Giants and Jets share one set of coordinates', VENUES.NYG.lat === VENUES.NYJ.lat && VENUES.NYG.lon === VENUES.NYJ.lon);
  ok('the known indoor teams read as indoors',
    ['DET', 'MIN', 'NO', 'LV', 'LAR', 'LAC'].every(isIndoors), 'DET MIN NO LV LAR LAC');
  /* ⚠⚠ THIS ASSERTION IS REVERSED — 29x, on Trey's instruction, and the reasoning is worth keeping.
     It used to read "retractable roofs are NOT treated as domes": we cannot know whether they closed the
     roof, and a missed snow game costs more than a flag you dismiss in a second. That is an argument about
     the cost of being WRONG. His is about whether the row is ACTIONABLE — "it might rain, unless they shut
     the roof, which they probably will, and we cannot find out" changes no lineup decision, and rows like
     that are what teach people to skip the ones that matter. The venue DATA still records the difference
     (a retractable roof is not a dome, and the table says so); what changed is that the weather report
     excludes both. */
  ok('retractable venues are recorded as retractable, not as domes',
    ['DAL', 'ATL', 'HOU', 'IND', 'ARI'].every((t) => VENUES[t].roof === 'retractable'),
    'the DATA keeps the distinction; the REPORT is what stopped caring — asserted below, on the filter');
  ok('the cold-weather outdoor stadiums are outdoors',
    ['GB', 'BUF', 'CHI', 'NE', 'PIT', 'CLE', 'DEN', 'KC'].every((t) => !isIndoors(t)));
}

console.log('\n== nothing to say ==');
{
  /* ⭐⭐⭐⭐ "If it's sunny, then you wouldn't list them." A null here is what keeps the panel short enough
     to be worth opening — every one of these is a game that must not appear at all. */
  ok('⭐⭐⭐⭐ a clear autumn afternoon is not flagged', weatherConcern({ tempF: 62, wind: 6, windGust: 9, rain: 0, snow: 0 }) === null);
  ok('⭐⭐⭐⭐ light rain is not flagged', weatherConcern({ tempF: 55, wind: 7, windGust: 10, rain: 2.5, snow: 0 }) === null, '2.5mm — a drizzle');
  ok('⭐⭐⭐ an ordinary breeze is not flagged', weatherConcern({ tempF: 50, wind: 11, windGust: 14, rain: 0, snow: 0 }) === null, 'gusting 14mph');
  ok('⭐⭐ a cold but calm day is not flagged on temperature alone', weatherConcern({ tempF: 22, wind: 5, windGust: 8, rain: 0, snow: 0 }) === null, '22°F, no wind');
  ok('⭐⭐ a missing forecast says nothing rather than guessing', weatherConcern(null) === null);
  ok('an empty forecast object says nothing', weatherConcern({}) === null);
}

console.log('\n== worth a manager\'s attention ==');
{
  const snow = weatherConcern({ tempF: 24, wind: 14, windGust: 20, rain: 0, snow: 8 });
  ok('⭐⭐⭐⭐ a snow game is flagged, and severely', snow && snow.severity === 3, snow ? `${snow.label}: ${snow.text}` : 'MISSED');
  ok('⭐⭐ …and the reading names the snow', snow && /snow/i.test(snow.text), snow ? snow.text : '');

  const downpour = weatherConcern({ tempF: 48, wind: 12, windGust: 16, rain: 18, snow: 0 });
  ok('⭐⭐⭐ heavy rain is flagged', downpour && downpour.severity === 3, downpour ? downpour.text : 'MISSED');

  /* ⭐⭐⭐⭐ WIND IS THE ONE THAT MOVES FANTASY SCORING MOST and the easiest to under-weight, because it
     looks like nothing in a forecast summary. A 28mph day is a different sport for a kicker. */
  const gale = weatherConcern({ tempF: 44, wind: 22, windGust: 30, rain: 0, snow: 0 });
  ok('⭐⭐⭐⭐ high wind alone is flagged', gale && gale.severity === 3, gale ? gale.text : 'MISSED');
  const breezy = weatherConcern({ tempF: 44, wind: 12, windGust: 16, rain: 0, snow: 0 });
  ok('⭐⭐ a borderline wind is a watch, not a red flag', breezy && breezy.severity === 1, breezy ? `${breezy.label}: ${breezy.text}` : 'not flagged');

  const bitter = weatherConcern({ tempF: 4, wind: 8, windGust: 11, rain: 0, snow: 0 });
  ok('⭐⭐ genuinely bitter cold is flagged on its own', bitter && bitter.severity >= 2, bitter ? bitter.text : 'MISSED');

  const both = weatherConcern({ tempF: 15, wind: 20, windGust: 27, rain: 0, snow: 3 });
  ok('⭐⭐⭐ a game with several problems reports all of them', both && /snow/i.test(both.text) && /wind/i.test(both.text), both ? both.text : 'MISSED');
  ok('⭐⭐ …and the temperature rides along once something else has flagged it', both && /°F/.test(both.text), both ? both.text : '');

  /* ⭐⭐⭐ SEVERITY HAS TO BE ORDERED, because the page sorts on it and the whole promise is "show me where
     to spend my time". If a drizzle outranks a blizzard the list is worse than unsorted. */
  const a = weatherConcern({ tempF: 30, wind: 16, windGust: 16, rain: 0, snow: 0 });     // watch
  const b = weatherConcern({ tempF: 30, wind: 19, windGust: 19, rain: 6, snow: 0 });     // concern
  const c = weatherConcern({ tempF: 30, wind: 26, windGust: 32, rain: 0, snow: 9 });     // severe
  ok('⭐⭐⭐ severity is ordered watch < concern < severe',
    a && b && c && a.severity < b.severity && b.severity < c.severity, `${a && a.severity}/${b && b.severity}/${c && c.severity}`);
  ok('⭐⭐ …and each carries a label a person can read', a.label === 'Watch' && b.label === 'Concern' && c.label === 'Severe',
    `${a.label} · ${b.label} · ${c.label}`);
}

/* ⚠⚠⚠ THE SECTION THAT ACTUALLY EXERCISES THE ROOF RULE — 29x.
 *
 *   Before this existed the rule had TWO tests and neither could fail. One read the venue table ("HOU is
 *   recorded as retractable"), which stays true whatever the route does with it. The other was a browser
 *   assertion over a stub whose weather response is HAND-WRITTEN and contains only open-air games, so it
 *   was checking that a fixture I wrote says what I wrote in it. Delete the filter from the route and both
 *   go green.
 *
 *   These call the filter, hand it a Houston game, and require it back out. That is the difference between
 *   a test and a description of a test.
 */
console.log('\n== which games are even worth a forecast ==');
{
  const soon = new Date(Date.now() + 2 * 86400000).toISOString();
  const rows = [
    { team: 'HOU', opponent: 'TEN', kickoff: soon },   // retractable — Trey's actual example
    { team: 'DAL', opponent: 'PHI', kickoff: soon },   // retractable
    { team: 'DET', opponent: 'CHI', kickoff: soon },   // fixed dome
    { team: 'GB',  opponent: 'MIN', kickoff: soon },   // open air — the only one that should survive
    { team: 'BUF', opponent: 'NYJ', kickoff: null },   // open air but no kickoff time
    { team: 'PIT', opponent: 'CLE', kickoff: new Date(Date.now() + 30 * 86400000).toISOString() },
    { team: 'ZZZ', opponent: 'GB',  kickoff: soon },   // not a team we have a venue for
  ];
  const { candidates, counts } = reportableGames(rows);
  const homes = candidates.map((c) => c.home);
  ok('⭐⭐⭐⭐⭐ a retractable-roof game never reaches the forecast — Trey\'s Houston case',
    !homes.includes('HOU'), homes.join(',') || 'nothing survived');
  ok('⭐⭐⭐⭐ …nor any other roof, fixed or not',
    !homes.some((h) => ['DAL', 'DET', 'ATL', 'IND', 'ARI'].includes(h)), `survivors: ${homes.join(',')}`);
  ok('⭐⭐⭐⭐⭐ …while an open-air game in the window still does',
    homes.includes('GB'), `survivors: ${homes.join(',')}`);
  ok('⭐⭐⭐⭐ …and the roofed games are COUNTED, so "14 games, 4 indoors" still adds up',
    counts.indoors === 3, `indoors=${counts.indoors} (HOU, DAL, DET)`);
  ok('⭐⭐⭐ a game with no kickoff hour is skipped and counted separately',
    !homes.includes('BUF') && counts.noTime === 1, `noTime=${counts.noTime}`);
  ok('⭐⭐⭐ a game past the forecast horizon is skipped and counted separately',
    !homes.includes('PIT') && counts.tooFar === 1, `tooFar=${counts.tooFar}`);
  ok('⭐⭐ an unknown team is dropped without throwing',
    counts.unknownVenue === 1 && candidates.length === 1, `${candidates.length} candidate(s)`);
}

console.log(`\n${pass}/${pass + fail} weather checks passed`);
process.exit(fail ? 1 : 0);
