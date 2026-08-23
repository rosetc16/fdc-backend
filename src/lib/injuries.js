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
export function mapEspnInjuries(payload, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const items = Array.isArray(payload) ? payload
    : (payload && Array.isArray(payload.items)) ? payload.items
    : (payload && Array.isArray(payload.injuries)) ? payload.injuries
    : [];
  const out = [];
  const warnings = [];

  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    // An unexpanded $ref carries no data — count it so a caller can tell "no injuries" from "we couldn't
    // read them", which are very different answers to give a user.
    if (it.$ref && !it.athlete && !it.status && !it.type) { warnings.push('unexpanded-ref'); continue; }

    const ath = it.athlete || it.player || {};
    const espnId = ath.id != null ? String(ath.id) : (it.athleteId != null ? String(it.athleteId) : null);
    if (!espnId) { warnings.push('no-athlete-id'); continue; }

    const designation = normalizeDesignation(it.status || it.type?.name || it.type?.description || null);

    // The detail block is where the good stuff lives: type (Hamstring), side (Right), returnDate.
    const d = it.details || it.detail || {};
    const bodyPart = clean(d.type || it.bodyPart || null, 40);
    const side = clean(d.side || null, 16);
    const part = bodyPart ? (side && !/^n\/?a$/i.test(side) ? `${side} ${bodyPart}` : bodyPart) : null;

    // ESPN gives several prose fields depending on endpoint; take the most specific non-empty one.
    const note = clean(it.longComment || it.shortComment || d.detail || it.comment || null, 300);

    const at = it.date || d.returnDate || it.lastModified || null;
    const atMs = at ? Date.parse(at) : NaN;
    const ageDays = Number.isFinite(atMs) ? (now - atMs) / 86400000 : null;

    out.push({
      espnId,
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

// The 32 NFL team ids ESPN uses. Static because they do not change during a season and a lookup call per
// sync would double our request count for nothing.
export const ESPN_TEAM_IDS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
  17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 33, 34,
];

export const ESPN_TEAM_INJURIES = (teamId) =>
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/${teamId}/injuries`;
