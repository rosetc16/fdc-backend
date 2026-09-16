/* ⭐⭐⭐⭐⭐ THE WEEKLY REVIEW — WHAT YOU SHOULD HAVE DONE, AND WHETHER IT WOULD HAVE MATTERED. b133.
 * ==================================================================================================
 * Trey: "I also want to create a weekly review. You should be able to toggle back to every week in the
 * past to show the review. This review should be a review of what you could have done better… should you
 * have started someone else? Was there a FA? Was it good luck or bad luck that you won or lost? Give
 * weekly trends not just for your matchup, but also compare it to the league."
 *
 * Every number here is HINDSIGHT, computed from what actually happened, and the whole file is pure so it
 * can be tested against hand-worked examples rather than against Sleeper being up. The route does the
 * fetching; this does the thinking.
 *
 * ⚠ ONE SOURCE, AND IT IS THE LEAGUE'S OWN SCOREBOARD. Sleeper's matchup object carries `players_points`
 *   — the points IT awarded each player under THIS league's scoring, that week, already settled. We never
 *   recompute from raw stats here. Recomputing is how a review ends up arguing with the standings page it
 *   sits next to, and in that argument the review is always the one that is wrong.
 *
 * ⚠ AND HINDSIGHT MUST NOT BE SMUGGLED IN WHERE IT DOES NOT BELONG. The "you should have started X" list
 *   is drawn ONLY from players who were on the roster that week — Sleeper snapshots `players` per week, so
 *   this is exactly the set you could have chosen from at the time. Free agents are deliberately absent:
 *   reconstructing who was unrostered in week 6 from today's rosters gets it exactly backwards (the player
 *   you should have claimed is, by definition, rostered by somebody now) and the honest version needs a
 *   transaction replay this does not do. The page says so out loud rather than quietly implying the wire
 *   was empty.
 */

/* Slot eligibility. Sleeper's roster_positions is a flat list with repeats: ['QB','RB','RB','WR','WR',
   'TE','FLEX','K','DEF','BN','BN',...]. BN/IR/TAXI are not lineup slots and never appear here. */
