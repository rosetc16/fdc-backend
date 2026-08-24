// INJURY DETAIL, FROM SOURCES THAT ACTUALLY KNOW.
//
// WHY THIS EXISTS: the app used to carry a hand-written table of injury notes in the frontend. It said
// things like "coming off the Achilles/calf issues that wrecked last season" — written once, asserted
// forever, and wrong within weeks. A confidently wrong note about a real player is worse than no note:
// the user believes it, and it poisons trust in the accurate numbers printed beside it.
//
// So everything here is SOURCED, and every field carries where it came from and when. Two sources, in
// order of detail:
//
//   1. SLEEPER (already synced daily, no key, and the platform most of our users are actually in).
//      Its player record carries injury_status, injury_body_part, injury_notes and injury_start_date.
//      Terse, but authoritative for the designation.
//
//   2. ESPN's team injuries endpoint — the richest free source: a TYPE (Achilles, Hamstring), a SIDE
//      (left/right), a detail, a return estimate, and often a sentence of actual reporting. This is what
//      turns "Q" into "Questionable — right hamstring, limited Wednesday, targeting Sunday".
//
// ⚠ NEITHER host is reachable from the build sandbox, so `mapEspnInjuries` and `mergeInjury` are written
// as PURE functions over the payload shape and unit-tested against fixtures. The network hop is the part
// that is unverified — same posture as the ESPN league import.
//
// The rule this file exists to enforce: we never invent, never estimate, and never carry a note forward
// once it is stale. If we don't know, the app says it doesn't know.

// How long a note stays worth showing. An injury note from six weeks ago is not news, it's history, and
// showing it with today's date attached is how the old table misled people.
export const NOTE_MAX_AGE_DAYS = 45;

const clean = (t, n = 300) => {
  if (t == null) return null;
  const s = String(t).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
};

// ESPN designations → the short token we show on a badge. Anything unrecognised passes through upper-cased
// rather than being mapped to a guess.
const DESIGNATION = {
  active: 'ACT', questionable: 'Q', doubtful: 'D', out: 'OUT',
  'injury-reserve': 'IR', 'injured-reserve': 'IR', ir: 'IR',
  suspension: 'SUSP', suspended: 'SUSP',
  'physically-unable-to-perform': 'PUP', pup: 'PUP',
  'non-football-injury': 'NFI', 'day-to-day': 'DTD', dayto_day: 'DTD',
};
export function normalizeDesignation(raw) {
  if (!raw) return null;
  const k = String(raw).toLowerCase().replace(/\s+/g, '-');
  return DESIGNATION[k] || String(raw).toUpperCase().slice(0, 6);
}

// ESPN's core API nests everything and half of it arrives as $ref links. This reads the SHAPES we can get
// without following refs, and returns null for anything it cannot read rather than guessing.
//
// Accepts either { items: [ ...injury objects ] } or a bare array, because the two ESPN hosts differ.
// FIND THE INJURY RECORDS WHEREVER THEY ARE.
//
// The first version assumed the envelope: { items: [...] } or { injuries: [...] }. Against the real
// endpoint it matched NOTHING and returned an empty list with no warnings — which the job then reported as
// a clean success. 32 teams read, 0 injuries, 0 problems. That is the silent-fallback failure this codebase
// has been bitten by twice before, and it wasted a whole deploy cycle.
//
// So it no longer guesses a path. ESPN's team-injuries response nests the real records inside a per-team
// group, and that nesting has changed before. Instead of encoding one shape, this WALKS the payload and
// collects every object that looks like an injury — one carrying an athlete with an id. Depth- and
// node-capped so a hostile or huge payload can't spin.
// The fields a real injury record carries. Used as a SCORE, not a checklist — see the walker below.
const INJURY_FIELDS = ['status', 'type', 'details', 'longComment', 'shortComment', 'date', 'athlete'];

// Pull an athlete id out of a $ref URL. ESPN's core API hands us `{ $ref: ".../athletes/3117251?lang=en" }`
// instead of the athlete; the id is right there in the link, so following it would be an HTTP request per
// injured player for a number we already have.
const refAthleteId = (n) => (n && typeof n === 'object' && typeof n.$ref === 'string'
  ? (/\/athletes\/(\d+)/.exec(n.$ref) || [])[1] || null : null);

