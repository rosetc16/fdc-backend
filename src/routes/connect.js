// Sleeper league connect + live draft sync. All read-only against Sleeper's free public API.
//  GET  /api/connect/sleeper/leagues?username=...   -> that user's NFL leagues for the active season
//  GET  /api/connect/sleeper/draft?league_id=...    -> league's draft config + picks so far (names mapped)
// "Live" sync is the frontend polling the /draft endpoint every few seconds during a draft.
import { Router } from 'express';
import { config } from '../lib/config.js';
import { requireAuth } from '../lib/auth.js';
import {
  getUser, getUserLeagues, getLeague, getLeagueDrafts, getLeagueUsers, getLeagueRosters,
  getDraft, getDraftPicks, getDraftTradedPicks, getAllPlayers,
} from '../lib/sleeper.js';

export const connectRouter = Router();
connectRouter.use(requireAuth);

// Map a Sleeper draft's scoring/roster settings to our league cfg shape (best-effort; user can edit).
function cfgFromLeague(league, draft) {
  const rp = (league && league.roster_positions) || (draft && draft.settings && []) || [];
  const count = (pos) => rp.filter((p) => p === pos).length;
  const teams = (league && league.total_rosters) || (draft && draft.settings && draft.settings.teams) || 12;
  const superflex = count('SUPER_FLEX') > 0;
  const qb = count('QB') + (superflex ? 1 : 0);
  const scoring = (league && league.scoring_settings) || {};
  const rec = scoring.rec || 0; // 1 = PPR, 0.5 = half, 0 = standard
  // TE premium: Sleeper stores the EXTRA points-per-reception for TEs in `bonus_rec_te` (e.g. 0.5
  // for a half-point premium, 1.0 for full). Capture the real amount, not just a boolean, so elite
  // TEs are lifted by the correct magnitude. Fall back to a sensible default if only a flag exists.
  const teBonus = Number(scoring.bonus_rec_te || 0);
  const tePremMult = teBonus > 0 ? teBonus : (scoring.rec_te && scoring.rec_te > rec ? Number(scoring.rec_te) - rec : 0);
  const tep = tePremMult > 0;
  const start = {
    QB: count('QB') || 1, RB: count('RB') || 2, WR: count('WR') || 2, TE: count('TE') || 1,
    FLEX: count('FLEX') || 1, SUPER: superflex ? 1 : 0, DST: count('DEF') || 0, K: count('K') || 0,
  };
  return {
    teams, rounds: (draft && draft.settings && draft.settings.rounds) || 15,
    sf: superflex, qbType: superflex ? 'SF' : qb >= 2 ? '2QB' : '1QB',
    scoringType: rec >= 1 ? 'ppr' : rec >= 0.5 ? 'half' : 'std',
    tePrem: tep, tePremMult: Math.round(tePremMult * 100) / 100,
    type: (league && league.settings && league.settings.type === 2) ? 'dynasty' : 'redraft',
    start,
  };
}

// 1) A user's leagues (so they can pick which one to connect)
connectRouter.get('/sleeper/leagues', async (req, res) => {
  const username = String(req.query.username || '').trim();
  if (!username) return res.status(400).json({ error: 'username required' });
  const season = Number(req.query.season || config.activeSeason);
  try {
    const user = await getUser(username);
    if (!user || !user.user_id) return res.status(404).json({ error: 'No Sleeper user with that username' });
    const leagues = (await getUserLeagues(user.user_id, season)) || [];
    // For each league, see if it has a draft and what status it's in (so we can highlight the live one).
    const out = [];
    for (const lg of leagues) {
      let draftStatus = null, draftId = lg.draft_id || null;
      try {
        const drafts = (await getLeagueDrafts(lg.league_id)) || [];
        if (drafts[0]) { draftId = drafts[0].draft_id; draftStatus = drafts[0].status; }
      } catch { /* ignore */ }
      out.push({
        league_id: lg.league_id, name: lg.name, total_rosters: lg.total_rosters,
        season: lg.season, draft_id: draftId, draft_status: draftStatus,
      });
    }
    res.json({ user_id: user.user_id, username: user.username, leagues: out });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach Sleeper. Try again in a moment.' });
  }
});

