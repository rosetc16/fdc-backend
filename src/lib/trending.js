/* ⭐⭐⭐⭐⭐ WHO IS ABOUT TO BE GOOD, AND WHY — b142.
 * ==================================================================================================
 * Trey: "targets, yards, points, stuff like that are certainly an indication of value. Also, what that
 * doesn't capture is like if there was an injury and someone's taking over as the starter type of deal.
 * Maybe we can pull data from other sources to suggest there's new roster, like… percentage owned."
 *
 * He named three things and they are not three versions of one thing — they sit at different points in
 * the life of a breakout, and that ordering is the whole design:
 *
 *   OPPORTUNITY   the back ahead of him went on IR an hour ago.        Knowable BEFORE any stat moves.
 *   ROLE          his snap share jumped from a third to two thirds.    Visible the Monday after.
 *   USAGE         his target share has been climbing for three weeks.  Certain, and by now he is gone.
 *   OWNERSHIP     the rest of the world is adding him right now.       Fast, noisy, and a race.
 *
 * ⚠⚠ THESE ARE NOT BLENDED INTO A SCORE, AND THAT IS A DECISION RATHER THAN AN OMISSION. Trey, on the
 *   free-agent list: "I want the green to draw attention to something you should really do." A composite
 *   number cannot do that, because the four mean different things and call for different actions: an
 *   opportunity change says CLAIM HIM TONIGHT, a usage trend says he is genuinely good and worth a bench
 *   spot, an ownership surge says you are in a race you may already be losing. Averaging them produces a
 *   number that is never wrong and never useful. Each signal fires under its own name, carries its own
 *   sentence, and the caller decides what to do with the set.
 *
 * ⚠⚠⚠ EVERY SIGNAL DISTINGUISHES "NO TREND" FROM "NO DATA", AND THIS IS THE MOST IMPORTANT LINE IN THE
 *   FILE. This backend cannot be reached from the sandbox these signals were written in, so the field
 *   names below are read off the codebase's existing mappers and Sleeper's documented shapes rather than
 *   from a live response. If one of them is wrong, a signal computed as `false` is indistinguishable from
 *   a signal that never had its input — the failure is silent, the page simply looks calm, and nobody
 *   learns anything. So a signal with no input returns NULL, never false, and `auditFields` below counts
 *   what actually arrived so the admin screen can say "off_snp: 0 of 812 players" out loud.
 *   (The same shape as the 20an legalCands bug and the 23a payment catch: a silent fallback is worse than
 *   an error, every time.)
 */

/* ⚠ A FLAG THAT FIRES FOR EVERYBODY IS NOT A DETECTOR — 29m and 29o, twice, on this project. The early-plan
   "still there at your next pick" flag fired for nobody; the positional-run detector fired for all four
   positions in 100% of mocks. Both passed every other kind of check, because "does this separate the
   field" is a question you have to ask on purpose. Hence the absolute floors below: a player going from
   one target to three has tripled his usage and told you nothing, and without a floor he outranks a man
   who went from eight to fourteen. Every threshold here is a PAIR — a ratio and a floor. */
/* ⚠ THIS FLOOR STARTED AT 4.0 AND THE DISCRIMINATION TEST MOVED IT. A player on 4.5 touches+targets a
   game, up from 2.5, cleared all three gates and fired — and he is not a free agent anybody should act
   on. Four opportunities a game is a deep bench flier in any league size; the number that makes a man
   worth a roster spot is closer to six and climbing, and a flex-worthy workload is eight or more.
   ⭐ THE FIXTURE CHANGED THE THRESHOLD, NOT THE OTHER WAY ROUND — the player was left in the field as a
     must-NOT-fire case, because the honest fix was the constant. Tuning a fixture until a threshold looks
     right is how a detector ends up measuring how hard you looked (the 29o run-detection lesson). */
const USAGE_MIN_RECENT = 6.0;     // touches+targets per game; below this the percentage is noise
const USAGE_RATIO = 1.5;          // recent must be half again the baseline
const USAGE_MIN_GAIN = 2.0;       // …and at least two real opportunities more
const SNAP_MIN_RECENT = 0.55;     // he is on the field for most of the offence
const SNAP_MIN_JUMP = 0.15;       // …and that is a real change, not week-to-week wobble
/* ⚠ A RANK, NOT A COUNT — 29x. This was `count >= 1000`, and Sleeper hosts millions of leagues: a
   thousand adds is an ordinary week for anyone mildly interesting, so dozens of players fired and Trey's
   free-agent list came back with 60+ names. "Top 25 most added in the country" means the same thing every
   week regardless of how busy it was, which an absolute threshold cannot. */
