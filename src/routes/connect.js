// Sleeper league connect + live draft sync. All read-only against Sleeper's free public API.
//  GET  /api/connect/sleeper/leagues?username=...   -> that user's NFL leagues for the active season
//  GET  /api/connect/sleeper/draft?league_id=...    -> league's draft config + picks so far (names mapped)
// "Live" sync is the frontend polling the /draft endpoint every few seconds during a draft.
//
//  GET  /api/connect/espn/league?league_id=...     -> settings-only import for a PUBLIC ESPN league.
//       Settings only, by design: ESPN has no live pick feed, so draft night there stays manual entry.
import { Router } from 'express';
import { config } from '../lib/config.js';
import { requireAuth, requirePaid } from '../lib/auth.js';
import { q } from '../lib/db.js';
import {
  getUser, getUserLeagues, getLeague, getLeagueDrafts, getLeagueUsers, getLeagueRosters,
  getDraft, getDraftPicks, getDraftTradedPicks, getAllPlayers, getNflState, getMatchups,
  getWeeklyProjections,
} from '../lib/sleeper.js';
import { getDefVsPos } from '../lib/defVsPos.js';
import { fetchEspnLeague, mapEspnLeague } from '../lib/espn.js';

export const connectRouter = Router();
connectRouter.use(requireAuth);
connectRouter.use(requirePaid); // full app data (Sleeper connect, team hub, draft) requires a pass or comp

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
        best_ball: !!(lg.settings && lg.settings.best_ball === 1),
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
  // Build the FULL scoring map from Sleeper, not just `rec`. Sleeper stores per-stat point values in
  // scoring_settings with keys like pass_td, pass_yd, pass_int, rush_td, rush_yd, rec, rec_yd, rec_td,
  // fum_lost, bonus_rec_te, etc. Our engine's scoreFromStats expects a different vocabulary (passTD, passYd,
  // INT, rushTD, …), so we translate. CRUCIAL: Sleeper's default passing TD is 6 pts (many leagues use 4),
  // and if we don't read it the app scores QBs with our 4-pt default and understates them by ~40-50 pts.
  // Only include a field when Sleeper actually specifies it, so unspecified fields fall to our defaults.
  const num = (k) => (scoring[k] != null && !Number.isNaN(Number(scoring[k])) ? Number(scoring[k]) : undefined);
  const fullScoring = { rec };
  const setIf = (dest, val) => { if (val !== undefined) fullScoring[dest] = val; };
  setIf('passYd', num('pass_yd'));
  setIf('passTD', num('pass_td'));
  setIf('INT', num('pass_int'));
  setIf('pass2pt', num('pass_2pt'));
  setIf('rushYd', num('rush_yd'));
  setIf('rushTD', num('rush_td'));
  setIf('rushAtt', num('rush_att'));
  setIf('rush2pt', num('rush_2pt'));
  setIf('recYd', num('rec_yd'));
  setIf('recTD', num('rec_td'));
  setIf('rec2pt', num('rec_2pt'));
  // TE-premium: Sleeper's rec_te is the TOTAL per-reception for TEs (base + bonus). bonus_rec_te is the
  // extra on top. Our recTE field is the TOTAL, so prefer rec_te; else base rec + bonus.
  const recTeTotal = num('rec_te');
  setIf('recTE', recTeTotal != null ? recTeTotal : (rec + (num('bonus_rec_te') || 0)));
  // fumbles: Sleeper's fum_lost is the common one (lost fumbles); fall back to fum.
  setIf('fum', num('fum_lost') != null ? num('fum_lost') : num('fum'));
  // common yardage bonuses
  setIf('bonus300pass', num('bonus_pass_yd_300'));
  // kicker
  setIf('fg', num('fgm')); setIf('pat', num('xpm')); setIf('fgMiss', num('fgmiss'));
  // DST
  setIf('sack', num('sack')); setIf('dint', num('int')); setIf('dfr', num('fum_rec')); setIf('dtd', num('def_td'));
  // Positional MAXIMUMS: some Sleeper leagues cap how many of a position you can roster. Sleeper stores these
  // (when set) as `position_limit_QB`, `position_limit_RB`, etc. in league.settings. Pass any that exist through
  // as caps so the engine never recommends a player past a position you've maxed out.
  const ls = (league && league.settings) || {};
  const caps = {};
  ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].forEach((pos) => {
    const v = ls['position_limit_' + pos];
    if (v != null && v !== '' && Number(v) > 0) caps[pos === 'DEF' ? 'DST' : pos] = Number(v);
  });
  const start = {
    QB: count('QB') || 1, RB: count('RB') || 2, WR: count('WR') || 2, TE: count('TE') || 1,
    FLEX: count('FLEX') || 1, SUPER: superflex ? 1 : 0, DST: count('DEF') || 0, K: count('K') || 0,
  };
  // Draft TYPE: Sleeper marks a rookie draft with draft.type === 'rookie' (or metadata.scoring_type /
  // the draft's own type field). A rookie draft uses a rookies-only pool, so it must be tagged 'rookie'
  // and NOT mixed with startup dynasty/redraft ADP. Best ball is its own draft profile (ceiling + depth,
  // no in-season management) and takes precedence when the league is flagged best_ball. Otherwise fall back
  // to dynasty (league type 2) or redraft.
  const draftType = ((draft && (draft.type || (draft.metadata && draft.metadata.type))) || '').toLowerCase();
  const isRookie = draftType === 'rookie' || draftType.includes('rookie');
  const isBestBall = !!(league && league.settings && league.settings.best_ball === 1);
  const leagueType = (league && league.settings && league.settings.type === 2) ? 'dynasty' : 'redraft';
  // ⭐ THE LEAGUE'S PLAYOFF WINDOW, captured at import. Playoff-weighted SOS is only a real differentiator
  // if it uses THIS league's playoff weeks — a site that assumes 15-17 for everybody is answering a question
  // the user in a week-14 league did not ask. Sleeper tells us; nothing else has to.
  const pws = Number(ls.playoff_week_start);
  const playoffStartWeek = Number.isFinite(pws) && pws >= 12 && pws <= 18 ? pws : undefined;
  return {
    teams, rounds: (draft && draft.settings && draft.settings.rounds) || 15,
    ...(playoffStartWeek ? { playoffStartWeek } : {}),
    sf: superflex, qbType: superflex ? 'SF' : qb >= 2 ? '2QB' : '1QB',
    scoringType: rec >= 1 ? 'ppr' : rec >= 0.5 ? 'half' : 'std',
    tePrem: tep, tePremMult: Math.round(tePremMult * 100) / 100,
    type: isRookie ? 'rookie' : isBestBall ? 'bestball' : leagueType,
    bestBall: isBestBall,
    scoring: fullScoring,
    start,
    caps: Object.keys(caps).length ? caps : undefined,
  };
}

