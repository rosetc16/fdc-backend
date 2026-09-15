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
  getWeeklyProjections, getWeeklyStats, getTrendingAdds,
} from '../lib/sleeper.js';
import { trendFor, auditFields } from '../lib/trending.js';
import { defaultWeek } from '../lib/weekpick.js';
import { getDefVsPos } from '../lib/defVsPos.js';
import { byeTeamsForWeek } from '../lib/nflSchedule.js';
import { lineupMisses, verdictFor, seasonLedger, pointRanks, playedGate, weekCompleteness } from '../lib/review.js';
import { rootingBoard, dayTotals, sideOf, gameState, weekStateFrom } from '../lib/rooting.js';
import { matchupForecast, projectedRecord, projectSide, normalCdf } from '../lib/winprob.js';
import { scoreStatsFor } from '../lib/scoring.js';
import { cached, picksKey, metaKey, draftsKey, TTL } from '../lib/draftCache.js';
import { fetchEspnLeague, mapEspnLeague } from '../lib/espn.js';
import { importEspnPrivate } from '../lib/espnPrivate.js';
import { mflLeague, mflPicks } from '../lib/mfl.js';
import { fantraxLeagues, fantraxLeague, fantraxPicks } from '../lib/fantrax.js';
import { yahooConfigured, yahooAuthUrl, yahooExchange, yahooRefresh, yahooMyLeagues, yahooLeague } from '../lib/yahoo.js';

export const connectRouter = Router();
connectRouter.use(requireAuth);
connectRouter.use(requirePaid); // full app data (Sleeper connect, team hub, draft) requires a pass or comp

/* ⭐⭐⭐⭐ ONE PERSON, SEVERAL FANTASY ACCOUNTS — b132.
   ------------------------------------------------------------------------------------------------
   Trey: "Can you make it so I can connect to multiple sleeper (or other platform) usernames at once.
   Right now on the check my week it's not picking up on the league that I was connected to earlier but
   not anymore."

   The link used to be TWO COLUMNS ON THE USER ROW, which made "link" mean REPLACE. That is not a
   cosmetic limit, and the second sentence above is exactly what it costs: every league imported under
   the old account keeps working as a draft board (the board needs no identity) but goes DARK the moment
   a screen has to answer "which of these twelve teams is yours" — because `myRosterId` was resolved by
   comparing each roster's owner against the ONE stored id. No match, no roster, and My Week drops the
   league silently while the home page shows it with no badge. A league you can see but that cannot see
   you is worse than one that failed loudly.

   So the link becomes a LIST, in its own table, keyed by platform so Yahoo/MFL/Fantrax can move in
   without another migration. Three rules keep the change from breaking anything already shipped:
     • `users.sleeper_user_id` STAYS, as the PRIMARY account. Half a dozen jobs read it (weeklyBrief,
       harvestSleeperDrafts, the auth payload) and none of them need to care that there are now others.
       It always points at one of the rows in the table, or nothing.
     • Linking is ADDITIVE. Nothing that used to work stops working when a second account arrives.
     • The table is backfilled from the columns on first touch, so an existing user's link survives the
       deploy without a migration step. (Trey is not going to run a shell command.)
   ------------------------------------------------------------------------------------------------ */
let linkColsEnsured = false;
async function ensureLinkCols() {
  if (linkColsEnsured) return;
  try {
    await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS sleeper_user_id TEXT;');
    await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS sleeper_username TEXT;');
    await q(`CREATE TABLE IF NOT EXISTS linked_accounts (
      user_id     INTEGER NOT NULL,
      platform    TEXT NOT NULL,
      account_id  TEXT NOT NULL,
      username    TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, platform, account_id)
    );`);
    await q('CREATE INDEX IF NOT EXISTS linked_accounts_user_idx ON linked_accounts (user_id, platform);');
    /* Backfill, once, from the old single-value columns. ON CONFLICT DO NOTHING makes this idempotent, so
       it is safe to leave in the ensure path rather than gating it behind a one-shot flag we would then
       have to store somewhere. */
    await q(`INSERT INTO linked_accounts (user_id, platform, account_id, username)
             SELECT id, 'sleeper', sleeper_user_id, sleeper_username FROM users
              WHERE sleeper_user_id IS NOT NULL AND sleeper_user_id <> ''
             ON CONFLICT DO NOTHING;`);
  } catch (e) { /* if this fails we surface a clear error at call time */ }
  linkColsEnsured = true;
}

async function accountsFor(userId, platform = 'sleeper') {
  const { rows } = await q(
    'SELECT platform, account_id, username FROM linked_accounts WHERE user_id=$1 AND platform=$2 ORDER BY created_at ASC',
    [userId, platform]
  );
  return rows.map((r) => ({ platform: r.platform, id: r.account_id, username: r.username || null }));
}

/* The primary is what the single-value columns hold, and it must always be one of the linked rows. Called
   after every add and remove so the columns can never point at an account the user no longer has. */
async function syncPrimary(userId) {
  const list = await accountsFor(userId, 'sleeper');
  const { rows } = await q('SELECT sleeper_user_id FROM users WHERE id=$1', [userId]);
  const cur = rows[0] && rows[0].sleeper_user_id;
  if (cur && list.some((a) => a.id === cur)) return list;
  const next = list[0] || null;
  await q('UPDATE users SET sleeper_user_id=$1, sleeper_username=$2 WHERE id=$3',
    [next ? next.id : null, next ? next.username : null, userId]);
  return list;
}

const accountPayload = (list) => ({
  linked: list.length > 0,
  accounts: list,
  // Back-compat: every caller shipped before b132 reads these two and only these two.
  sleeperUserId: list[0] ? list[0].id : null,
  sleeperUsername: list[0] ? list[0].username : null,
});

// ---- Persistent Sleeper account links ----
// GET  /api/connect/sleeper/account                      -> { linked, accounts:[{platform,id,username}], sleeperUserId, sleeperUsername }
// POST /api/connect/sleeper/link { username }             -> ADDS an account (does not replace the others)
// POST /api/connect/sleeper/unlink { sleeperUserId? }     -> removes one; with no id, removes them all

connectRouter.get('/sleeper/account', async (req, res) => {
  try {
    await ensureLinkCols();
    res.json(accountPayload(await syncPrimary(req.user.id)));
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
    await q(`INSERT INTO linked_accounts (user_id, platform, account_id, username) VALUES ($1,'sleeper',$2,$3)
             ON CONFLICT (user_id, platform, account_id) DO UPDATE SET username=EXCLUDED.username`,
      [req.user.id, user.user_id, user.username || username]);
    const list = await syncPrimary(req.user.id);
    res.json({ ...accountPayload(list), added: { platform: 'sleeper', id: user.user_id, username: user.username || username } });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach Sleeper. Try again in a moment.' });
  }
});

connectRouter.post('/sleeper/unlink', async (req, res) => {
  const one = String((req.body && (req.body.sleeperUserId || req.body.accountId)) || '').trim();
  try {
    await ensureLinkCols();
    /* No id = the old all-or-nothing "Unlink" button, which must keep meaning what it always meant.
       An id = "remove just this one", which is the only sane behaviour once there can be several. */
    if (one) await q('DELETE FROM linked_accounts WHERE user_id=$1 AND platform=$2 AND account_id=$3', [req.user.id, 'sleeper', one]);
    else await q('DELETE FROM linked_accounts WHERE user_id=$1 AND platform=$2', [req.user.id, 'sleeper']);
    res.json(accountPayload(await syncPrimary(req.user.id)));
  } catch (e) {
    res.status(500).json({ error: 'Could not unlink' });
  }
});

// A linked user's leagues, across EVERY linked account.
connectRouter.get('/sleeper/my-leagues', async (req, res) => {
  try {
    await ensureLinkCols();
    const accounts = await syncPrimary(req.user.id);
    if (!accounts.length) return res.status(400).json({ error: 'No Sleeper account linked' });
    const sid = accounts[0].id;
    const season = Number(req.query.season || config.activeSeason);
    /* ⭐⭐⭐ ONE LIST, TAGGED BY WHO OWNS EACH ENTRY. Two accounts in the same league (it happens — a
       work league you also commish under a second handle) would otherwise appear twice, so the first
       account to claim a league_id keeps it and later ones are dropped. The tag rides on the league so
       the importer can store WHICH account this team belongs to, which is what stops the whole problem
       from coming back the next time an account is removed. */
    const seenLeague = new Set();
    const leagues = [];
    for (const acct of accounts) {
      let mine = [];
      try { mine = (await getUserLeagues(acct.id, season)) || []; } catch { mine = []; }
      for (const lg of mine) {
        if (!lg || !lg.league_id || seenLeague.has(lg.league_id)) continue;
        seenLeague.add(lg.league_id);
        leagues.push({ ...lg, _ownerId: acct.id, _ownerUsername: acct.username });
      }
    }
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
        // Which linked account this team belongs to. The importer stores it on the league so the hub can
        // find your roster later even if this account is no longer the primary one.
        owner_id: lg._ownerId || null,
        owner_username: lg._ownerUsername || null,
      });
    }
    res.json({ sleeperUserId: sid, accounts, leagues: out });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach Sleeper. Try again in a moment.' });
  }
});


