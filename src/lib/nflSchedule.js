// THE NFL SCHEDULE — who each team plays, in which week.
//
// WHY WE NEED IT: playoff-weighted strength of schedule. Fantasy leagues are decided in weeks 15-17, but
// almost every ranking in the industry averages difficulty across all 18 weeks, which buries the only three
// that decide a title. A running back facing three of the softest run defences in the league in the fantasy
// playoffs is worth more than his season-long schedule suggests, and nothing on the market prices that
// properly. That is the whole feature — and it cannot exist without a real schedule.
//
// ⚠ THE SCHEDULE MUST BE SOURCED. It would be very easy to type a 32x18 table into this file and be done.
// That is precisely what the deleted injury-notes table did: written once by a person, asserted forever, and
// wrong in a way nobody notices until it has already misled somebody. A wrong opponent in week 16 would
// silently corrupt every playoff SOS number we print. So: fetched, cached in the database, and absent rather
// than guessed.
import { findRecords, diagnoseEmpty, trySources } from './shapes.js';

// The 32 team abbreviations we normalise to — Sleeper's spelling, because Sleeper is our player source and
// `players.team` is what any join will use.
const TEAM_ALIASES = {
  JAC: 'JAX', JAG: 'JAX', WSH: 'WAS', WFT: 'WAS', LA: 'LAR', STL: 'LAR', SD: 'LAC',
  OAK: 'LV', LVR: 'LV', ARZ: 'ARI', BLT: 'BAL', CLV: 'CLE', HST: 'HOU', SL: 'LAR',
  TAM: 'TB', NOR: 'NO', GNB: 'GB', KAN: 'KC', SFO: 'SF', NWE: 'NE',
};
export const TEAMS = ['ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB',
  'HOU', 'IND', 'JAX', 'KC', 'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG', 'NYJ', 'PHI', 'PIT',
  'SEA', 'SF', 'TB', 'TEN', 'WAS'];
const TEAMSET = new Set(TEAMS);

export function normTeam(t) {
  if (t == null) return null;
  const s = String(t).trim().toUpperCase();
  if (!s) return null;
  const a = TEAM_ALIASES[s] || s;
  return TEAMSET.has(a) ? a : null;
}

/* ⭐⭐⭐ WHEN THE GAME STARTS, which nothing needed until now and weather needs completely.
   A forecast is only a forecast OF something: without a kickoff time you cannot ask what the conditions will
   be at the moment the game is played, and "the weather in Buffalo this week" is not a fantasy question.
   The payloads have carried the timestamp all along — `date` is already in GAME_FIELDS below, used to
   RECOGNISE a game record — it was simply never read off one. Every shape the parser accepts spells it
   differently, so this reads them all and returns an ISO string or null; a game with no readable time still
   stores fine and is simply skipped by anything that needs the hour. */
/* ⭐⭐⭐⭐⭐ A DATE IS NOT A KICKOFF — b150, and this one line is the whole DJ Moore bug.
   ==================================================================================================
   Trey, three times now, and the third time after two fixes that both missed: "DJ Moore plays on Thursday,
   but his game hasn't started yet (it's 12:21 AM). Because of that, he is showing up with a 0 projection
   AND he isn't listed as left to play." Then: "players that are still scheduled to play today (but haven't
   started) show that they are not on the 'left' column." Then: "the left to play is still not accurate and
   games haven't started."

   ⚠⚠ `new Date('2026-09-20')` IS MIDNIGHT UTC — 8pm Eastern the evening BEFORE. A payload that gives the
     day of a game without its hour is not telling us when the game starts, and reading it as an instant
     invents a kickoff that is thirteen to twenty hours early for every game on the slate. `gameState` then
     does exactly what it is supposed to do with the time it was handed: 3.5 hours after that phantom
     kickoff it says the game is OVER. Which means every player on Sunday's slate reads `done` from about
     8:30pm Eastern on SATURDAY, and a Thursday-night starter reads `done` at 12:21 on Thursday morning —
     which is the minute, to the minute, that Trey first reported.

   ⭐⭐⭐ AND IT IS WHY b148 AND b149 BOTH FAILED. Both narrowed the rule that arbitrates between the stats
     feed and the clock — and neither could help, because the clock itself was lying and it was lying in
     the `done` direction, which is the branch where the feed never gets a say. Two correct fixes, applied
     one layer downstream of the fault, is a pattern worth naming: when a fix does not move the symptom,
     the next question is not "what else decides this" but "is the INPUT to the thing I fixed true".

   ⚠ SO A VALUE WITHOUT A TIME OF DAY IS REFUSED, and a game with no readable hour stores with a NULL
     kickoff — which every consumer already handles, says out loud (`scheduleMissing`), and degrades from
     honestly. Refusing is not a loss of data: a kickoff that is seventeen hours wrong is worse than no
     kickoff, because nothing downstream can tell that it is wrong. `fillKickoffs` below then goes and gets
     the real hours from a source that publishes them. */