const SLOT_ELIGIBLE = {
  QB: ['QB'],
  RB: ['RB'],
  WR: ['WR'],
  TE: ['TE'],
  K: ['K'],
  DEF: ['DEF', 'DST'],
  DST: ['DEF', 'DST'],
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  WRRB_WRT: ['RB', 'WR', 'TE'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  IDP_FLEX: ['DL', 'LB', 'DB'],
  DL: ['DL', 'DE', 'DT'],
  LB: ['LB'],
  DB: ['DB', 'CB', 'S'],
};
const NON_SLOT = new Set(['BN', 'IR', 'TAXI', 'RES']);

export const isLineupSlot = (s) => !!s && !NON_SLOT.has(String(s).toUpperCase());
export const eligibleFor = (slot) => SLOT_ELIGIBLE[String(slot || '').toUpperCase()] || [String(slot || '').toUpperCase()];

/* ⭐⭐⭐⭐ THE BEST LINEUP YOU COULD HAVE SET, and why the obvious greedy is the right greedy.
 *
 * Assigning players to slots to maximise points is a bipartite matching, and "take the highest scorer
 * first" is famously wrong in general — spend your 30-point back on FLEX and your RB slot may be left with
 * a bye-week body. The fix that IS correct here: fill slots in order of how FEW positions they accept, so
 * the fussiest slot gets served before a permissive one can eat its only candidate.
 *
 * That greedy is provably optimal when the eligibility sets are NESTED — RB ⊂ FLEX ⊂ SUPER_FLEX — which is
 * exactly the shape real fantasy lineups have. WRRB_FLEX (RB/WR) and REC_FLEX (WR/TE) overlap without
 * nesting, so a league with both could in principle be assigned one point better by a full matching. Both
 * are rare, the gap is tiny, and a wrong answer here is a wrong ACCUSATION — "you left 4 points on the
 * bench" when you did not — so `exact` comes back false in that case and the caller can soften its wording
 * rather than assert something it cannot stand behind.
 */
export function optimalLineup(rosterPositions, players, ptsOf, posOf) {
  const slots = (rosterPositions || []).filter(isLineupSlot);
  if (!slots.length) return null;
  const pool = (players || []).map(String).filter(Boolean);

  const used = new Set();
  const picked = [];
  // Fussiest first. Ties broken by the slot name so the answer is deterministic run to run.
  const order = slots
    .map((s, i) => ({ s, i, n: eligibleFor(s).length }))
    .sort((a, b) => a.n - b.n || String(a.s).localeCompare(String(b.s)) || a.i - b.i);

  for (const { s } of order) {
    const elig = new Set(eligibleFor(s));
    let best = null, bestPts = -Infinity;
    for (const sid of pool) {
      if (used.has(sid)) continue;
      const p = posOf(sid);
      if (!p || !elig.has(String(p).toUpperCase())) continue;
      const v = ptsOf(sid);
      if (v == null) continue;                 // no score recorded is not a zero — see the route
      if (v > bestPts) { bestPts = v; best = sid; }
    }
    if (best != null) { used.add(best); picked.push({ slot: s, sid: best, pts: bestPts }); }
    else picked.push({ slot: s, sid: null, pts: 0 });
  }

  // Do any two slots accept overlapping-but-not-nested position sets? If so, say the answer is approximate.
  const sets = [...new Set(slots)].map((s) => new Set(eligibleFor(s)));
  let exact = true;
  for (let a = 0; a < sets.length && exact; a++) {
    for (let b = a + 1; b < sets.length; b++) {
      const A = sets[a], B = sets[b];
      const inter = [...A].filter((x) => B.has(x)).length;
      if (inter === 0) continue;                                  // disjoint is fine
      if (inter === A.size || inter === B.size) continue;          // nested is fine
      exact = false; break;                                        // overlapping is the awkward case
    }
  }

  const total = picked.reduce((s, x) => s + (x.pts > 0 ? x.pts : 0), 0);
  return { slots: picked, total: r2(total), exact };
}

/* ⭐⭐⭐⭐ WHAT IT COST YOU, AS SPECIFIC SWAPS RATHER THAN ONE REGRETFUL NUMBER.
   "You left 18.4 on your bench" is a stat. "You started Blake Corum (6.2) over Bucky Irving (22.4)" is a
   thing you can learn from. Pairs a started player with the benched player who would have taken his slot,
   which is only meaningful position by position — so the pairing is done inside each slot of the optimal
   lineup, not by sorting two lists against each other. */
export function lineupMisses(rosterPositions, starters, allPlayers, ptsOf, posOf, nameOf) {
  const opt = optimalLineup(rosterPositions, allPlayers, ptsOf, posOf);
  if (!opt) return { misses: [], left: 0, optimal: 0, exact: true };
  const started = new Set((starters || []).map(String).filter(Boolean));
  const actual = [...started].reduce((s, sid) => s + (ptsOf(sid) || 0), 0);

  /* ⭐⭐⭐⭐⭐ THE `|| 0` THAT UNDID THE KENNETH WALKER FIX — b139.
     `optimalLineup` above already skips a player with no recorded score, correctly. This line did not: it
     read `ptsOf(sid) || 0` and turned "no score yet" straight back into "scored nothing", which is the
     precise coercion that produced "started Kenneth Walker 0 over Chubba Hubbard 22.2". Gating the route's
     ptsOf was necessary and NOT sufficient — the null it produced died here, one function later, and the
     bogus regret came out the far end exactly as before.

     ⚠ CAUGHT ONLY BECAUSE THE TEST REPRODUCED THE BUG RATHER THAN ASSERTING ITS ABSENCE. A test that
       merely checked "no miss mentions Walker" against a fixture where Walker had a real score would have
       passed against the broken code. Test 14 in review.test.js pins the broken arithmetic on purpose, so
       15 has something to be measured against — see the block comment there.

     A starter whose game has not happened is not a benching you regret; he is a decision still pending. */
  const pending = [...started].filter((sid) => ptsOf(sid) == null);

  /* The players the optimal lineup used that you did NOT start, and the players you started that it did
     not use. Matched within position so the swap it describes is a swap you could actually have made. */
  const shouldStart = opt.slots.filter((x) => x.sid && !started.has(x.sid));
  const optUsed = new Set(opt.slots.map((x) => x.sid).filter(Boolean));
  const shouldSit = [...started].filter((sid) => !optUsed.has(sid))
    .map((sid) => ({ sid, pts: ptsOf(sid), pos: posOf(sid) }))
    .filter((o) => o.pts != null)
    .sort((a, b) => a.pts - b.pts);

  const misses = [];
  const takenOut = new Set();
  for (const inP of shouldStart.sort((a, b) => b.pts - a.pts)) {
    const elig = new Set(eligibleFor(inP.slot));
    const outP = shouldSit.find((o) => !takenOut.has(o.sid) && o.pos && elig.has(String(o.pos).toUpperCase()));
    if (!outP) continue;
    takenOut.add(outP.sid);
    misses.push({
      slot: inP.slot,
      out: nameOf(outP.sid), outSid: outP.sid, outPos: outP.pos, outPts: r2(outP.pts),
      in: nameOf(inP.sid), inSid: inP.sid, inPos: posOf(inP.sid), inPts: r2(inP.pts),
      gain: r2(inP.pts - outP.pts),
    });
  }
  misses.sort((a, b) => b.gain - a.gain);
  /* ⚠ `left` IS NOT FINAL WHILE ANYBODY IS STILL TO PLAY, and the number is misleading in a specific
     direction: the optimal total counts only players with scores, while your actual total is missing the
     points your unplayed starter is about to add — so mid-week it reads as waste that has not happened.
     `pending` lets the caller say "not yet" instead of printing it. */
  return { misses, left: r2(Math.max(0, opt.total - actual)), optimal: opt.total, actual: r2(actual),
    exact: opt.exact, pending: pending.length };
}

/* ⭐⭐⭐⭐ ALL-PLAY: the single most honest luck number in fantasy football.
   Your score against every OTHER score that week. Win at 4-7 and you were carried by the draw; lose at
   9-2 and you were robbed. It is the measure that separates "I played badly" from "I played fine and met
   the one team that exploded", which is the distinction Trey's question is actually about. */
export function allPlay(myPts, allPts) {
  const others = (allPts || []).filter((v) => Number.isFinite(v));
  if (!Number.isFinite(myPts) || others.length < 2) return null;
  let w = 0, l = 0, t = 0, seenSelf = false;
  for (const v of others) {
    /* Exactly one entry in this list is your own score. Skip the FIRST exact match and compare against
       the rest — dropping every equal score would erase a genuine tie with another team, which is a real
       result (a tie in the all-play record) and not a duplicate of you. */
    if (!seenSelf && v === myPts) { seenSelf = true; continue; }
    if (myPts > v) w++; else if (myPts < v) l++; else t++;
  }
  const n = w + l + t;
  return { w, l, t, rank: l + 1, of: others.length, pct: n ? r3(w / n) : null };
}

export function median(values) {
  const v = (values || []).filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return r2(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2);
}

/* ⭐⭐⭐⭐ THE VERDICT — one sentence that says whether the result was earned.
   Deliberately blunt, and deliberately willing to blame the user: a review that finds every loss unlucky
   is a horoscope. Four states, in the order they are checked:
     robbed      lost with a top-third score          — nothing you could have done
     lucky       won with a bottom-half score         — enjoy it, do not learn from it
     blown       lost, and the optimal lineup wins    — this one is on you, and it is the useful one
     earned      everything else
   `oppSwing` is how far the opponent was above their own average; a loss to a season-high is a different
   story from a loss to a typical week, and the caller prints both. */
export function verdictFor({ won, myPts, allPtsThisWeek, optimalPts, oppPts, oppAvg }) {
  const ap = allPlay(myPts, allPtsThisWeek);
  const med = median(allPtsThisWeek);
  const oppSwing = Number.isFinite(oppAvg) && Number.isFinite(oppPts) ? r2(oppPts - oppAvg) : null;
  const topThird = ap ? ap.rank <= Math.ceil(ap.of / 3) : false;
  const belowMed = med != null && myPts < med;
  const optimalWins = Number.isFinite(optimalPts) && Number.isFinite(oppPts) && optimalPts > oppPts;

  let key, text;
  if (!won && topThird) {
    key = 'robbed';
    text = oppSwing != null && oppSwing > 0
      ? `You scored top-third and still lost — they beat their own average by ${oppSwing}. Nothing to fix.`
      : 'You scored top-third and still lost. Nothing to fix.';
  } else if (won && belowMed) {
    key = 'lucky';
    text = `A below-median week that still won${ap ? ` — against the field you were ${ap.w}-${ap.l}` : ''}. Take it.`;
  } else if (!won && optimalWins) {
    key = 'blown';
    text = 'Your best lineup beats this opponent. This one was the lineup, not the draw.';
  } else {
    key = 'earned';
    text = won ? 'Won a game you deserved to win.' : 'Lost a game you deserved to lose.';
  }
  return { key, text, allPlay: ap, median: med, oppSwing, optimalWins };
}

/* ⭐⭐⭐ THE SEASON LEDGER — the trend line behind every week's verdict.
   "You are 3-4 and deserve to be 5-2" is the sentence people actually want, and it is just the actual
   record next to the all-play record rounded to the same number of games. `luck` is the gap in wins:
   positive means the schedule has been kind. `ptsAgainstRank` is the slow-burn version — 1 means you have
   faced the most points in the league, which is nobody's fault and worth knowing. */
/* ⭐⭐⭐⭐⭐ HAS HE PLAYED, AND IS THIS WEEK OVER — b139.
   ================================================================================================
   Trey: "it says 'Worst Call - Started Kenneth Walker 0 over Chubba Hubbard 22.2' — Kenneth Walker hasn't
   played yet."

   The ambiguity that caused it is worth stating precisely, because it is not obvious and it will come back
   in some other shape: Sleeper's `players_points` holds an entry for EVERY rostered player from the moment
   the week opens, and that entry is 0. So "he played and scored nothing" and "he has not kicked off" are
   the same value, and any code that asks only "what did he score" will confidently mistake the second for
   the first. The stat feed is the discriminator — a stat line means he was in the game.

   ⚠ THIS LIVED INSIDE THE ROUTE HANDLER UNTIL b139, AND THAT IS WHY IT WAS NEVER PROPERLY TESTED. The
     season-review fixture is a pre-baked response: it calls lineupMisses directly and emits a finished
     payload, so it exercises none of the route's own logic. Every browser assertion about the Walker fix
     was therefore testing the fixture's arithmetic rather than the fix. Pulled out here it is a pure
     function with an obvious failing case, the route calls it, and the fixture builder can call it too —
     so the stub can no longer be kinder than production on this exact point.

   `playedSet` is null when we have no stat feed for the week. That is a THIRD state and it must behave
   like the old code (assume the week is done), because a missing feed blanking every review in the season
   would be a far worse failure than a stale one.
   ================================================================================================ */
export function playedGate(playersPoints, playedSet, opts) {
  const pp = playersPoints || {};
  /* ⭐⭐⭐⭐⭐ A FINISHED WEEK NEEDS NO GATE — 29ab. `weekOver` says the schedule has already established
     that every game in this week is final, and when that is true "did he play" is not a question the
     STATS FEED gets to answer: he did, and a 0 from him is a real 0. The gate exists for the man whose
     game has not kicked off, and in a finished week there is no such man. */
  const over = !!(opts && opts.weekOver);
  const didPlay = (sid) => (over || !playedSet ? true : playedSet.has(String(sid)));
  return {
    didPlay,
    /* Points, or null where there is no score to speak of. Two different nulls, both correct: no entry at
       all (he was never on this roster), and a 0 from a man whose game has not started. */
    ptsOf: (sid) => {
      const raw = pp[String(sid)];
      if (raw == null) return null;
      const n = Number(raw);
      if (!Number.isFinite(n)) return null;
      if (n === 0 && !didPlay(sid)) return null;
      return n;
    },
  };
}

/* How much of a week is in the books, and who we are waiting on. `complete` gates every judgement the
   review makes — see the note in connect.js on why an unfinished week gets no verdict and no result. */
export function weekCompleteness(myStarters, oppStarters, playedSet, nameOf, opts) {
  const name = nameOf || ((sid) => String(sid));
  /* ⭐⭐⭐⭐⭐ THE BUG THIS FIXES, IN TREY'S WORDS — 29ab: "When I go back to review week one it says I have
     two left to play (DST and K) but week one is over."
     He is right, and the cause is that this asked the wrong oracle. A starter counts as "yet to play" when
     he is missing from the weekly STATS feed — and kickers and team defences are exactly the rows that
     feed most often omits. So a finished week with a stat gap presented itself as a week still in
     progress, which then suppressed the result, the verdict and the ledger entry for that week: one
     missing row quietly withdrew a whole week's judgement.
     ⚠ THE FIX IS NOT A BETTER STATS QUERY, IT IS ASKING A SOURCE THAT KNOWS. The review route already
       establishes from the SCHEDULE which weeks are finished and reviews only those, so completeness is
       settled before this function is called. Same shape as the 29t lesson: do not infer "has he played"
       from the presence of a stat line when the clock can tell you. */
  if (opts && opts.weekOver) return { complete: true, yetToPlay: 0, oppYetToPlay: 0, waitingOn: [] };
  if (!playedSet) return { complete: true, yetToPlay: 0, oppYetToPlay: 0, waitingOn: [] };
  const mine = (myStarters || []).filter(Boolean).map(String).filter((sid) => !playedSet.has(sid));
  const theirs = (oppStarters || []).filter(Boolean).map(String).filter((sid) => !playedSet.has(sid));
  return {
    complete: mine.length === 0 && theirs.length === 0,
    yetToPlay: mine.length,
    oppYetToPlay: theirs.length,
    waitingOn: mine.slice(0, 6).map(name),
  };
}

export function seasonLedger(weeks) {
  /* ⚠ ONLY FINISHED WEEKS COUNT — b138. `complete === false` marks a week with starters still to play (see
     the review route). Counting it here put an in-progress scoreline into the season record, which is how
     a 5–5 season presented itself as 8–2: the current week contributed a "win" that was three unplayed
     starters away from being anything at all. An absent flag means an older payload that predates the
     check, and those weeks were all genuinely complete, so undefined counts. */
  const done = (weeks || []).filter((w) => w && w.me && Number.isFinite(w.me.pts) && w.me.complete !== false);
  if (!done.length) return null;
  let actualW = 0, actualL = 0, actualT = 0, apW = 0, apL = 0, pf = 0, pa = 0, left = 0, medW = 0, medL = 0;
  for (const w of done) {
    const m = w.me;
    if (m.result === 'W') actualW++; else if (m.result === 'L') actualL++; else if (m.result === 'T') actualT++;
    /* ⭐⭐⭐⭐ A MEDIAN LEAGUE'S WEEK IS TWO GAMES — b140. Sleeper's league_average_match puts every team
       against the league median as well as its scheduled opponent, and the standings count both in one
       record. `medianResult` is absent for leagues that do not play it, so nothing changes there. */
    if (m.medianResult === 'W') { actualW++; medW++; }
    else if (m.medianResult === 'L') { actualL++; medL++; }
    else if (m.medianResult === 'T') actualT++;
    if (m.allPlay) { apW += m.allPlay.w; apL += m.allPlay.l; }
    pf += m.pts || 0;
    if (Number.isFinite(m.oppPts)) pa += m.oppPts;
    left += m.left || 0;
  }
  const games = actualW + actualL + actualT;
  const medianGames = medW + medL;
  // The all-play record scaled back down to the number of games actually played.
  const deservedW = apW + apL ? Math.round((apW / (apW + apL)) * games) : null;
  return {
    games, actualW, actualL, actualT, medianGames, medianW: medW, medianL: medL,
    deservedW, deservedL: deservedW == null ? null : games - deservedW,
    luck: deservedW == null ? null : actualW - deservedW,
    pointsFor: r2(pf), pointsAgainst: r2(pa),
    leftOnBench: r2(left),
    // Weeks where the all-play record says you were the better team and the scoreboard disagreed.
    robbedWeeks: done.filter((w) => w.me.verdict && w.me.verdict.key === 'robbed').map((w) => w.week),
    blownWeeks: done.filter((w) => w.me.verdict && w.me.verdict.key === 'blown').map((w) => w.week),
  };
}

/* Where each roster sits on points for and points against across the season so far. Rank 1 = most. */
export function pointRanks(weeks, rosterIds) {
  const pf = new Map(), pa = new Map();
  (rosterIds || []).forEach((r) => { pf.set(String(r), 0); pa.set(String(r), 0); });
  for (const w of weeks || []) {
    for (const [rid, v] of Object.entries((w && w.pointsByRoster) || {})) {
      pf.set(String(rid), (pf.get(String(rid)) || 0) + (Number(v) || 0));
    }
    for (const [rid, oid] of Object.entries((w && w.opponentByRoster) || {})) {
      const v = ((w.pointsByRoster || {})[oid]);
      if (Number.isFinite(v)) pa.set(String(rid), (pa.get(String(rid)) || 0) + v);
    }
  }
  const rankIn = (map) => {
    const sorted = [...map.entries()].sort((a, b) => b[1] - a[1]);
    const out = {};
    sorted.forEach(([rid], i) => { out[rid] = i + 1; });
    return out;
  };
  return { pointsFor: Object.fromEntries([...pf].map(([k, v]) => [k, r2(v)])), pointsForRank: rankIn(pf),
    pointsAgainst: Object.fromEntries([...pa].map(([k, v]) => [k, r2(v)])), pointsAgainstRank: rankIn(pa) };
}

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);
const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);
