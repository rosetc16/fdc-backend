/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
   ESPN PRIVATE LEAGUES — the paste-once, never-stored import
   ───────────────────────────────────────────────────────────────────────────────────────────────────
   Users: "I know, to connect ESPN, it has to be public. But, for those of us who are not the
   commissioners, that's not an option."

   They are right, and public-only was always the wrong place to stop: most ESPN leagues are private by
   default, and a member who is not the commissioner cannot change that. ESPN has no OAuth, no developer
   program and no API key — the only way in is the two cookies a logged-in browser holds, `espn_s2` and
   `SWID`. This file does that, under one rule that is not negotiable:

       THE COOKIES ARE USED FOR THIS ONE REQUEST AND THEN DROPPED. They are never written to the
       database, never logged, never returned to the client, and never held between calls.

   That rule is the whole design, and it costs something real: because nothing is stored, there is no
   background sync for a private ESPN league. The user re-pastes when they want to refresh. That is the
   honest trade — those cookies authenticate the user's ENTIRE Disney/ESPN account, not a fantasy-scoped
   token. Storing them would mean holding, indefinitely, something that can read someone's whole ESPN
   account, with no way to scope it down and no revocation we control. A refresh button is not worth that.

   ⚠ THE BASE URL MOVED. It is lm-api-reads.fantasy.espn.com, not fantasy.espn.com — the latter has been
     wrong since about April 2024 and answers with redirects or 403s. Seasons of 2017 and earlier live
     under a different leagueHistory shape, which this deliberately does not chase: this is a draft tool.

   ⚠ ESPN 403s A REQUEST WITH NO CREDIBLE User-Agent, intermittently and without explanation. The header
     below is not decoration.
   ═══════════════════════════════════════════════════════════════════════════════════════════════════ */
import { ESPN_BASE, mapEspnLeague } from './espn.js';

const UA = 'FantasyDraftCompass/1.0 (+https://www.fantasydraftcompass.com)';

/* SWID is braced in the cookie jar — "{AABBCC-...}" — and people paste it both ways. Accept either and
   normalise, because a missing pair of braces is an authentication failure with no useful message. */
export function normalizeSwid(swid) {
  const s = String(swid || '').trim();
  if (!s) return '';
  return s.startsWith('{') ? s : `{${s.replace(/^\{|\}$/g, '')}}`;
}

export function cleanS2(s2) {
  // Browsers show the value URL-encoded; some copy paths hand back the decoded form. ESPN accepts the
  // raw value, so strip nothing except surrounding whitespace and an accidental "espn_s2=" prefix.
  return String(s2 || '').trim().replace(/^espn_s2=/i, '');
}

async function espnGet(path, { s2, swid, timeoutMs = 10000 }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(path, {
      signal: ctl.signal,
      headers: {
        accept: 'application/json',
        'user-agent': UA,
        ...(s2 && swid ? { cookie: `espn_s2=${s2}; SWID=${swid}` } : {}),
      },
    });
  } catch {
    const e = new Error("Couldn't reach ESPN. Try again in a moment."); e.status = 502; throw e;
  } finally { clearTimeout(timer); }

  if (res.status === 401 || res.status === 403) {
    const e = new Error('ESPN rejected those cookies. They expire when you sign out of ESPN or after a while — sign in to ESPN again in your browser, re-copy espn_s2 and SWID, and paste them here. Check you copied the WHOLE espn_s2 value; it is around 300 characters.');
    e.status = 403; e.code = 'ESPN_AUTH'; throw e;
  }
  if (res.status === 404) {
    const e = new Error('ESPN has no league with that ID for this season. Check the leagueId in your league URL.');
    e.status = 404; e.code = 'ESPN_NOT_FOUND'; throw e;
  }
  if (!res.ok) {
    const e = new Error(`ESPN returned ${res.status}. This API is undocumented and changes without notice.`);
    e.status = 502; e.code = 'ESPN_BAD_STATUS'; throw e;
  }
  let json;
  try { json = await res.json(); } catch {
    const e = new Error('ESPN returned something we could not read.'); e.status = 502; throw e;
  }
  return Array.isArray(json) ? json[0] : json;
}

/* ESPN's draft slot ids are 1-based and match our own slot numbering, but a team's `id` is NOT its draft
   slot — the draft order is a separate list. Both are needed: picks reference teamId, and the board is
   laid out by slot. */
function slotsFromDraftOrder(raw) {
  const order = raw?.settings?.draftSettings?.pickOrder;
  const map = {};                                  // teamId -> 1-based slot
  if (Array.isArray(order) && order.length) order.forEach((teamId, i) => { map[teamId] = i + 1; });
  else (raw?.teams || []).forEach((t, i) => { map[t.id] = i + 1; });
  return map;
}

