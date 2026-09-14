/* ⭐⭐⭐⭐⭐ WHAT THE SCORE IS GOING TO BE, AND HOW SURE WE ARE — b136.
 * ==================================================================================================
 * Trey: "It's saying I'm 8-2… This is true RIGHT NOW, but on sleeper, I'm showed that I'm projected to
 * lose at least 5 total. So the 8-2 is misleading. I also love on sleeper how there is color coded
 * projection systems (i.e. 11% projected to win is red // 87% to win is green)."
 *
 * He is right and the criticism is sharper than it looks. "8-2" was not merely optimistic, it was a
 * CATEGORY ERROR: a live scoreboard read at 10am Sunday says what has happened so far, and presenting that
 * as a record implies something settled. With half a lineup yet to kick off, a 41-0 lead and a 41-0 deficit
 * are the same amount of information — almost none.
 *
 * So every matchup carries three numbers instead of one: what the score IS, what it is heading for, and how
 * confident that is. The third is the one that does the work, because it is the only one that knows the
 * difference between "up 3 with everyone done" and "up 3 with their whole lineup still to play".
 *
 * ⚠ THE MODEL, STATED PLAINLY SO IT CAN BE ARGUED WITH:
 *     projected final  = points already scored + Σ projections of starters who have not played
 *     margin           = my projected final − their projected final
 *     uncertainty      = sqrt( Σ variance of every starter still to play, BOTH sides )
 *     P(win)           = Φ(margin / uncertainty)
 *   It is a normal approximation to a sum of independent player weeks. Player weeks are neither normal nor
 *   independent (a QB and his WR1 correlate hard), so this is deliberately NOT sold as precise — it is sold
 *   as the difference between 11% and 87%, which is the thing he actually asked for and the thing a number
 *   like this can honestly support.
 *
 * ⚠ AND THE UNCERTAINTY HAS TO COLLAPSE TO ZERO. When every starter on both sides has played there is
 *   nothing left to be uncertain about, and the answer must be exactly 0% or 100% — not 97%. A model that
 *   still hedges after the final whistle is visibly broken and destroys trust in the numbers beside it.
 */

/* Weekly fantasy scoring is brutally noisy. Across positions a starter's actual points land somewhere
   around ±55% of his projection one standard deviation out — a 12-point projection routinely returns 4 or
   22. The floor matters as much as the ratio: a kicker projected 7.5 is not 4x more predictable than a
   running back projected 7.5 just because the ratio says so, and a projection of 0 is not certainty. */
const SD_RATIO = 0.55;
const SD_FLOOR = 3.0;
/* ⚠ IGNORANCE MUST COST MORE THAN KNOWLEDGE. The first cut gave an unprojectable starter a variance of
   4 x the floor — which worked out to sd 6, LESS than the sd of an ordinary 14-point projection (7.7). So
   not knowing what a man would score made the forecast more confident than knowing, which is exactly
   backwards and is the kind of sign error a probability never gets caught making in production. A starter
   we cannot project could plausibly return anywhere from nothing to a big week; sd 12 says that, and is
   comfortably wider than any single projected starter. */
const UNKNOWN_SD = 12.0;
export const sdFor = (proj) => Math.max(SD_FLOOR, Math.abs(Number(proj) || 0) * SD_RATIO);

/* Abramowitz & Stegun 26.2.17 — the standard normal CDF to about 7 decimal places, which is six more than
   a win probability deserves. Kept inline rather than pulled in, because one function is not a dependency. */
export function normalCdf(z) {
  if (!Number.isFinite(z)) return null;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  let p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  p = 1 - p;
  return z >= 0 ? p : 1 - p;
}

/* One side of a matchup, projected forward.
   `players` is the started lineup: { sid, pts, played, proj }.
     pts    — what the platform has already awarded him (authoritative; never recomputed)
     played — whether his game is over. See the route: this comes from the week's ACTUAL stats feed, not
              from a clock, because "did this man play" is a fact the stats feed states directly.
     proj   — his projection for the week in THIS league's scoring, used only if he has not played. */
