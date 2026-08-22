// WEEKLY BRIEF — the retention job.
//
// A draft tool gets opened for about three weeks a year; an in-season tool gets opened seventeen, but only
// if there's a reason to open it. This is that reason: every Tuesday morning, after waivers have run and
// the NFL week has rolled over, each linked user gets a short email naming what actually needs attention in
// their leagues, with a link straight into the hub.
//
// SCOPE, DELIBERATELY NARROW. The in-app Weekly Brief is far richer (close calls, FAAB bids with the
// league-wide competition read, trade ideas, playoff-odds deltas) because it runs the full scoring engine
// in the browser. Porting that engine here would mean a second copy of it to keep in sync, which is exactly
// the trap the single buildDigest() function was written to avoid. So the email answers only the questions
// this server can answer correctly and cheaply — your lineup, your byes, your matchup — and sends you to
// the app for the rest. Better a short true email than a long duplicated one that drifts.
//
// Requires RESEND_API_KEY + BRIEF_FROM. Without them the job no-ops and logs, so it's safe to schedule
// before the mail account exists.
import { q } from '../lib/db.js';
import { log } from '../lib/log.js';
import { config } from '../lib/config.js';
import {
  getUserLeagues, getLeague, getLeagueRosters, getMatchups,
  getNflState, getWeeklyProjections, getAllPlayers,
} from '../lib/sleeper.js';

const APP_URL = process.env.APP_URL || 'https://www.fantasydraftcompass.com';

// ---- the smallest honest lineup optimizer -----------------------------------------------------------
// Mirrors the app's slot rules: base positions first, then FLEX (RB/WR/TE), then SUPER_FLEX (any of the
// four). Kickers and defenses are ignored on purpose — nobody benches a kicker by mistake, and leaving
// them out keeps this from disagreeing with the app over a slot it doesn't optimize either.
function bestLineup(roster, start) {
  const byPos = { QB: [], RB: [], WR: [], TE: [] };
  roster.forEach((p) => { if (byPos[p.pos]) byPos[p.pos].push(p); });
  Object.keys(byPos).forEach((k) => byPos[k].sort((a, b) => b.pts - a.pts));
  const used = { QB: 0, RB: 0, WR: 0, TE: 0 };
  const picked = [];
  const take = (pos) => { const p = byPos[pos][used[pos]]; if (p) { used[pos]++; picked.push(p); } };
  for (let i = 0; i < (start.QB || 0); i++) take('QB');
  for (let i = 0; i < (start.RB || 0); i++) take('RB');
  for (let i = 0; i < (start.WR || 0); i++) take('WR');
  for (let i = 0; i < (start.TE || 0); i++) take('TE');
  for (let i = 0; i < (start.FLEX || 0); i++) {
    let best = null, bp = null;
    ['RB', 'WR', 'TE'].forEach((pos) => { const p = byPos[pos][used[pos]]; if (p && (!best || p.pts > best.pts)) { best = p; bp = pos; } });
    if (best) { used[bp]++; picked.push(best); }
  }
  for (let i = 0; i < (start.SUPER || 0); i++) {
    let best = null, bp = null;
    ['QB', 'RB', 'WR', 'TE'].forEach((pos) => { const p = byPos[pos][used[pos]]; if (p && (!best || p.pts > best.pts)) { best = p; bp = pos; } });
    if (best) { used[bp]++; picked.push(best); }
  }
  return picked;
}

// Sleeper's roster_positions -> the app's start-slot shape.
function startFromPositions(positions) {
  const start = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0, SUPER: 0 };
  (positions || []).forEach((slot) => {
    if (slot === 'QB') start.QB++;
    else if (slot === 'RB') start.RB++;
    else if (slot === 'WR') start.WR++;
    else if (slot === 'TE') start.TE++;
    else if (slot === 'FLEX' || slot === 'REC_FLEX' || slot === 'WRRB_FLEX') start.FLEX++;
    else if (slot === 'SUPER_FLEX') start.SUPER++;
  });
  return start;
}

const sum = (arr) => Math.round(arr.reduce((s, p) => s + (p.pts || 0), 0) * 10) / 10;