// WHO is this injury about? Returns { id, name } or null.
//
// Deliberately separate from "is this an injury record". Conflating the two is what made a readable payload
// look unreadable: an athlete in an unexpected place meant the whole record was discarded silently rather
// than reported as "found the injury, couldn't name the player" — two very different things to tell a user.
export function athleteOf(node) {
  if (!node || typeof node !== 'object') return null;
  for (const key of ['athlete', 'player']) {
    const a = node[key];
    if (a && typeof a === 'object') {
      const id = a.id != null ? String(a.id) : refAthleteId(a);
      const name = a.displayName || a.fullName || a.name || null;
      if (id || name) return { id: id || null, name: name ? String(name) : null };
    }
  }
  if (node.athleteId != null) return { id: String(node.athleteId), name: null };
  // Last resort: something one level down that looks like a person rather than a lookup table.
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && v.displayName
        && (v.position || v.firstName || v.lastName || v.headshot || v.jersey)) {
      return { id: v.id != null ? String(v.id) : refAthleteId(v), name: String(v.displayName) };
    }
  }
  return null;
}

function collectInjuryNodes(root, cap = 4000, maxDepth = 8) {
  const found = [];
  let refsSeen = 0;      // $ref links we were given instead of data — a distinct, actionable condition
  const seen = new Set();
  // A QUEUE, not a stack: popping reverses document order, so the first injury in the payload came out
  // last and anything downstream that assumes "first" meant "first" was quietly wrong.
  const queue = [[root, 0]];
  let head = 0, visited = 0;
  while (head < queue.length && visited < cap) {
    const [node, depth] = queue[head++];
    if (!node || typeof node !== 'object' || depth > maxDepth) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    visited++;
    if (Array.isArray(node)) {
      for (const child of node) queue.push([child, depth + 1]);
      continue;
    }
    // ⭐⭐ RECOGNISE THE RECORD BY ITSELF, IDENTIFY THE PLAYER SEPARATELY.
    //
    // The previous rule was "has an athlete AND has a status", and against the real league-wide response it
    // matched NOTHING — so the job reported "no injury records" when the payload was full of them. Requiring
    // the athlete to be present in the shape I expected meant one unexpected athlete field turned a payload
    // we could read into a payload we claimed was unreadable.
    //
    // So detection is now about the record's OWN fields, scored rather than demanded: real injury records
    // carry most of status/type/details/longComment/shortComment/date/athlete, and the objects we must NOT
    // match carry at most one. `details` ({type, side, returnDate}) scores 1. `type`
    // ({id,name,description}) scores 0. `season` ({year,type,name}) scores 1. A real record scores 5-7.
    // Whether we can then NAME the player is a separate question, answered — and reported — below.
    const score = INJURY_FIELDS.reduce((n, f) => n + (node[f] != null ? 1 : 0), 0);
    const hasAthlete = athleteOf(node) != null;
    if (score >= 3 || (score >= 2 && hasAthlete)) { found.push(node); continue; }  // don't descend into a match
    if (node.$ref && !hasAthlete) refsSeen++;
    for (const k of Object.keys(node)) queue.push([node[k], depth + 1]);
  }
  found.refsSeen = refsSeen;
  return found;
}