const TIME_OF_DAY = /\d{1,2}:\d{2}/;
export function hasTimeOfDay(v) {
  if (v == null || v === '') return false;
  // An epoch number is an instant by construction — there is no such thing as a date-only integer.
  if (typeof v === 'number') return true;
  return TIME_OF_DAY.test(String(v));
}

export function kickoffOf(node) {
  if (!node) return null;
  const cand = [node.date, node.kickoff, node.start_time, node.startTime, node.gameTime,
    node.competitions && node.competitions[0] && node.competitions[0].date];
  for (const c of cand) {
    if (c == null || c === '') continue;
    // ⚠ b150 — "2026-09-20" parses perfectly and means midnight UTC. See the note above.
    if (!hasTimeOfDay(c)) continue;
    // Sleeper gives epoch milliseconds; ESPN gives an ISO string.
    const d = typeof c === 'number' ? new Date(c) : new Date(String(c));
    if (!Number.isNaN(d.getTime()) && d.getUTCFullYear() > 2000) return d.toISOString();
  }
  return null;
}

/* ⭐⭐⭐⭐ HOW MUCH OF THE SCHEDULE WE CAN ACTUALLY PUT A CLOCK ON — b150.
   With the refusal above, a source that publishes days rather than instants now yields a complete and
   correct schedule with no kickoff times at all — which is the honest answer to "when does this start"
   and the useless one for a page built around it. So coverage becomes a number the job reports and the
   fill step below acts on, rather than a property nobody was measuring. */
export function kickoffCoverage(records) {
  const total = (records || []).length;
  const have = (records || []).filter((r) => r && r.kickoff).length;
  return { have, total, ratio: total ? have / total : 0 };
}

/* ⭐⭐⭐⭐⭐ FILL THE HOURS FROM WHOEVER PUBLISHES THEM — b150.
   `trySources` stops at the first source that yields games, which is right for the schedule itself (two
   sources disagreeing about an opponent is a corruption, not a merge) and wrong for the kickoff hour: the
   hour is the same fact from whoever states it, and a source that has games but no times should be allowed
   to borrow them from one that has both.

   ⚠ MATCHED ON THE GAME, NOT ON POSITION IN THE LIST. The donor's ordering, count and week coverage are all
     its own business; the only safe join key is the fixture itself. Home/away is not trusted to agree
     between two unofficial feeds, so the pair is keyed unordered — a week plus two teams identifies an NFL
     game uniquely, and if two feeds disagree about which side is home that is a separate (and much less
     damaging) question than the kickoff hour.
   ⚠ AND IT ONLY EVER FILLS A HOLE. A record that already carries a kickoff keeps it; the primary source
     stays authoritative about everything it actually said. */
export function mergeKickoffs(records, donors) {
  const key = (r) => `${r.week}:${[r.home, r.away].sort().join('|')}`;
  const times = new Map();
  for (const d of donors || []) {
    if (d && d.kickoff && d.week != null && d.home && d.away && !times.has(key(d))) times.set(key(d), d.kickoff);
  }
  let filled = 0;
  const out = (records || []).map((r) => {
    if (!r || r.kickoff) return r;
    const t = times.get(key(r));
    if (!t) return r;
    filled++;
    return { ...r, kickoff: t };
  });
  return { records: out, filled, donors: times.size };
}

// A game record carries these; metadata blocks in the same payloads carry at most one of them.
const GAME_FIELDS = ['week', 'home', 'away', 'home_team', 'away_team', 'competitions', 'competitors', 'date'];

