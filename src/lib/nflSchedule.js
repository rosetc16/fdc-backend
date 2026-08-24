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
    out.push({ week: wk, home: t.home, away: t.away });
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
  return trySources(sources || scheduleSourcesResolved(season));
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
      rows.push({ week: g.week, team, opponent: opp, home });
    }
  }
  return rows;
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
