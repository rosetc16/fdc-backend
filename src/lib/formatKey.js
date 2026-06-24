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

// Derive a cfg-like object from a Sleeper draft's settings so we can format-key its picks.
// Sleeper draft settings expose slots_qb, slots_super_flex, slots_te, scoring_type, teams, etc.
export function cfgFromSleeperDraft(draft) {
  const s = draft.settings || {};
  const meta = draft.metadata || {};
  const scoringType = (meta.scoring_type || s.scoring_type || 'ppr').toLowerCase();
  const rec = scoringType.includes('ppr') ? 1 : scoringType.includes('half') ? 0.5 : 0;
  const type = (draft.type === 'dynasty' || meta.dynasty) ? 'dynasty'
    : (draft.metadata && draft.metadata.best_ball === 'on') ? 'bestball' : 'redraft';
  return {
    teams: s.teams || 12,
    type,
    start: {
      QB: s.slots_qb || 1,
      SUPER: s.slots_super_flex || 0,
      TE: s.slots_te || 1,
    },
    scoring: {
      rec,
      // Sleeper carries per-position rec bonuses in league scoring_settings; te premium is
      // detected upstream from the league object when available. Default standard here.
      recTE: rec,
    },
  };
}

// Fallback chain: when an exact format has too few samples, walk toward a richer profile.
// e.g. 'PPR|SF|TEP|DYNASTY|12' -> drop TE premium -> drop team size -> drop scoring nuance.
export function formatFallbacks(key) {
  const [scoring, qb, te, pool, teams] = key.split('|');
  const out = [key];
  if (te === 'TEP') out.push([scoring, qb, 'STD', pool, teams].join('|'));
  out.push([scoring, qb, te, pool, '12'].join('|'));
  out.push([scoring, qb, 'STD', pool, '12'].join('|'));
  out.push(['PPR', qb, 'STD', pool, '12'].join('|'));
  return [...new Set(out)];
}
