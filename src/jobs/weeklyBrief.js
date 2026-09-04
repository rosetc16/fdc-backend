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
import { unsubLink, ensureBriefColumn } from '../routes/brief.js';

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
      /* ⚠⚠⚠ NO SET LINEUP MEANS WE KNOW NOTHING, NOT THAT EVERYTHING IS BENCHED. `sum([])` is 0, so an
         empty `setSkill` made `gain` the WHOLE optimal total — and this email goes out on TUESDAY MORNING,
         which is exactly when a lineup for the coming week may not be set yet and Sleeper can answer with
         no starters at all. The first brief anybody ever received would have opened "94.6 points are
         sitting on your bench", which is both false and alarming, and there is no taking an email back.
         ⚠ AND A PARTIAL LINEUP IS THE SAME BUG IN MINIATURE: if the feed returns three starters where the
         league starts nine, the six missing ones all count as bench points. Require the set lineup to be
         the size the optimizer produced before comparing them at all. */
      const skillSlots = optimal.length;
      const lineupKnown = setSkill.length >= skillSlots && skillSlots > 0;
      const gain = lineupKnown ? Math.round((sum(optimal) - sum(setSkill)) * 10) / 10 : null;

      const swapIn = lineupKnown ? optimal.filter((p) => !setSkill.some((s) => s.id === p.id)).slice(0, 2) : [];

      // Byes among the players they'd normally start, over the next five weeks.
      const startingIds = new Set(optimal.map((p) => p.id));
      const byeAhead = [];
      for (let w = week + 1; w <= week + 5; w++) {
        const out = roster.filter((p) => p.bye === w && startingIds.has(p.id));
        if (out.length >= 2) byeAhead.push(`week ${w}: ${out.length} starters on bye`);
      }

      /* `actionable` is what decides whether this email is worth sending at all — see the caller. A league
         whose only news is "lineup looks optimal" is worth a line once you are already reading, and is not
         worth an email on its own. */
      const bits = [];
      let actionable = false;
      if (gain != null && gain >= 1 && swapIn.length) {
        bits.push(`${gain} points on your bench — consider starting ${swapIn.map((p) => p.name).join(' and ')}`);
        actionable = true;
      } else if (gain != null) {
        bits.push('lineup looks optimal');
      }
      if (byeAhead.length) { bits.push(byeAhead[0]); actionable = true; }
      if (bits.length) lines.push({ league: full.name || 'Your league', bits, gain: gain || 0, actionable });
    } catch (e) { /* one bad league never kills the whole brief */ }
  }
  return lines.length ? lines : null;
}

// ---- send -------------------------------------------------------------------------------------------
async function sendEmail({ to, subject, text, unsubscribe }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.BRIEF_FROM || process.env.FEEDBACK_FROM;
  if (!key || !from) return false;
  /* ⭐ ONE-CLICK UNSUBSCRIBE HEADERS (RFC 8058). Gmail and Yahoo have REQUIRED these of bulk senders since
     2024: with them the mail client shows its own unsubscribe button beside the sender name and POSTs to
     the URL; without them, mail from a young domain to a list of addresses is markedly likelier to be
     filed as spam whatever the body says — and if this domain's reputation goes, it takes PASSWORD RESET
     mail down with it, which is the one email a user genuinely cannot do without. */
  const headers = unsubscribe ? {
    'List-Unsubscribe': `<${unsubscribe}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  } : undefined;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to, subject, text, ...(headers ? { headers } : {}) }),
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

  /* ⭐⭐⭐⭐ OPT-IN. `brief_opt_in IS TRUE` — not "IS NOT FALSE", not a NULL-tolerant test.
       Trey: "I don't think I want to send automated emails unless someone subscribes to them."
     The column defaults to FALSE and backfills every existing row that way, so this query returns NOBODY
     until somebody switches it on from their account page. That is the intended state, and a run that
     reports `candidates: 0` is this working rather than failing.
     ⚠ THE SUBSCRIPTION CHECK BELOW IS NOT THE CONSENT CHECK. Paying for a season pass is not asking for
       email, and the two conditions must stay separate — folding them together is how "our users" quietly
       becomes "our mailing list". */
  await ensureBriefColumn();
  const { rows } = await q(
    `SELECT id, email, sleeper_user_id FROM users
      WHERE sleeper_user_id IS NOT NULL AND email IS NOT NULL AND disabled IS NOT TRUE
        AND brief_opt_in IS TRUE
        AND (comp = TRUE OR is_admin = TRUE OR (paid_until IS NOT NULL AND paid_until > now()))
      LIMIT $1`, [limit]);

  let sent = 0, empty = 0, failed = 0, nothingToSay = 0;
  const players = await getAllPlayers().catch(() => ({}));
  for (const u of rows) {
    try {
      const lines = await briefForUser({ sleeperUserId: u.sleeper_user_id, season, week }, players);
      if (!lines) { empty++; continue; }
      /* ⭐⭐ AN EMAIL WITH NOTHING IN IT IS WORSE THAN NO EMAIL. `bits` almost always contains at least
         "lineup looks optimal", so before this every linked user got a message every Tuesday whether or
         not anything needed doing — under the subject "Week 3 check-in", which is precisely the mail people
         learn to delete unread, and then miss the week their lineup IS wrong. This job exists for
         retention; a weekly nothing burns exactly the attention it is trying to earn. */
      if (!lines.some((l) => l.actionable)) { nothingToSay++; continue; }
      // Lead with the league that needs the most attention.
      lines.sort((a, b) => (b.gain || 0) - (a.gain || 0));
      const head = lines[0].gain >= 1 ? `${lines[0].gain} points are sitting on your bench` : `Week ${week} check-in`;
      const unsub = unsubLink(u.id);
      const text = [
        `Week ${week} — Fantasy Draft Compass`, '',
        ...lines.flatMap((l) => [l.league, ...l.bits.map((b) => `  · ${b}`), '']),
        `Open your hub for close calls, waiver bids and playoff odds:`, APP_URL, '',
        `You asked for this weekly email from Fantasy Draft Compass.`,
        `Stop it any time: ${unsub}`,
      ].join('\n');
      if (dryRun) { log.info({ to: u.email, head, leagues: lines.length }, 'weeklyBrief dry run'); sent++; continue; }
      const ok = await sendEmail({ to: u.email, subject: `Week ${week}: ${head}`, text, unsubscribe: unsub });
      if (ok) sent++; else failed++;
    } catch (e) { failed++; log.warn({ err: String(e && e.message), user: u.id }, 'weeklyBrief: user failed'); }
  }
  return { candidates: rows.length, sent, empty, nothingToSay, failed, week, season };
}

// Allow `node src/jobs/weeklyBrief.js --dry` to preview without sending.
if (import.meta.url === `file://${process.argv[1]}`) {
  sendWeeklyBriefs({ dryRun: process.argv.includes('--dry') })
    .then((r) => { log.info(r, 'weeklyBrief done'); process.exit(0); })
    .catch((e) => { log.error(e, 'weeklyBrief failed'); process.exit(1); });
}
