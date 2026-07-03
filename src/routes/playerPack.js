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
  const isRookieFormat = format.split('|')[3] === 'ROOKIE'; // rookie-only draft: format-specific harvested ADP wins

  // ---- ADP: published Sleeper ADP is the PRIMARY source ------------------------------------------
  // This early in the year, harvested-draft ADP is thin and rookie-contaminated, so it badly distorts the
  // board (veterans buried, retired players surfacing). Sleeper's PUBLISHED ADP is the real market every
  // owner sees, with clean full coverage. So we read published ADP DIRECTLY and use it as the ADP, and
  // only fall back to harvested consensus where no published number exists for the format.
  //
  // Published ADP is stored as observations keyed by format. We resolve the best matching format with a
  // fallback chain that also degrades SF->1QB and KEEPER->DYNASTY (so an SF league still finds the closest
  // real market number instead of falling through to junk).
  //
  // ROOKIE is deliberately NOT degraded to DYNASTY/REDRAFT: a rookie draft's pool is ONLY incoming rookies,
  // and their draft position must come from actual rookie drafts. Degrading to a dynasty/redraft pool would
  // price a rookie among veterans (e.g. a rookie QB inherits his dynasty-STARTUP ADP of ~2 overall), which
  // is exactly wrong for a rookie-only draft. So ROOKIE stays within ROOKIE format variants only; a rookie
  // with no rookie-ADP yet gets no published number and the engine ranks him by rookie value instead.
  const pubFallbacks = (key) => {
    const [scoring, qb, te, pool, teams] = key.split('|');
    const pools = pool === 'ROOKIE' ? ['ROOKIE'] : pool === 'KEEPER' ? [pool, 'DYNASTY'] : pool === 'BESTBALL' ? [pool, 'REDRAFT'] : [pool];
    const qbs = qb === 'SF' ? ['SF', '1QB'] : ['1QB'];
    const scorings = [scoring, 'PPR'];
    const out = [];
    for (const pl of pools) for (const qx of qbs) for (const sc of scorings) for (const tx of [te, 'STD']) for (const tm of [teams, '12'])
      out.push([sc, qx, tx, pl, tm].join('|'));
    return [...new Set(out)];
  };
  // Pull all published observations for this season once, index by (format_key -> player_id -> pick).
  const pubRows = (await q(
    `SELECT player_id, format_key, pick FROM adp_observations
       WHERE season=$1 AND source='sleeper_published'`,
    [season]
  )).rows;
  const pubByFormat = new Map(); // format_key -> Map(player_id -> pick)
  for (const r of pubRows) {
    if (!pubByFormat.has(r.format_key)) pubByFormat.set(r.format_key, new Map());
    pubByFormat.get(r.format_key).set(r.player_id, Number(r.pick));
  }
  // Resolve published ADP PER PLAYER across the fallback chain, rather than picking one format map for
  // the whole board. Picking a single map meant that if the exact league format (e.g. SF|TEP|DYNASTY)
  // was sparse, EVERY player fell back to a distant format (e.g. REDRAFT|STD) — which is what made a
  // TE-premium player like Hunter Henry show a redraft-standard number far from his real league ADP.
  // Now each player takes the FIRST format in the chain that actually has a number for HIM, so a player
  // covered in the exact format keeps that number while only genuinely-missing players degrade.
  const chain = pubFallbacks(format);
  const publishedAdp = new Map();   // player_id -> pick (best-matching format)
  const publishedFmtById = new Map(); // player_id -> which format supplied it (for diagnostics)
  const fmtUsageCount = {};         // format_key -> how many players it supplied (to report the dominant one)
  // Consider a format "available" only if it has real coverage somewhere on the board; this avoids a
  // one-off stray observation in an odd format hijacking a player.
  const usableChain = chain.filter((fk) => { const m = pubByFormat.get(fk); return m && m.size > 8; });
  const resolveChain = usableChain.length ? usableChain : chain;
  // Pre-fetch the maps once.
  const chainMaps = resolveChain.map((fk) => [fk, pubByFormat.get(fk)]).filter(([, m]) => m);
  for (const [fk, m] of chainMaps) {
    for (const [pid, pick] of m) {
      if (!publishedAdp.has(pid)) { publishedAdp.set(pid, pick); publishedFmtById.set(pid, fk); fmtUsageCount[fk] = (fmtUsageCount[fk] || 0) + 1; }
    }
  }
  // The "dominant" published format = the one that supplied the most players (for the version-tag debug).
  let usedPubFormat = null, _bestN = 0;
  for (const [fk, n] of Object.entries(fmtUsageCount)) { if (n > _bestN) { _bestN = n; usedPubFormat = fk; } }
  const publishedIds = new Set(publishedAdp.keys());

  // Harvested consensus (fallback only — used to fill players with no published number, and for lo/hi/trend)
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
  // news_updated may be absent on a DB that hasn't migrated yet — fall back to a query without it rather
  // than letting the whole pack fail (which would empty the board).
  let players;
  try {
    players = (await q(
      `SELECT player_id, full_name, position, team, age, years_exp, bye_week, injury_status, news_updated
         FROM players
        WHERE position IN ('QB','RB','WR','TE','K','DEF','DL','LB','DB')
          AND active = true`
    )).rows;
  } catch {
    players = (await q(
      `SELECT player_id, full_name, position, team, age, years_exp, bye_week, injury_status
         FROM players
        WHERE position IN ('QB','RB','WR','TE','K','DEF','DL','LB','DB')
          AND active = true`
    )).rows;
  }

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
    // ADP: prefer the PUBLISHED Sleeper number (the real market). Only if there's no published number
    // for this player do we fall back to harvested consensus (and only with a healthy sample). This is
    // what makes the app's ADP match Sleeper — e.g. Tua/Chris Brazzell show their real Sleeper ADP.
    const pubPick = publishedAdp.get(pl.player_id);
    let adpVal = null, adpLo = null, adpHi = null, trend = null, sampleN = 0;
    // ROOKIE drafts: prefer the FORMAT-SPECIFIC harvested consensus (real 1QB/SF/TEP rookie drafts on Sleeper)
    // over the single generic published rookie field — the harvested number reflects the actual format (e.g.
    // SF rookie drafts push rookie QBs up; the lone published rookie ADP is 1QB-flavored and can't). Only when
    // there's no healthy harvested sample do we fall back to the published rookie number.
    if (isRookieFormat && adp) {
      adpVal = Number(adp.consensus); adpLo = Number(adp.lo); adpHi = Number(adp.hi); trend = Number(adp.trend); sampleN = adp.sample_n;
    } else if (pubPick != null && pubPick > 0) {
      adpVal = pubPick; sampleN = 999; // published = high confidence
      if (adp) { adpLo = Number(adp.lo); adpHi = Number(adp.hi); trend = Number(adp.trend); }
    } else if (adp) {
      adpVal = Number(adp.consensus); adpLo = Number(adp.lo); adpHi = Number(adp.hi); trend = Number(adp.trend); sampleN = adp.sample_n;
    }
    pack.push({
      id: pl.player_id,
      name: pl.full_name,
      pos,
      team: pl.team || null,
      age: pl.age || null,
      bye: pl.bye_week || null,
      adp: adpVal,
      adpLo, adpHi, trend, sampleN,
      pubFmt: pubPick != null ? (publishedFmtById.get(pl.player_id) || null) : null, // which format gave this ADP
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

  res.json({ format: usedFormat, publishedFormat: usedPubFormat, requestedFormat: format, season, count: pack.length, players: pack });
});