// 2) A league's draft config + picks so far (names mapped). Polled during the draft for live sync.
connectRouter.get('/sleeper/draft', async (req, res) => {
  const leagueId = String(req.query.league_id || '').trim();
  if (!leagueId) return res.status(400).json({ error: 'league_id required' });
  const username = String(req.query.username || '').trim().toLowerCase();
  try {
    const league = await getLeague(leagueId);
    if (!league) return res.status(404).json({ error: 'League not found' });
    const drafts = (await getLeagueDrafts(leagueId)) || [];
    const draftMeta = drafts[0];
    if (!draftMeta) return res.json({ league_id: leagueId, name: league.name, status: 'no_draft', picks: [], cfg: cfgFromLeague(league, null) });

    const [draft, picksRaw, leagueUsers, rosters, tradedRaw, players] = await Promise.all([
      getDraft(draftMeta.draft_id),
      getDraftPicks(draftMeta.draft_id),
      getLeagueUsers(leagueId).catch(() => []),
      getLeagueRosters(leagueId).catch(() => []),
      getDraftTradedPicks(draftMeta.draft_id).catch(() => []),
      getAllPlayers(),
    ]);

    const teamsN = (league && league.total_rosters) || (draft && draft.settings && draft.settings.teams) || 12;

    // ----- team identities -----
    // user_id -> display info (team name preferred, else display_name)
    const userById = {};
    (leagueUsers || []).forEach((u) => {
      const tn = (u.metadata && (u.metadata.team_name || u.metadata.team_name_update)) || null;
      userById[u.user_id] = { name: tn || u.display_name || 'Team', display_name: u.display_name || null, user_id: u.user_id };
    });
    // roster_id -> owner user_id (for mapping picks/rosters to a team)
    const rosterOwner = {}; const rosterPlayers = {};
    (rosters || []).forEach((r) => { rosterOwner[r.roster_id] = r.owner_id; rosterPlayers[r.roster_id] = r.players || []; });

    // ----- slot ↔ team mapping -----
    // draft.draft_order: { user_id: slot } ; draft.slot_to_roster_id: { slot: roster_id }
    const draftOrder = (draft && draft.draft_order) || {};        // user_id -> slot (1-based)
    const slotToRoster = (draft && draft.slot_to_roster_id) || {}; // slot -> roster_id
    // Build slot (1-based) -> team name, and figure out which slot is the connecting user.
    const slotName = {}; // slot -> name
    let yourSlot = null, yourUserId = null;
    // resolve the connecting user's id from username (via leagueUsers display_name match)
    if (username) {
      const me = (leagueUsers || []).find((u) => (u.display_name || '').toLowerCase() === username);
      if (me) yourUserId = me.user_id;
    }
    for (let slot = 1; slot <= teamsN; slot++) {
      // prefer explicit draft_order; else fall back to slot_to_roster -> owner
      let uid = Object.keys(draftOrder).find((k) => draftOrder[k] === slot);
      if (!uid) { const rid = slotToRoster[slot]; if (rid != null) uid = rosterOwner[rid]; }
      if (uid && userById[uid]) slotName[slot] = userById[uid].name;
      if (uid && yourUserId && uid === yourUserId) yourSlot = slot;
    }
    // last resort: match your slot via draft_order directly
    if (yourSlot == null && yourUserId && draftOrder[yourUserId]) yourSlot = draftOrder[yourUserId];
    // Robust fallback: fill any still-unnamed slots from the ACTUAL picks. Each Sleeper pick carries
    // `picked_by` (the real user_id) and its `draft_slot`, so even when draft_order/slot_to_roster are
    // incomplete (common in pre-draft or oddly-configured leagues), the picks themselves reveal who owns
    // each slot. This is what makes real manager/team names show up reliably.
    (picksRaw || []).forEach((pk) => {
      const slot = pk.draft_slot;
      if (!slot || slotName[slot]) return;
      const uid = pk.picked_by;
      if (uid && userById[uid]) slotName[slot] = userById[uid].name;
    });

    // ----- picks (mapped to names) -----
    const picks = (picksRaw || [])
      .filter((pk) => pk.player_id && pk.pick_no)
      .sort((a, b) => a.pick_no - b.pick_no)
      .map((pk) => {
        const p = players[pk.player_id] || {};
        const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || (p.position === 'DEF' ? `${pk.player_id} DST` : pk.player_id);
        return {
          pick_no: pk.pick_no, round: pk.round, draft_slot: pk.draft_slot,
          player_id: pk.player_id, name, pos: p.position || null, team: p.team || null,
          picked_by: pk.picked_by || null,
        };
      });

    // ----- traded draft picks (so the board knows who really owns each slot's pick) -----
    // Sleeper traded_picks: { season, round, roster_id (original), owner_id (current), previous_owner_id }
    const tradedPicks = (tradedRaw || []).map((t) => ({
      round: t.round,
      fromRoster: t.roster_id, toRoster: t.owner_id,
      fromSlot: rosterToSlot(slotToRoster, t.roster_id),
      toSlot: rosterToSlot(slotToRoster, t.owner_id),
    })).filter((t) => t.fromSlot && t.toSlot);

    // ----- keepers ----- Sleeper stores kept players on each roster's `keepers` array (player_ids).
    // Map each to the owning team's slot + player name so the board can pre-place them.
    const keepers = [];
    (rosters || []).forEach((r) => {
      const slot = rosterToSlot(slotToRoster, r.roster_id);
      if (slot == null) return;
      (r.keepers || []).forEach((pid) => {
        const p = players[pid] || {};
        const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || (p.position === 'DEF' ? `${pid} DST` : pid);
        keepers.push({ slot, player_id: pid, name, pos: p.position || null });
      });
    });

    // ----- existing rosters ----- For rookie/keeper/dynasty drafts, each team already has a roster.
    // Those holdings drive prediction (a team with two elite QBs won't draft a rookie QB). Map each
    // team's current players to its slot, with name + position, so the engine can factor them in.
    const existingRosters = {}; // slot -> [{ player_id, name, pos }]
    (rosters || []).forEach((r) => {
      const slot = rosterToSlot(slotToRoster, r.roster_id);
      if (slot == null) return;
      const list = [];
      (r.players || []).forEach((pid) => {
        const p = players[pid] || {};
        const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || (p.position === 'DEF' ? `${pid} DST` : pid);
        if (p.position) list.push({ player_id: pid, name, pos: p.position });
      });
      existingRosters[slot] = list;
    });

    const reversalRound = draft && draft.settings && Number(draft.settings.reversal_round || 0);
    let resolvedType = (draft && draft.type) === 'linear' ? 'linear' : 'snake';
    if (reversalRound && reversalRound >= 1) resolvedType = '3rr';

    // ---- Live clock ----------------------------------------------------------------------------
    // Sleeper drives the draft clock from: settings.pick_timer (seconds allowed per pick) and the
    // timestamp the LAST pick was made (draft.last_picked, epoch ms). The current pick's deadline is
    // last_picked + pick_timer. We pass both the raw inputs and a computed server-side deadline so the
    // app can show a clock that matches Sleeper exactly (and survives refreshes) instead of resetting.
    const pickTimerSec = draft && draft.settings ? Number(draft.settings.pick_timer || 0) : 0;
    const lastPickedMs = draft ? Number(draft.last_picked || draft.start_time || 0) : 0;
    const nowMs = Date.now();
    // If the draft is actively "drafting" and there's a timer, compute the current pick's deadline.
    let pickDeadlineMs = null;
    if ((draft?.status === 'drafting') && pickTimerSec > 0 && lastPickedMs > 0) {
      pickDeadlineMs = lastPickedMs + pickTimerSec * 1000;
    }

    res.json({
      league_id: leagueId, name: league.name, draft_id: draftMeta.draft_id,
      status: draft?.status || draftMeta.status || 'unknown', // pre_draft | drafting | complete | paused
      teams: teamsN,
      cfg: cfgFromLeague(league, draft),
      draftType: resolvedType,   // snake | linear | 3rr
      reversalRound: reversalRound || null,
      yourSlot,                 // 1-based slot of the connecting user (null if not resolved)
      slotNames: slotName,      // { slot: teamName } for all teams
      tradedPicks,              // resolved to slots
      keepers,                  // [{ slot, player_id, name, pos }]
      existingRosters,          // { slot: [{ player_id, name, pos }] } — current holdings (rookie/dynasty)
      picks,
      // live clock fields (all epoch ms / seconds); server_now lets the client correct for clock skew
      pickTimerSec,             // seconds allowed per pick (0 = untimed / slow draft)
      lastPickedMs,             // when the last pick was made
      pickDeadlineMs,           // computed deadline for the CURRENT pick (null if untimed/not drafting)
      serverNowMs: nowMs,       // server's current time, so the client can align its countdown
    });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach Sleeper. Try again in a moment.' });
  }
});

function rosterToSlot(slotToRoster, rosterId) {
  const slot = Object.keys(slotToRoster).find((s) => slotToRoster[s] === rosterId);
  return slot ? Number(slot) : null;
}