const OWN_MAX_RANK = 25;

const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/* Opportunities in one week: the things a coach CHOOSES to give a man. Carries and targets are decisions;
   yards and points are outcomes, and outcomes are noisier than decisions — a 60-yard screen is one target.
   That is why this counts touches rather than production, even though Trey mentioned yards: production is
   what the rest of the page already ranks on, and repeating it here would just be the same signal twice. */
export function opportunityOf(stat) {
  if (!stat) return null;
  const tgt = num(stat.rec_tgt);
  const att = num(stat.rush_att);
  if (tgt == null && att == null) return null;      // no usage fields at all — NOT zero opportunity
  return (tgt || 0) + (att || 0);
}

/* Share of his own offence's snaps. `tm_off_snp` is the team total and is already known to scoring.js,
   which is where the spelling comes from; `off_snp` is the player's own and is the one this cannot
   verify from here. Returns null rather than 0 when either is missing. */
export function snapShareOf(stat) {
  if (!stat) return null;
  const own = num(stat.off_snp);
  const team = num(stat.tm_off_snp);
  if (own == null || team == null || team <= 0) return null;
  return Math.max(0, Math.min(1, own / team));
}

/* ⭐⭐⭐⭐ USAGE — the slow, certain one.
   `weeks` is oldest-first, one stat object per week the player appeared, and the split is deliberately
   uneven: the last TWO weeks against everything before them. Two is enough to see a change and short
   enough that a three-week-old change has already moved into the baseline and stopped firing — which is
   what stops this shouting about somebody the whole league claimed a fortnight ago. */
export function usageTrend(weeks) {
  const list = (weeks || []).filter(Boolean);
  const opps = list.map(opportunityOf);
  const known = opps.filter((o) => o != null);
  // Fewer than three readable weeks cannot produce a baseline AND a recent window. That is NO DATA.
  if (known.length < 3) return null;
  const recent = opps.slice(-2).filter((o) => o != null);
  const base = opps.slice(0, -2).filter((o) => o != null);
  if (!recent.length || !base.length) return null;
  const rAvg = avg(recent), bAvg = avg(base);
  const fired = rAvg >= USAGE_MIN_RECENT && rAvg >= bAvg * USAGE_RATIO && (rAvg - bAvg) >= USAGE_MIN_GAIN;
  return {
    kind: 'usage', fired,
    recent: r2(rAvg), baseline: r2(bAvg), weeks: known.length,
    /* The sentence names both numbers, because "trending up" without them is a claim the reader cannot
       check — and this page has been burned before by a colour nobody could interrogate. */
    why: fired
      ? `${r2(rAvg)} touches+targets a game over the last ${recent.length}, up from ${r2(bAvg)}`
      : `usage flat (${r2(rAvg)} recent vs ${r2(bAvg)} before)`,
    strength: fired ? Math.min(1, (rAvg - bAvg) / 8) : 0,
  };
}

/* ⭐⭐⭐⭐ ROLE — the same question asked of snaps rather than touches, which catches the cases usage
   misses: a committee back who takes over early-down work, a receiver moved into the slot. A man can be
   on the field far more without the ball finding him yet, and that gap is exactly where the value is. */
export function roleTrend(weeks) {
  const list = (weeks || []).filter(Boolean);
  const shares = list.map(snapShareOf);
  const known = shares.filter((s) => s != null);
  if (known.length < 2) return null;                 // no snap data — NOT a role of zero
  const recent = shares.slice(-1).filter((s) => s != null);
  const base = shares.slice(0, -1).filter((s) => s != null);
  if (!recent.length || !base.length) return null;
  const rAvg = avg(recent), bAvg = avg(base);
  const fired = rAvg >= SNAP_MIN_RECENT && (rAvg - bAvg) >= SNAP_MIN_JUMP;
  const pct = (x) => `${Math.round(x * 100)}%`;
  return {
    kind: 'role', fired,
    recent: r2(rAvg), baseline: r2(bAvg),
    why: fired
      ? `on the field for ${pct(rAvg)} of snaps last week, up from ${pct(bAvg)}`
      : `snap share steady at ${pct(rAvg)}`,
    strength: fired ? Math.min(1, (rAvg - bAvg) / 0.4) : 0,
  };
}

