// ESPN PUBLIC-LEAGUE IMPORT.
//
// ESPN has no public API and no developer program to apply to. What exists is the undocumented v3
// endpoint their own web app calls. For a league whose visibility is PUBLIC it answers unauthenticated;
// for a private league it answers 401 and the only way in is for the user to paste their espn_s2 and
// SWID cookies out of dev tools. We deliberately support the public path ONLY — see the note at the
// bottom of this file for why.
//
// WHAT THIS CAN AND CANNOT DO:
//   CAN  — import league settings: size, roster slots (incl. superflex + IDP), scoring, draft type,
//          team names, draft order.
//   CANNOT — sync picks during a draft. ESPN has no live pick feed worth relying on. Draft night on
//          ESPN is manual entry, and every string in the UI says so.
//
// STABILITY: this endpoint is undocumented and has moved host once already (fantasy.espn.com ->
// lm-api-reads.fantasy.espn.com, April 2024). Everything here is written to FAIL SOFT: any parse that
// can't find what it expects falls back to the app's own defaults and pushes a line onto `warnings`,
// which the UI shows above the pre-filled settings form. The user reviews and corrects before saving.
// A wrong import that the user can see and fix is recoverable; a wrong import that looks authoritative
// is not.
//
// TESTING: ESPN is not reachable from CI/sandboxes, so the network hop is exercised only in production.
// Everything that carries real risk — the slot and scoring translation — is pure and covered by
// fixtures in scripts/espn.test.js.

export const ESPN_BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';

// ---- lineup slot ids -> our start-slot shape ---------------------------------------------------
// From ESPN's lineupSlotCounts. 20 = bench, 21 = IR, 19 = head coach, 18 = punter: all ignored.
const SLOT = {
  0: 'QB', 1: 'QB',            // 1 is "team QB", vanishingly rare, but it starts a QB
  2: 'RB', 4: 'WR', 6: 'TE',
  3: 'FLEX', 5: 'FLEX', 23: 'FLEX',   // RB/WR, WR/TE, RB/WR/TE all behave as a flex for our purposes
  7: 'SUPER',                  // "OP" (offensive player) — ESPN's superflex
  16: 'DST', 17: 'K',
  8: 'DL', 9: 'DL', 11: 'DL',  // DT, DE, DL
  10: 'LB',
  12: 'DB', 13: 'DB', 14: 'DB', // CB, S, DB
  15: 'IDPFLEX',               // DP — any defensive player
};
const IGNORED_SLOTS = new Set([18, 19, 20, 21, 24, 25]);

export function startFromLineupSlots(lineupSlotCounts) {
  const start = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, SUPER: 0, K: 0, DST: 0, DL: 0, LB: 0, DB: 0, IDPFLEX: 0 };
  const unknown = [];
  let bench = 0, ir = 0;
  Object.entries(lineupSlotCounts || {}).forEach(([id, n]) => {
    const count = Number(n) || 0;
    if (count <= 0) return;
    const key = Number(id);
    if (key === 20) { bench = count; return; }
    if (key === 21) { ir = count; return; }
    if (IGNORED_SLOTS.has(key)) return;
    const dest = SLOT[key];
    if (dest) start[dest] += count;
    else unknown.push(key);
  });
  return { start, bench, ir, unknown };
}

// ---- scoring ------------------------------------------------------------------------------------
// settings.scoringSettings.scoringItems is [{ statId, points, pointsOverrides }]. ESPN's stat table has
// DUPLICATE ids for several receiving stats (41/47/53 all decode to "receptions" in the community
// mappings, and the maintainers of the most-used library have an open TODO about which is which). So we
// accept every known alias and take the last one that actually appears, rather than betting on one id.
const STAT_ALIASES = {
  passYd: [3], passTD: [4], INT: [20],
  rushYd: [24, 40], rushTD: [25],
  rec: [53, 41, 47], recYd: [42, 48], recTD: [43, 49],
  fum: [72],
};
// pointsOverrides is keyed by ESPN POSITION id (not lineup slot): 1 QB, 2 RB, 3 WR, 4 TE, 5 K, 16 D/ST.
const POS_ID_TE = '4';