// Pull the two teams out of whatever a game record looks like.
//
// ⭐ SEPARATE FROM DETECTION, deliberately. The injury mapper's last bug was requiring the participant to sit
// where it was expected in order to recognise the record at all — so one unforeseen key made a readable
// record vanish AND get reported as unreadable. Here, finding the game and naming its teams are two
// questions, and failing the second is its own diagnosis rather than silence.
export function teamsOf(node) {
  // (a) flat: { home: 'KC', away: 'BUF' } or { home_team, away_team }
  for (const [h, aw] of [['home', 'away'], ['home_team', 'away_team'], ['homeTeam', 'awayTeam']]) {
    const H = normTeam(typeof node[h] === 'string' ? node[h] : (node[h] && (node[h].abbreviation || node[h].abbr || node[h].team)));
    const A = normTeam(typeof node[aw] === 'string' ? node[aw] : (node[aw] && (node[aw].abbreviation || node[aw].abbr || node[aw].team)));
    if (H && A) return { home: H, away: A };
  }
  // (b) ESPN: competitions[0].competitors[] with homeAway + team.abbreviation
  const comps = Array.isArray(node.competitions) ? node.competitions
    : (Array.isArray(node.competitors) ? [{ competitors: node.competitors }] : []);
  for (const c of comps) {
    const list = Array.isArray(c && c.competitors) ? c.competitors : [];
    let H = null, A = null;
    for (const x of list) {
      const ab = normTeam(x && ((x.team && (x.team.abbreviation || x.team.abbrev)) || x.abbreviation));
      if (!ab) continue;
      if (String(x.homeAway || x.homeaway || '').toLowerCase() === 'home') H = ab;
      else if (String(x.homeAway || x.homeaway || '').toLowerCase() === 'away') A = ab;
      else if (!H) H = ab; else if (!A) A = ab;      // no homeAway flag: order is the only signal
    }
    if (H && A) return { home: H, away: A };
  }
  return null;
}

// The week number, from whichever field carries it.
export function weekOf(node, fallback) {
  const cands = [node.week, node.week_num, node.weekNumber,
    node.week && typeof node.week === 'object' ? node.week.number : null];
  for (const c of cands) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 1 && n <= 18) return n;
  }
  // ⚠ `Number(null)` is 0 and `Number.isFinite(0)` is true, so a naive coercion turned "no week anywhere"
  // into WEEK 0 — every game silently filed under a week that does not exist, and the source would have
  // reported a full, confident, useless schedule. Range-check the hint like any other value.
  const f = Number(fallback);
  return fallback != null && Number.isFinite(f) && f >= 1 && f <= 18 ? f : null;
}

// PURE: payload -> { records: [{week, home, away}], warnings }
// `weekHint` is used when the endpoint is already week-scoped (ESPN's scoreboard is) and the records
// themselves don't repeat the number.
export function mapSchedule(payload, { weekHint = null } = {}) {
  const warnings = [];
  const nodes = findRecords(payload, GAME_FIELDS, 2);
  if (!nodes.length) { warnings.push(diagnoseEmpty(payload, nodes)); return { records: [], warnings }; }

  const out = [];
  const seen = new Set();
  let noTeams = 0, noWeek = 0;
  for (const n of nodes) {
    const t = teamsOf(n);
    if (!t) { noTeams++; continue; }
    const wk = weekOf(n, weekHint);
    if (wk == null) { noWeek++; continue; }
    if (t.home === t.away) continue;                        // a team cannot play itself
    const key = `${wk}:${t.home}:${t.away}`;
    if (seen.has(key)) continue;                            // the walker can reach one game by two paths
    seen.add(key);
    out.push({ week: wk, home: t.home, away: t.away, kickoff: kickoffOf(n) });
  }
  // Name the partial failures. "Found games but couldn't read the teams" is a different problem from
  // "found no games", and conflating them is what cost three deploys on the injury feed.
  if (noTeams) warnings.push(`game-no-teams:${noTeams}`);
  if (noWeek) warnings.push(`game-no-week:${noWeek}`);
  if (!out.length && !warnings.length) warnings.push(diagnoseEmpty(payload, nodes));
  return { records: out, warnings };
}

// ---- THE SOURCE CHAIN ------------------------------------------------------------------------------------
// Cheapest first. Never one URL — see shapes.js for why that rule exists.
export function scheduleSources(season) {
  return [
    {
      // Sleeper, one call for the whole season. Sleeper is already our player source, so its team spellings
      // match `players.team` with no translation.
      name: 'sleeper-season',
      urls: [`https://api.sleeper.app/schedule/nfl/regular/${season}`],
      map: (j) => mapSchedule(j),
    },
    {
      // ESPN's scoreboard, one call per week. seasontype=2 is the regular season.
      name: 'espn-scoreboard',
      urls: Array.from({ length: 18 }, (_, i) =>
        `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=2&week=${i + 1}`),
      // ⚠ The scoreboard is week-scoped and its events do NOT all repeat the week number, so the week comes
      // from the URL. Without this hint every game is dropped as "no week" — and the endpoint would look
      // broken when it was answering perfectly.
      map: (j, i) => mapSchedule(j, { weekHint: (j && j.week && j.week.number) || null }),
    },
    {
      name: 'espn-core-events',
      urls: [`https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/types/2/events?limit=400`],
      map: (j) => mapSchedule(j),
    },
  ];
}