// Map a Sleeper draft's scoring/roster settings to our league cfg shape (best-effort; user can edit).
// Exported for the pack-mapping test, so the distance-scoring conversion is checked against the SAME code
// the import runs rather than a copy of it that can drift.
export const mapSleeperScoringForDiag = (scoring) => cfgFromLeague({ scoring_settings: scoring, roster_positions: [] }, null).scoring;
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
  // ⚠⚠ SLEEPER'S DISTANCE KEYS ARE ABSOLUTE VALUES, THE ENGINE'S ARE BONUSES. Sleeper publishes
  //   `fgm_0_19 … fgm_50p` as what a made field goal of that length is WORTH (default 3/3/3/4/5); the
  //   engine models a base plus a bonus for the long ones. Importing 4 straight into `fg40` would score a
  //   45-yarder as 3 + 4 = 7. Convert: base = the short bucket (or the flat `fgm`, or 3), bonuses = the
  //   long buckets MINUS that base. A league with no distance settings just keeps the flat value.
  const fgBase = num('fgm_0_19') != null ? num('fgm_0_19') : (num('fgm') != null ? num('fgm') : null);
  setIf('fg', fgBase);
  const base = fgBase != null ? fgBase : 3;
  if (num('fgm_40_49') != null) setIf('fg40', Math.max(0, num('fgm_40_49') - base));
  if (num('fgm_50p') != null) setIf('fg50', Math.max(0, num('fgm_50p') - base));
  setIf('pat', num('xpm')); setIf('fgMiss', num('fgmiss'));
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

