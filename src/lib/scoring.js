/* ⭐⭐⭐⭐ ONE STAT LINE, SCORED UNDER ONE LEAGUE'S RULES — b136.
 * ==================================================================================================
 * Sleeper hands out pre-summed points (`pts_ppr`, `pts_half_ppr`, `pts_std`) and every one of them assumes
 * DEFAULT scoring: six-point passing touchdowns, no tight-end premium, nothing custom. For a league that
 * changed any of that — and most leagues have changed something — those numbers are simply wrong, quietly,
 * by a few points a week in a direction nobody notices until they compare with the league's own scoreboard.
 *
 * So anywhere this app needs points from a stat line, it multiplies the RAW stats by the league's OWN
 * per-stat values. That correctly handles four-point passing TDs, TE premium, return yards, IDP, and every
 * other thing a commissioner can invent, because it never assumes what the rules are — it reads them.
 *
 * ⚠ THIS EXISTS BECAUSE THERE WERE ABOUT TO BE TWO OF IT. The team hub grew this logic inline to score
 *   weekly projections; the live route then needed exactly the same thing to forecast the rest of a
 *   Sunday. Two copies of a scoring function is how a projected score ends up disagreeing with the live
 *   score on the same screen, for one league, under one custom rule that only one copy learned about.
 */

// Keys that live in a Sleeper stats object but are metadata or pre-summed points, never scorable stats.
const NON_STAT = new Set([
  'gp', 'gms_active', 'tm_st_snp', 'tm_def_snp', 'tm_off_snp',
  'pts_ppr', 'pts_half_ppr', 'pts_std',
  'adp_dd_ppr', 'pos_adp_dd_ppr', 'rank_ppr', 'rank_std', 'rank_half_ppr',
]);

/* Returns points, or null when the stat line could not be scored at all — which is NOT zero. A null says
   "we cannot price this man's week", and callers must be able to tell that apart from "he scored nothing",
   because forecasting an unscoreable starter as a zero biases every total he is part of. */
export function scoreStatsFor(stats, position, scoring) {
  if (!stats || !scoring) return null;
  let pts = 0, matched = 0;
  for (const key in scoring) {
    const perPt = Number(scoring[key]);
    if (!perPt) continue;
    if (key === 'bonus_rec_te') {
      // TE premium: extra points per reception, tight ends only.
      if (position === 'TE' && stats.rec != null) { pts += Number(stats.rec) * perPt; matched++; }
      continue;
    }
    if (NON_STAT.has(key)) continue;
    const v = stats[key];
    if (v == null) continue;
    const num = Number(v);
    if (!Number.isFinite(num)) continue;
    pts += num * perPt;
    matched++;
  }
  return matched > 0 ? Math.round(pts * 100) / 100 : null;
}

/* The pre-summed field a league's scoring most resembles — used only as a LAST resort, when the raw stats
   are missing entirely and something is better than nothing. Named so its second-class status is obvious
   at the call site. */
export function fallbackPointsField(scoring) {
  const rec = (scoring && Number(scoring.rec)) || 0;
  return rec >= 1 ? 'pts_ppr' : rec >= 0.5 ? 'pts_half_ppr' : 'pts_std';
}
