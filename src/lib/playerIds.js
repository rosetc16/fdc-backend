/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
   PLATFORM PLAYER-ID → NAME, for MyFantasyLeague and Fantrax
   ───────────────────────────────────────────────────────────────────────────────────────────────────
   ⚠ THIS IS THE THING THAT WAS ACTUALLY MISSING, AND IT IS EASY TO MISS.

   MFL and Fantrax both have real live draft feeds — that part was built and shipped. But read what a
   pick from either of them actually contains:

       MFL      { overall: 14, round: 2, franchise: '0007', player_id: '13593' }
       Fantrax  { overall: 14, round: 2, team: 'abc123',   player_id: '04xk9' }

   A number, and no name. The draft room places every incoming pick by looking its NAME up in the
   player pool (`nameToId[normName(pk.name)]`), because that is the only identifier the pool and the
   platform have in common — our sids are Sleeper's. So a live MFL poll would have returned a tidy list
   of picks, every one of them unresolvable, and the board would have filled with holes while reporting
   a healthy sync. That failure is worse than no sync at all: no sync is visibly manual, whereas this
   looks connected right up until you notice the picks are missing.

   So a live feed needs a directory. Both platforms publish one:

       MFL      /{year}/export?TYPE=players&DETAILS=1   id → name/position/team, ~3MB, ~2600 players
       Fantrax  /fxea/general/getPlayerIds?sport=NFL    id → name/position/team (+ other platforms' ids)

   ⚠ FETCH IT ONCE A DAY, NOT ONCE A POLL. These are the largest payloads either platform serves and the
     roster of the NFL does not change between two picks. They go through the same single-flight TTL
     cache the Sleeper draft poll uses, so twelve people in one draft cost one fetch, and a cache miss
     during a live draft cannot stampede.

   ⚠ A DIRECTORY THAT FAILS MUST NOT TAKE THE PICKS WITH IT. If the fetch is down, callers get an empty
     resolver and the picks come back name-less — exactly what happens today — rather than the whole
     poll 502ing. Degraded is not the same as broken, and on draft night the difference matters.
   ═══════════════════════════════════════════════════════════════════════════════════════════════════ */
import { cached } from './draftCache.js';
import { log } from './log.js';

const UA = 'FantasyDraftCompass/1.0 (+https://www.fantasydraftcompass.com)';
// A day. The directory changes when a player signs somewhere, which is not a draft-night event.
const DIRECTORY_TTL_MS = Number(process.env.PLAYER_DIRECTORY_TTL_MS || 24 * 60 * 60 * 1000);
const FETCH_TIMEOUT_MS = 20000;

const POS = (p) => ({
  QB: 'QB', RB: 'RB', FB: 'RB', WR: 'WR', TE: 'TE',
  PK: 'K', K: 'K', DEF: 'DST', DST: 'DST', 'D/ST': 'DST', DEFENSE: 'DST',
})[String(p || '').trim().toUpperCase()] || null;

/* MFL writes names "Last, First" — every one of them, including defences ("Bears, Chicago"). Left
   as-is, every single name would fail to match the pool, which is the same outcome as having no
   directory at all, so this is not cosmetic. */
function flipName(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const i = s.indexOf(',');
  if (i < 0) return s;
  const last = s.slice(0, i).trim();
  const first = s.slice(i + 1).trim();
  return first ? `${first} ${last}` : last;
}

async function getJson(url, label) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': UA } });
    if (!res.ok) throw new Error(`${label} returned ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

/* The parse steps are separate from the fetch steps so they can be tested without a network — the two
   payload shapes below are the whole risk in this file, and a test that needs MFL to be up is a test
   that does not run. */

// ---- MyFantasyLeague ------------------------------------------------------------------------------
export function parseMflDirectory(j) {
  const out = new Map();
  for (const p of arr(j?.players?.player)) {
    if (!p || p.id == null) continue;
    const name = flipName(p.name);
    if (!name) continue;
    out.set(String(p.id), { name, pos: POS(p.position), team: p.team ? String(p.team).toUpperCase() : null });
  }
  return out;
}

const fetchMflDirectory = async (year) => parseMflDirectory(await getJson(
  `https://api.myfantasyleague.com/${year}/export?TYPE=players&DETAILS=1&JSON=1`,
  'MyFantasyLeague player directory',
));

// ---- Fantrax --------------------------------------------------------------------------------------
export function parseFantraxDirectory(j) {
  const out = new Map();
  /* ⚠ TWO SHAPES, BOTH SEEN. The beta API has answered with a bare object keyed by Fantrax id and with
     an array of records carrying the id inside. Neither is documented, so accept both rather than
     picking one and discovering the other on draft night. */
  const entries = Array.isArray(j)
    ? j.map((v) => [v && (v.fantraxId || v.id), v])
    : Object.entries(j || {});
  for (const [k, v] of entries) {
    if (!v || typeof v !== 'object') continue;
    const id = String(v.fantraxId || v.id || k || '').trim();
    const name = String(v.name || v.playerName || '').trim();
    if (!id || !name) continue;
    out.set(id, { name, pos: POS(v.position), team: v.team ? String(v.team).toUpperCase() : null });
  }
  return out;
}

const fetchFantraxDirectory = async () => parseFantraxDirectory(
  await getJson('https://www.fantrax.com/fxea/general/getPlayerIds?sport=NFL', 'Fantrax player directory'),
);

const EMPTY = new Map();

/**
 * The id → { name, pos, team } directory for a platform. Never throws: a failed fetch yields an empty
 * map so the caller degrades to name-less picks instead of failing the whole request.
 */
export async function playerDirectory(platform, season) {
  const yr = Number(season) || new Date().getUTCFullYear();
  const key = platform === 'mfl' ? `dir:mfl:${yr}` : 'dir:fantrax';
  try {
    return await cached(key, DIRECTORY_TTL_MS, () => (platform === 'mfl' ? fetchMflDirectory(yr) : fetchFantraxDirectory()));
  } catch (e) {
    log.warn({ platform, err: e && e.message }, 'player directory unavailable — picks will be returned without names');
    return EMPTY;
  }
}

/**
 * Fill in `name` (and pos/team where blank) on a list of picks or roster entries carrying `player_id`.
 *
 * ⚠ A NAME ALREADY ON THE RECORD WINS. Fantrax's draft feed sometimes carries playerName itself, and
 *   what the league's own feed says about its own draft beats a directory lookup.
 */
export async function withPlayerNames(rows, platform, season) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return list;
  if (list.every((r) => r && r.name)) return list;
  return applyDirectory(list, await playerDirectory(platform, season));
}

/** The pure half of the above: rows + directory -> rows with names filled in. */
export function applyDirectory(rows, dir) {
  const list = Array.isArray(rows) ? rows : [];
  if (!dir || !dir.size) return list;
  return list.map((r) => {
    if (!r || r.name) return r;
    const hit = dir.get(String(r.player_id));
    if (!hit) return r;
    const out = { ...r, name: hit.name };
    if (out.pos == null) out.pos = hit.pos;
    /* ⚠ DO NOT TOUCH `team` IF THE RECORD HAS THE KEY AT ALL. On a Fantrax pick `team` is the FANTRAX
       TEAM that made the pick, and the directory's `team` is an NFL club — writing one over the other
       would silently misattribute picks to the wrong roster, which is a far worse bug than a blank
       field. Only a record with no notion of a team gets one. */
    if (!('team' in out)) out.team = hit.team;
    return out;
  });
}

export const _internals = { flipName, POS };
