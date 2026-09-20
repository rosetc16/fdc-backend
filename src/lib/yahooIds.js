/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
   YAHOO PLAYER → THE ID THE REST OF THE APP IS KEYED BY — b161
   ───────────────────────────────────────────────────────────────────────────────────────────────────
   ⚠⚠⚠⚠⚠ THIS IS THE WHOLE DIFFICULTY OF YAHOO IN-SEASON, AND IT IS EASY TO UNDERESTIMATE.

   Every in-season screen — My Week, the matchup, free agents, the trade finder, the league tab, the
   weekly review — is keyed by SLEEPER PLAYER ID, because that is what our projection pack is keyed by.
   Yahoo knows nothing about Sleeper ids. So a Yahoo roster that arrives as twelve real players with real
   names joins to NOTHING: the hub renders, the rosters look populated, and every projection, every
   lineup solve, every trade value and every free-agent comparison silently reads zero. That is the
   lib/playerIds.js failure in its most expensive form — "it looks connected right up until you notice".

   ⭐⭐⭐⭐⭐ AND THE BRIDGE IS ALREADY IN A DOCUMENT WE FETCH. Sleeper's player map carries cross-platform
     ids on every player, `yahoo_id` among them. So this needs no new upstream dependency, no scraping
     and no third-party crosswalk: one pass over a document the app already caches for other reasons
     gives an exact, non-heuristic mapping.

   ⚠ THE NAME PATH IS A FALLBACK, NEVER THE PRIMARY. `yahoo_id` is null on some Sleeper records —
     rookies signed since the last refresh, practice-squad bodies, most defences — so a name+position
     index catches those. It is second because names are genuinely ambiguous in the NFL: there have been
     two Michael Thomases, two Josh Allens and two Steve Smiths at the same time, and an index keyed on
     name alone WILL pick one of them. Position is part of the key for that reason, and a name that maps
     to more than one player at the same position is DROPPED rather than guessed — an unresolved player
     shows as missing, which is visible; a wrongly-resolved one shows as somebody else's projection,
     which is not.

   ⚠ DEFENCES ARE A SPECIAL CASE AND MUST NOT BE NAME-MATCHED. Sleeper keys a defence by its NFL team
     abbreviation ("PIT"), and Yahoo calls it "Pittsburgh". Matching "Pittsburgh Steelers" against
     "Pittsburgh" by name would be wrong about half the league, so the team abbreviation is used
     directly, which is exact.
   ══════════════════════════════════════════════════════════════════════════════════════════════════ */

const clean = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')     // fold accents: "Amon-Ra St. Brown"
  .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')              // suffixes differ between platforms
  .replace(/[^a-z ]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const POS_OK = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DST']);
const normPos = (p) => {
  const v = String(p || '').toUpperCase();
  return v === 'DEF' ? 'DST' : v;
};

/**
 * Build the lookup from Sleeper's own player document.
 * @param {object} allPlayers  Sleeper's /players/nfl map, id -> player
 * @returns {{byYahooId: Map, byName: Map, byTeamDst: Map, stats: object}}
 */
export function buildYahooIndex(allPlayers) {
  const byYahooId = new Map();
  const byName = new Map();          // "name|POS" -> sleeperId, or null once it is ambiguous
  const byTeamDst = new Map();       // "PIT" -> sleeperId
  let withYahooId = 0, total = 0;
  Object.entries(allPlayers || {}).forEach(([sid, p]) => {
    if (!p || typeof p !== 'object') return;
    total++;
    const pos = normPos(p.position || (Array.isArray(p.fantasy_positions) ? p.fantasy_positions[0] : ''));
    if (p.yahoo_id != null && String(p.yahoo_id) !== '') {
      withYahooId++;
      /* ⚠ FIRST WRITER WINS. Sleeper occasionally carries a retired duplicate sharing an old yahoo_id;
         its records sort later and overwriting with one would silently replace an active player. */
      if (!byYahooId.has(String(p.yahoo_id))) byYahooId.set(String(p.yahoo_id), String(sid));
    }
    if (pos === 'DST' || pos === 'DEF') {
      const t = String(p.team || sid || '').toUpperCase();
      if (t && !byTeamDst.has(t)) byTeamDst.set(t, String(sid));
      return;                         // never name-index a defence — see the header
    }
    if (!POS_OK.has(pos)) return;
    const name = clean(p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' '));
    if (!name) return;
    const k = `${name}|${pos}`;
    /* ⚠ AMBIGUITY IS RECORDED AS `null`, NOT RESOLVED. Two active players with one name and one position
       means we cannot tell them apart from a name, and picking either is a silent wrong answer. */
    if (byName.has(k)) byName.set(k, null);
    else byName.set(k, String(sid));
  });
  return { byYahooId, byName, byTeamDst, stats: { total, withYahooId } };
}

/**
 * One Yahoo player -> a Sleeper id, or null.
 * @param {object} index  from buildYahooIndex
 * @param {{yahooId?:string,name?:string,pos?:string,team?:string}} p
 */
export function toSleeperId(index, p) {
  if (!index || !p) return null;
  const pos = normPos(p.pos);
  /* 1 — the exact route. */
  if (p.yahooId != null && index.byYahooId.has(String(p.yahooId))) return index.byYahooId.get(String(p.yahooId));
  /* 2 — a defence is its team, never its name. */
  if (pos === 'DST') {
    const t = String(p.team || '').toUpperCase();
    return (t && index.byTeamDst.get(t)) || null;
  }
  /* 3 — name + position, and only when it is unambiguous. */
  const k = `${clean(p.name)}|${pos}`;
  const hit = index.byName.get(k);
  return hit || null;                 // `null` here means "known to be ambiguous" and is the right answer
}

/**
 * Resolve a whole roster, keeping a census of what did not map.
 * ⚠ THE CENSUS IS NOT OPTIONAL. A mapping that silently drops a quarter of a league is the failure this
 *   file exists to prevent, and it is invisible from the screen — the roster simply looks short. The
 *   route puts these counts on the payload so a thin Yahoo hub can be diagnosed from one response
 *   instead of by eye. (The same reasoning as `trendAudit` on the Sleeper hub.)
 */
export function resolveRoster(index, players) {
  const out = [];
  const unresolved = [];
  (players || []).forEach((p) => {
    const sid = toSleeperId(index, p);
    if (sid) out.push({ ...p, sid });
    else unresolved.push({ name: p && p.name, pos: p && p.pos, yahooId: p && p.yahooId });
  });
  return { players: out, unresolved };
}

export const _internals = { clean, normPos };