export function projectSide(players) {
  const list = (players || []).filter(Boolean);
  let scored = 0, remaining = 0, variance = 0, left = 0, unknown = 0;
  for (const p of list) {
    const pts = Number.isFinite(p.pts) ? p.pts : 0;
    scored += pts;
    if (p.played) continue;
    left++;
    if (!Number.isFinite(p.proj)) {
      /* ⚠ NO PROJECTION IS NOT ZERO POINTS. A player the projection feed does not cover — a late promotion,
         an unusual position — would otherwise be silently forecast to score nothing, which quietly biases
         the whole matchup toward whoever has fewer of them. He is counted as unknown, carries the average
         uncertainty of a starter, and the caller can say the forecast is incomplete. */
      unknown++;
      variance += UNKNOWN_SD * UNKNOWN_SD;
      continue;
    }
    remaining += p.proj;
    variance += sdFor(p.proj) ** 2;
  }
  return {
    scored: r2(scored),
    remaining: r2(remaining),
    projected: r2(scored + remaining),
    variance,
    yetToPlay: left,
    unknown,
  };
}

/* ⭐⭐⭐⭐⭐ THE MATCHUP. Returns the two projected finals, the probability, and — deliberately — the inputs,
   so a screen can say "up 3 with their whole lineup to come" rather than only "52%". */
export function matchupForecast(mine, theirs) {
  const me = projectSide(mine);
  const opp = projectSide(theirs);
  const margin = r2(me.projected - opp.projected);
  const sd = Math.sqrt(me.variance + opp.variance);

  /* ⭐⭐⭐⭐ THE FINAL WHISTLE. Nobody left to play means nothing left to be uncertain about: the answer is
     the scoreboard, exactly, and a model that still says 97% here is one a person can catch being wrong. */
  const settled = me.yetToPlay === 0 && opp.yetToPlay === 0;
  let win;
  if (settled) win = margin > 0 ? 1 : margin < 0 ? 0 : 0.5;
  else if (!(sd > 0)) win = margin > 0 ? 1 : margin < 0 ? 0 : 0.5;
  else win = normalCdf(margin / sd);

  return {
    me, opp,
    margin,
    /* Never printed as 0% or 100% while anything is still to play — a 3% chance is not impossible, and a
       page that says 0% and then loses the game has told a lie it did not need to tell. */
    win: settled ? win : Math.min(0.99, Math.max(0.01, win)),
    settled,
    sd: r2(sd),
    // The forecast leans on projections we did not have for this many starters.
    unknown: me.unknown + opp.unknown,
  };
}

/* ⭐⭐⭐ THE RECORD HE ACTUALLY WANTED. "8-2 … is misleading … I'm projected to lose at least 5 total."
   Two records side by side: what the scoreboard says right now, and what the projections expect it to
   settle at. The second is the honest headline while games are in play. */
export function projectedRecord(forecasts) {
  const list = (forecasts || []).filter(Boolean);
  let liveW = 0, liveL = 0, liveT = 0, projW = 0, projL = 0, projT = 0, settled = 0;
  for (const f of list) {
    const now = f.me.scored - f.opp.scored;
    if (now > 0) liveW++; else if (now < 0) liveL++; else liveT++;
    if (f.margin > 0) projW++; else if (f.margin < 0) projL++; else projT++;
    if (f.settled) settled++;
  }
  return {
    games: list.length, settled,
    liveW, liveL, liveT,
    projW, projL, projT,
    // Expected wins is the sum of the probabilities, which is a truer summary than counting favourites:
    // ten coin-flips is 5 expected wins, not 10, however the individual leans fall.
    expected: r2(list.reduce((s, f) => s + (f.win || 0), 0)),
    // Matchups still genuinely in the balance — the ones worth a Sunday afternoon.
    tossups: list.filter((f) => !f.settled && f.win > 0.2 && f.win < 0.8).length,
  };
}

const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);