// Kicker and defensive scoring is deliberately NOT imported. Those stat ids are the least consistently
// documented of the set, they barely move a draft board, and a subtly wrong DST value is the kind of
// error nobody catches by eye. They fall through to the app's defaults, and the UI says so.
export function scoringFromItems(scoringItems) {
  const items = Array.isArray(scoringItems) ? scoringItems : [];
  const byId = new Map();
  items.forEach((it) => { if (it && it.statId != null) byId.set(Number(it.statId), it); });

  const pick = (aliases) => {
    for (const id of aliases) { if (byId.has(id)) return byId.get(id); }
    return null;
  };
  const scoring = {};
  const warnings = [];
  Object.entries(STAT_ALIASES).forEach(([dest, aliases]) => {
    const it = pick(aliases);
    if (!it) return;
    const pts = Number(it.points);
    if (!Number.isFinite(pts)) return;
    scoring[dest] = pts;
  });

  // A league with no reception item at all is standard scoring — that's a real answer, not a miss.
  if (scoring.rec == null) scoring.rec = 0;

  // TE premium: ESPN has no dedicated setting for it. Leagues do it by overriding the per-reception
  // value for the TE position on the reception item itself.
  let tePremMult = 0;
  const recItem = pick(STAT_ALIASES.rec);
  const overrides = (recItem && recItem.pointsOverrides) || null;
  if (overrides && typeof overrides === 'object') {
    const teVal = Number(overrides[POS_ID_TE]);
    if (Number.isFinite(teVal) && teVal > scoring.rec) {
      tePremMult = Math.round((teVal - scoring.rec) * 100) / 100;
      scoring.recTE = teVal;
    }
    // Any other position-specific reception value is real scoring we are NOT modeling. Say so out loud
    // rather than importing a league that quietly scores differently than the board shows.
    const others = Object.keys(overrides).filter((k) => k !== POS_ID_TE);
    if (others.length) warnings.push('This league sets different per-reception values by position. Only the tight-end premium was imported — check your scoring before drafting.');
  }
  if (scoring.recTE == null) scoring.recTE = scoring.rec;

  if (!byId.size) warnings.push('No scoring settings came back from ESPN — the values below are our defaults. Please check them.');
  return { scoring, tePremMult, warnings };
}

// ---- draft type ---------------------------------------------------------------------------------
function draftTypeFrom(draftSettings) {
  const t = String((draftSettings && draftSettings.type) || '').toUpperCase();
  if (t.includes('AUCTION')) return 'auction';
  if (t.includes('LINEAR')) return 'linear';
  return 'snake';
}

// ---- the whole mapping --------------------------------------------------------------------------
// Takes the raw JSON from ?view=mSettings&view=mTeam and returns the app's league cfg plus the team
// list. PURE — no network, no clock, no randomness — so it is fully testable against fixtures.
export function mapEspnLeague(raw, { season } = {}) {
  const warnings = [];
  const settings = (raw && raw.settings) || {};
  const rosterSettings = settings.rosterSettings || {};
  const draftSettings = settings.draftSettings || {};
  const scheduleSettings = settings.scheduleSettings || {};

  const { start, bench, ir, unknown } = startFromLineupSlots(rosterSettings.lineupSlotCounts);
  if (unknown.length) warnings.push(`ESPN returned roster slots we don't recognize (${unknown.join(', ')}) — they were skipped.`);

  const startersTotal = Object.values(start).reduce((s, n) => s + n, 0);
  if (startersTotal === 0) {
    warnings.push('No roster slots came back from ESPN — the starting lineup below is our default. Please check it.');
    Object.assign(start, { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 });
  }

  // Draft rounds = every roster spot that gets drafted. IR is not drafted; bench is.
  const rounds = Math.max(1, startersTotal + bench) || 15;

  const { scoring, tePremMult, warnings: scoreWarnings } = scoringFromItems((settings.scoringSettings || {}).scoringItems);
  warnings.push(...scoreWarnings);

  const teamsRaw = Array.isArray(raw && raw.teams) ? raw.teams : [];
  const size = Number(settings.size) || teamsRaw.length || 12;
  if (teamsRaw.length && teamsRaw.length !== size) {
    warnings.push(`ESPN reports ${size} teams but returned ${teamsRaw.length} — check the team list.`);
  }

  // Draft order. ESPN's pickOrder is an array of teamIds in first-round order; its index is the slot.
  const pickOrder = Array.isArray(draftSettings.pickOrder) ? draftSettings.pickOrder : [];
  const slotOfTeamId = new Map();
  pickOrder.forEach((teamId, i) => slotOfTeamId.set(Number(teamId), i + 1));

  const teams = teamsRaw.map((t, i) => {
    // ESPN moved from location+nickname to a single `name` field; both still appear in the wild.
    const nm = (t.name && String(t.name).trim())
      || [t.location, t.nickname].filter(Boolean).join(' ').trim()
      || t.abbrev || `Team ${i + 1}`;
    return { id: Number(t.id), name: nm, abbrev: t.abbrev || null, slot: slotOfTeamId.get(Number(t.id)) || null };
  });
  if (teams.length && !pickOrder.length) {
    warnings.push('ESPN has not set a draft order for this league yet, so team-to-slot assignments are unknown. Pick your slot by hand below.');
  }

  // teamNames indexed by slot, which is the shape the app's cfg wants.
  let teamNames = null;
  if (pickOrder.length) {
    const bySlot = new Array(size).fill('');
    teams.forEach((t) => { if (t.slot && t.slot <= size) bySlot[t.slot - 1] = t.name; });
    if (bySlot.some((x) => x)) teamNames = bySlot;
  }

  const draftType = draftTypeFrom(draftSettings);
  if (draftType === 'auction') {
    warnings.push('This is an auction draft. The board is built for pick-by-pick drafts, so it was set up as a snake — the player values are still right for your scoring.');
  }

  const keeperCount = Number(draftSettings.keeperCount || 0);
  const isKeeper = keeperCount > 0 || draftSettings.isUsingKeeper === true;

  const superflex = start.SUPER > 0;
  const rec = scoring.rec || 0;

  const cfg = {
    name: (settings.name && String(settings.name).trim()) || 'ESPN league',
    teams: size,
    rounds,
    type: isKeeper ? 'keeper' : 'redraft',
    keeper: isKeeper,
    order: draftType === 'linear' ? 'linear' : 'snake',
    slot: null,                 // the user picks their team in the UI; we can't know it from a public read
    sf: superflex,
    qbType: superflex ? 'SF' : start.QB >= 2 ? '2QB' : '1QB',
    scoringType: rec >= 1 ? 'ppr' : rec >= 0.5 ? 'half' : 'std',
    tePrem: tePremMult > 0,
    tePremMult,
    scoring,
    start,
    teamNames,
    keepers: [],
    pickTrades: [],
  };

  return {
    cfg,
    teams,
    source: 'espn',
    season: season || Number(raw && raw.seasonId) || null,
    // Stated in the response, not just in the docs, so the UI can never imply otherwise.
    canSyncPicks: false,
    playoffTeams: Number(scheduleSettings.playoffTeamCount) || null,
    regularSeasonWeeks: Number(scheduleSettings.matchupPeriodCount) || null,
    warnings,
  };
}