// ---- one user's brief -------------------------------------------------------------------------------
async function briefForUser({ sleeperUserId, season, week }, playersById) {
  const leagues = (await getUserLeagues(sleeperUserId, season)) || [];
  if (!leagues.length) return null;

  // This week's projections, in the plain PPR/standard field. The app recomputes points from raw stats
  // against each league's exact scoring; here we only need a RANKING to spot a bad lineup, and the
  // pre-summed field is good enough for that. The email never quotes a projected total as fact.
  let weekly = {};
  try {
    const wp = (await getWeeklyProjections(season, week)) || [];
    wp.forEach((row) => { if (row.player_id) weekly[row.player_id] = row.stats || {}; });
  } catch { weekly = {}; }

  const lines = [];
  for (const lg of leagues.slice(0, 8)) {
    try {
      const [full, rosters] = await Promise.all([getLeague(lg.league_id), getLeagueRosters(lg.league_id)]);
      if (!full || !Array.isArray(rosters)) continue;
      const mine = rosters.find((r) => r.owner_id === sleeperUserId);
      if (!mine) continue;

      const recPts = Number((full.scoring_settings || {}).rec) || 0;
      const field = recPts >= 1 ? 'pts_ppr' : recPts >= 0.5 ? 'pts_half_ppr' : 'pts_std';
      const start = startFromPositions(full.roster_positions);

      const resolve = (ids) => (ids || []).filter(Boolean).map((id) => {
        const meta = playersById[id] || {};
        const st = weekly[id] || {};
        return { id, name: meta.full_name || meta.last_name || String(id), pos: meta.position || null, bye: meta.bye_week || null, pts: Number(st[field] || 0) };
      });

      const roster = resolve(mine.players);
      if (!roster.length) continue;

      // What they've actually set this week vs what they could set.
      let setStarters = resolve(mine.starters);
      try {
        const ms = await getMatchups(lg.league_id, week);
        const m = Array.isArray(ms) ? ms.find((x) => x.roster_id === mine.roster_id) : null;
        if (m && Array.isArray(m.starters) && m.starters.length) setStarters = resolve(m.starters);
      } catch { /* keep the roster-level starters */ }

      const optimal = bestLineup(roster, start);
      // Compare like with like: the optimizer ignores K/DST, so drop them from the set lineup too.
      const setSkill = setStarters.filter((p) => ['QB', 'RB', 'WR', 'TE'].includes(p.pos));
      const gain = Math.round((sum(optimal) - sum(setSkill)) * 10) / 10;

      const swapIn = optimal.filter((p) => !setSkill.some((s) => s.id === p.id)).slice(0, 2);

      // Byes among the players they'd normally start, over the next five weeks.
      const startingIds = new Set(optimal.map((p) => p.id));
      const byeAhead = [];
      for (let w = week + 1; w <= week + 5; w++) {
        const out = roster.filter((p) => p.bye === w && startingIds.has(p.id));
        if (out.length >= 2) byeAhead.push(`week ${w}: ${out.length} starters on bye`);
      }

      const bits = [];
      if (gain >= 1 && swapIn.length) {
        bits.push(`${gain} points on your bench — consider starting ${swapIn.map((p) => p.name).join(' and ')}`);
      } else if (gain < 1) {
        bits.push('lineup looks optimal');
      }
      if (byeAhead.length) bits.push(byeAhead[0]);
      if (bits.length) lines.push({ league: full.name || 'Your league', bits, gain });
    } catch (e) { /* one bad league never kills the whole brief */ }
  }
  return lines.length ? lines : null;
}

// ---- send -------------------------------------------------------------------------------------------
async function sendEmail({ to, subject, text }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.BRIEF_FROM || process.env.FEEDBACK_FROM;
  if (!key || !from) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to, subject, text }),
  });
  return res.ok;
}

export async function sendWeeklyBriefs({ limit = 500, dryRun = false } = {}) {
  if (!process.env.RESEND_API_KEY && !dryRun) {
    log.info('weeklyBrief: RESEND_API_KEY not set — skipping (this is expected until mail is configured)');
    return { skipped: true, sent: 0 };
  }
  const nfl = await getNflState().catch(() => null);
  const season = (nfl && nfl.season) || String(config.activeSeason);
  const week = Math.min(18, Math.max(1, Number(nfl && (nfl.display_week || nfl.week)) || 1));
  // Out of season there is nothing to brief.
  if (nfl && nfl.season_type && nfl.season_type !== 'regular') {
    log.info({ seasonType: nfl.season_type }, 'weeklyBrief: not the regular season — nothing to send');
    return { skipped: true, sent: 0 };
  }

  const { rows } = await q(
    `SELECT id, email, sleeper_user_id FROM users
      WHERE sleeper_user_id IS NOT NULL AND email IS NOT NULL AND disabled IS NOT TRUE
        AND (comp = TRUE OR is_admin = TRUE OR (paid_until IS NOT NULL AND paid_until > now()))
      LIMIT $1`, [limit]);

  let sent = 0, empty = 0, failed = 0;
  const players = await getAllPlayers().catch(() => ({}));
  for (const u of rows) {
    try {
      const lines = await briefForUser({ sleeperUserId: u.sleeper_user_id, season, week }, players);
      if (!lines) { empty++; continue; }
      // Lead with the league that needs the most attention.
      lines.sort((a, b) => (b.gain || 0) - (a.gain || 0));
      const head = lines[0].gain >= 1 ? `${lines[0].gain} points are sitting on your bench` : `Week ${week} check-in`;
      const text = [
        `Week ${week} — Fantasy Draft Compass`, '',
        ...lines.flatMap((l) => [l.league, ...l.bits.map((b) => `  · ${b}`), '']),
        `Open your hub for close calls, waiver bids and playoff odds:`, APP_URL, '',
        `You're getting this because your Sleeper account is linked. Reply to this email to turn it off.`,
      ].join('\n');
      if (dryRun) { log.info({ to: u.email, head, leagues: lines.length }, 'weeklyBrief dry run'); sent++; continue; }
      const ok = await sendEmail({ to: u.email, subject: `Week ${week}: ${head}`, text });
      if (ok) sent++; else failed++;
    } catch (e) { failed++; log.warn({ err: String(e && e.message), user: u.id }, 'weeklyBrief: user failed'); }
  }
  return { candidates: rows.length, sent, empty, failed, week, season };
}

// Allow `node src/jobs/weeklyBrief.js --dry` to preview without sending.
if (import.meta.url === `file://${process.argv[1]}`) {
  sendWeeklyBriefs({ dryRun: process.argv.includes('--dry') })
    .then((r) => { log.info(r, 'weeklyBrief done'); process.exit(0); })
    .catch((e) => { log.error(e, 'weeklyBrief failed'); process.exit(1); });
}
