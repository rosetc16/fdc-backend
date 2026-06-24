// Player-pack API. Assembles everything the front-end draft engine needs, from live Sleeper data:
// identity (name/pos/team/age/bye), status (injury/rookie), projected stats (mapped to the engine's
// stat keys), and live ADP consensus for the requested format. The front-end builds its RAW/STATS/
// META structures from this, so the board reflects real rosters/projections/ADP instead of a frozen
// built-in dataset.
import { Router } from 'express';
import { config } from '../lib/config.js';
import { q } from '../lib/db.js';
import { formatFallbacks } from '../lib/formatKey.js';

export const playerPackRouter = Router();

// Map Sleeper projection stat keys -> the engine's stat keys (see scoreFromStats in the front-end).
function mapStats(s) {
  if (!s) return {};
  const n = (v) => (v == null ? undefined : Math.round(v * 10) / 10);
  const out = {
    passYd: n(s.pass_yd), passTD: n(s.pass_td), INT: n(s.pass_int),
    rushAtt: n(s.rush_att), rushYd: n(s.rush_yd), rushTD: n(s.rush_td),
    rec: n(s.rec), tgt: n(s.rec_tgt), recYd: n(s.rec_yd), recTD: n(s.rec_td),
    fum: n(s.fum_lost),
    // kicker
    fg: n(s.fgm), fg50: n(s.fgm_50_59 != null || s.fgm_60p != null ? (s.fgm_50_59 || 0) + (s.fgm_60p || 0) : undefined), pat: n(s.xpm),
    // idp (Sleeper uses idp_* keys)
    solo: n(s.idp_tkl_solo), ast: n(s.idp_tkl_ast), idpSack: n(s.idp_sack), tfl: n(s.idp_tkl_loss),
    qbh: n(s.idp_qb_hit), idpInt: n(s.idp_int), pd: n(s.idp_pass_def), ff: n(s.idp_ff), fr: n(s.idp_fum_rec),
    idpTD: n(s.idp_td), saf: n(s.idp_safe),
  };
  // drop undefineds so the engine's defaults apply cleanly
  Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
  return out;
}

// Rough rookie flag: Sleeper carries years_exp (0 = rookie). We pass it through from players table
// if present (added opportunistically); otherwise null.
// GET /api/player-pack?format=...&season=...
playerPackRouter.get('/', async (req, res) => {
  const season = Number(req.query.season || config.activeSeason);
  const format = String(req.query.format || 'PPR|1QB|STD|REDRAFT|12');

  // 1) consensus ADP for the format (with fallback to a richer profile)
  let adpRows = [];
  let usedFormat = format;
  for (const fkey of formatFallbacks(format)) {
    const r = await q(
      `SELECT player_id, consensus, lo, hi, trend, sample_n
         FROM adp_consensus WHERE format_key=$1 AND season=$2`,
      [fkey, season]
    );
    if (r.rows.length) { adpRows = r.rows; usedFormat = fkey; break; }
  }
  const adpById = new Map(adpRows.map((a) => [a.player_id, a]));

  // 2) projections for the season
  const projRows = (await q(
    `SELECT player_id, stats, floor_pts, ceil_pts FROM projections WHERE season=$1 AND source='sleeper'`,
    [season]
  )).rows;
  const projById = new Map(projRows.map((p) => [p.player_id, p]));

  // 3) players (identity + status). Only fantasy-relevant, active, on a team.
  const players = (await q(
    `SELECT player_id, full_name, position, team, age, years_exp, bye_week, injury_status
       FROM players
      WHERE position IN ('QB','RB','WR','TE','K','DEF','DL','LB','DB')
        AND active = true`
  )).rows;

  // 4) assemble. Prefer players who have either ADP or a projection (keeps the pool meaningful).
  const pack = [];
  for (const pl of players) {
    const adp = adpById.get(pl.player_id);
    const proj = projById.get(pl.player_id);
    if (!adp && !proj) continue; // skip players with neither signal
    const stats = proj ? mapStats(proj.stats) : {};
    pack.push({
      id: pl.player_id,
      name: pl.full_name,
      pos: pl.position === 'DEF' ? 'DST' : pl.position,
      team: pl.team || null,
      age: pl.age || null,
      bye: pl.bye_week || null,
      adp: adp ? Number(adp.consensus) : null,
      adpLo: adp ? Number(adp.lo) : null,
      adpHi: adp ? Number(adp.hi) : null,
      trend: adp ? Number(adp.trend) : null,
      sampleN: adp ? adp.sample_n : 0,
      inj: pl.injury_status || null,
      rookie: pl.years_exp != null && pl.years_exp === 0,
      stats,
      floor: proj && proj.floor_pts != null ? Number(proj.floor_pts) : null,
      ceil: proj && proj.ceil_pts != null ? Number(proj.ceil_pts) : null,
    });
  }

  // sort by ADP (players without ADP sink to the bottom, ordered by having a projection)
  pack.sort((a, b) => {
    if (a.adp == null && b.adp == null) return 0;
    if (a.adp == null) return 1;
    if (b.adp == null) return -1;
    return a.adp - b.adp;
  });

  res.json({ format: usedFormat, requestedFormat: format, season, count: pack.length, players: pack });
});