// ---- the network hop ----------------------------------------------------------------------------
// Kept as thin as possible and separated from every decision above, so that when ESPN moves the
// endpoint again this is the only function that has to change.
export async function fetchEspnLeague(leagueId, season, { timeoutMs = 9000 } = {}) {
  const id = String(leagueId || '').trim().replace(/\D/g, '');
  if (!id) { const e = new Error('A numeric ESPN league ID is required.'); e.status = 400; throw e; }
  const yr = Number(season) || new Date().getUTCFullYear();
  const url = `${ESPN_BASE}/seasons/${yr}/segments/0/leagues/${id}?view=mSettings&view=mTeam`;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: 'application/json', 'user-agent': 'FantasyDraftCompass/1.0 (+https://www.fantasydraftcompass.com)' },
    });
  } catch (e) {
    const err = new Error("Couldn't reach ESPN. Try again in a moment.");
    err.status = 502; throw err;
  } finally { clearTimeout(timer); }

  if (res.status === 401 || res.status === 403) {
    const e = new Error('That ESPN league is private, so we can\'t read it. Set the league to public in ESPN (League Settings → Basic Settings → Visibility), or set it up by hand here — it takes about a minute.');
    e.status = 403; e.code = 'ESPN_PRIVATE'; throw e;
  }
  if (res.status === 404) {
    const e = new Error(`No ESPN league ${id} found for ${yr}. Check the ID in your league's URL, and that the season is right.`);
    e.status = 404; e.code = 'ESPN_NOT_FOUND'; throw e;
  }
  if (!res.ok) {
    const e = new Error(`ESPN returned ${res.status}. This endpoint is undocumented and occasionally changes — set the league up by hand and let us know.`);
    e.status = 502; e.code = 'ESPN_BAD_STATUS'; throw e;
  }

  let json;
  try { json = await res.json(); } catch {
    const e = new Error('ESPN returned something we could not read.'); e.status = 502; throw e;
  }
  // Some seasons answer with a single-element array instead of an object.
  return Array.isArray(json) ? json[0] : json;
}

// ---- WHY PUBLIC-ONLY ----------------------------------------------------------------------------
// The private-league path needs the user to open dev tools, find the fantasy.espn.com cookies, and paste
// a 250+ character espn_s2 value plus a SWID. Those are live session credentials for the user's whole
// ESPN account, not a scoped token: storing them means holding something that can read the user's ESPN
// account until it expires, with no way to scope it down and no revocation story we control. They also
// expire on their own, so the "connected" league silently rots and the user re-pastes. For a league
// setup that takes about a minute by hand, that trade is not worth it. If enough people ask, the honest
// version is a paste-once, never-stored flow: take the cookies, use them for the single import request,
// and drop them.