// A week-scoped source needs the week from its URL, which trySources does not thread through. Rather than
// complicate the shared helper for one caller, the scoreboard source is expanded here with the hint baked in.
export function scheduleSourcesResolved(season) {
  const s = scheduleSources(season);
  return s.map((src) => (src.name !== 'espn-scoreboard' ? src : {
    ...src,
    urls: src.urls,
    map: (j) => {
      const hint = (j && j.week && Number(j.week.number)) || null;
      return mapSchedule(j, { weekHint: hint });
    },
  }));
}

// `sources` is an injection seam, not a convenience. The provider hop is the part that cannot be reached
// from the build sandbox and is therefore the part that has historically shipped broken; passing a local
// stub chain in lets the whole fetch → map → sanity-check → write path be exercised end to end. ESM exports
// are live bindings and cannot be monkey-patched, so the seam has to be explicit.
export async function fetchSchedule(season, sources) {
  const chain = sources || scheduleSourcesResolved(season);
  const res = await trySources(chain);
  /* ⭐⭐⭐⭐ THE SECOND PASS, WHICH EXISTS ONLY BECAUSE OF b150. If the winning source gave us games without
     hours, ask the ones after it in the chain for hours alone. Best-effort throughout: a failed fill leaves
     a correct schedule with null kickoffs, which every consumer already states rather than guesses at.
     ⚠ The winner is never re-run and never overruled — `mergeKickoffs` only fills holes. */
  const cov = kickoffCoverage(res.records);
  if (!res.used || cov.ratio >= 0.9 || !res.records.length) return { ...res, kickoffCoverage: cov, kickoffFill: null };
  const rest = chain.filter((s) => s.name !== res.used);
  if (!rest.length) return { ...res, kickoffCoverage: cov, kickoffFill: null };
  try {
    const donor = await trySources(rest);
    const m = mergeKickoffs(res.records, donor.records);
    return {
      ...res,
      records: m.records,
      attempts: [...res.attempts, ...donor.attempts.map((a) => ({ ...a, source: a.source + ' (kickoffs only)' }))],
      kickoffCoverage: kickoffCoverage(m.records),
      kickoffFill: { from: donor.used || null, filled: m.filled, before: cov.have, of: cov.total },
    };
  } catch {
    return { ...res, kickoffCoverage: cov, kickoffFill: null };
  }
}

// Turn game records into the per-team rows we store: two rows per game, one from each side.
export function toTeamRows(games) {
  const rows = [];
  const seen = new Set();
  for (const g of games) {
    for (const [team, opp, home] of [[g.home, g.away, true], [g.away, g.home, false]]) {
      const key = `${g.week}:${team}`;
      // A team plays once per week. A duplicate means two sources disagreed or a payload repeated itself;
      // keep the first and count it rather than writing a second row that would silently double a matchup.
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ week: g.week, team, opponent: opp, home, kickoff: g.kickoff || null });
    }
  }
  return rows;
}

/* ⭐⭐⭐⭐ WHICH TEAMS ARE ON BYE IN ONE WEEK — b132, and the answer the whole free-agent view turns on.
   Trey: "Yes, I want this to be focused on bye weeks."
   The obvious implementation — "teams with no row for week N" — is WRONG in the one case that matters, and
   wrong in the most damaging direction: if the schedule has not been synced for week N at all, every team
   has no row, so every team is on bye and the page tells you your entire lineup is out. So a week with no
   rows AT ALL returns null, meaning "we do not know", and the caller degrades to saying nothing rather than
   to saying something catastrophic. A real NFL week has at most six teams on bye; anything wilder than that
   is a partial sync, not a schedule, and is refused the same way.
   Returns a sorted array of team abbreviations, or null when the data cannot support an answer. */
export function byeTeamsForWeek(rows, week) {
  if (!Array.isArray(rows) || !rows.length || !week) return null;
  const all = new Set();
  const playing = new Set();
  for (const r of rows) {
    if (!r || !r.team) continue;
    all.add(String(r.team));
    if (Number(r.week) === Number(week)) playing.add(String(r.team));
  }
  if (!playing.size) return null;                       // that week was never synced — not "everyone is out"
  const byes = [...all].filter((t) => !playing.has(t)).sort();
  /* Six of thirty-two is the most the NFL has ever rested in one week, and the cap is a FRACTION rather than
     a count so it means the same thing on a real schedule and on a small fixture: if a third of the league
     appears to be off, the week is half-loaded, not unusual. */
  return byes.length > all.size / 3 ? null : byes;
}

// Which weeks a team is on bye: the regular-season weeks with no game.
export function byeWeeksFrom(rows, weeks = 18) {
  const played = {};
  for (const r of rows) { (played[r.team] || (played[r.team] = new Set())).add(r.week); }
  const out = {};
  for (const t of Object.keys(played)) {
    for (let w = 1; w <= weeks; w++) if (!played[t].has(w)) { out[t] = w; break; }
  }
  return out;
}