const posOf = (p) => ({ 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DST' })[p?.defaultPositionId] || null;
const nameOf = (p) => (p?.fullName || [p?.firstName, p?.lastName].filter(Boolean).join(' ') || null);

/* ═══ THE IMPORT ═══════════════════════════════════════════════════════════════════════════════════
   One call, five views, everything the app needs from a league it will never see again:
     mSettings     roster slots, scoring, draft type              → cfg
     mTeam         team names, owners                             → slotNames, yourSlot
     mRoster       current holdings                               → existingRosters (dynasty/keeper)
     mDraftDetail  the draft order and every pick made so far     → picks, tradedPicks
   ═══════════════════════════════════════════════════════════════════════════════════════════════ */
export async function importEspnPrivate(leagueId, season, { s2, swid, teamId = null } = {}) {
  const id = String(leagueId || '').trim().replace(/\D/g, '');
  if (!id) { const e = new Error('A numeric ESPN league ID is required.'); e.status = 400; throw e; }
  const S2 = cleanS2(s2), SW = normalizeSwid(swid);
  if (!S2 || !SW) { const e = new Error('Both espn_s2 and SWID are needed to read a private league.'); e.status = 400; e.code = 'ESPN_NEED_COOKIES'; throw e; }
  const yr = Number(season) || new Date().getUTCFullYear();

  const url = `${ESPN_BASE}/seasons/${yr}/segments/0/leagues/${id}`
    + '?view=mSettings&view=mTeam&view=mRoster&view=mDraftDetail';
  const raw = await espnGet(url, { s2: S2, swid: SW });

  // The public mapper already knows how to read settings and scoring; private adds the rest.
  const mapped = mapEspnLeague(raw, { season: yr });

  const slotOf = slotsFromDraftOrder(raw);
  const slotNames = {};
  const teamById = {};
  (raw?.teams || []).forEach((t) => {
    teamById[t.id] = t;
    const slot = slotOf[t.id];
    if (slot) slotNames[slot] = (t.name || [t.location, t.nickname].filter(Boolean).join(' ') || `Team ${slot}`).trim();
  });

  /* WHICH TEAM IS THEIRS. The SWID identifies the ESPN member, and each team carries its owner ids —
     so unlike the public import, a private one does NOT have to ask. When it cannot be resolved (a
     co-owned team, an unusual owners array) the caller falls back to asking, which is why this returns
     null rather than guessing. */
  let yourSlot = null;
  const swidBare = SW.replace(/^\{|\}$/g, '').toLowerCase();
  for (const t of raw?.teams || []) {
    const owners = [].concat(t.owners || [], t.primaryOwner ? [t.primaryOwner] : []);
    if (owners.some((o) => String(o || '').replace(/^\{|\}$/g, '').toLowerCase() === swidBare)) { yourSlot = slotOf[t.id] || null; break; }
  }
  if (!yourSlot && teamId != null) yourSlot = slotOf[Number(teamId)] || null;

  // Existing rosters, in the { slot: [{name, pos}] } shape every other importer produces.
  const existingRosters = {};
  (raw?.teams || []).forEach((t) => {
    const slot = slotOf[t.id]; if (!slot) return;
    const entries = t?.roster?.entries || [];
    const list = entries.map((e) => {
      const p = e?.playerPoolEntry?.player;
      return p ? { player_id: String(p.id), name: nameOf(p), pos: posOf(p) } : null;
    }).filter((x) => x && x.name && x.pos);
    if (list.length) existingRosters[slot] = list;
  });

  /* THE DRAFT. `picks` is dense and ordered by overall pick — the same array shape the Sleeper importer
     returns — because everything downstream indexes it by pick number. A draft that has not started
     yields an empty array, not null: "no picks yet" and "we could not read the picks" are different
     answers and the board treats them differently. */
  const dp = raw?.draftDetail?.picks || [];
  const picks = dp
    .filter((p) => p && p.playerId)
    .sort((a, b) => (a.overallPickNumber || 0) - (b.overallPickNumber || 0))
    .map((p) => ({
      overall: p.overallPickNumber,
      round: p.roundId,
      slot: slotOf[p.teamId] || null,
      player_id: String(p.playerId),
      // mDraftDetail gives ids, not names; the client resolves against its own pool by id → name is
      // filled in where the roster views happened to carry the player.
      name: null,
      keeper: !!p.keeper,
    }));
  // Fill names from any roster entry we already saw — saves the client a second lookup for kept players.
  const nameById = {};
  Object.values(existingRosters).flat().forEach((r) => { if (r.player_id) nameById[r.player_id] = r.name; });
  picks.forEach((p) => { if (!p.name && nameById[p.player_id]) p.name = nameById[p.player_id]; });

  const keepers = picks.filter((p) => p.keeper && p.slot).map((p) => ({ slot: p.slot, player_id: p.player_id, name: p.name, pos: null }));

  return {
    league_id: id,
    name: raw?.settings?.name || mapped.name || `ESPN league ${id}`,
    season: yr,
    private: true,
    cfg: mapped.cfg,
    teams: mapped.teams || (raw?.teams || []).length || null,
    draftType: mapped.draftType || 'snake',
    status: raw?.draftDetail?.drafted ? 'complete' : (picks.length ? 'drafting' : 'pre_draft'),
    yourSlot,
    slotNames,
    tradedPicks: [],           // ESPN exposes traded picks only inside its own draft-room payloads
    keepers,
    existingRosters: Object.keys(existingRosters).length ? existingRosters : null,
    picks,
    /* ⚠ SAID OUT LOUD, IN THE PAYLOAD, so the UI cannot forget to say it: there is no live sync for a
       private ESPN league, because keeping one would mean keeping the cookies. */
    liveSync: false,
    note: 'Imported with cookies that were used once and not stored. To refresh later, paste them again.',
  };
}