// ---- In-season team hub (Phase 2 live data) ----
// Everything the post-draft hub needs for ONE linked league, in a single call. We return raw Sleeper
// player_ids (not enriched player objects) so the frontend can join them against the player pack it already
// loads — same projections/VBD the draft board uses, no duplicated assembly here.
//
// ---- REMAINING-SCHEDULE CACHE ---------------------------------------------------------------------
// Sleeper only exposes matchups one week at a time, so building the rest of a season costs one call per
// remaining week. A schedule is fixed for the year, so we do that once per league per season and keep it
// in memory. Without the cache this would be ~10 extra Sleeper calls on EVERY hub open, for every user.
const _schedCache = new Map(); // `${leagueId}:${season}` -> { at, weeks:{ [week]: [[a,b],...] } }
const SCHED_TTL_MS = 6 * 3600 * 1000;

async function getRemainingSchedule(leagueId, season, fromWeek, toWeek) {
  if (!(toWeek >= fromWeek)) return null;
  const key = `${leagueId}:${season}`;
  const hit = _schedCache.get(key);
  const cached = (hit && Date.now() - hit.at < SCHED_TTL_MS) ? hit.weeks : {};
  const need = [];
  for (let w = fromWeek; w <= toWeek; w++) if (!cached[w]) need.push(w);

  if (need.length) {
    const fetched = await Promise.all(need.map((w) =>
      getMatchups(leagueId, w).then((ms) => [w, ms]).catch(() => [w, null])));
    for (const [w, ms] of fetched) {
      if (!Array.isArray(ms) || !ms.length) continue;
      // Group rosters by matchup_id; each id holds exactly the two teams playing that week.
      const byMatch = new Map();
      ms.forEach((m) => {
        if (m == null || m.matchup_id == null || m.roster_id == null) return;
        const arr = byMatch.get(m.matchup_id) || [];
        arr.push(m.roster_id);
        byMatch.set(m.matchup_id, arr);
      });
      const pairs = [];
      byMatch.forEach((ids) => { if (ids.length === 2) pairs.push([ids[0], ids[1]]); });
      if (pairs.length) cached[w] = pairs;
    }
    _schedCache.set(key, { at: Date.now(), weeks: cached });
  }
  // Only hand back the weeks we were asked for, and only if we actually resolved some.
  const out = {};
  for (let w = fromWeek; w <= toWeek; w++) if (cached[w]) out[w] = cached[w];
  return Object.keys(out).length ? out : null;
}

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

    // Determine the week to show: explicit query wins. Otherwise pick the CURRENT/UPCOMING regular-season week.
    // Sleeper's /state/nfl is fiddly around the season boundary: in the preseason `week` can read 1 OR 2 (the
    // preseason leg), while `display_week` is what Sleeper itself shows users. So: if we're not in the regular
    // season yet, always start at regular-season week 1 (the upcoming games). In-season, prefer display_week,
    // fall back to week. Always clamp to a real regular-season week (1..18) so the hub never opens on a phantom
    // "week 2" before week 1 has even happened.
    let week = Number(req.query.week || 0);
    if (!week || Number.isNaN(week)) {
      const seasonType = nfl && nfl.season_type;
      if (seasonType && seasonType !== 'regular' && seasonType !== 'post') {
        week = 1; // preseason / offseason → the upcoming games are regular-season week 1
      } else {
        week = (nfl && (nfl.display_week || nfl.week)) || 1;
      }
    }
    week = Math.min(18, Math.max(1, week));
    const season = (nfl && nfl.season) || String(config.activeSeason);

    // Which scoring field to use as a FALLBACK only (if a player has no raw stats to score).
    const recPts = (league.scoring_settings && Number(league.scoring_settings.rec)) || 0;
    const ptsField = recPts >= 1 ? 'pts_ppr' : recPts >= 0.5 ? 'pts_half_ppr' : 'pts_std';

    // The league's actual scoring rules (pass_td, pass_yd, rec, bonus_rec_te, etc.). Sleeper's pre-summed
    // pts_ppr/pts_std fields assume DEFAULT scoring (6-pt pass TDs, no TE premium), so they're wrong for
    // leagues with custom rules. We instead recompute each player's points from the RAW stat projections
    // times this league's per-stat values — which correctly handles 4-pt pass TDs, TE premium, and anything
    // else the commissioner set. Same stat vocabulary is used by both the projections and the scoring map.
    const scoring = league.scoring_settings || {};
    // Keys that are metadata/points fields in the stats object, not scorable stats — never multiply these.
    const NON_STAT = new Set(['gp', 'gms_active', 'pts_ppr', 'pts_half_ppr', 'pts_std', 'adp_dd_ppr', 'pos_adp_dd_ppr', 'rank_ppr', 'rank_std']);
    const scoreFromSleeper = (stats, position) => {
      if (!stats) return null;
      let pts = 0, matched = 0;
      for (const key in scoring) {
        const perPt = Number(scoring[key]);
        if (!perPt) continue;
        if (key === 'bonus_rec_te') {
          // TE-premium: extra points per reception, TE only.
          if (position === 'TE' && stats.rec != null) { pts += Number(stats.rec) * perPt; matched++; }
          continue;
        }
        if (NON_STAT.has(key)) continue;
        const statVal = stats[key];
        if (statVal != null && !Number.isNaN(Number(statVal))) { pts += Number(statVal) * perPt; matched++; }
      }
      // If we couldn't match ANY scoring stats (unexpected key mismatch), signal null so we fall back.
      return matched > 0 ? Math.round(pts * 100) / 100 : null;
    };

    // Pull THIS WEEK's projections so points are matchup-specific (not season/17). Same Sleeper stats host
    // we already use. Build a per-player map: weekly points (in the league's scoring), opponent, game date,
    // and this week's injury status. Fails soft — if the weekly call is unavailable the hub still renders
    // (the frontend falls back to its season-based estimate).
    let weekly = {};
    try {
      const wp = (await getWeeklyProjections(season, week)) || [];
      for (const row of wp) {
        const pid = row.player_id; if (!pid) continue;
        const st = row.stats || {};
        const position = (row.player && row.player.position) || null;
        // Recompute with the league's real scoring; fall back to Sleeper's pre-summed field only if the
        // raw-stat scoring couldn't run.
        const custom = scoreFromSleeper(st, position);
        const pts = custom != null ? custom : (st[ptsField] != null ? st[ptsField] : (st.pts_ppr != null ? st.pts_ppr : null));
        weekly[pid] = {
          pts: pts != null ? Math.round(pts * 10) / 10 : null,
          ptsPpr: st.pts_ppr != null ? Math.round(st.pts_ppr * 10) / 10 : null,
          ptsHalf: st.pts_half_ppr != null ? Math.round(st.pts_half_ppr * 10) / 10 : null,
          ptsStd: st.pts_std != null ? Math.round(st.pts_std * 10) / 10 : null,
          opp: row.opponent || null,
          team: row.team || (row.player && row.player.team) || null,
          // Home/away if Sleeper provides it on the row (varies by season readiness). We check the common
          // field names; when absent the frontend shows a neutral "vs". Also expose game_id, which Sleeper's
          // schedule encodes, so we can resolve home/away later if needed.
          home: (row.home != null ? !!row.home : (row.is_home != null ? !!row.is_home : (row.game && row.game.home ? row.game.home === (row.team) : null))),
          gameId: row.game_id || null,
          date: row.date || null,
          inj: (row.player && row.player.injury_status) || null,
        };
      }
    } catch { weekly = {}; }

    // Defense-vs-position difficulty — season-to-date ACTUAL points allowed by each defense per position
    // (the method the major sites use), cached in def_vs_pos. Empty early in the season (no completed weeks).
    let matchupDifficulty = {};
    try { matchupDifficulty = (await getDefVsPos(season, week)) || {}; } catch { matchupDifficulty = {}; }

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
      /* ⭐⭐⭐ 29ai / b120 — A ROSTER IS EVERY FIELD SLEEPER PUTS A PLAYER IN, NOT JUST `players`.
         Reported: "the free agents are messed up now (it's showing players that aren't available)… for
         example, Jahmyr Gibbs was showing up as a FA."
         `players` is documented as the full roster and usually is, but `reserve` (IR) and `taxi` are separate
         arrays and a roster mid-move does not always have them mirrored back into it. Anyone this misses is
         not reported as an error downstream — he is offered to the user as the best free agent in football,
         which is the single most damaging thing this endpoint can get wrong. Union all of it, and send the
         two extra arrays on so the client can check them independently rather than having to trust one list.
         ⚠ THIS CAN ONLY REMOVE FALSE FREE AGENTS. A player named in any roster field is rostered, so there is
           no input for which the union is worse than reading `players` alone. */
      const players = Array.isArray(r.players) ? r.players : [];
      const reserve = Array.isArray(r.reserve) ? r.reserve : [];
      const taxi = Array.isArray(r.taxi) ? r.taxi : [];
      players.concat(reserve, taxi).forEach((pid) => { if (pid != null) rostered.add(String(pid)); });
      const m = matchupByRoster.get(r.roster_id);
      const starters = (m && Array.isArray(m.starters)) ? m.starters : (Array.isArray(r.starters) ? r.starters : []);
      (starters || []).forEach((pid) => { if (pid != null && pid !== '0') rostered.add(String(pid)); });
      const s = r.settings || {};
      if (sid && r.owner_id === sid) myRosterId = r.roster_id;
      return {
        rosterId: r.roster_id,
        ownerId: r.owner_id,
        ownerName: owner.ownerName,
        teamName: owner.teamName,
        players: players.map(String),
        reserve: reserve.map(String),
        taxi: taxi.map(String),
        starters: starters.map((x) => (x == null ? null : String(x))),
        weekPoints: m && m.points != null ? Number(m.points) : null,
        matchupId: m ? m.matchup_id : null,
        record: { wins: Number(s.wins || 0), losses: Number(s.losses || 0), ties: Number(s.ties || 0) },
        pointsFor: Number(s.fpts || 0) + Number(s.fpts_decimal || 0) / 100,
        pointsAgainst: Number(s.fpts_against || 0) + Number(s.fpts_against_decimal || 0) / 100,
        // FAAB actually remaining for this team. The hub prices waiver bids as a share of what's LEFT, so
        // without this it can only show a percentage; with it, it shows dollars.
        faabUsed: s.waiver_budget_used != null ? Number(s.waiver_budget_used) : null,
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

    // ---- League SHAPE: playoff structure and FAAB budget -------------------------------------------
    // The hub's playoff odds need to know how many weeks of regular season are left and how many teams
    // make it; the waiver bids need the budget. All of it is on the Sleeper league settings.
    const ls = league.settings || {};
    const playoffStartWeek = Number(ls.playoff_week_start) || 15;
    const regularSeasonWeeks = Math.max(1, playoffStartWeek - 1);
    const playoffTeams = Number(ls.playoff_teams) || null;
    const faabBudget = Number(ls.waiver_budget) > 0 ? Number(ls.waiver_budget) : null;
    const faabLeft = {};
    if (faabBudget != null) {
      teams.forEach((t) => { faabLeft[t.rosterId] = Math.max(0, faabBudget - (t.faabUsed || 0)); });
    }

    // ---- REMAINING SCHEDULE ------------------------------------------------------------------------
    // Playoff odds are only honest if they're simulated against the games each team actually has left.
    // Sleeper exposes matchups one week at a time, so we fetch the rest of the regular season once and
    // cache it — a schedule doesn't change, and this runs on every hub load otherwise.
    let schedule = null;
    try {
      schedule = await getRemainingSchedule(leagueId, season, week, regularSeasonWeeks);
    } catch { schedule = null; }

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
      defaultWeek: week,   // the current/upcoming week the hub should open on
      minWeek: 1,
      maxWeek: 18,
      season,
      scoringField: ptsField,
      seasonType: nfl ? nfl.season_type : null,
      myRosterId,
      linked: !!sid,
      rostered: Array.from(rostered),
      teams,
      matchup,
      standings,
      playoffStartWeek,
      regularSeasonWeeks,
      playoffTeams,
      faabBudget,
      faabLeft,      // { [rosterId]: dollars remaining }
      schedule,      // { [week]: [[rosterIdA, rosterIdB], ...] } for the rest of the regular season
      weekly,        // { [player_id]: { pts, opp, team, date, gameId, inj, ... } } for THIS week
      matchupDifficulty,  // { [defTeam]: { QB/RB/WR/TE: { rank, of, tier, pg } } } season-to-date pts allowed/game
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
  const userIdParam = String(req.query.user_id || '').trim();
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
    const slotOwner = {}; // slot -> Sleeper username (display_name), for showing "(username)" next to team names
    let yourSlot = null, yourUserId = null;
    // resolve the connecting user's id: prefer an explicit user_id (exact + reliable), else match by username
    // against display_name. Matching by display_name alone is fragile (casing, name changes), which left
    // yourSlot null and the app stuck on a stale/default slot; the user_id path fixes that.
    if (userIdParam) {
      const me = (leagueUsers || []).find((u) => String(u.user_id) === userIdParam);
      if (me) yourUserId = me.user_id;
    }
    if (!yourUserId && username) {
      const me = (leagueUsers || []).find((u) => (u.display_name || '').toLowerCase() === username);
      if (me) yourUserId = me.user_id;
    }
    for (let slot = 1; slot <= teamsN; slot++) {
      // prefer explicit draft_order; else fall back to slot_to_roster -> owner
      let uid = Object.keys(draftOrder).find((k) => draftOrder[k] === slot);
      if (!uid) { const rid = slotToRoster[slot]; if (rid != null) uid = rosterOwner[rid]; }
      if (uid && userById[uid]) { slotName[slot] = userById[uid].name; slotOwner[slot] = userById[uid].display_name || null; }
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
      if (uid && userById[uid]) { slotName[slot] = userById[uid].name; slotOwner[slot] = userById[uid].display_name || null; }
    });

    // ----- picks (mapped to names) -----
    // Resolve each pick's ACTUAL drafting team: for a traded pick, the player was selected at `draft_slot` but
    // the pick belonged to whoever `picked_by` is. Map picked_by (user_id) → that user's own slot so the board
    // attributes the player to the team that really made the pick, not the seat it was made from.
    const userIdToSlot = {};
    for (let slot = 1; slot <= teamsN; slot++) {
      let uid = Object.keys(draftOrder).find((k) => draftOrder[k] === slot);
      if (!uid) { const rid = slotToRoster[slot]; if (rid != null) uid = rosterOwner[rid]; }
      if (uid) userIdToSlot[uid] = slot;
    }
    const picks = (picksRaw || [])
      .filter((pk) => pk.player_id && pk.pick_no)
      .sort((a, b) => a.pick_no - b.pick_no)
      .map((pk) => {
        const p = players[pk.player_id] || {};
        const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || (p.position === 'DEF' ? `${pk.player_id} DST` : pk.player_id);
        // picked_by_slot = the slot of the team that ACTUALLY made this selection (via picked_by). For a pick
        // that changed hands, this differs from the physical draft_slot. We DON'T move the player off draft_slot
        // (the board keeps every pick in its true board position, like Sleeper); instead the frontend compares
        // picked_by_slot vs the slot's natural owner to flag a traded pick and name who drafted it.
        const pickedBySlot = (pk.picked_by && userIdToSlot[pk.picked_by]) ? userIdToSlot[pk.picked_by] : null;
        return {
          pick_no: pk.pick_no, round: pk.round, draft_slot: pk.draft_slot,
          // team_slot stays = draft_slot so the player renders in its real board position (no column-jumping).
          team_slot: pk.draft_slot,
          picked_by_slot: pickedBySlot,     // who actually drafted it (slot); differs from draft_slot iff traded
          pickedByName: (pickedBySlot && slotName[pickedBySlot]) ? slotName[pickedBySlot] : null,
          is_keeper: !!(pk.is_keeper || (pk.metadata && (pk.metadata.is_keeper === 'true' || pk.metadata.is_keeper === true))),
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
      slotOwners: slotOwner,    // { slot: sleeperUsername } — shown as "(username)" next to team names
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

// FAST live-sync endpoint. During an active draft the only things that change pick-to-pick are the PICKS and
// the CLOCK — team names, rosters, traded picks, and keepers are stable. The full /draft endpoint refetches
// all of those every poll (6 Sleeper round-trips), which is why live sync lagged ~10-15s behind Sleeper.
// ---- Dynasty draft history --------------------------------------------------------------------
// A dynasty league on Sleeper is a CHAIN of one league per season, linked by previous_league_id, and
// each season-league can carry its own draft (the startup draft in year one, a rookie draft each year
// after). This walks the whole chain and returns every draft, newest first, labeled startup/rookie/vet
// from Sleeper's player_type setting (1 = rookies only, 2 = vets only, else all players).
//   GET /api/connect/sleeper/draft-history?league_id=...
connectRouter.get('/sleeper/draft-history', async (req, res) => {
  const leagueId = String(req.query.league_id || '').trim();
  if (!leagueId) return res.status(400).json({ error: 'league_id required' });
  try {
    const out = [];
    let lid = leagueId;
    for (let hop = 0; hop < 12 && lid; hop++) {   // 12 seasons is plenty; the cap guards a cyclic chain
      const lg = await getLeague(lid).catch(() => null);
      if (!lg) break;
      const drafts = (await getLeagueDrafts(lid).catch(() => [])) || [];
      for (const d of drafts) {
        const pt = d.settings && d.settings.player_type;
        out.push({
          draft_id: d.draft_id,
          league_id: lid,
          season: d.season || lg.season || null,
          status: d.status || null,
          rounds: (d.settings && d.settings.rounds) || null,
          teams: (d.settings && d.settings.teams) || lg.total_rosters || null,
          kind: pt === 1 ? 'rookie' : pt === 2 ? 'vets' : 'all',
          start_time: d.start_time || null,
          current: lid === leagueId,
        });
      }
      lid = lg.previous_league_id || null;
    }
    out.sort((a, b) => String(b.season || '').localeCompare(String(a.season || '')) || ((b.start_time || 0) - (a.start_time || 0)));
    res.json({ drafts: out });
  } catch (e) {
    res.status(502).json({ error: 'Could not load draft history from Sleeper' });
  }
});

// The finished board of ANY Sleeper draft — including prior-season dynasty drafts. Player names come
// straight from each pick's metadata (no player-table join needed), so archived rookie classes render
// correctly no matter how old the draft is.
//   GET /api/connect/sleeper/draft-board?draft_id=...
connectRouter.get('/sleeper/draft-board', async (req, res) => {
  const draftId = String(req.query.draft_id || '').trim();
  if (!draftId) return res.status(400).json({ error: 'draft_id required' });
  try {
    const [draft, picksRaw] = await Promise.all([getDraft(draftId), getDraftPicks(draftId)]);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });
    const leagueUsers = draft.league_id ? await getLeagueUsers(draft.league_id).catch(() => []) : [];
    const nameByUser = {};
    (leagueUsers || []).forEach((u) => { nameByUser[u.user_id] = (u.metadata && u.metadata.team_name) || u.display_name || null; });
    const picks = (picksRaw || []).map((p) => ({
      round: p.round,
      pick_no: p.pick_no,
      slot: p.draft_slot,
      name: p.metadata ? `${p.metadata.first_name || ''} ${p.metadata.last_name || ''}`.trim() : null,
      pos: p.metadata ? p.metadata.position : null,
      team: p.metadata ? p.metadata.team : null,
      by: p.picked_by ? (nameByUser[p.picked_by] || null) : null,
    }));
    const pt = draft.settings && draft.settings.player_type;
    res.json({
      draft_id: draftId,
      season: draft.season || null,
      status: draft.status || null,
      type: draft.type || null,
      rounds: (draft.settings && draft.settings.rounds) || null,
      teams: (draft.settings && draft.settings.teams) || null,
      kind: pt === 1 ? 'rookie' : pt === 2 ? 'vets' : 'all',
      picks,
    });
  } catch (e) {
    res.status(502).json({ error: 'Could not load that draft from Sleeper' });
  }
});

// This endpoint fetches only the draft meta + picks (players list is cached in-process), so it returns in a
// fraction of the time and can be polled aggressively. The client uses /draft once on entry for the heavy
// context, then polls THIS for near-instant pick updates.
//   GET /api/connect/sleeper/picks?league_id=...&draft_id=...(optional)
connectRouter.get('/sleeper/picks', async (req, res) => {
  const leagueId = String(req.query.league_id || '').trim();
  let draftId = String(req.query.draft_id || '').trim();
  if (!leagueId && !draftId) return res.status(400).json({ error: 'league_id or draft_id required' });
  try {
    // Resolve the draft id if the client didn't pass it (first call). Subsequent calls pass draft_id to skip
    // the league→drafts lookup entirely — the fastest possible path.
    if (!draftId) {
      const drafts = (await getLeagueDrafts(leagueId)) || [];
      if (!drafts[0]) return res.json({ status: 'no_draft', picks: [] });
      draftId = drafts[0].draft_id;
    }
    const [draft, picksRaw, players] = await Promise.all([
      getDraft(draftId),
      getDraftPicks(draftId),
      getAllPlayers(), // cached in-process for a day; effectively free
    ]);
    const picks = (picksRaw || [])
      .filter((pk) => pk.player_id && pk.pick_no)
      .sort((a, b) => a.pick_no - b.pick_no)
      .map((pk) => {
        const p = players[pk.player_id] || {};
        const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || (p.position === 'DEF' ? `${pk.player_id} DST` : pk.player_id);
        return { pick_no: pk.pick_no, round: pk.round, draft_slot: pk.draft_slot, player_id: pk.player_id, name, pos: p.position || null, team: p.team || null, picked_by: pk.picked_by || null };
      });
    const pickTimerSec = draft && draft.settings ? Number(draft.settings.pick_timer || 0) : 0;
    const lastPickedMs = draft ? Number(draft.last_picked || draft.start_time || 0) : 0;
    let pickDeadlineMs = null;
    if ((draft?.status === 'drafting') && pickTimerSec > 0 && lastPickedMs > 0) pickDeadlineMs = lastPickedMs + pickTimerSec * 1000;
    res.json({
      draft_id: draftId,
      status: draft?.status || 'unknown',
      picks,
      pickTimerSec, lastPickedMs, pickDeadlineMs, serverNowMs: Date.now(),
    });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach Sleeper. Try again in a moment.' });
  }
});


// ---- ESPN public-league import -------------------------------------------------------------------
// One call, settings only. Everything about why this is public-league-only and what it deliberately
// does not do lives in src/lib/espn.js — read that before changing this.
//   GET /api/connect/espn/league?league_id=123456&season=2026
connectRouter.get('/espn/league', async (req, res) => {
  const leagueId = String(req.query.league_id || '').trim();
  const season = Number(req.query.season || config.activeSeason);
  if (!leagueId) return res.status(400).json({ error: 'league_id required' });
  try {
    const raw = await fetchEspnLeague(leagueId, season);
    const mapped = mapEspnLeague(raw, { season });
    res.json({ league_id: leagueId, ...mapped });
  } catch (e) {
    const status = e && e.status ? e.status : 502;
    // The message on these errors is written for the user, not for a log line — pass it through.
    res.status(status).json({ error: String((e && e.message) || 'ESPN import failed'), code: (e && e.code) || null });
  }
});