export function mapEspnInjuries(payload, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const out = [];
  const warnings = [];

  const items = collectInjuryNodes(payload);
  if (!items.length) {
    // Links instead of data is its own diagnosis: the endpoint answered, but with $refs we did not follow.
    if (items.refsSeen) {
      for (let i = 0; i < items.refsSeen; i++) warnings.push('unexpanded-ref');
      return { injuries: out, warnings };
    }
    // ⭐ SAY SO. "We read the response and understood none of it" must never look like "nobody is hurt".
    // The top-level keys are logged so the next run diagnoses the shape instead of another guess.
    //
    // ⚠ AND NAME THE EMPTY CASE SEPARATELY. The first diagnostic run came back with a bare
    // `shape-unrecognized:` — an empty key list — which reads like the warning itself is broken. It wasn't:
    // the endpoint was answering 200 with a literal `{}` for all 32 teams, i.e. that URL has no such
    // sub-resource. "Empty" and "unfamiliar" are different problems and must not print the same way.
    if (payload && typeof payload === 'object' && !Array.isArray(payload) && !Object.keys(payload).length) {
      warnings.push('empty-object');
      return { injuries: out, warnings };
    }
    if (Array.isArray(payload) && !payload.length) { warnings.push('empty-array'); return { injuries: out, warnings }; }
    const keys = (payload && typeof payload === 'object' && !Array.isArray(payload))
      ? Object.keys(payload).slice(0, 12) : (Array.isArray(payload) ? ['<array>'] : [typeof payload]);
    warnings.push('shape-unrecognized:' + keys.join(','));
    return { injuries: out, warnings };
  }

  for (const it of items) {
    // An unexpanded $ref carries no data — count it so a caller can tell "no injuries" from "we couldn't
    // read them", which are very different answers to give a user.
    if (it.$ref && !it.athlete && !it.status && !it.type) { warnings.push('unexpanded-ref'); continue; }

    const who = athleteOf(it);
    const espnId = who && who.id ? who.id : null;
    // The NAME is the fallback key. espn_id comes to us from Sleeper's player record and is missing on a
    // slice of players (rookies especially, whose cross-source ids lag), so an id-only match silently drops
    // exactly the players whose news is newest.
    const name = who ? clean(who.name, 60) : null;
    if (!espnId && !name) {
      // ⭐ NAME THE SHAPE. "Found a record I couldn't attribute" is a different problem from "found no
      // records", and printing them the same way is what sent the last two rounds chasing the wrong thing.
      warnings.push('record-no-athlete:' + Object.keys(it).slice(0, 10).join(','));
      continue;
    }

    // Status arrives as a bare string on some endpoints and as a {name,description,abbreviation} object
    // on others. Take whichever is present rather than assuming.
    const rawStatus = typeof it.status === 'string' ? it.status
      : (it.status && (it.status.name || it.status.description)) ? (it.status.description || it.status.name)
      : (it.type && (it.type.description || it.type.name)) || null;
    const designation = normalizeDesignation(rawStatus);

    // The detail block is where the good stuff lives: type (Hamstring), side (Right), returnDate.
    const d = it.details || it.detail || {};
    const bodyPart = clean(d.type || d.location || it.bodyPart || null, 40);
    const side = clean(d.side || null, 16);
    const part = bodyPart ? (side && !/^n\/?a$/i.test(side) ? `${side} ${bodyPart}` : bodyPart) : null;

    const note = clean(it.longComment || it.shortComment || d.detail || it.comment || null, 300);

    const at = it.date || d.returnDate || it.lastModified || null;
    const atMs = at ? Date.parse(at) : NaN;
    const ageDays = Number.isFinite(atMs) ? (now - atMs) / 86400000 : null;

    out.push({
      espnId,
      name,
      designation,
      part,
      note,
      // A return estimate is only reported when ESPN actually supplies one. We never compute it.
      returnDate: d.returnDate || null,
      at: Number.isFinite(atMs) ? new Date(atMs).toISOString() : null,
      ageDays: ageDays != null ? Math.round(ageDays * 10) / 10 : null,
      stale: ageDays != null ? ageDays > NOTE_MAX_AGE_DAYS : false,
      source: 'espn',
    });
  }
  return { injuries: out, warnings };
}

// Merge what Sleeper knows with what ESPN knows for ONE player.
//
// Sleeper owns the DESIGNATION — it is the platform our users' leagues actually run on, so its status is
// the one their league sees. ESPN owns the DETAIL, because it has reporting and Sleeper has a field.
// A stale ESPN note is dropped rather than shown next to a fresh designation, which is precisely the
// mismatch Trey caught: a current injury wearing an old story.
export function mergeInjury(sleeper = {}, espn = null, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const status = sleeper.injury_status || (espn && espn.designation) || null;
  if (!status) return null;

  const sleeperPart = clean(sleeper.injury_body_part, 40);
  const sleeperNote = clean(sleeper.injury_notes, 300);
  const espnUsable = espn && !espn.stale;

  const part = (espnUsable && espn.part) || sleeperPart || null;
  const note = (espnUsable && espn.note) || sleeperNote || null;

  // Freshness: prefer whichever source actually dated its note.
  let at = null;
  if (espnUsable && espn.at) at = espn.at;
  else if (sleeper.news_updated) {
    const ms = Number(sleeper.news_updated);
    const norm = ms < 1e12 ? ms * 1000 : ms;          // Sleeper sends seconds sometimes, ms others
    if (Number.isFinite(norm)) at = new Date(norm).toISOString();
  }
  const ageDays = at ? Math.round(((now - Date.parse(at)) / 86400000) * 10) / 10 : null;

  return {
    status: normalizeDesignation(status),
    rawStatus: String(status),
    part,
    note,
    returnDate: (espnUsable && espn.returnDate) || null,
    at,
    ageDays,
    // What the UI keys on to decide between showing a note and admitting it has none.
    sourced: !!(part || note),
    sources: [sleeper.injury_status ? 'sleeper' : null, espnUsable && (espn.part || espn.note) ? 'espn' : null].filter(Boolean),
  };
}

