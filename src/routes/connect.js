// Sleeper league connect + live draft sync. All read-only against Sleeper's free public API.
//  GET  /api/connect/sleeper/leagues?username=...   -> that user's NFL leagues for the active season
//  GET  /api/connect/sleeper/draft?league_id=...    -> league's draft config + picks so far (names mapped)
// "Live" sync is the frontend polling the /draft endpoint every few seconds during a draft.
import { Router } from 'express';
import { config } from '../lib/config.js';
import { requireAuth } from '../lib/auth.js';
import { q } from '../lib/db.js';
import {
  getUser, getUserLeagues, getLeague, getLeagueDrafts, getLeagueUsers, getLeagueRosters,
  getDraft, getDraftPicks, getDraftTradedPicks, getAllPlayers, getNflState, getMatchups,
} from '../lib/sleeper.js';

export const connectRouter = Router();
connectRouter.use(requireAuth);

// Lazily make sure the Sleeper-link columns exist, so linking works even if a manual migration
// hasn't been run yet (the user is non-technical; we don't want to require a shell step).
let linkColsEnsured = false;
async function ensureLinkCols() {
  if (linkColsEnsured) return;
  try {
    await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS sleeper_user_id TEXT;');
    await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS sleeper_username TEXT;');
  } catch (e) { /* if this fails we surface a clear error at call time */ }
  linkColsEnsured = true;
}

// ---- Persistent Sleeper account link ----
// The link is stored on the user row and stays until the user unlinks (or links a different account).
// GET  /api/connect/sleeper/account            -> { linked, sleeperUserId, sleeperUsername }
// POST /api/connect/sleeper/link { username }   -> resolves the username to a Sleeper id and stores it
// POST /api/connect/sleeper/unlink              -> clears the stored link

connectRouter.get('/sleeper/account', async (req, res) => {
  try {
    await ensureLinkCols();
    const { rows } = await q('SELECT sleeper_user_id, sleeper_username FROM users WHERE id=$1', [req.user.id]);
    const r = rows[0] || {};
    res.json({ linked: !!r.sleeper_user_id, sleeperUserId: r.sleeper_user_id || null, sleeperUsername: r.sleeper_username || null });
  } catch (e) {
    res.status(500).json({ error: 'Could not read Sleeper link' });
  }
});

connectRouter.post('/sleeper/link', async (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  if (!username) return res.status(400).json({ error: 'Sleeper username required' });
  try {
    await ensureLinkCols();
    const user = await getUser(username);
    if (!user || !user.user_id) return res.status(404).json({ error: 'No Sleeper user with that username' });
    await q('UPDATE users SET sleeper_user_id=$1, sleeper_username=$2 WHERE id=$3', [user.user_id, user.username || username, req.user.id]);
    res.json({ linked: true, sleeperUserId: user.user_id, sleeperUsername: user.username || username });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach Sleeper. Try again in a moment.' });
  }
});

connectRouter.post('/sleeper/unlink', async (req, res) => {
  try {
    await ensureLinkCols();
    await q('UPDATE users SET sleeper_user_id=NULL, sleeper_username=NULL WHERE id=$1', [req.user.id]);
    res.json({ linked: false });
  } catch (e) {
    res.status(500).json({ error: 'Could not unlink' });
  }
});

// A linked user's leagues, pulled from the STORED account (no username needed at call time).
connectRouter.get('/sleeper/my-leagues', async (req, res) => {
  try {
    await ensureLinkCols();
    const { rows } = await q('SELECT sleeper_user_id FROM users WHERE id=$1', [req.user.id]);
    const sid = rows[0] && rows[0].sleeper_user_id;
    if (!sid) return res.status(400).json({ error: 'No Sleeper account linked' });
    const season = Number(req.query.season || config.activeSeason);
    const leagues = (await getUserLeagues(sid, season)) || [];
    // Enrich each league with its draft state (pre-draft / drafting + round / complete) so the UI can show
    // where each team stands. We look up the league's draft; for an in-progress draft we derive the round
    // from the number of picks made so far and the team count.
    const out = [];
    for (const lg of leagues) {
      let draftId = lg.draft_id || null, draftStatus = null, round = null, totalRounds = null, madePicks = null;
      try {
        const drafts = (await getLeagueDrafts(lg.league_id)) || [];
        const d = drafts[0];
        if (d) {
          draftId = d.draft_id;
          draftStatus = d.status || null; // 'pre_draft' | 'drafting' | 'paused' | 'complete'
          totalRounds = (d.settings && d.settings.rounds) || null;
          const teams = (d.settings && d.settings.teams) || lg.total_rosters || 12;
          if (draftStatus === 'drafting' || draftStatus === 'paused') {
            try {
              const picks = (await getDraftPicks(d.draft_id)) || [];
              madePicks = picks.length;
              round = Math.floor(picks.length / teams) + 1;
            } catch { /* ignore */ }
          }
        }
      } catch { /* ignore — league still listed, just without draft detail */ }
      out.push({
        league_id: lg.league_id, name: lg.name, total_rosters: lg.total_rosters,
        season: lg.season, draft_id: draftId, draft_status: draftStatus,
        round, total_rounds: totalRounds, made_picks: madePicks,
      });
    }
    res.json({ sleeperUserId: sid, leagues: out });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach Sleeper. Try again in a moment.' });
  }
});


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

