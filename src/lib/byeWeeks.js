// Official 2026 NFL bye weeks (source: NFL.com schedule release). Sleeper's player feed doesn't reliably carry
// bye weeks, and a bye is a property of the TEAM's schedule, so we resolve each player's bye from his team.
// Update this map each season when the schedule is released. Keys are Sleeper team abbreviations.
export const BYES_2026 = {
  CAR: 5, KC: 5,
  CIN: 6, DET: 6, MIA: 6, MIN: 6,
  BUF: 7, JAX: 7, LAC: 7, WAS: 7,
  HOU: 8, NO: 8, NYG: 8, SF: 8,
  PIT: 9, TEN: 9,
  CHI: 10, DEN: 10, PHI: 10, TB: 10,
  ATL: 11, CLE: 11, GB: 11, LAR: 11, NE: 11, SEA: 11,
  BAL: 13, IND: 13, LV: 13, NYJ: 13,
  ARI: 14, DAL: 14,
};

// Normalize a few team-abbreviation variants Sleeper/imports may use to our map's keys.
export const TEAM_ALIAS = { LA: 'LAR', STL: 'LAR', SD: 'LAC', OAK: 'LV', WSH: 'WAS', JAC: 'JAX', ARZ: 'ARI', LVR: 'LV' };

export const byeForTeam = (team) => {
  if (!team) return null;
  const t = String(team).toUpperCase();
  return BYES_2026[t] != null ? BYES_2026[t] : (TEAM_ALIAS[t] && BYES_2026[TEAM_ALIAS[t]] != null ? BYES_2026[TEAM_ALIAS[t]] : null);
};

// FAST bye-only refresh. Instead of re-upserting all ~11k players (which overruns the HTTP request timeout on
// a web dyno), this sets bye_week for every player whose team has a known bye, in ONE bulk UPDATE per week —
// ~9 statements total. It runs in well under a second and is safe to call from an admin endpoint. Also keys
// team defenses (position DEF) off their team code, since on Sleeper a DEF's player_id IS the team abbrev.
export async function syncByeWeeks(q) {
  await q('ALTER TABLE players ADD COLUMN IF NOT EXISTS bye_week SMALLINT;').catch(() => {});

  // Build week -> [team codes] so we can do one UPDATE per distinct bye week.
  const byWeek = new Map();
  for (const [team, wk] of Object.entries(BYES_2026)) {
    if (!byWeek.has(wk)) byWeek.set(wk, []);
    byWeek.get(wk).push(team);
  }
  // Include alias codes so a player stored under an alt abbrev (e.g. WSH) still gets set.
  const aliasesFor = (team) => Object.entries(TEAM_ALIAS).filter(([, canon]) => canon === team).map(([alt]) => alt);

  let updated = 0;
  for (const [wk, teams] of byWeek.entries()) {
    const codes = [];
    for (const t of teams) { codes.push(t, ...aliasesFor(t)); }
    // Set bye for skill/IDP players by team AND for team defenses whose player_id is the team code.
    const r = await q(
      `UPDATE players SET bye_week=$1, updated_at=now()
        WHERE (team = ANY($2) OR (position='DEF' AND player_id = ANY($2)))
          AND (bye_week IS DISTINCT FROM $1)`,
      [wk, codes]
    );
    updated += (r && r.rowCount) || 0;
  }
  return { updated, weeks: byWeek.size };
}
