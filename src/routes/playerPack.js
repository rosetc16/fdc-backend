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

  // Which players have a PUBLISHED (real market) ADP observation this season? Published ADP = Sleeper's
  // own draft board, which only lists currently-relevant players. We use this as the inclusion gate so
  // long-retired players (who only have stale harvested ADP from odd old mocks) are excluded entirely.
  const publishedIds = new Set((await q(
    `SELECT DISTINCT player_id FROM adp_observations
       WHERE season=$1 AND source='sleeper_published'`,
    [season]
  )).rows.map((r) => r.player_id));

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

  // Which positions does THIS format actually draft? Parse the format key's QB/TE bits and always
  // include core skill positions. K/DST are only included when the league rosters them — otherwise a
  // pile of kickers from harvested K-leagues pollutes the board (e.g. 40 kickers in a row). We infer
  // K/DST inclusion from the request (?k=1&dst=1) defaulting to OFF, since most modern leagues skip them.
  const wantK = String(req.query.k || '') === '1';
  const wantDST = String(req.query.dst || '') === '1';
  const wantIDP = String(req.query.idp || '') === '1';
  const posAllowed = (pos) => {
    if (['QB', 'RB', 'WR', 'TE'].includes(pos)) return true;
    if (pos === 'K') return wantK;
    if (pos === 'DST' || pos === 'DEF') return wantDST;
    if (['DL', 'LB', 'DB'].includes(pos)) return wantIDP;
    return false;
  };

  // 4) assemble. A player must have a TRUSTWORTHY signal: a projection, OR ADP from a healthy sample.
  // Tiny-sample ADP (a player who showed up in one or two old/odd drafts — e.g. a long-retired player)
  // is NOT trustworthy and gets dropped, which removes the retired-player / junk-ADP contamination.
  const MIN_ADP_SAMPLE = 4; // need at least a few drafts before we trust a harvested ADP number
  const pack = [];
  for (const pl of players) {
    const pos = pl.position === 'DEF' ? 'DST' : pl.position;
    if (!posAllowed(pos)) continue; // drop K/DST/IDP the league doesn't use
    const adpRaw = adpById.get(pl.player_id);
    const proj = projById.get(pl.player_id);
    const hasPublished = publishedIds.has(pl.player_id);
    // trust ADP only with a healthy sample; otherwise treat as "no ADP" (projection still keeps them)
    const adp = adpRaw && Number(adpRaw.sample_n) >= MIN_ADP_SAMPLE ? adpRaw : null;
    // INCLUSION GATE: a player must be a current, relevant player — meaning they have a season projection
    // OR a published (real market) ADP. Stale harvested ADP alone is NOT enough; that's what was letting
    // long-retired players (Adrian Peterson, Frank Gore, etc.) leak in. This is the hard filter for them.
    if (!proj && !hasPublished) continue;
    const stats = proj ? mapStats(proj.stats) : {};
    pack.push({
      id: pl.player_id,
      name: pl.full_name,
      pos,
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