// ---- In-season team hub (Phase 2 live data) ----
// Everything the post-draft hub needs for ONE linked league, in a single call. We return raw Sleeper
// player_ids (not enriched player objects) so the frontend can join them against the player pack it already
// loads — same projections/VBD the draft board uses, no duplicated assembly here.
//
// GET /api/connect/sleeper/team-hub?league_id=...[&week=N]
//   -> { league:{cfg,name}, week, myRosterId, rostered:[ids], teams:[{rosterId,ownerName,teamName,players,
//        starters,record,pointsFor,pointsAgainst}], matchup:{me,opp}|null, standings:[...] }
connectRouter.get('/sleeper/team-hub', async (req, res) => {
  const leagueId = String(req.query.league_id || '').trim();
  if (!leagueId) return res.status(400).json({ error: 'league_id required' });
  try {
    await ensureLinkCols();
    const { rows } = await q('SELECT sleeper_user_id FROM users WHERE id=$1', [req.user.id]);
    const sid = rows[0] && rows[0].sleeper_user_id;

    // Pull league, its users (owners), rosters, and NFL state in parallel.
    const [league, users, rosters, nfl] = await Promise.all([
      getLeague(leagueId),
      getLeagueUsers(leagueId),
      getLeagueRosters(leagueId),
      getNflState().catch(() => null),
    ]);
    if (!league) return res.status(404).json({ error: 'League not found on Sleeper' });

    // Determine the week to show: explicit query, else the current NFL week (min 1).
    let week = Number(req.query.week || 0);
    if (!week || Number.isNaN(week)) week = (nfl && (nfl.week || nfl.display_week)) || 1;
    week = Math.max(1, week);

    // Owner lookup: Sleeper user_id -> display info. Prefer a custom team_name over the display_name.
    const ownerById = new Map();
    (users || []).forEach((u) => {
      const teamName = (u.metadata && u.metadata.team_name) ? u.metadata.team_name : null;
      ownerById.set(u.user_id, { ownerName: u.display_name || 'Unknown', teamName: teamName || u.display_name || 'Team' });
    });

    // Matchups for the week (each roster's starters + points). May be empty pre-season.
    let matchupByRoster = new Map();
    try {
      const ms = (await getMatchups(leagueId, week)) || [];
      ms.forEach((m) => matchupByRoster.set(m.roster_id, m));
    } catch { /* no matchups yet */ }

    // Assemble per-team roster info + records. Track all rostered player ids for free-agent computation.
    const rostered = new Set();
    let myRosterId = null;
    const teams = (rosters || []).map((r) => {
      const owner = ownerById.get(r.owner_id) || { ownerName: 'Unknown', teamName: 'Team' };
      const players = Array.isArray(r.players) ? r.players : [];
      players.forEach((pid) => rostered.add(String(pid)));
      const m = matchupByRoster.get(r.roster_id);
      const starters = (m && Array.isArray(m.starters)) ? m.starters : (Array.isArray(r.starters) ? r.starters : []);
      const s = r.settings || {};
      if (sid && r.owner_id === sid) myRosterId = r.roster_id;
      return {
        rosterId: r.roster_id,
        ownerId: r.owner_id,
        ownerName: owner.ownerName,
        teamName: owner.teamName,
        players: players.map(String),
        starters: starters.map((x) => (x == null ? null : String(x))),
        weekPoints: m && m.points != null ? Number(m.points) : null,
        matchupId: m ? m.matchup_id : null,
        record: { wins: Number(s.wins || 0), losses: Number(s.losses || 0), ties: Number(s.ties || 0) },
        pointsFor: Number(s.fpts || 0) + Number(s.fpts_decimal || 0) / 100,
        pointsAgainst: Number(s.fpts_against || 0) + Number(s.fpts_against_decimal || 0) / 100,
      };
    });

    // My matchup this week: find my team, then the opponent sharing my matchup_id.
    let matchup = null;
    if (myRosterId != null) {
      const me = teams.find((t) => t.rosterId === myRosterId);
      if (me && me.matchupId != null) {
        const opp = teams.find((t) => t.rosterId !== myRosterId && t.matchupId === me.matchupId);
        matchup = { me, opp: opp || null };
      } else if (me) {
        matchup = { me, opp: null };
      }
    }

    // Standings: sort by wins, then points-for.
    const standings = teams.slice().sort((a, b) =>
      (b.record.wins - a.record.wins) || (b.pointsFor - a.pointsFor)
    ).map((t, i) => ({
      rank: i + 1, rosterId: t.rosterId, teamName: t.teamName, ownerName: t.ownerName,
      record: t.record, pointsFor: Math.round(t.pointsFor * 10) / 10, pointsAgainst: Math.round(t.pointsAgainst * 10) / 10,
      isMe: t.rosterId === myRosterId,
    }));

    // Best-effort cfg from the league so the hub knows starting requirements/scoring.
    let cfg = null;
    try {
      const drafts = (await getLeagueDrafts(leagueId)) || [];
      const d = drafts[0] ? await getDraft(drafts[0].draft_id).catch(() => null) : null;
      cfg = cfgFromLeague(league, d);
    } catch { cfg = cfgFromLeague(league, null); }

    res.json({
      leagueName: league.name,
      cfg,
      week,
      seasonType: nfl ? nfl.season_type : null,
      myRosterId,
      linked: !!sid,
      rostered: Array.from(rostered),
      teams,
      matchup,
      standings,
    });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach Sleeper. Try again in a moment.' });
  }
});

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