/* ⭐⭐⭐⭐⭐ OPPORTUNITY — the early one, and the only signal that can beat your league to a player.
   Trey: "if there was an injury and someone's taking over as the starter type of deal."

   Nothing here is about the player's own performance. It asks one question about the depth chart: is the
   man in front of him unavailable? That is knowable the moment a team makes an announcement, days before
   a single snap is played, which is the entire reason it is worth having alongside three lagging signals.

   ⚠ `depth_chart_order` IS 1-BASED AND SOMETIMES ABSENT, and a missing order must not read as "he is the
     starter". A player with no depth-chart position gets NULL from this, not false.
   ⚠ AND ONLY A REAL ABSENCE COUNTS. "Questionable" is the most common tag in football and means very
     little by itself — treating it as a promotion would fire this for half the league every Friday, which
     is the flag-fires-for-everyone failure this file opens by warning about. */
const OUT_STATUSES = new Set(['out', 'ir', 'injured reserve', 'doubtful', 'pup', 'sus', 'suspended', 'dnr']);
export function isUnavailable(status) {
  if (!status) return false;
  return OUT_STATUSES.has(String(status).trim().toLowerCase());
}

export function opportunityChange(player, teammates) {
  if (!player) return null;
  const pos = player.depth_chart_position || player.position || null;
  const myOrder = num(player.depth_chart_order);
  if (!pos || myOrder == null) return null;          // no depth chart for him — NO DATA, not "starter"
  const ahead = (teammates || []).filter((t) => t
    && String(t.player_id) !== String(player.player_id)
    && (t.depth_chart_position || t.position) === pos
    && num(t.depth_chart_order) != null
    && num(t.depth_chart_order) < myOrder);
  // Nobody ahead of him at all: he IS the starter. That is a fact, not a change, and not this signal.
  if (!ahead.length) {
    return { kind: 'opportunity', fired: false, why: `already the ${pos}1`, blockers: 0, strength: 0 };
  }
  const out = ahead.filter((t) => isUnavailable(t.injury_status));
  const fired = out.length === ahead.length;         // EVERY man ahead of him is unavailable
  const names = out.map((t) => t.full_name || t.last_name || t.player_id).filter(Boolean);
  return {
    kind: 'opportunity', fired,
    blockers: ahead.length, blockersOut: out.length,
    why: fired
      ? (names.length === 1
        ? `steps up with ${names[0]} out`
        : `steps up with ${names.slice(0, 2).join(' and ')} out`)
      : `${ahead.length - out.length} still ahead of him on the depth chart`,
    /* Strongest when he is stepping into a clear job — one man out ahead of him — rather than being the
       last of four names standing. */
    strength: fired ? Math.min(1, 1 / Math.max(1, ahead.length)) : 0,
  };
}

/* ⭐⭐⭐ OWNERSHIP — the crowd, and the one worth the most scepticism.
   Trey: "maybe we can pull data from other sources to suggest there's new roster… percentage owned."

   Sleeper publishes adds across every league it hosts, which is the closest thing to a free ownership feed
   that exists and needs no key. But on its own it is the least useful of the four, because by the time a
   player is being added everywhere the sharp managers in YOUR league have already claimed him — it tells
   you about a race you are probably losing.

   ⭐ THE INVERSION IS WHAT MAKES IT WORTH SHIPPING. A player being added all over the country who is STILL
     SITTING FREE IN YOUR LEAGUE is a genuine gap between what the world knows and what your leaguemates
     have noticed, and that gap is the most actionable thing on the page. So this signal is only ever
     computed for players the caller has already established are available — it is not a ranking of the
     wire, it is a statement about YOUR wire.
   ⚠ `count` IS ADDS, NOT PERCENT OWNED. Sleeper does not publish ownership percentage; adds over a window
     is a rate of change, which is arguably the better signal anyway but must not be LABELLED as ownership,
     or the number on screen means something different from what it says. */
