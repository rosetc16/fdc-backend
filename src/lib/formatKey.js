// Derive the canonical ADP format key from a league config (or a Sleeper draft's settings).
// MUST stay in lockstep with the front-end engine's formatKey/isSuperflex so the numbers
// the engine predicts against match the ADP bucket we aggregated.
//
// Format key shape:  SCORING | QB | TE | POOL | TEAMS
//   SCORING: STD | HALF | PPR
//   QB:      1QB | SF        (SuperFlex / 2QB)
//   TE:      STD | TEP       (TE premium)
//   POOL:    REDRAFT | DYNASTY | KEEPER | BESTBALL | ROOKIE
//   TEAMS:   bucket -> '8-10' | '12' | '14+'

export function isSuperflex(cfg) {
  if (!cfg) return false;
  if (cfg.sf) return true;
  const st = cfg.start || {};
  return (st.SUPER || 0) > 0 || (st.QB || 0) >= 2;
}

export function scoringClass(cfg) {
  // rec = points per reception. >=1 PPR, ~0.5 half, else standard.
  const rec = (cfg.scoring && cfg.scoring.rec != null) ? cfg.scoring.rec : (cfg.ppr != null ? cfg.ppr : 1);
  if (rec >= 0.75) return 'PPR';
  if (rec >= 0.25) return 'HALF';
  return 'STD';
}

export function tePremium(cfg) {
  const sc = cfg.scoring || {};
  if (cfg.tePremMult && cfg.tePremMult > 0) return true;
  if (sc.recTE != null && sc.rec != null && sc.recTE > sc.rec) return true;
  return false;
}

export function poolClass(cfg) {
  const t = (cfg.type || 'redraft').toLowerCase();
  if (t === 'dynasty') return 'DYNASTY';
  if (t === 'keeper') return 'KEEPER';
  if (t === 'bestball') return 'BESTBALL';
  if (t === 'rookie' || t === 'rookie only') return 'ROOKIE';
  return 'REDRAFT';
}

export function teamsBucket(teams) {
  const n = Number(teams || 12);
  if (n <= 10) return '8-10';
  if (n >= 14) return '14+';
  return '12';
}

export function formatKey(cfg) {
  return [
    scoringClass(cfg),
    isSuperflex(cfg) ? 'SF' : '1QB',
    tePremium(cfg) ? 'TEP' : 'STD',
    poolClass(cfg),
    teamsBucket(cfg.teams),
  ].join('|');
}

// Derive a cfg-like object from a Sleeper draft's settings so we can format-key its picks. Optionally pass
// the LEAGUE object too — it's the only reliable place to tell dynasty from redraft (league.settings.type:
// 0/1 = redraft/keeper, 2 = dynasty). Without it, everything looks like redraft (which is the bug that made
// the pool show only REDRAFT keys). Rookie drafts are detected from the draft itself.
export function cfgFromSleeperDraft(draft, league = null) {
  const s = draft.settings || {};
  const meta = draft.metadata || {};
  // Scoring: prefer the LEAGUE's actual rec value (authoritative) over the draft's scoring_type label, which
  // is often missing/generic. rec >= 0.75 = PPR, >= 0.25 = half, else standard.
  const leagueRec = (league && league.scoring_settings && league.scoring_settings.rec != null) ? Number(league.scoring_settings.rec) : null;
  const scoringType = (meta.scoring_type || s.scoring_type || 'ppr').toLowerCase();
  const rec = leagueRec != null ? leagueRec : (scoringType.includes('ppr') ? 1 : scoringType.includes('half') ? 0.5 : 0);
  // ROOKIE detection: a rookie draft has few rounds and its own pool. Sleeper signals it a few ways —
  // draft.type is usually the ORDER ('snake'/'linear'), so we can't rely on it alone. The strongest signals:
  //   • metadata.scoring_type or metadata.name mentioning 'rookie'
  //   • the league is a dynasty AND the draft is short (<= 6 rounds) and it's not the league's startup
  //   • draft.metadata.type === 'rookie'
  const dtype = ((draft.type || meta.type || '') + '').toLowerCase();
  const metaBlob = ((meta.scoring_type || '') + ' ' + (meta.name || '') + ' ' + (draft.name || '')).toLowerCase();
  const rounds = Number(s.rounds || 0);
  const leagueIsDynasty = !!(league && league.settings && Number(league.settings.type) === 2);
  const leagueIsKeeper = !!(league && league.settings && Number(league.settings.type) === 1);
  const explicitRookie = dtype.includes('rookie') || metaBlob.includes('rookie');
  // A short draft inside a dynasty league is a rookie draft (startups are full-length, ~15+ rounds).
  const shortDynastyDraft = leagueIsDynasty && rounds > 0 && rounds <= 6;
  const isRookie = explicitRookie || shortDynastyDraft;
  const bestBall = meta.best_ball === 'on' || s.best_ball === 1 || (league && league.settings && league.settings.best_ball === 1);
  const type = isRookie ? 'rookie'
    : bestBall ? 'bestball'
    : leagueIsDynasty ? 'dynasty'
    : leagueIsKeeper ? 'keeper'
    : 'redraft';
  // TE premium: rec bonus for TE greater than base rec (from league scoring settings when we have them).
  const sc = (league && league.scoring_settings) || {};
  const recTE = sc.rec_te != null ? Number(sc.rec_te) : rec;
  return {
    teams: (league && league.total_rosters) || s.teams || 12,
    type,
    tePremMult: recTE > rec ? recTE - rec : 0,
    start: {
      QB: s.slots_qb != null ? s.slots_qb : ((league && league.roster_positions) ? league.roster_positions.filter((p) => p === 'QB').length : 1),
      SUPER: s.slots_super_flex != null ? s.slots_super_flex : ((league && league.roster_positions) ? league.roster_positions.filter((p) => p === 'SUPER_FLEX').length : 0),
      TE: s.slots_te || 1,
    },
    scoring: { rec, recTE },
  };
}

// Fallback chain: when an exact format has too few samples, walk toward a richer profile.
// e.g. 'PPR|SF|TEP|DYNASTY|12' -> drop TE premium -> drop team size -> drop scoring nuance.
export function formatFallbacks(key) {
  const [scoring, qb, te, pool, teams] = key.split('|');
  const out = [key];
  // Try to PRESERVE the two settings that most change ADP — TE premium and superflex — before relaxing them.
  // Order: keep te+qb, vary team count; then vary scoring (HALF<->PPR are close, both far from STD); only
  // AFTER exhausting those do we drop TE premium. This keeps a TEP league on TEP data whenever any exists.
  const scoringAlts = scoring === 'HALF' ? ['HALF', 'PPR'] : scoring === 'PPR' ? ['PPR', 'HALF'] : ['STD', 'HALF', 'PPR'];
  const teamAlts = [teams, '12', '8-10', '14+'];
  // 1) same te, same qb — vary scoring then team count
  for (const sc of scoringAlts) for (const tm of teamAlts) out.push([sc, qb, te, pool, tm].join('|'));
  // 2) drop TE premium (te -> STD), same qb — vary scoring then team count
  if (te === 'TEP') for (const sc of scoringAlts) for (const tm of teamAlts) out.push([sc, qb, 'STD', pool, tm].join('|'));
  // 3) last resort broad default
  out.push(['PPR', qb, 'STD', pool, '12'].join('|'));
  return [...new Set(out)];
}