// GET /api/connect/sleeper/team-hub?league_id=...[&week=N][&owner=username]
//   -> { league:{cfg,name}, week, myRosterId, rostered:[ids], teams:[{rosterId,ownerName,teamName,players,
//        starters,record,pointsFor,pointsAgainst}], matchup:{me,opp}|null, standings:[...] }
connectRouter.get('/sleeper/team-hub', async (req, res) => {
  const leagueId = String(req.query.league_id || '').trim();
  if (!leagueId) return res.status(400).json({ error: 'league_id required' });
  try {
    await ensureLinkCols();
    /* ⭐⭐⭐⭐ WHICH OF THESE TWELVE TEAMS IS YOURS — the question that used to have exactly one answer.
       Now every linked account is a candidate, and on top of that the client may pass `owner`: the Sleeper
       username the league was IMPORTED under, which the league record has been carrying all along.
       That hint is what rescues a league whose account has since been removed — the case Trey hit — and it
       costs nothing to trust, because it grants no access: this whole route is public Sleeper data behind
       an auth check, and `owner` only decides which of the rosters we have ALREADY fetched gets pointed at.
       A wrong or hostile value can highlight a different team in a league the caller can already read in
       full. (It is also why it is safe in a query string, unlike the MFL/Fantrax secrets, which are not.) */
    const mineIds = new Set((await accountsFor(req.user.id, 'sleeper')).map((a) => a.id));
    const { rows } = await q('SELECT sleeper_user_id FROM users WHERE id=$1', [req.user.id]);
    const sid = rows[0] && rows[0].sleeper_user_id;
    if (sid) mineIds.add(sid);
    const ownerHint = String(req.query.owner || '').trim();
    if (ownerHint) {
      try { const u = await getUser(ownerHint); if (u && u.user_id) mineIds.add(u.user_id); } catch { /* hint is best-effort */ }
    }

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
    const weekAsked = !!(week && !Number.isNaN(week));
    if (!weekAsked) {
      const seasonType = nfl && nfl.season_type;
      if (seasonType && seasonType !== 'regular' && seasonType !== 'post') {
        week = 1; // preseason / offseason → the upcoming games are regular-season week 1
      } else {
        week = (nfl && (nfl.display_week || nfl.week)) || 1;
      }
    }
    week = Math.min(18, Math.max(1, week));
    const season = (nfl && nfl.season) || String(config.activeSeason);

    /* ⭐⭐⭐⭐⭐ ONCE THE WEEK IS OVER, OPEN ON THE NEXT ONE — b143.
       Trey: "it's still defaulted to week 1 with all games done. I do want flip it to the next week (week 2)
       starting on Tuesday. You can still flip back and forth."
       Sleeper's `display_week` keeps pointing at a finished week, so My Week opened on a week where nothing
       could be fixed — and every panel on it (availability, lineup changes, free agents, weather) is empty
       by definition once the games are played. That is exactly the screen he was looking at.
       ⚠ ONLY WHEN NO WEEK WAS ASKED FOR. An explicit `?week=` is the user driving the toggle and must be
         obeyed exactly, or stepping back to a finished week would bounce him forward again.
       ⚠ AND ONLY ON EVIDENCE — see weekpick.js: no schedule rows means no roll. */
    if (!weekAsked) {
      try {
        const { rows: kick } = await q(
          'SELECT DISTINCT kickoff FROM nfl_schedule WHERE season=$1 AND week=$2 AND kickoff IS NOT NULL',
          [Number(season), week]);
        week = defaultWeek(week, kick.map((r) => r.kickoff));
      } catch { /* no schedule: the platform's week stands, which is the pre-b143 behaviour */ }
    }

    // Which scoring field to use as a FALLBACK only (if a player has no raw stats to score).
    const recPts = (league.scoring_settings && Number(league.scoring_settings.rec)) || 0;
    const ptsField = recPts >= 1 ? 'pts_ppr' : recPts >= 0.5 ? 'pts_half_ppr' : 'pts_std';

    // The league's actual scoring rules (pass_td, pass_yd, rec, bonus_rec_te, etc.). Sleeper's pre-summed
    // pts_ppr/pts_std fields assume DEFAULT scoring (6-pt pass TDs, no TE premium), so they're wrong for
    // leagues with custom rules. We instead recompute each player's points from the RAW stat projections
    // times this league's per-stat values — which correctly handles 4-pt pass TDs, TE premium, and anything
    // else the commissioner set. Same stat vocabulary is used by both the projections and the scoring map.
    const scoring = league.scoring_settings || {};
    /* ⭐ b136 — this was an inline copy of the scoring maths; it now shares one implementation with the live
       route's forecast (src/lib/scoring.js). Two copies is how a projected score and a live score end up
       disagreeing on the same screen for one league with one custom rule only one copy knows about. */
    const scoreFromSleeper = (stats, position) => scoreStatsFor(stats, position, scoring);

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
        const pl = row.player || {};
        weekly[pid] = {
          /* ⭐⭐⭐⭐ NAME AND POSITION RIDE ALONG — b132, and the reason the free-agent finder was empty.
             This map is the ONLY complete list of "every NFL player with a projection this week". The
             draft player pack is not: it is the draftable universe, and it drops anyone with neither an
             ADP nor a season projection — which is the precise description of the waiver-wire pickup you
             are looking for in October. My Week was intersecting the two, so its free-agent pool was the
             draft board minus rostered players, and in a deep league that is close to nobody. Carrying
             two extra strings here lets the page use THIS as its universe and the pack purely for
             enrichment. Two strings on ~1,000 rows is a few tens of KB on a call that already ships the
             whole league. */
          name: pl.first_name || pl.last_name ? `${pl.first_name || ''} ${pl.last_name || ''}`.trim() : (pl.full_name || null),
          pos: pl.position || null,
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

    /* ⭐⭐⭐⭐ WHO IS ON BYE, FROM THE SCHEDULE RATHER THAN FROM A PLAYER COLUMN — b132.
       Trey: "Yes, I want this to be focused on bye weeks."
       The old bye test was `player.bye_week === week`, read off the players table, and it is the weakest
       link in the chain: Sleeper's player feed leaves `bye_week` null for large stretches of the year, so
       in the weeks that matter most the answer was "nobody is on bye" — stated with total confidence, in
       every league at once. The schedule cannot be coy about it: a team either has a row for this week or
       it does not, and a team with no row is on bye. That is a set of about six strings.
       Null, not [], when the schedule table has nothing for the season — an empty array would read as
       "no byes this week", which is a claim we would not be entitled to make. */
    let byeTeams = null, byeTeamsNext = null;
    try {
      const { rows: sch } = await q('SELECT team, week FROM nfl_schedule WHERE season=$1', [Number(season)]);
      byeTeams = byeTeamsForWeek(sch, week);
      // Next week too, because a waiver claim for a bye you can already see is the one piece of advice this
      // whole page can give you EARLY rather than at 11:55 on Sunday.
      byeTeamsNext = week < 18 ? byeTeamsForWeek(sch, week + 1) : null;
    } catch { byeTeams = null; byeTeamsNext = null; }

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
      /* ⭐⭐⭐ 29ai/b123 — A ROSTER IS EVERY FIELD SLEEPER PUTS A PLAYER IN, NOT JUST `players`.
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
      if (myRosterId == null && r.owner_id && mineIds.has(r.owner_id)) myRosterId = r.roster_id;
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

    /* ⭐⭐⭐⭐ THE PROJECTED TOTAL FOR A SIDE — b140.
       Trey, on the future-week view: "I also want to see the projected scores and such."
       A week that has not happened has `weekPoints: 0` for everybody, so the home page could show who you
       play and nothing else. The per-player projections are already loaded above (`weekly`), in THIS
       league's scoring — so the side total is a sum, not a new model, and it cannot disagree with the
       numbers the hub prints on the same players.
       ⚠ SUMS THE LINEUP THEY HAVE ACTUALLY SET, not their best possible one. Before kickoff that is what
         Sleeper shows and what they are going to score with; treating everyone as optimally deployed would
         flatter every opponent in the league. */
    const projTotalFor = (t) => {
      if (!t || !Array.isArray(t.starters)) return null;
      let sum = 0, known = 0;
      for (const sid of t.starters) {
        if (!sid) continue;
        const w = weekly[String(sid)];
        if (w && Number.isFinite(w.pts)) { sum += w.pts; known++; }
      }
      return known ? { pts: Math.round(sum * 10) / 10, known, of: t.starters.filter(Boolean).length } : null;
    };

    // My matchup this week: find my team, then the opponent sharing my matchup_id.
    let matchup = null;
    if (myRosterId != null) {
      const me = teams.find((t) => t.rosterId === myRosterId);
      if (me && me.matchupId != null) {
        const opp = teams.find((t) => t.rosterId !== myRosterId && t.matchupId === me.matchupId);
        matchup = { me, opp: opp || null, meProj: projTotalFor(me), oppProj: projTotalFor(opp) };
      } else if (me) {
        matchup = { me, opp: null, meProj: projTotalFor(me), oppProj: null };
      }
    }
    /* ⭐⭐⭐ AND THE PROJECTED LEAGUE MEDIAN, for leagues that play it — see the median note in the live
       route. On a future week this is the only way to answer "am I on the right side of the median",
       which in a median league is half the result. */
    const medianOnHub = !!(league && league.settings && Number(league.settings.league_average_match) === 1);
    let medianProj = null;
    if (medianOnHub) {
      const all = teams.map(projTotalFor).filter(Boolean).map((x) => x.pts).sort((a2, b2) => a2 - b2);
      if (all.length >= 3) {
        const h = Math.floor(all.length / 2);
        medianProj = all.length % 2 ? all[h] : Math.round(((all[h - 1] + all[h]) / 2) * 10) / 10;
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

    /* ⭐⭐⭐⭐⭐ WHO IS ABOUT TO BE GOOD — b142.
       ================================================================================================
       Trey: "targets, yards, points… are certainly an indication of value. Also, what that doesn't
       capture is like if there was an injury and someone's taking over as the starter type of deal.
       Maybe we can pull data from other sources to suggest there's new roster, like… percentage owned."

       Four signals, computed here rather than in the browser for one reason each: the usage and role
       trends need several weeks of stat lines (four extra Sleeper calls, shared across every user by the
       cache), the opportunity signal needs the whole player table to see who is ahead of a man on his own
       depth chart, and the ownership feed is a single league-wide call that would otherwise be made once
       per open tab. The browser gets the answers, keyed by player id.

       ⚠ ONLY FOR PLAYERS WHO ARE ACTUALLY AVAILABLE. The ownership signal in particular only means
         anything about YOUR wire — "being added everywhere and still free in your league" is the whole
         point of it — and computing trends for 800 rostered players would be several hundred milliseconds
         spent on rows nobody can act on.
       ⚠ AND THE WHOLE BLOCK IS BEST-EFFORT. Every input is optional, every signal reports UNKNOWN rather
         than false when its field is missing, and a total failure here must leave the hub exactly as it
         was — this is a decoration on the free-agent list, not a load-bearing part of it. */
    let trending = null;
    let trendAudit = null;
    try {
      const TREND_WEEKS = 4;
      const wks = [];
      for (let w = Math.max(1, week - TREND_WEEKS); w < week; w++) wks.push(w);
      /* ⚠ `players` INSIDE THIS HANDLER IS A ROSTER'S ID ARRAY, NOT THE MASTER PLAYER TABLE — it is
         declared per-roster inside the team loop above. Reaching for it here would have been a
         ReferenceError at request time on a route that builds perfectly cleanly, which is the same shape
         as the 29q Rosters-panel bug the error boundary swallowed. The master table has its own name. */
      const [statWeeks, adds, allPlayers] = await Promise.all([
        Promise.all(wks.map((w) => cachedCall(`stats:${season}:${w}`, LEAGUE_TTL_MS,
          () => getWeeklyStats(season, w, { positions: ['QB', 'RB', 'WR', 'TE'] })).catch(() => []))),
        getTrendingAdds().catch(() => new Map()),
        getAllPlayers().catch(() => ({})),
      ]);
      // sid -> [week1 stats, week2 stats, …] oldest first, with gaps preserved as undefined so a man who
      // missed a week does not have his history silently compacted into a false continuity.
      const byPlayer = new Map();
      statWeeks.forEach((rows, i) => {
        (rows || []).forEach((r) => {
          if (!r || r.player_id == null) return;
          const k = String(r.player_id);
          if (!byPlayer.has(k)) byPlayer.set(k, new Array(statWeeks.length).fill(undefined));
          byPlayer.get(k)[i] = r.stats || r;
        });
      });
      /* Teammates, grouped once. The opportunity signal asks "who is ahead of him at his position on his
         own team", which is a per-team question and would otherwise be a scan of the full player table
         for every free agent on the page. */
      const byTeam = new Map();
      for (const pid in allPlayers) {
        const pl = allPlayers[pid];
        if (!pl || !pl.team) continue;
        if (!byTeam.has(pl.team)) byTeam.set(pl.team, []);
        byTeam.get(pl.team).push(pl);
      }
      const out = {};
      const FANTASY_POS = new Set(['QB', 'RB', 'WR', 'TE']);
      for (const pid in allPlayers) {
        if (rostered.has(String(pid))) continue;              // rostered somewhere: not an add
        const pl = allPlayers[pid];
        if (!pl || !FANTASY_POS.has(pl.position) || !pl.team) continue;
        const t = trendFor({
          player: pl,
          teammates: byTeam.get(pl.team) || [],
          weeks: byPlayer.get(String(pid)) || [],
          addsByPlayer: adds,
        });
        // Only players with something to say travel over the wire; the rest would be 700 empty objects.
        if (t.fired.length) {
          out[String(pid)] = {
            top: t.top.kind,
            why: t.top.why,
            rank: Math.round(t.rank * 100) / 100,
            all: t.fired.map((x) => ({ kind: x.kind, why: x.why })),
          };
        }
      }
      trending = out;
      // The instrument, always, whether or not anything fired — see auditFields in trending.js.
      trendAudit = auditFields(
        statWeeks.flat(),
        Object.keys(allPlayers).slice(0, 4000).map((k) => allPlayers[k]),
        adds,
      );
    } catch { trending = null; trendAudit = null; }

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
      // Whether we could point at a team at all, and if so which account it came from. The frontend uses
      // this to say "add the Sleeper account that owns this league" instead of dropping the league.
      ownerResolved: myRosterId != null,
      ownerHint: ownerHint || null,
      byeTeams,
      byeTeamsNext,
      rostered: Array.from(rostered),
      trending,
      trendAudit,
      teams,
      matchup,
      medianScoring: medianOnHub, medianProjected: medianProj,
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

/* ⭐⭐⭐⭐⭐ GET /api/connect/sleeper/season-review?league_id=...[&owner=username]  — b133
 * ================================================================================================
 * Trey: "I also want to create a weekly review. You should be able to toggle back to every week in the
 * past… should you have started someone else? Was there a FA? Was it good luck or bad luck that you won
 * or lost? Give weekly trends not just for your matchup, but also compare it to the league."
 *
 * Returns EVERY COMPLETED WEEK of one league at once, already reduced to verdicts and totals. Three
 * decisions shape it, and all three are about the fifteen-league case:
 *
 * ⭐ THE WHOLE SEASON IN ONE CALL, so the week toggle is instant and the trend lines and the ledger exist
 *   at all. A per-week endpoint would make "toggle back to every week" fifteen more round-trips per click.
 *
 * ⭐ REDUCED HERE, NOT ON THE CLIENT. The raw material is twelve rosters x fourteen weeks of per-player
 *   point maps — roughly 300KB per league, so 4.5MB across his fifteen. What he actually needs is a few
 *   dozen numbers per week. Doing the reduction server-side turns that into ~6KB a league and means the
 *   optimal-lineup maths lives in ONE tested place (lib/review.js) rather than in a screen.
 *
 * ⭐ COMPLETED WEEKS ARE IMMUTABLE, so they cache hard. Week 3 will never change again; re-fetching it
 *   every time somebody opens the page is pure waste against a rate limit that is application-wide. The
 *   CURRENT week is deliberately excluded entirely — a review of a week still being played is not a
 *   review, it is a scoreboard, and the page already has one of those.
 *
 * ⚠ NO FREE AGENTS, AND THE RESPONSE SAYS SO. `faBasis: 'bench-only'` is not a footnote, it is the honest
 *   answer to half of his question: who was unrostered in week 6 CANNOT be recovered from today's rosters,
 *   because the player you should have claimed is by definition on somebody's roster now. Answering it
 *   properly needs a replay of the league's transaction log; answering it with today's rosters would
 *   systematically hide exactly the misses he is asking about. So the review reports what it can stand
 *   behind — the players who were on your own bench, which Sleeper snapshots per week — and the page
 *   prints the limitation rather than implying the wire was empty.
 */
const REVIEW_TTL_MS = 6 * 60 * 60 * 1000;          // a settled week never changes; this is just a memory bound
const reviewCache = new Map();                      // `${leagueId}:${season}:${week}` -> { at, matchups }

async function settledMatchups(leagueId, season, week) {
  const key = `${leagueId}:${season}:${week}`;
  const hit = reviewCache.get(key);
  if (hit && Date.now() - hit.at < REVIEW_TTL_MS) return hit.matchups;
  const ms = (await getMatchups(leagueId, week)) || [];
  reviewCache.set(key, { at: Date.now(), matchups: ms });
  // Cheap bound: this is one small array per league-week and the process is long-lived.
  if (reviewCache.size > 4000) { const first = reviewCache.keys().next().value; reviewCache.delete(first); }
  return ms;
}

connectRouter.get('/sleeper/season-review', async (req, res) => {
  const leagueId = String(req.query.league_id || '').trim();
  if (!leagueId) return res.status(400).json({ error: 'league_id required' });
  try {
    await ensureLinkCols();
    const mineIds = new Set((await accountsFor(req.user.id, 'sleeper')).map((a) => a.id));
    const { rows: urow } = await q('SELECT sleeper_user_id FROM users WHERE id=$1', [req.user.id]);
    if (urow[0] && urow[0].sleeper_user_id) mineIds.add(urow[0].sleeper_user_id);
    const ownerHint = String(req.query.owner || '').trim();
    if (ownerHint) { try { const u = await getUser(ownerHint); if (u && u.user_id) mineIds.add(u.user_id); } catch { /* best-effort */ } }

    const [league, users, rosters, nfl] = await Promise.all([
      getLeague(leagueId), getLeagueUsers(leagueId), getLeagueRosters(leagueId), getNflState().catch(() => null),
    ]);
    if (!league) return res.status(404).json({ error: 'League not found on Sleeper' });

    const season = (nfl && nfl.season) || String(config.activeSeason);
    /* WHICH WEEKS ARE OVER. `display_week` is the week Sleeper is currently showing, i.e. the one in
       progress — so the last COMPLETED week is the one before it. In the preseason nothing is complete,
       and the response says that plainly instead of returning an empty list that reads like a failure. */
    const seasonType = nfl && nfl.season_type;
    const cur = (nfl && (nfl.display_week || nfl.week)) || 1;
    let lastDone = (seasonType && seasonType !== 'regular' && seasonType !== 'post') ? 0 : Math.max(0, Math.min(18, cur) - 1);

    /* ⭐⭐⭐⭐ SUNDAY NIGHT IS REVIEWABLE — b135.
       Trey: "once games have finished… There should be a review tab next to live where you can dive into
       these." This used to stop dead at `cur - 1`, which meant the most interesting review in the world —
       the one for the games you just watched — did not exist until Sleeper rolled the week over on
       Tuesday. So the CURRENT week is included too, but only once EVERY game in it is finished.
       ⚠ AND "EVERY" IS NOT PEDANTRY. A review of a week with the Monday-night game still to come computes
         its optimal lineup from players who have not played, so it would tell you to bench the man you
         are about to watch score thirty. One game short is not done; the page says so instead. */
    let currentWeekOpen = false;
    if (lastDone < 18 && cur >= 1) {
      try {
        const { rows: sch } = await q(
          'SELECT kickoff FROM nfl_schedule WHERE season=$1 AND week=$2', [Number(season), Math.min(18, cur)]);
        const ws = weekStateFrom(sch.map((r) => (r.kickoff ? new Date(r.kickoff).toISOString() : null)));
        if (ws.known && ws.allDone) { lastDone = Math.min(18, cur); currentWeekOpen = true; }
      } catch { /* no schedule: fall back to completed weeks only, which is the safe direction */ }
    }

    let myRosterId = null;
    const ownerById = new Map();
    (users || []).forEach((u) => {
      const teamName = (u.metadata && u.metadata.team_name) ? u.metadata.team_name : null;
      ownerById.set(u.user_id, { ownerName: u.display_name || 'Unknown', teamName: teamName || u.display_name || 'Team' });
    });
    const teams = (rosters || []).map((r) => {
      if (myRosterId == null && r.owner_id && mineIds.has(r.owner_id)) myRosterId = r.roster_id;
      const o = ownerById.get(r.owner_id) || { ownerName: 'Unknown', teamName: 'Team' };
      return { rosterId: r.roster_id, ownerName: o.ownerName, teamName: o.teamName };
    });

    const rosterPositions = (league.roster_positions || []).filter(Boolean);

    if (!lastDone || myRosterId == null) {
      return res.json({ leagueId, leagueName: league.name, season, teams, myRosterId,
        ownerResolved: myRosterId != null, rosterPositions, lastCompletedWeek: lastDone,
        currentWeek: cur, currentWeekOpen,
        weeks: [], ledger: null, ranks: null, faBasis: 'bench-only',
        note: !lastDone ? 'No completed weeks yet this season.' : null });
    }

    // One fetch per completed week, cached; weeks in parallel but paced by the same pool used elsewhere.
    const weekNums = Array.from({ length: lastDone }, (_, i) => i + 1);
    const raw = await Promise.all(weekNums.map(async (w) => {
      try { return [w, await settledMatchups(leagueId, season, w)]; } catch { return [w, null]; }
    }));

    /* Names and positions for the miss list. The players table is the same source the draft board uses, so
       a name printed here matches the name printed everywhere else in the app. */
    const nameById = new Map(), posById = new Map();
    try {
      const { rows: pl } = await q(
        `SELECT player_id, full_name, position FROM players WHERE position IS NOT NULL`);
      pl.forEach((p) => { nameById.set(String(p.player_id), p.full_name); posById.set(String(p.player_id), p.position); });
    } catch { /* the review still works, with ids where names would be */ }

    // Does this league play the median as a second weekly opponent? See the median notes elsewhere.
    const medianOnReview = !!(league && league.settings && Number(league.settings.league_average_match) === 1);

    /* ⭐⭐⭐⭐⭐ WHO ACTUALLY PLAYED, PER WEEK — b138.
       Trey: "In the weekly review, it says 'Worst Call - Started Kenneth Walker 0 over Chubba Hubbard 22.2'
       — Kenneth Walker hasn't played yet."

       The review believed he had, and the reason is a genuine ambiguity in the data rather than a slip:
       Sleeper's `players_points` carries an entry for EVERY rostered player, set to 0 from the moment the
       week opens. So a man who has not kicked off and a man who was targeted twice and dropped both look
       identical — both are 0.0 — and the optimal-lineup pass, which is only ever asked "what did he
       score", dutifully concluded that starting Walker cost 22.2 points. It is the worst class of wrong
       output: confident, specific, checkable, and false.

       The stat feed settles it, exactly as it does on the live board (see `playedBy` in /sleeper/live): a
       STAT LINE means he was in the game. No stat line and we do not know what he will score, so he is not
       a data point about a decision — he is excluded from the comparison rather than counted as a zero.

       ⚠ THIS IS ALSO WHY THE RECORD READ 8–2. The same zeros flowed into the week's result: a matchup with
         four starters still to play is not a settled win, and the review presented it as one. A week that
         is not finished now says so and is summarised as in-progress instead.
       ⚠ ONE CALL PER WEEK, CACHED, AND FAILURE IS NOT FATAL. If the stat feed is unavailable, `played`
         falls back to "we cannot tell", and the code below then treats the week as complete exactly as it
         used to — an unchanged review rather than a broken one. */
    const playedByWeek = new Map();
    await Promise.all(weekNums.map(async (w) => {
      try {
        const rows = await cachedCall(`stats:${season}:${w}`, LEAGUE_TTL_MS,
          () => getWeeklyStats(season, w, { positions: ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'] }));
        const set = new Set();
        (rows || []).forEach((r) => { if (r && r.player_id != null) set.add(String(r.player_id)); });
        if (set.size) playedByWeek.set(w, set);
      } catch { /* no stat feed for this week: the week is judged as it always was */ }
    }));

    const weeks = [];
    for (const [week, ms] of raw) {
      if (!ms || !ms.length) continue;
      const byRoster = new Map(ms.map((m) => [m.roster_id, m]));
      const pointsByRoster = {}, opponentByRoster = {};
      ms.forEach((m) => {
        if (Number.isFinite(m.points)) pointsByRoster[String(m.roster_id)] = Math.round(m.points * 100) / 100;
        const opp = ms.find((x) => x.matchup_id != null && x.matchup_id === m.matchup_id && x.roster_id !== m.roster_id);
        if (opp) opponentByRoster[String(m.roster_id)] = String(opp.roster_id);
      });
      const mine = byRoster.get(myRosterId);
      if (!mine) { weeks.push({ week, pointsByRoster, opponentByRoster, me: null }); continue; }

      const pp = mine.players_points || {};
      const playedSet = playedByWeek.get(week) || null;
      /* ⭐ THE KENNETH WALKER GATE, in lib/review.js so it is unit-testable — see playedGate there for the
         full reasoning. A 0 from a man who has not kicked off is not a score. */
      const { ptsOf } = playedGate(pp, playedSet);
      const posOf = (sid) => posById.get(String(sid)) || null;
      const nameOf = (sid) => nameById.get(String(sid)) || `Player ${sid}`;
      const roster = [...new Set([...(mine.players || []), ...(mine.starters || [])].filter(Boolean).map(String))];

      /* How much of this week is actually in the books. A week with starters still to play can be SHOWN —
         it is the week he is living in and he wants to see it — but it cannot be judged, and everything
         downstream keys off this flag rather than guessing from the date. */
      const oppRow = opponentByRoster[String(myRosterId)] != null ? byRoster.get(Number(opponentByRoster[String(myRosterId)])) : null;
      const C = weekCompleteness(mine.starters, oppRow && oppRow.starters, playedSet, nameOf);
      const complete = C.complete;

      const lm = lineupMisses(rosterPositions, mine.starters, roster, ptsOf, posOf, nameOf);
      const oppId = opponentByRoster[String(myRosterId)];
      const oppPts = oppId != null ? pointsByRoster[oppId] : null;
      const myPts = pointsByRoster[String(myRosterId)];
      /* ⚠ NO RESULT UNTIL IT IS A RESULT. A scoreline with eight players still to play is not a win, and
         calling it one is what produced "8–2 across 10 leagues" for an afternoon that was closer to 5–5. */
      const result = !complete || !Number.isFinite(oppPts) ? null : myPts > oppPts ? 'W' : myPts < oppPts ? 'L' : 'T';

      /* ⭐⭐⭐⭐ THE MEDIAN HALF OF A COMPLETED WEEK — b140.
         Trey: "Throughout the review and on the 'this week' hub… if your league has median scoring, you
         need to show how we relate to that as well."
         Every team's score for the week is already in hand, so the median is a sort and a midpoint — no
         new data and no second source to disagree with. Only computed where the league actually plays it;
         elsewhere the field stays absent so the UI can tell "does not apply" from "zero". */
      let medianPts = null, medianMargin = null, medianResult = null;
      if (medianOnReview) {
        const field = Object.values(pointsByRoster).filter(Number.isFinite).sort((a2, b2) => a2 - b2);
        if (field.length >= 3) {
          const h = Math.floor(field.length / 2);
          medianPts = field.length % 2 ? field[h] : Math.round(((field[h - 1] + field[h]) / 2) * 100) / 100;
          if (Number.isFinite(myPts) && complete) {
            medianMargin = Math.round((myPts - medianPts) * 100) / 100;
            medianResult = medianMargin > 0 ? 'W' : medianMargin < 0 ? 'L' : 'T';
          }
        }
      }
      weeks.push({ week, pointsByRoster, opponentByRoster, complete,
        me: { pts: myPts, oppRosterId: oppId || null, oppPts: Number.isFinite(oppPts) ? oppPts : null, result,
          medianPts, medianMargin, medianResult,
          complete, yetToPlay: C.yetToPlay, oppYetToPlay: C.oppYetToPlay,
          // Named, so the page can say WHO it is waiting on rather than just that it is waiting.
          waitingOn: C.waitingOn,
          optimal: lm.optimal, actual: lm.actual, left: lm.left, exact: lm.exact, pending: lm.pending,
          misses: lm.misses.slice(0, 6) } });
    }

    /* The opponent's own average has to be computed across the WHOLE season before any week's verdict can
       use it — "they beat their average" is a season fact, not a week fact. So verdicts are a second pass. */
    const avgByRoster = {};
    for (const t of teams) {
      const vals = weeks.map((w) => w.pointsByRoster[String(t.rosterId)]).filter(Number.isFinite);
      if (vals.length) avgByRoster[String(t.rosterId)] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
    }
    for (const w of weeks) {
      if (!w.me) continue;
      /* ⚠ AN UNFINISHED WEEK GETS NO VERDICT — b138. Every one of these judgements assumes final scores:
         "robbed" compares you to a league median half the league has not finished scoring, "blown" says
         your best lineup would have won a game still being played, and the all-play record counts teams
         with four starters on the bench waiting for Monday. Each would be a confident sentence about a
         result that does not exist. The week still appears, with its live scores and a note saying what
         it is waiting on; it simply is not graded until it is over. */
      if (w.me.complete === false) { w.me.verdict = null; continue; }
      const field = Object.values(w.pointsByRoster);
      const v = verdictFor({ won: w.me.result === 'W', myPts: w.me.pts, allPtsThisWeek: field,
        optimalPts: w.me.optimal, oppPts: w.me.oppPts, oppAvg: w.me.oppRosterId ? avgByRoster[w.me.oppRosterId] : null });
      w.me.verdict = { key: v.key, text: v.text };
      w.me.allPlay = v.allPlay;
      w.me.median = v.median;
      w.me.oppSwing = v.oppSwing;
      w.me.optimalWins = v.optimalWins;
    }

    res.json({
      leagueId, leagueName: league.name, season, teams, myRosterId, ownerResolved: true,
      rosterPositions, lastCompletedWeek: lastDone,
      // Whether the newest reviewable week is the one just played (every game final) or the last full one.
      currentWeek: cur, currentWeekOpen,
      medianScoring: medianOnReview,
      weeks, ledger: seasonLedger(weeks), ranks: pointRanks(weeks, teams.map((t) => t.rosterId)),
      averages: avgByRoster,
      // Not a footnote. See the header: this is the honest scope of the "was there a FA?" answer.
      faBasis: 'bench-only',
    });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach Sleeper. Try again in a moment.' });
  }
});

/* ⭐⭐⭐⭐⭐ GET /api/connect/sleeper/live?league_ids=a,b,c[&week=N][&owner=username]  — b134
 * ================================================================================================
 * Trey: "I also want to be able to track all leagues live during games to see scores, trends, etc.
 * basically have this be my hub for what should I be rooting for."
 *
 * ⭐ ONE REQUEST FOR THE WHOLE SUNDAY, and that is the entire design. The obvious build — call team-hub
 *   once per league from the client — is unusable here: team-hub makes SEVEN upstream calls per league
 *   (league, users, rosters, NFL state, weekly projections, defence-vs-position, schedule) because it is
 *   built to answer everything about one league once. Polling that for fifteen leagues every minute is
 *   105 upstream calls a minute FOR ONE USER, against an app-wide ceiling of about a thousand. Two people
 *   watching football would degrade live draft sync for everybody.
 *
 *   So this route asks each league only what changes during a game: the matchups. League rosters and user
 *   names change roughly never, so they are cached for an hour; matchups get a short TTL with single-flight,
 *   which also means twelve people in the same league cost one upstream call between them rather than
 *   twelve. Fifteen leagues then cost fifteen short-lived calls per refresh, shared across every viewer.
 *
 * ⚠ AND THE ANSWER IS ASSEMBLED HERE, not shipped raw. The rooting board is a cross-league reduction —
 *   who is on your side in which leagues, minus whose side he is on against you — and doing it on the
 *   server means one tested implementation (lib/rooting.js) rather than one per screen.
 *
 * ⚠ GAME STATE IS A WINDOW, NOT A CLOCK. Nothing this app talks to reports whether a game is in the third
 *   quarter. What we do have is kickoff times from nfl_schedule, which gives certainty on the only state
 *   that carries real meaning — "has not kicked off yet" — and an honest approximation of the rest. See
 *   lib/rooting.js `gameState`.
 */
const LIVE_TTL_MS = 20 * 1000;            // matchups during a game; short, and shared across all viewers
const LEAGUE_TTL_MS = 60 * 60 * 1000;     // rosters and display names, which do not move on a Sunday
const liveCache = new Map();              // key -> { at, value }
const liveFlight = new Map();             // key -> promise (single-flight: concurrent viewers share one call)

/* A few leagues at a time. Firing fifteen fan-outs at once is how you get the app rate-limited into a
   half-loaded board — the same reason the client paces its own calls. Never throws: a league that fails
   comes back as an error row so the other fourteen still render. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: String((e && e.message) || e) }; }
    }
  }));
  return out;
}

async function cachedCall(key, ttl, fn) {
  const hit = liveCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  if (liveFlight.has(key)) return liveFlight.get(key);
  const p = (async () => {
    try {
      const value = await fn();
      liveCache.set(key, { at: Date.now(), value });
      if (liveCache.size > 5000) liveCache.delete(liveCache.keys().next().value);
      return value;
    } finally { liveFlight.delete(key); }
  })();
  liveFlight.set(key, p);
  return p;
}

connectRouter.get('/sleeper/live', async (req, res) => {
  const ids = String(req.query.league_ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 40);
  if (!ids.length) return res.status(400).json({ error: 'league_ids required' });
  try {
    await ensureLinkCols();
    const mineIds = new Set((await accountsFor(req.user.id, 'sleeper')).map((a) => a.id));
    const { rows: urow } = await q('SELECT sleeper_user_id FROM users WHERE id=$1', [req.user.id]);
    if (urow[0] && urow[0].sleeper_user_id) mineIds.add(urow[0].sleeper_user_id);
    /* `owner` may be a comma-separated list, positionally matched to league_ids — the same hint team-hub
       takes, batched. A league whose account has been unlinked is still readable because of it. */
    const hints = String(req.query.owner || '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const h of [...new Set(hints)]) {
      try { const u = await getUser(h); if (u && u.user_id) mineIds.add(u.user_id); } catch { /* best-effort */ }
    }

    const nfl = await getNflState().catch(() => null);
    const season = (nfl && nfl.season) || String(config.activeSeason);
    let week = Number(req.query.week || 0);
    if (!week || Number.isNaN(week)) {
      const st = nfl && nfl.season_type;
      week = (st && st !== 'regular' && st !== 'post') ? 1 : ((nfl && (nfl.display_week || nfl.week)) || 1);
    }
    week = Math.min(18, Math.max(1, week));

    // Kickoff times for the week — the only thing that lets a scoreline say "with four still to play".
    const kickoffByTeam = {};
    try {
      const { rows: sch } = await q(
        'SELECT team, kickoff FROM nfl_schedule WHERE season=$1 AND week=$2', [Number(season), week]);
      sch.forEach((r) => { if (r.kickoff) kickoffByTeam[String(r.team)] = new Date(r.kickoff).toISOString(); });
    } catch { /* no schedule loaded: every player reads as unknown, which the UI states rather than guesses */ }

    const nameById = new Map(), posById = new Map(), teamById = new Map();
    try {
      const { rows: pl } = await q('SELECT player_id, full_name, position, team FROM players WHERE position IS NOT NULL');
      pl.forEach((p) => {
        nameById.set(String(p.player_id), p.full_name);
        posById.set(String(p.player_id), p.position);
        teamById.set(String(p.player_id), p.team);
      });
    } catch { /* ids will stand in for names rather than the whole board failing */ }

    /* ⭐⭐⭐⭐⭐ WHO HAS ACTUALLY PLAYED, AND WHAT THE REST ARE PROJECTED FOR — b136.
       Trey: "It's saying I'm 8-2… This is true RIGHT NOW, but on sleeper, I'm showed that I'm projected to
       lose at least 5 total. So the 8-2 is misleading."

       Two feeds, one call each for the whole week no matter how many leagues are asked for, both cached:
         • STATS   — every player who has recorded a stat line this week. This, not the clock, is how we
                     know a man has played. A kickoff time tells you a game started; a stat line tells you
                     he was in it. It also settles the case the clock cannot: a starter who scored exactly
                     zero and a starter who has not kicked off both show 0.0 in `players_points`, and
                     treating the first as "still to come" would forecast him twice.
         • PROJECTIONS — what everyone left is expected to score, so the remainder of the day can be
                     estimated instead of assumed to be nothing.

       ⚠ THESE ARE PER-WEEK, NOT PER-LEAGUE, so fifteen leagues cost two extra upstream calls between them
         rather than thirty. Scoring differs by league, which is why the PROJECTION is scaled per league
         from the raw stats below rather than taken as a single number. */
    const statsKey = `wstats:${season}:${week}`;
    const projKey = `wproj:${season}:${week}`;
    const [weekStats, weekProj] = await Promise.all([
      cachedCall(statsKey, LIVE_TTL_MS * 6, () => getWeeklyStats(season, week, { positions: ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'] })).catch(() => []),
      cachedCall(projKey, LEAGUE_TTL_MS, () => getWeeklyProjections(season, week)).catch(() => []),
    ]);
    /* `gp` is Sleeper's games-played flag. When it is present it is the cleanest possible signal; when it
       is not, the presence of a stat row at all means he was on a field. */
    const playedSet = new Set();
    for (const row of weekStats || []) {
      const st = row && row.stats;
      if (!row || !row.player_id || !st) continue;
      if (st.gp === 0) continue;
      playedSet.add(String(row.player_id));
    }
    const statsKnown = playedSet.size > 0;
    // Raw stat projections per player, kept raw so each league can score them under its own rules.
    const projStats = new Map();
    for (const row of weekProj || []) {
      if (row && row.player_id && row.stats) projStats.set(String(row.player_id), row.stats);
    }

    const now = Date.now();
    /* ⭐⭐⭐⭐⭐ AND RECORD WHICH TEAMS WE HAD NO TIME FOR — b137.
       Trey: "we need to check the 'yet to play' button. Right now it's showing me that I have no one yet
       to play… but Monday night football is tonight."

       A starter whose team has no row in nfl_schedule comes back 'unknown', and 'unknown' is not a
       harmless third value — it is the one that makes the page quietly wrong. It cannot say "yet to play"
       and it must not say "played", so a filter built on two buckets loses him entirely and the Monday
       night game disappears from a screen whose whole job is to tell you what is left.

       ⚠ THE FIX IS TO REPORT THE GAP, NOT TO GUESS AT IT. Defaulting unknown either way would have made
         the symptom go away and left the page confidently wrong in whichever direction we picked. The set
         of teams we could not time is a fact the client can state plainly, name the players for, and point
         at the job that fixes it — which is the difference between a bug he has to report and a page that
         diagnoses itself. */
    const missingKick = new Set();
    const stateOf = (sid) => {
      const team = String(teamById.get(String(sid)) || '');
      const k = kickoffByTeam[team] || null;
      if (!k && team) missingKick.add(team);
      return gameState(k, now);
    };
    /* ⚠ THE STATS FEED WINS OVER THE CLOCK. The clock is a three-and-a-half-hour window around kickoff and
       is honest about being an approximation; a stat line is a fact. Where they disagree, believe the fact. */
    const playedBy = (sid) => (statsKnown ? playedSet.has(String(sid)) : stateOf(sid) === 'done');

    /* ⭐⭐⭐⭐⭐ THREE PHASES, NOT TWO — b140.
       Trey, on a Monday night: "something isn't working right for games that are currently LIVE… it's
       showing that there is no one left AND the scores are static."

       `playedBy` is exactly right for the question it was written to answer and exactly wrong for this one.
       A man in the second quarter HAS a stat line, so he read as finished: his eleven points so far became
       his final score and the thirteen still to come vanished out of every projection on the site. The
       clock is the only thing that knows the difference between "has played" and "is playing", so the two
       signals are combined rather than one trusted alone:

         stats say he played + clock says the game is on   → LIVE   (partial score, more to come)
         stats say he played + clock says it is over       → DONE
         no stat line       + clock says the game is on    → LIVE   (he can still score; kickers often do)
         no stat line       + clock says it is over        → DONE   (he was inactive, or scored nothing)
         no stat line       + clock has not started        → PRE

       ⚠ AND `remain` IS HOW MUCH OF HIS GAME IS LEFT, derived from elapsed time against a nominal game
         length. No feed here reports a game clock, so this is an approximation and it is worth being
         explicit that it is a crude one: a blowout empties in the fourth quarter, a two-minute drill is
         worth more than its two minutes, and neither is visible from a kickoff timestamp. It is still
         vastly closer than the two values it replaces, which were "all of his projection" and "none of
         it". Everything downstream treats it as an estimate and says so. */
    const GAME_LEN_MS = 3.5 * 60 * 60 * 1000;
    const phaseOf = (sid) => {
      const st = stateOf(sid);
      if (st === 'live') return 'live';
      if (playedBy(sid) || st === 'done') return 'done';
      return 'pre';
    };
    const remainOf = (sid) => {
      const team = String(teamById.get(String(sid)) || '');
      const k = kickoffByTeam[team] || null;
      if (!k) return 0.5;                       // no clock for his game: the least-wrong single guess
      const elapsed = now - Date.parse(k);
      if (!Number.isFinite(elapsed)) return 0.5;
      return Math.max(0, Math.min(1, 1 - elapsed / GAME_LEN_MS));
    };

    const out = await pool(ids, 5, async (leagueId) => {
      const [league, users, rosters, ms] = await Promise.all([
        cachedCall(`l:${leagueId}`, LEAGUE_TTL_MS, () => getLeague(leagueId)),
        cachedCall(`u:${leagueId}`, LEAGUE_TTL_MS, () => getLeagueUsers(leagueId)),
        cachedCall(`r:${leagueId}`, LEAGUE_TTL_MS, () => getLeagueRosters(leagueId)),
        cachedCall(`m:${leagueId}:${week}`, LIVE_TTL_MS, () => getMatchups(leagueId, week)),
      ]);
      const ownerById = new Map();
      (users || []).forEach((u) => ownerById.set(u.user_id, (u.metadata && u.metadata.team_name) || u.display_name || 'Team'));
      let myRosterId = null;
      const teamNameByRoster = new Map();
      (rosters || []).forEach((r) => {
        teamNameByRoster.set(r.roster_id, ownerById.get(r.owner_id) || 'Team');
        if (myRosterId == null && r.owner_id && mineIds.has(r.owner_id)) myRosterId = r.roster_id;
      });
      if (myRosterId == null) return { leagueId, leagueName: (league && league.name) || null, ownerResolved: false, me: null, opp: null };

      const byRoster = new Map((ms || []).map((m) => [m.roster_id, m]));
      const mineM = byRoster.get(myRosterId);
      if (!mineM) return { leagueId, leagueName: (league && league.name) || null, ownerResolved: true, me: null, opp: null, note: 'no matchup this week' };
      const oppM = (ms || []).find((m) => m.matchup_id != null && m.matchup_id === mineM.matchup_id && m.roster_id !== myRosterId) || null;

      const entryOf = (m) => (m ? { rosterId: m.roster_id, teamName: teamNameByRoster.get(m.roster_id) || 'Team',
        points: Number.isFinite(m.points) ? m.points : null, starters: m.starters || [] } : null);
      // ⚠ Points come from the league's OWN scoring, per player, as Sleeper already settled them. We never
      //   recompute: a scoreboard that disagrees with the platform's scoreboard is worse than no scoreboard.
      const ptsOf = (sid, entry) => {
        const m = byRoster.get(entry.rosterId);
        const v = m && m.players_points ? m.players_points[String(sid)] : null;
        return v == null ? null : Number(v);
      };
      /* ⚠ THE PROJECTION IS SCORED UNDER THIS LEAGUE'S RULES, not taken as a number. The same projected
         stat line is worth different points in PPR and standard, and a forecast built from somebody else's
         scoring would quietly disagree with the scoreboard it sits beside. Same helper the team hub uses. */
      const projFor = (sid) => {
        const st = projStats.get(String(sid));
        if (!st) return null;
        const v = scoreStatsFor(st, posById.get(String(sid)) || null, league.scoring_settings || {});
        return v == null ? null : Math.round(v * 10) / 10;
      };

      const me = sideOf(entryOf(mineM), { ptsOf, stateOf });
      const opp = sideOf(entryOf(oppM), { ptsOf, stateOf });
      const forPlayers = (side) => (side ? (side.players || []).map((p) => ({
        sid: p.sid, pts: p.pts, phase: phaseOf(p.sid), remain: remainOf(p.sid),
        played: phaseOf(p.sid) === 'done', proj: projFor(p.sid),
      })) : []);
      const forecast = opp ? matchupForecast(forPlayers(me), forPlayers(opp)) : null;
      /* Every player carries his own projection, his phase and how much of his game is left, so a lineup
         can be read row by row rather than only in total — Game Day, the hub matchup and the home hover
         all want that, and all three must agree about who is still playing. */
      const decorate = (side) => {
        if (!side) return null;
        const players = (side.players || []).map((p) => {
          const ph = phaseOf(p.sid);
          const rem = ph === 'live' ? remainOf(p.sid) : (ph === 'pre' ? 1 : 0);
          const proj = projFor(p.sid);
          return { ...p, phase: ph, played: ph === 'done', remain: Math.round(rem * 100) / 100, proj,
            /* What he is expected to FINISH on: what he has plus what is still ahead of him. The number
               Sleeper shows beside a live player, and the one a person actually wants. */
            projFinal: Number.isFinite(proj)
              ? Math.round(((Number.isFinite(p.pts) ? p.pts : 0) + proj * rem) * 10) / 10
              : null };
        });
        return { ...side, players,
          // ⚠ INCLUDES MEN CURRENTLY PLAYING — see the note in winprob.js. "Left" means undecided.
          yetToPlay: players.filter((p) => p.phase !== 'done').length,
          playing: players.filter((p) => p.phase === 'live').length };
      };

      /* ⭐⭐⭐⭐⭐ MEDIAN SCORING — b140.
         Trey: "if your league has median scoring, you need to show how we relate to that as well (based on
         projected scoring and projected median). This is in sleeper when you look at leagues."

         In a median league every team plays TWO opponents each week: the one on the schedule, and the
         league median. So a week is 2-0, 1-1 or 0-2, and a page that only ever shows the head-to-head is
         reporting half the result — you can beat your opponent and still take a loss, or lose and salvage
         a split. Sleeper flags it as `league_average_match` in the league settings.

         ⚠ THE MEDIAN IS PROJECTED THE SAME WAY EVERY OTHER TOTAL IS, from every team's lineup, so it moves
           with the afternoon exactly as the scoreboard does. A median computed from live scores alone would
           sit far too low all Sunday and make everyone look like they were beating it.
         ⚠ AND IT IS THE MEDIAN OF EVERY TEAM INCLUDING YOU, which is what Sleeper does — with an even
           number of teams that is the midpoint of the two middle scores. */
      const medianOn = !!(league && league.settings && Number(league.settings.league_average_match) === 1);
      let medianGame = null;
      if (medianOn && (ms || []).length >= 3) {
        const totalsFor = (m) => {
          const side2 = sideOf(entryOf(m), { ptsOf, stateOf });
          if (!side2) return null;
          const proj = projectSide((side2.players || []).map((p) => ({
            sid: p.sid, pts: p.pts, phase: phaseOf(p.sid), remain: remainOf(p.sid), proj: projFor(p.sid),
          })));
          return { now: side2.pts, projected: proj.projected };
        };
        const all = (ms || []).map(totalsFor).filter(Boolean);
        const mid = (arr) => {
          const v = arr.slice().sort((x, y) => x - y);
          if (!v.length) return null;
          const h = Math.floor(v.length / 2);
          return v.length % 2 ? v[h] : Math.round(((v[h - 1] + v[h]) / 2) * 100) / 100;
        };
        const nowMed = mid(all.map((x) => x.now).filter(Number.isFinite));
        const projMed = mid(all.map((x) => x.projected).filter(Number.isFinite));
        const myTot = totalsFor(mineM);
        /* The median half of the week as its own forecast, so it gets the same treatment as the head-to-
           head: a probability rather than a bare comparison, using the same uncertainty already computed
           for my side. A median is steadier than any one opponent — it is an average of the field — so it
           carries roughly half a single team's variance. */
        const myVar = forecast && forecast.me ? forecast.me.variance : 0;
        const margin = myTot && Number.isFinite(projMed) ? Math.round((myTot.projected - projMed) * 100) / 100 : null;
        const sd = Math.sqrt(myVar + myVar * 0.5) || 0;
        let winMed = null;
        if (margin != null) {
          winMed = sd > 0 ? normalCdf(margin / sd) : (margin > 0 ? 1 : margin < 0 ? 0 : 0.5);
          if (!forecast || !forecast.settled) winMed = Math.min(0.99, Math.max(0.01, winMed));
        }
        medianGame = { on: true, median: nowMed, projMedian: projMed,
          myNow: myTot ? myTot.now : null, myProjected: myTot ? myTot.projected : null,
          beatNow: myTot && Number.isFinite(nowMed) ? myTot.now > nowMed : null,
          margin, win: winMed, teams: all.length };
      }

      return {
        leagueId,
        // ⚠ THE BLANK-NAME BUG. This row never carried a name, so every league tag on the rooting board
        //   came out as an empty string and the sub-line rendered as ", , +2". The stub fixture supplied
        //   one, which is exactly why no test caught it — see hubstub/mk-live.mjs.
        leagueName: (league && league.name) || null,
        ownerResolved: true,
        me: decorate(me), opp: decorate(opp), forecast, medianGame,
      };
    });

    const leagues = out.map((r) => (r && !r.error ? r : { leagueId: null, error: String((r && r.error) || 'failed') }));
    const rows = leagues.filter((r) => r && r.me);
    const board = rootingBoard(rows, {
      nameOf: (sid) => nameById.get(sid) || `Player ${sid}`,
      posOf: (sid) => posById.get(sid) || null,
      teamOf: (sid) => teamById.get(sid) || null,
      stateOf,
      // The same fraction the forecast uses, so the board's colour and the projection agree by construction.
      remainOf,
      oppOf: () => null,
    });

    res.json({
      week, season, at: new Date().toISOString(),
      leagues, totals: dayTotals(rows), rooting: board,
      /* ⭐⭐⭐⭐⭐ THE HONEST HEADLINE. `totals` is the live scoreboard — what is true right now — and it was
         being presented as a record, which is what made "8-2" misleading with half the lineups yet to
         kick off. `record` carries BOTH: what the scoreboard says and what the projections expect it to
         settle at, so the page can lead with the second and footnote the first. */
      record: projectedRecord(rows.map((r) => r.forecast).filter(Boolean),
        rows.map((r) => r.medianGame).filter(Boolean)),
      /* Whether we could tell who has played, and whether we had projections to forecast the rest. Without
         the first, "yet to play" is a guess from kickoff windows; without the second there is no forecast
         at all, and in both cases the page says so rather than printing a confident number built on air. */
      playedKnown: statsKnown,
      projKnown: projStats.size > 0,
      /* ⭐⭐⭐ WHERE THE WEEK IS UP TO. The home page needs this to decide between a live badge, a review
         tab, both (Sunday afternoon) or neither (Wednesday) — and it must not cost a second request to
         find out, or every home-page load pays for a question whose answer is usually "nothing is on". */
      weekState: weekStateFrom(Object.values(kickoffByTeam), now),
      // Whether the kickoff times were there at all. Without them "yet to play" is not a number we have.
      scheduleKnown: Object.keys(kickoffByTeam).length > 0,
      /* ⭐⭐⭐⭐ THE KICKOFF TIMES THEMSELVES, NOT JUST WHAT WE CONCLUDED FROM THEM — b137.
         Trey: "I think this tab could also just have more info / sections for 'game day'."

         The obvious missing section on a Sunday is "which game should I put on" — and that cannot be
         built from `state` alone, because 'pre' collapses the 1pm slate, the 4:25 window and Sunday night
         into one indistinguishable bucket. Every one of these times was already read from the schedule
         two hundred lines above to derive `state` and `weekState`; sending the map costs one small object
         on a response that already carries every starter, and it is the difference between "9 still to
         play" and "four of them are in the 4:25 window, and Jacobs is going against you in five leagues
         at the same time".

         ⚠ SENT AS THE MAP, NOT AS A PRE-BUILT SECTION. Grouping is a rendering decision that depends on
           the reader's time zone, and a server that groups by its own clock gets it wrong for everybody
           not sitting next to it. */
      kickoffs: kickoffByTeam,
      /* The teams among your actual starters that we could not put a clock on — see stateOf above. Sent
         as the team codes rather than a count, so the page can name the players rather than say "some". */
      scheduleMissing: [...missingKick].sort(),
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
      const drafts = (await cached(draftsKey(leagueId), TTL.drafts, () => getLeagueDrafts(leagueId))) || [];
      if (!drafts[0]) return res.json({ status: 'no_draft', picks: [] });
      draftId = drafts[0].draft_id;
    }
    /* ⭐⭐⭐ THIS IS THE HOT PATH OF THE WHOLE APPLICATION.
       Every connected drafter polls here every 2 seconds. It used to make two uncached Sleeper calls per
       poll, so upstream load scaled with the number of PEOPLE rather than the number of DRAFTS: measured
       at 60.5 Sleeper calls per user-minute, which crosses Sleeper's ~1000/min APP-WIDE ceiling at about
       sixteen simultaneous drafters — at which point live sync fails for everybody, not just the sixteen.
       Now both payloads go through a shared per-draft cache with single-flight, so a whole league shares
       one fetch. Re-measured at 2.5 calls per user-minute. See lib/draftCache.js for TTLs and backoff. */
    const [draft, picksRaw, players] = await Promise.all([
      cached(metaKey(draftId), TTL.meta, () => getDraft(draftId)),
      cached(picksKey(draftId), TTL.picks, () => getDraftPicks(draftId)),
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

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
   THE OTHER PLATFORMS
   ───────────────────────────────────────────────────────────────────────────────────────────────────
   Users: "for those of us who are not the commissioners, [making the league public] is not an option.
   Maybe there could be a feature where you would sign into ESPN… perhaps it could also work on
   platforms such as Yahoo and NFL."

   Four are built here and two are deliberately not. The dividing line is what the user has to hand over:

     ESPN private   two session cookies, used for ONE request and never stored (see espnPrivate.js)
     MFL            a per-league read key the commissioner mints; safe to store, LIVE draft picks
     Fantrax        a Secret ID from the user's own profile, revocable by regenerating it; live picks
     Yahoo          real OAuth — a consent screen, no secrets typed anywhere; needs Yahoo's approval

     CBS            NOT BUILT. Its API is deprecated and undocumented, and the only way in is to POST the
                    user's CBS USERNAME AND PASSWORD to an endpoint using the mobile app's hard-coded
                    client secret. Asking a person to type their password into our site so we can replay
                    it elsewhere is not a feature, it is a phishing pattern with a nice UI, and no amount
                    of "we don't store it" makes it a reasonable thing to teach users to do. See
                    /cbs/status for what the user is told instead.
     NFL.com        NOTHING TO BUILD. The NFL stopped running season-long fantasy in 2026 and moved its
                    leagues to ESPN; the migration is at espn.com/importnfl. See /nfl/status.
   ═══════════════════════════════════════════════════════════════════════════════════════════════ */

/* ---- ESPN, private ------------------------------------------------------------------------------
   ⚠ POST, NOT GET. The cookies are credentials: a GET puts them in the URL, which means the query string
     lands in access logs, proxy logs and browser history. This is exactly the "never place sensitive
     data in a query string" rule and it applies to our own server first. */
connectRouter.post('/espn/private', async (req, res) => {
  const { league_id: leagueId, season, espn_s2: s2, swid, team_id: teamId } = req.body || {};
  try {
    const out = await importEspnPrivate(leagueId, season || config.activeSeason, { s2, swid, teamId });
    // ⚠ The response deliberately carries no echo of the cookies. Nothing downstream needs them, and an
    //   echoed credential ends up in a client-side state blob that DOES get stored.
    res.json(out);
  } catch (e) {
    res.status(e && e.status ? e.status : 502).json({ error: String((e && e.message) || 'ESPN import failed'), code: (e && e.code) || null });
  }
});

/* ⚠⚠⚠ EVERY MFL AND FANTRAX ROUTE BELOW IS A POST, AND THAT IS NOT A STYLE CHOICE.
   ───────────────────────────────────────────────────────────────────────────────────────────────────
   They carry a credential — an MFL league API key, a Fantrax Secret ID — and a GET puts a credential in
   the URL, where it is written to the access log of every hop it passes through, kept in the browser's
   history, and handed to the next site in a Referer header. That is the same rule the ESPN private
   import is built around; it applies here with more force, because these are the two platforms the
   draft room POLLS. A GET here does not leak a credential once at import time: it writes it into the
   access log every two seconds for the length of a draft, a few thousand times a night, per user.

   ⚠ THERE IS NO GET FALLBACK. Leaving the old GET in "for compatibility" would leave the leak in place
     for anyone running a cached bundle, which is precisely the population that would still be using it.
   ───────────────────────────────────────────────────────────────────────────────────────────────── */

/* ---- MyFantasyLeague ---------------------------------------------------------------------------- */
connectRouter.post('/mfl/league', async (req, res) => {
  const { league_id: leagueId, season, api_key: apiKey } = req.body || {};
  try {
    res.json(await mflLeague(leagueId, season || config.activeSeason, { apiKey: apiKey || null }));
  } catch (e) {
    res.status(e && e.status ? e.status : 502).json({ error: String((e && e.message) || 'MFL import failed'), code: (e && e.code) || null });
  }
});
// The live poll. MFL is one of only two platforms where this is a real thing rather than a fiction.
connectRouter.post('/mfl/picks', async (req, res) => {
  const { league_id: leagueId, season, api_key: apiKey } = req.body || {};
  try {
    res.json({ picks: await livePicks('mfl', leagueId, season || config.activeSeason, apiKey || null) });
  } catch (e) {
    res.status(e && e.status ? e.status : 502).json({ error: String((e && e.message) || 'MFL picks failed') });
  }
});

/* ---- Fantrax ------------------------------------------------------------------------------------ */
connectRouter.post('/fantrax/leagues', async (req, res) => {
  try { res.json({ leagues: await fantraxLeagues((req.body || {}).secret_id) }); }
  catch (e) { res.status(e && e.status ? e.status : 502).json({ error: String((e && e.message) || 'Fantrax lookup failed'), code: (e && e.code) || null }); }
});
connectRouter.post('/fantrax/league', async (req, res) => {
  const { league_id: leagueId, secret_id: secretId, name } = req.body || {};
  try { res.json(await fantraxLeague(leagueId, { secretId: secretId || null, name: name || null })); }
  catch (e) { res.status(e && e.status ? e.status : 502).json({ error: String((e && e.message) || 'Fantrax import failed'), code: (e && e.code) || null }); }
});
connectRouter.post('/fantrax/picks', async (req, res) => {
  const { league_id: leagueId, secret_id: secretId } = req.body || {};
  try { res.json({ picks: await livePicks('fantrax', leagueId, null, secretId || null) }); }
  catch (e) { res.status(e && e.status ? e.status : 502).json({ error: String((e && e.message) || 'Fantrax picks failed') }); }
});

/* ⭐⭐⭐ ONE UPSTREAM FETCH PER DRAFT, NOT ONE PER VIEWER — the same lesson the Sleeper poll learned the
   expensive way (see src/lib/draftCache.js: twelve people in one league were making sixty upstream
   calls a minute between them, against an app-wide rate limit). MFL and Fantrax are smaller shops than
   Sleeper with no published ceiling at all, and hammering either one from a single IP on a Sunday
   afternoon is how an app gets blocked wholesale.
   ⚠ THE CACHE KEY IS THE LEAGUE, NOT THE CREDENTIAL. Two people in the same league hold different
     credentials and must share one fetch; keying on the credential would give each of them their own,
     which is the entire problem back again — and would put a credential in a cache key besides.
   ⚠ IT DOES RECORD WHETHER THERE WAS ONE. A private league answers only to a key holder, so without
     this a key holder's fetch would warm a cache entry that then served the private draft to anyone
     who knew the league id and had no key at all. Sharing between key holders is the point; sharing
     from a key holder to a stranger is a leak. One bit, no credential, both properties kept. */
function livePicks(platform, leagueId, season, credential) {
  const id = String(leagueId || '').trim();
  if (!id) { const e = new Error('A league id is required.'); e.status = 400; throw e; }
  const key = `livepicks:${platform}:${id}:${season || ''}:${credential ? 'auth' : 'open'}`;
  return cached(key, TTL.picks, () => (platform === 'mfl'
    ? mflPicks(id, season, { apiKey: credential })
    : fantraxPicks(id, { secretId: credential })));
}

/* ---- Yahoo (OAuth) ------------------------------------------------------------------------------
   Tokens live in the users table, next to the Sleeper link, because that is what they are: a link to an
   account. ⚠ NOTHING ELSE FROM YAHOO IS PERSISTED SERVER-SIDE — their terms require user data to be
   deleted within 24 hours, so leagues go straight to the client's own state and no cache table exists. */
async function ensureYahooCols() {
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS yahoo_access  TEXT`).catch(() => {});
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS yahoo_refresh TEXT`).catch(() => {});
  await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS yahoo_expires BIGINT`).catch(() => {});
}
connectRouter.get('/yahoo/status', async (req, res) => {
  if (!yahooConfigured()) return res.json({ configured: false, linked: false, why: 'This server has no Yahoo application credentials yet.' });
  await ensureYahooCols();
  const { rows } = await q('SELECT yahoo_refresh FROM users WHERE id=$1', [req.user.id]).catch(() => ({ rows: [] }));
  res.json({ configured: true, linked: !!(rows[0] && rows[0].yahoo_refresh) });
});
connectRouter.get('/yahoo/auth-url', async (req, res) => {
  try { res.json({ url: yahooAuthUrl(String(req.user.id)) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message, code: e.code || null }); }
});
connectRouter.post('/yahoo/exchange', async (req, res) => {
  try {
    await ensureYahooCols();
    const t = await yahooExchange(String((req.body || {}).code || '').trim());
    await q('UPDATE users SET yahoo_access=$1, yahoo_refresh=$2, yahoo_expires=$3 WHERE id=$4',
      [t.accessToken, t.refreshToken, t.expiresAt, req.user.id]);
    res.json({ ok: true, linked: true });
  } catch (e) { res.status(e.status || 502).json({ error: e.message, code: e.code || null }); }
});
connectRouter.post('/yahoo/unlink', async (req, res) => {
  await ensureYahooCols();
  await q('UPDATE users SET yahoo_access=NULL, yahoo_refresh=NULL, yahoo_expires=NULL WHERE id=$1', [req.user.id]).catch(() => {});
  res.json({ ok: true, linked: false });
});
// One hour is short enough that almost every call needs this; refreshing eagerly is cheaper than
// handling a 401 in four places.
async function yahooToken(userId) {
  await ensureYahooCols();
  const { rows } = await q('SELECT yahoo_access, yahoo_refresh, yahoo_expires FROM users WHERE id=$1', [userId]);
  const r = rows[0];
  if (!r || !r.yahoo_refresh) { const e = new Error('Connect your Yahoo account first.'); e.status = 401; e.code = 'YAHOO_NOT_LINKED'; throw e; }
  if (r.yahoo_access && Number(r.yahoo_expires || 0) > Date.now() + 60000) return r.yahoo_access;
  const t = await yahooRefresh(r.yahoo_refresh);
  await q('UPDATE users SET yahoo_access=$1, yahoo_refresh=$2, yahoo_expires=$3 WHERE id=$4',
    [t.accessToken, t.refreshToken, t.expiresAt, userId]);
  return t.accessToken;
}
connectRouter.get('/yahoo/my-leagues', async (req, res) => {
  try { res.json({ leagues: await yahooMyLeagues(await yahooToken(req.user.id)) }); }
  catch (e) { res.status(e.status || 502).json({ error: e.message, code: e.code || null }); }
});
connectRouter.get('/yahoo/league', async (req, res) => {
  try { res.json(await yahooLeague(req.query.league_key, await yahooToken(req.user.id))); }
  catch (e) { res.status(e.status || 502).json({ error: e.message, code: e.code || null }); }
});

/* ---- The two we are not building, and why -------------------------------------------------------
   These answer honestly rather than 404ing, so the UI can show the real reason instead of a dead end. */
connectRouter.get('/cbs/status', (_req, res) => res.json({
  supported: false,
  reason: "CBS shut its developer API down years ago. The only remaining way in requires you to type your CBS password into a third-party site so it can be replayed against a private endpoint — we won't ask anyone to do that.",
  instead: 'Set the league up by hand once (about a minute) and enter picks as they happen. Everything else in the app works the same.',
}));
connectRouter.get('/nfl/status', (_req, res) => res.json({
  supported: false,
  reason: 'The NFL stopped running season-long fantasy football in 2026 — ESPN is now the official fantasy game of the NFL, and NFL.com leagues were migrated there with their settings and history.',
  instead: 'Import your league at espn.com/importnfl (the league manager has to start it), then connect it here as an ESPN league.',
}));