export function ownershipSurge(playerId, addsByPlayer) {
  if (!addsByPlayer || typeof addsByPlayer.get !== 'function') return null;   // no feed — NO DATA
  if (!addsByPlayer.size) return null;
  const entry = addsByPlayer.get(String(playerId));
  if (entry == null) {
    // He is simply not on the trending list. That IS an answer: the crowd is not moving on him.
    return { kind: 'ownership', fired: false, adds: 0, rank: null, why: 'not being widely added', strength: 0 };
  }
  // Older callers passed a bare count; accept both so a stale cache cannot throw.
  const count = num(typeof entry === 'object' ? entry.count : entry);
  const rank = typeof entry === 'object' && Number.isFinite(entry.rank) ? entry.rank : null;
  const fired = rank != null && rank <= OWN_MAX_RANK;
  return {
    kind: 'ownership', fired, adds: count == null ? 0 : count, rank,
    why: fired
      ? `one of the most added players in the country right now (#${rank})${count != null ? `, ${count.toLocaleString('en-US')} leagues in a day` : ''} — and still free in yours`
      : `being added, but well down the list${rank != null ? ` (#${rank})` : ''}`,
    strength: fired ? Math.max(0.2, 1 - (rank - 1) / OWN_MAX_RANK) : 0,
  };
}

/* ⭐⭐⭐⭐⭐ THE SET, NOT A SCORE. Returns every signal that could be computed, the ones that fired, and
   which one leads — ordered by how EARLY it is rather than how strong, because the whole value of this
   feature is getting to a player before the league does. A man whose blocker is on IR is a more urgent
   add than one with a nice three-week target trend, even though the trend is better evidence.
   ⚠ `unknown` is the list of signals that had NO INPUT, and it is returned rather than hidden so the
     caller can tell "we checked and there is nothing" from "we could not check". */
export const SIGNAL_ORDER = ['opportunity', 'role', 'usage', 'ownership'];

export function trendFor({ player, teammates, weeks, addsByPlayer }) {
  const computed = [
    opportunityChange(player, teammates),
    roleTrend(weeks),
    usageTrend(weeks),
    ownershipSurge(player && player.player_id, addsByPlayer),
  ];
  const known = computed.filter(Boolean);
  const unknown = SIGNAL_ORDER.filter((k) => !known.some((s) => s.kind === k));
  const fired = known.filter((s) => s.fired)
    .sort((a, b) => SIGNAL_ORDER.indexOf(a.kind) - SIGNAL_ORDER.indexOf(b.kind));
  return {
    signals: known,
    fired,
    unknown,
    top: fired.length ? fired[0] : null,
    /* A rough urgency, used ONLY for ordering rows that all fired — never shown as a number and never
       the reason for the colour, which is the top signal's own name. */
    rank: fired.reduce((s, x) => s + (x.strength || 0) * (4 - SIGNAL_ORDER.indexOf(x.kind)), 0),
  };
}

/* ⭐⭐⭐⭐⭐ WHAT ACTUALLY ARRIVED — the instrument, shipped in the same build as the feature.
   ==================================================================================================
   Every field name in this file was read off the existing mappers and Sleeper's documented shapes, not
   off a live response, because the environment this was written in cannot reach Sleeper. `off_snp` in
   particular is a guess with good reasons behind it (scoring.js already knows `tm_off_snp`) and no proof.

   If it is wrong, `roleTrend` returns null for every player forever, the page shows three signals instead
   of four, and NOTHING ANYWHERE SAYS SO. That is the exact shape of the bug that has cost this project
   the most time, five separate occasions, under the name "drop on the floor".

   So the admin screen gets a button that prints this: for each field, how many players carried it. A row
   reading `off_snp: 0 / 812` is a one-line fix and an obvious one. A row reading `off_snp: 780 / 812` is
   proof the signal is live. Either way somebody knows. */
export function auditFields(statRows, playerRows, addsByPlayer) {
  const stats = (statRows || []).filter(Boolean);
  const players = (playerRows || []).filter(Boolean);
  const countStat = (key) => stats.filter((r) => {
    const s = r && (r.stats || r);
    return s && s[key] != null;
  }).length;
  const countPlayer = (key) => players.filter((p) => p && p[key] != null && p[key] !== '').length;
  return {
    statRows: stats.length,
    playerRows: players.length,
    fields: [
      { field: 'rec_tgt', of: stats.length, have: countStat('rec_tgt'), feeds: 'usage' },
      { field: 'rush_att', of: stats.length, have: countStat('rush_att'), feeds: 'usage' },
      { field: 'off_snp', of: stats.length, have: countStat('off_snp'), feeds: 'role' },
      { field: 'tm_off_snp', of: stats.length, have: countStat('tm_off_snp'), feeds: 'role' },
      { field: 'depth_chart_order', of: players.length, have: countPlayer('depth_chart_order'), feeds: 'opportunity' },
      { field: 'depth_chart_position', of: players.length, have: countPlayer('depth_chart_position'), feeds: 'opportunity' },
      { field: 'injury_status', of: players.length, have: countPlayer('injury_status'), feeds: 'opportunity' },
    ],
    trendingAdds: addsByPlayer && typeof addsByPlayer.size === 'number' ? addsByPlayer.size : 0,
    /* A signal is DEAD when the fields it needs arrived for nobody — which is a different and much louder
       statement than "it did not fire for anybody this week". */
    dead: [
      (countStat('rec_tgt') === 0 && countStat('rush_att') === 0) ? 'usage' : null,
      (countStat('off_snp') === 0 || countStat('tm_off_snp') === 0) ? 'role' : null,
      (countPlayer('depth_chart_order') === 0) ? 'opportunity' : null,
      (!addsByPlayer || !addsByPlayer.size) ? 'ownership' : null,
    ].filter(Boolean),
  };
}