// ⭐ A STRUCTURAL MAP OF A RESPONSE — keys and types, no content.
//
// The previous diagnostic shipped 600 raw characters of the payload. A single 400-character blurb about a
// kicker's field-goal percentage consumed almost all of it, so the one thing needed — what the injury
// records look like — was cut off mid-sentence. Values are never the question; structure is. Arrays collapse
// to a count plus their first element, strings become `str`, and nothing long can crowd out the shape.
export function describeShape(v, depth = 0, maxDepth = 6) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return depth >= maxDepth ? `[${v.length}]`
    : `[${v.length}]` + (v.length ? describeShape(v[0], depth + 1, maxDepth) : '');
  const t = typeof v;
  if (t !== 'object') return t === 'string' ? 'str' : t === 'number' ? 'num' : t === 'boolean' ? 'bool' : t;
  if (depth >= maxDepth) return '{…}';
  const keys = Object.keys(v);
  const shown = keys.slice(0, 14).map((k) => `${k}:${describeShape(v[k], depth + 1, maxDepth)}`);
  if (keys.length > 14) shown.push(`+${keys.length - 14} more`);
  return `{${shown.join(',')}}`;
}

// The 32 NFL team ids ESPN uses. Static because they do not change during a season and a lookup call per
// sync would double our request count for nothing.
export const ESPN_TEAM_IDS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
  17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 33, 34,
];

export const ESPN_TEAM_INJURIES = (teamId) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}/injuries`;

// ⭐⭐ WHY THIS IS A CHAIN AND NOT A URL.
//
// The first production run called ESPN_TEAM_INJURIES for all 32 teams, got HTTP 200 every time, and read a
// literal `{}` out of every one — that path has no injuries sub-resource. 32 successful requests, zero
// information, and the job reported `espnTeamsOk: 32`. A single hard-coded URL against an UNOFFICIAL API is
// a guess with no fallback and no way to tell a wrong guess from an injury-free league.
//
// So the job now works down an ordered list and stops at the first source that actually yields records.
// Cheapest and most likely first. Which one won is reported back in the job result, so the next time ESPN
// moves something we learn it from the result box instead of another deploy cycle.
export const ESPN_INJURY_SOURCES = [
  {
    // ONE call for the whole league. If this works, the other 32-call sources never run.
    name: 'site-league',
    urls: ['https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries'],
  },
  {
    // The web host mirrors the site host but exposes different sub-resources; per team.
    name: 'web-team',
    urls: ESPN_TEAM_IDS.map((id) =>
      `https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/teams/${id}/injuries`),
  },
  {
    // The core API definitely has this, but hands back { items: [{ $ref }] }. We do NOT follow those refs —
    // the athlete id is embedded in the ref URL and the mapper parses it out. When the refs carry no inline
    // status this source yields nothing and we fall through, which the warnings will say.
    name: 'core-team',
    urls: ESPN_TEAM_IDS.map((id) =>
      `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/teams/${id}/injuries?limit=100`),
  },
  {
    // The original guess, kept LAST rather than deleted: it costs nothing once the others have failed, and
    // if ESPN ever fills it in we pick that up for free.
    name: 'site-team',
    urls: ESPN_TEAM_IDS.map((id) => ESPN_TEAM_INJURIES(id)),
  },
  {
    // ⭐ THE ONE THAT CANNOT FAIL ON SHAPE. core-team demonstrably returns real injuries — it just returns
    // them as `{ items: [{ $ref }] }`, links rather than data. Following those links is the one path whose
    // success does not depend on my guessing an envelope correctly.
    //
    // It is LAST because it is expensive: one request per injured player, several hundred of them. It only
    // ever runs when every cheap source has already failed, it is bounded hard (see expandRefs), and the
    // nightly is the thing that pays the cost. Correct and slow beats fast and empty.
    name: 'core-expand',
    urls: ESPN_TEAM_IDS.map((id) =>
      `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/teams/${id}/injuries?limit=100`),
    expandRefs: { max: 600, concurrency: 8 },
  },
];

// Collect the $ref URLs out of a core-API listing so they can be fetched.
export function refsIn(payload, cap = 200) {
  const out = [];
  const items = payload && Array.isArray(payload.items) ? payload.items : [];
  for (const it of items) {
    if (out.length >= cap) break;
    if (it && typeof it === 'object' && typeof it.$ref === 'string') out.push(it.$ref);
  }
  return out;
}
