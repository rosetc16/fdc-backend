// Player-pack API. Assembles everything the front-end draft engine needs, from live Sleeper data:
// identity (name/pos/team/age/bye), status (injury/rookie), projected stats (mapped to the engine's
// stat keys), and live ADP consensus for the requested format. The front-end builds its RAW/STATS/
// META structures from this, so the board reflects real rosters/projections/ADP instead of a frozen
// built-in dataset.
import { Router } from 'express';
import { config } from '../lib/config.js';
import { q } from '../lib/db.js';
import { formatFallbacks } from '../lib/formatKey.js';
import { packCacheGet, packCacheSet } from '../lib/packCache.js';
import { getPlayoffSos } from '../lib/sosService.js';
import { positionGapsToFill } from '../lib/coverage.js';

export const playerPackRouter = Router();

/* ⭐⭐⭐ DEGRADATION IS PER-POSITION, NOT PER-BOARD.
 *
 * `adpDegraded` means "this number was measured in a DIFFERENT format from the one you asked for". The
 * client takes it seriously: a degraded player is excluded from the ADP health guards, from VBD's ADP
 * anchor, and from the trusted-ADP count — and if EVERY player is degraded the app concludes it has no
 * usable market and ranks the whole board by projections instead.
 *
 * That makes a board-wide flag far too blunt. Sleeper publishes no TE-premium ADP at all, so a TEP league
 * must always be answered with standard-TE numbers. Flagging the entire board for it would throw away 250
 * perfectly good RB/WR/QB numbers because of a setting that only moves tight ends — trading a small, known
 * inaccuracy at one position for a total loss of market data at every position.
 *
 * So we ask, per axis, which positions that axis actually re-prices:
 *   · POOL (redraft vs dynasty vs rookie) — everyone. Dynasty prices age: Kelce 89 redraft, 129 dynasty.
 *   · QB (1QB vs superflex)               — everyone, QBs enormously. Josh Allen 21.0 in 1QB, 3.6 in 2QB;
 *                                           and because QBs eat early picks, every other position slides
 *                                           later too (Chase 3.2 -> 4.9).
 *   · SCORING (PPR/half/standard)         — every pass-catcher and receiving back. NOT quarterbacks, whose
 *                                           scoring is passing-based and unmoved by points per reception.
 *   · TE (standard vs premium)            — tight ends only. A TE premium does not move a running back.
 *
 * The result: a TE-premium league keeps exact-format confidence everywhere except at TE, where it is
 * honestly marked provisional and can be overridden by TE-premium-aware harvested drafts.
 */
function degradationAxes(reqFmt, gotFmt) {
  const r = String(reqFmt || '').split('|'), g = String(gotFmt || '').split('|');
  return { scoring: r[0] !== g[0], qb: r[1] !== g[1], te: r[2] !== g[2], pool: r[3] !== g[3] };
}
function degradedForPos(pos, axes) {
  if (!axes) return false;
  if (axes.pool || axes.qb) return true;                 // re-prices the whole board
  if (axes.scoring) return pos !== 'QB';                 // reception scoring moves everyone but QBs
  if (axes.te) return pos === 'TE';                      // a TE premium moves tight ends and nobody else
  return false;
}


// Exported so the admin `proj-check` diagnostic reports on the SAME mapper the pack uses. A diagnostic that
// reimplements the thing it is diagnosing can agree with itself while production disagrees with both.
export const mapStatsForDiag = (s) => mapStats(s);

// Map Sleeper projection stat keys -> the engine's stat keys (see scoreFromStats in the front-end).
function mapStats(s) {
  if (!s) return {};
  const n = (v) => (v == null ? undefined : Math.round(v * 10) / 10);
  // Sleeper's projection blobs are not consistent about stat-key spelling across positions and seasons.
  // `first` takes whichever alias is actually present; `sum` adds every alias that is (for buckets like
  // 50-59 / 60+ that some seasons publish separately and others as one 50+ figure).
  const first = (o, keys) => { for (const k of keys) if (o[k] != null) return o[k]; return undefined; };
  const sum = (o, keys) => { let t, any = false; for (const k of keys) if (o[k] != null) { t = (t || 0) + o[k]; any = true; } return any ? t : undefined; };
  const sum2 = (a, b) => (a == null && b == null ? undefined : (a || 0) + (b || 0));
  const out = {
    passYd: n(s.pass_yd), passTD: n(s.pass_td), INT: n(s.pass_int),
    rushAtt: n(s.rush_att), rushYd: n(s.rush_yd), rushTD: n(s.rush_td),
    rec: n(s.rec), tgt: n(s.rec_tgt), recYd: n(s.rec_yd), recTD: n(s.rec_td),
    fum: n(s.fum_lost),
    // ---- kicker ------------------------------------------------------------------------------
    // ⚠ Trey: "I also think the Kicker projected points is extremely low (in the 40s)." A kicker with only
    //   `pat` mapped scores almost exactly that (≈40 extra points × 1), which is the signature of the made
    //   field goals never arriving. Sleeper is not consistent about which of these keys it publishes, and a
    //   single spelling that misses is indistinguishable from a kicker who never kicks — so take the first
    //   one that exists rather than betting on one name. `fga - fgmiss` is the last resort.
    fg: n(first(s, ['fgm', 'fg_made', 'fgm_tot']) ?? (s.fga != null ? (s.fga || 0) - (s.fgmiss || s.fg_miss || 0) : undefined)),
    // ⚠ Some seasons publish 50-59 and 60+ separately, others publish one 50+ figure. Adding all four
    //   aliases would double-count a season that carries both, so take the split pair when it exists.
    fg50: n(s.fgm_50_59 != null || s.fgm_60p != null
      ? (s.fgm_50_59 || 0) + (s.fgm_60p || 0)
      : first(s, ['fgm_50p', 'fgm_50'])),
    pat: n(first(s, ['xpm', 'pat_made', 'xp_made'])),
    fgMiss: n(first(s, ['fgmiss', 'fg_miss', 'fgm_miss'])),
    // Distance buckets when Sleeper publishes them. The engine models the 40-49 share when it can't see it,
    // so passing the real count through is strictly better than the estimate.
    fg40: n(sum(s, ['fgm_40_49'])),
    // ---- team defense ------------------------------------------------------------------------
    // ⭐⭐ THIS BLOCK DID NOT EXIST. Trey: "can you check DST point projections… most/all are coming up as
    //   0 (and VBD is 0)." Not a rounding problem or a scoring-setting problem — mapStats had no team-defense
    //   branch at all, so every DST reached the engine with an EMPTY stat object. scoreFromStats then
    //   computes `max(0, 35 - (pa ?? 350)/10) * paPer` = 0 and adds nothing else, which is why the number
    //   was a clean zero rather than a wrong one. The same key names are already used by connect.js, which
    //   is how I know they are the ones Sleeper publishes.
    sack: n(first(s, ['sack', 'def_sack', 'sacks'])),
    dint: n(first(s, ['int', 'def_int', 'ints'])),
    dfr: n(first(s, ['fum_rec', 'def_fr', 'def_fum_rec'])),
    // A defensive touchdown and a special-teams touchdown both score for the DST unit and are separate
    //   Sleeper fields — but `def_st_td` and `st_td` are two names for the same one, so only one counts.
    dtd: n(sum2(first(s, ['def_td', 'def_dtd']), first(s, ['def_st_td', 'st_td']))),
    pa: n(first(s, ['pts_allow', 'pts_allowed', 'def_pa'])),
    // idp (Sleeper uses idp_* keys)
    solo: n(s.idp_tkl_solo), ast: n(s.idp_tkl_ast), idpSack: n(s.idp_sack), tfl: n(s.idp_tkl_loss),
    qbh: n(s.idp_qb_hit), idpInt: n(s.idp_int), pd: n(s.idp_pass_def), ff: n(s.idp_ff), fr: n(s.idp_fum_rec),
    idpTD: n(s.idp_td), saf: n(s.idp_safe),
  };
  // drop undefineds so the engine's defaults apply cleanly
  Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
  return out;
}

/* Season points from the MAPPED stats, under a given points-per-reception value.
 *
 * This exists only to give the TE-premium model an exchange rate between points and draft slots, so it is
 * deliberately the plain standard-scoring formula every site shares (yardage, touchdowns, turnovers, plus
 * whatever the league pays per catch). It is not used to rank the board, price a player, or grade a pick —
 * the front-end engine does all of that with the league's full custom scoring. Keeping this narrow is the
 * point: a second, subtly different scoring model competing with the real one is how two screens start
 * disagreeing about the same player.
 */
function ptsFromMapped(s, rec) {
  if (!s) return 0;
  const n = (v) => Number(v) || 0;
  return n(s.passYd) * 0.04 + n(s.passTD) * 4 - n(s.INT) * 2
    + n(s.rushYd) * 0.1 + n(s.rushTD) * 6
    + n(s.recYd) * 0.1 + n(s.recTD) * 6 + n(s.rec) * rec
    - n(s.fum) * 2;
}

// Rough rookie flag: Sleeper carries years_exp (0 = rookie). We pass it through from players table
// if present (added opportunistically); otherwise null.
// GET /api/player-pack?format=...&season=...
playerPackRouter.get('/', async (req, res) => {
  const season = Number(req.query.season || config.activeSeason);
  const format = String(req.query.format || 'PPR|1QB|STD|REDRAFT|12');
  const isRookieFormat = format.split('|')[3] === 'ROOKIE'; // rookie-only draft: format-specific harvested ADP wins

  // Every input that can change the response. Nothing else varies it — no auth, no per-user data — so this is
  // a complete cache key. Check it BEFORE touching the database: a hit skips all 5 queries and the payload build.
  const cacheKey = [season, format,
    String(req.query.k || '') === '1' ? 'k1' : 'k0',
    String(req.query.dst || '') === '1' ? 'd1' : 'd0',
    String(req.query.idp || '') === '1' ? 'i1' : 'i0',
    // ⚠ The playoff window CHANGES the SOS numbers, so it must be part of the cache identity. Leaving it out
    // would serve a week-14 league the week-15 league's schedule read — the same class of bug as the K/DST
    // pack collision, where two league shapes shared a key and whichever loaded first won for everybody.
    'pw' + (Number(req.query.pw) || 15),
    // ⚠ THE TE-PREMIUM SIZE IS PART OF THE RESPONSE, SO IT IS PART OF THE KEY. Two leagues can share a
    //   format key (both "TEP") and still deserve different tight-end numbers — a 0.5/rec premium and a
    //   1.5/rec premium are not the same market. Leaving this out would serve whichever league asked
    //   first to every league behind it: correct on the first request of the day, quietly wrong after.
    `t${Number(req.query.tep || 0) || 0}`].join('~');
  const cached = packCacheGet(cacheKey);
  if (cached) {
    // Let the browser/CDN reuse it too, so a repeat open doesn't even reach us.
    res.set('Cache-Control', 'public, max-age=300');
    res.set('X-Pack-Cache', 'HIT');
    return res.json(cached);
  }

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
    /* ⭐⭐⭐ KEEPER DEGRADES TO REDRAFT, NOT DYNASTY.
       This one line was the whole of Trey's live-draft complaint. A keeper league asked for
       PPR|1QB|STD|KEEPER|12; the published sync wrote no KEEPER keys at all, so the chain fell to
       DYNASTY — a genuinely different market (Kelce: 89 redraft, 129 dynasty; Derrick Henry: 20 vs 47)
       and, before the sentinel fix, one where 1QB dynasty was 999 for everyone.
       A keeper league is a REDRAFT draft with some players already off the board. The keepers change WHO
       is available, not what the rest of the room is worth. Sleeper's own keeper draft rooms show the
       redraft numbers, which is why his app said 39 and his screen said 52.
       The sync now writes REDRAFT numbers into KEEPER keys directly, so this is usually an exact hit;
       REDRAFT stays here ahead of DYNASTY as the fallback for any player the redraft market misses. */
    const pools = pool === 'ROOKIE' ? ['ROOKIE']
      : pool === 'KEEPER' ? [pool, 'REDRAFT', 'DYNASTY']
      : pool === 'BESTBALL' ? [pool, 'REDRAFT'] : [pool];
    const qbs = qb === 'SF' ? ['SF', '1QB'] : ['1QB'];
    // HALF and PPR are close; both are far from STD. Try the league's own scoring first, then its neighbor,
    // before STD. Crucially we EXHAUST TE-premium-preserving variants (all scorings, all team counts) BEFORE
    // dropping TEP->STD, because TE premium materially changes TE ADP — a TEP league should stay on TEP data.
    const scorings = scoring === 'HALF' ? ['HALF', 'PPR', 'STD'] : scoring === 'PPR' ? ['PPR', 'HALF', 'STD'] : ['STD', 'HALF', 'PPR'];
    const teamAlts = [teams, '12', '8-10', '14+'];
    const teVariants = te === 'TEP' ? ['TEP', 'STD'] : ['STD'];
    const out = [];
    for (const pl of pools) for (const tx of teVariants) for (const qx of qbs) for (const sc of scorings) for (const tm of teamAlts)
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

  // Harvested consensus (fallback only — used to fill players with no published number, and for lo/hi/trend).
  //
  // We do NOT take the first fallback format that has ANY rows. That greedy rule is a trap: if the exact
  // requested format (e.g. SF|TEP|DYNASTY) has a handful of stray consensus rows from some earlier partial
  // harvest, the loop would stop there with near-zero coverage and never reach the hundreds of real
  // SF|STD|DYNASTY drafts one step down the chain — leaving almost every player with no harvested ADP and
  // forcing the board onto degraded 1QB published numbers. Instead we scan the chain and pick the format with
  // the MOST coverage, so the board rides the biggest real market sample available (your 621 SF-dynasty drafts).
  let adpRows = [];
  let usedFormat = format;
  const harvestChainTried = [];
  let best = { rows: [], fmt: null, n: 0 };
  for (const fkey of formatFallbacks(format)) {
    const r = await q(
      `SELECT player_id, consensus, lo, hi, trend, sample_n
         FROM adp_consensus WHERE format_key=$1 AND season=$2`,
      [fkey, season]
    );
    harvestChainTried.push({ format: fkey, rows: r.rows.length });
    if (r.rows.length > best.n) best = { rows: r.rows, fmt: fkey, n: r.rows.length };
    // Early exit: the exact requested format with solid coverage is unbeatable — take it and stop.
    if (fkey === format && r.rows.length >= 50) { best = { rows: r.rows, fmt: fkey, n: r.rows.length }; break; }
  }
  if (best.n > 0) { adpRows = best.rows; usedFormat = best.fmt; }
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
      `SELECT player_id, full_name, position, team, age, years_exp, bye_week, injury_status, news_updated,
              injury_body_part, injury_notes, injury_start_date,
              injury_detail, injury_part, injury_return, injury_at, injury_sources
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
  // The playoff-SOS table is one lookup for the whole request rather than a query per player.
  const sosData = await getPlayoffSos(season, Number(req.query.pw) || 15, Number(req.query.week) || null)
    .catch(() => null);
  const sosFor = (team, pos) => {
    if (!sosData || !team) return undefined;
    const e = sosData.table[team] && sosData.table[team][pos];
    if (!e) return undefined;
    // Compact on the wire: this rides on every player of a 600-row pack.
    return { s: e.score, r: e.rank, of: e.of, t: e.tier, b: e.byes || 0,
      o: e.opps.map((x) => ({ w: x.week, t: x.opp, r: x.rank, y: x.bye ? 1 : 0 })) };
  };

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
  const droppedByGate = []; // real, active players the inclusion gate rejected — see the coverage backstop below
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
    if (!proj && !hasPublished) { droppedByGate.push({ pl, pos }); continue; }
    const stats = proj ? mapStats(proj.stats) : {};
    // ADP: prefer the PUBLISHED Sleeper number (the real market). Only if there's no published number
    // for this player do we fall back to harvested consensus (and only with a healthy sample). This is
    // what makes the app's ADP match Sleeper — e.g. Tua/Chris Brazzell show their real Sleeper ADP.
    const pubPick = publishedAdp.get(pl.player_id);
    const pubFmtForPlayer = pubPick != null ? (publishedFmtById.get(pl.player_id) || null) : null;
    // Did the published number actually come from the format we asked for, or from a DEGRADED fallback?
    // The fallback chain will happily answer an SF request with a 1QB number, or a TE-premium request with a
    // standard-TE number. Those are the wrong market for this league.
    // Exact when the supplying format IS the requested one; otherwise exact for THIS PLAYER when none of
    // the axes that differ actually re-price his position (see degradationAxes above).
    const pubAxes = pubFmtForPlayer ? degradationAxes(format, pubFmtForPlayer) : null;
    const pubIsExactFormat = pubFmtForPlayer === format || (pubFmtForPlayer != null && !degradedForPos(pos, pubAxes));
    // A format-correct harvested consensus with a healthy sample is the REAL market for this exact league —
    // superflex-aware, TE-premium-aware, dynasty-aware. Require a slightly larger sample than the bare
    // minimum before we let it outrank a published number, so a couple of odd drafts can't move a star.
    const MIN_HARVEST_BEATS_PUB = 6;
    const harvestIsStrong = adp && Number(adp.sample_n) >= MIN_HARVEST_BEATS_PUB;

    let adpVal = null, adpLo = null, adpHi = null, trend = null, sampleN = 0, adpSrc = null, adpDegraded = false;
    // SOURCE PRIORITY.
    //
    // Historically published ADP won outright, on the reasoning that harvested drafts were "thin and
    // rookie-contaminated." That is no longer true (the blender was silently collapsing every harvested draft
    // into a single observation; with that fixed, sample counts are real). And a published number carries a
    // hidden defect: it is a SINGLE GENERIC number that is not superflex-aware, not TE-premium-aware, and not
    // dynasty-aware. Serving it for an SF/TEP/dynasty league prices the whole board as 1QB redraft — which is
    // how a QB the market actually drafts ~13th in superflex shows up around 40th.
    //
    // So: a format-correct harvested consensus (enough real drafts, in THIS exact format) beats a published
    // number that had to be degraded to answer this format. Published still wins when it exactly matches the
    // requested format, and still backstops any player the harvest hasn't seen enough of.
    if (isRookieFormat && adp) {
      adpVal = Number(adp.consensus); adpLo = Number(adp.lo); adpHi = Number(adp.hi); trend = Number(adp.trend); sampleN = adp.sample_n; adpSrc = 'harvest';
    } else if (harvestIsStrong && !pubIsExactFormat) {
      // real drafts in THIS format beat a generic/degraded published number
      adpVal = Number(adp.consensus); adpLo = Number(adp.lo); adpHi = Number(adp.hi); trend = Number(adp.trend); sampleN = adp.sample_n; adpSrc = 'harvest';
    } else if (pubPick != null && pubPick > 0) {
      adpVal = pubPick;
      adpSrc = 'published';
      // CONFIDENCE depends on whether this number is actually FOR this format. The fallback chain will answer
      // a superflex request with a 1QB number when the exact format has no entry for that player — correct as
      // a last resort, but it is NOT the market for this league (a QB the SF market drafts ~13th shows up
      // around 40 on a 1QB board). Marking that 999 ("absolute confidence") makes the board trust a number it
      // should be treating as a rough stand-in, and there is no way for the client to tell the difference.
      // Exact-format published stays high-confidence; a degraded number is flagged as provisional.
      sampleN = pubIsExactFormat ? 999 : 1;
      adpDegraded = !pubIsExactFormat;
      if (adp) { adpLo = Number(adp.lo); adpHi = Number(adp.hi); trend = Number(adp.trend); }
    } else if (adp) {
      adpVal = Number(adp.consensus); adpLo = Number(adp.lo); adpHi = Number(adp.hi); trend = Number(adp.trend); sampleN = adp.sample_n; adpSrc = 'harvest';
    }
    /* ⭐⭐ LAST LINE OF DEFENCE AGAINST A SENTINEL ON THE BOARD.
       The ingest job now drops Sleeper's 999 marker, which is where it should be caught. This is the
       backstop for every OTHER way a ~999 could arrive — a harvested consensus computed before that fix
       landed and still sitting in adp_consensus, a manual ranking uploaded with a placeholder, a future
       feed with its own marker. A draft has teams x rounds picks; ~200 is a big league. Nothing legitimate
       is ever 900. Treat it as "no ADP" (which is what it means) rather than shipping it as a pick and
       letting the engine sort a player to the bottom of the board with total confidence. */
    if (adpVal != null && adpVal >= 900) { adpVal = null; adpLo = null; adpHi = null; trend = null; sampleN = 0; adpSrc = null; }
    // A player kept ONLY because he had a "published" number that turned out to be a sentinel is not a
    // real board entry — without a projection there is nothing left to rank him by.
    if (adpVal == null && !proj) continue;
    pack.push({
      id: pl.player_id,
      name: pl.full_name,
      pos,
      team: pl.team || null,
      age: pl.age || null,
      bye: pl.bye_week || null,
      adp: adpVal,
      adpLo, adpHi, trend, sampleN,
      adpSrc,                                    // 'published' | 'harvest' | null — which market supplied the number
      adpDegraded,                               // true = this number came from a DIFFERENT format than requested
      pubFmt: pubPick != null ? (publishedFmtById.get(pl.player_id) || null) : null, // which format gave this ADP
      inj: pl.injury_status || null,
      // The rest of what the platform already told us about the injury. The board can then say "Hamstring,
      // limited in practice Wednesday" instead of a bare "Q" that sends the user to another site.
      // The MERGED, sourced detail wins over Sleeper's raw fields — it is the same data plus ESPN's, with
      // anything stale already dropped. Falls back to the raw fields when syncInjuries hasn't run.
      injPart: pl.injury_part || pl.injury_body_part || null,
      injNote: pl.injury_detail || pl.injury_notes || null,
      injReturn: pl.injury_return || null,
      injSrc: pl.injury_sources || null,
      injSince: pl.injury_start_date || null,
      injAt: pl.injury_at ? Date.parse(pl.injury_at) : (pl.news_updated != null ? Number(pl.news_updated) : null),
      rookie: pl.years_exp != null && pl.years_exp === 0,
      // PLAYOFF STRENGTH OF SCHEDULE for this player's team and position. Absent entirely when we have no
      // schedule or no defensive ranks — the board then simply doesn't show the column, which is the right
      // behaviour for a number we cannot source.
      sos: sosFor(pl.team, pos),
      stats,
      floor: proj && proj.floor_pts != null ? Number(proj.floor_pts) : null,
      ceil: proj && proj.ceil_pts != null ? Number(proj.ceil_pts) : null,
    });
  }

  /* ⭐⭐⭐ TE PREMIUM: THE ONE FORMAT DIMENSION NOBODY PUBLISHES.
   *
   * Sleeper's payload carries twelve ADP fields and not one is TE-premium, so a TEP league can only be
   * answered three ways: with standard-TE numbers (wrong, and tight ends are the entire point of the
   * setting), with harvested TEP drafts (right, but only once enough exist), or with a model.
   *
   * A model was written here and then taken back out of the default path, which is worth recording so it
   * is not rebuilt the same way. The first version converted the premium into points (receptions x bonus)
   * and walked the player up the board's own points-per-pick curve. It moved Brock Bowers from ADP 23 to
   * 1.5 overall on a HALF-point premium, and produced identical output at 0.5 and 1.5 because both pinned
   * against the cap. Two faults, one conceptual and one about evidence:
   *
   *   1. Points are the wrong currency; VALUE OVER REPLACEMENT is. A TE premium pays every tight end,
   *      including the replacement-level one you would have taken instead, so an elite TE only gains
   *      (his receptions - replacement TE receptions) x bonus. Scoring him on his full reception count
   *      credits him for points the alternative also receives, which is why the shift came out enormous.
   *   2. It could not be measured. Validating a points-based model needs real projections across the whole
   *      board; the accuracy rig is seeded from Sleeper's published ADP, which is real, but its projection
   *      column is synthetic. An unvalidated model that moves a player twenty picks is worse than an
   *      honest "we do not have this number" — it is wrong with confidence, which is the failure this
   *      whole change set exists to remove.
   *
   * So the shift is VBD-based now, and it is OPT-IN (`&tepModel=1`) rather than on by default. What ships
   * for a TE-premium league is the honest path: the standard-TE number, flagged `adpDegraded` at TE only
   * (see degradationAxes), which both tells the client it is provisional and lets format-correct harvested
   * TEP drafts — which are genuinely TE-premium aware — override it as they accumulate. The admin manual
   * ranking upload covers the same gap deliberately (see MANUAL_RANKING in adpConsensus).
   */
  const tep = Number(req.query.tep || 0);
  if (tep > 0 && String(req.query.tepModel || '') === '1') {
    const recVal = format.split('|')[0] === 'PPR' ? 1 : format.split('|')[0] === 'HALF' ? 0.5 : 0;
    const tes = pack.filter((p) => p.pos === 'TE' && p.adp != null && p.adp < 900 && Number(p.stats && p.stats.rec) > 0)
      .sort((a, b) => Number(a.adp) - Number(b.adp));
    // Replacement TE = the last one a 12-team league would start (one TE per team). Everything above him
    // is only worth the receptions he gains OVER that baseline.
    const teamCount = Number((format.split('|')[4] || '12').replace('+', '')) || 12;
    const repl = tes[Math.min(tes.length - 1, teamCount - 1)];
    if (repl && tes.length >= 6) {
      const replRec = Number(repl.stats.rec) || 0;
      const usable = pack.filter((p) => p.adp != null && p.adp < 900 && ptsFromMapped(p.stats, recVal) > 0);
      const adpsAsc = usable.map((p) => Number(p.adp)).sort((a, b) => a - b);
      const ptsDesc = usable.map((p) => ptsFromMapped(p.stats, recVal)).sort((a, b) => b - a);
      // Monotone by construction: the k-th earliest pick in this market buys the k-th best projection.
      const curve = adpsAsc.map((adp, i) => ({ adp, pts: ptsDesc[i] }));
      const ptsAtAdp = (a) => {
        if (a <= curve[0].adp) return curve[0].pts;
        if (a >= curve[curve.length - 1].adp) return curve[curve.length - 1].pts;
        let lo = 0, hi = curve.length - 1;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (curve[m].adp <= a) lo = m; else hi = m; }
        const span = curve[hi].adp - curve[lo].adp;
        const t = span > 0 ? (a - curve[lo].adp) / span : 0;
        return curve[lo].pts + t * (curve[hi].pts - curve[lo].pts);
      };
      const adpAtPts = (want) => {
        for (let i = 0; i < curve.length; i++) if (curve[i].pts <= want) return curve[i].adp;
        return curve[curve.length - 1].adp;
      };
      const MAX_SHIFT = 12; // a model may nudge the market, never rewrite it
      for (const p of tes) {
        const gain = Math.max(0, (Number(p.stats.rec) || 0) - replRec) * tep;
        if (gain <= 0) continue;
        const moved = adpAtPts(ptsAtAdp(Number(p.adp)) + gain);
        const shift = Math.max(0, Math.min(MAX_SHIFT, Number(p.adp) - moved));
        if (shift >= 0.5) {
          p.adpBefore = p.adp;
          p.adp = Math.round((Number(p.adp) - shift) * 10) / 10;
          p.adpModel = `te-premium+${tep}`;
        }
      }
    }
  }

  /* ⭐⭐⭐ 29al/b123 — COVERAGE BACKSTOP: EVERY NFL TEAM FIELDS A TIGHT END, SO EVERY NFL TEAM MUST HAVE ONE HERE.
       Trey: "If possible, can you please add Chig Okonkwo (TE, Was) to the available players list. Washington
              has no TE's listed and somebody in my league just drafted him."
     The inclusion gate above is right about what it is for — it keeps long-retired players with stale
     harvested ADP off the board — but it has a blind spot it cannot see from the inside: a CURRENT player
     whose projection has not landed and whose ADP has not been published looks exactly like a retired one.
     The costs are not symmetric. A retired player on the board is a row you scroll past. A missing player is
     a pick you cannot record — somebody drafts him and the board cannot represent what happened, which
     corrupts every number downstream of it.
     ⚠ THE RULE IS ABOUT TEAM-POSITION COVERAGE, NOT ABOUT INDIVIDUALS — see src/lib/coverage.js, where the
       decision lives as a pure function so it can be tested without a database. */
  const gapIdx = droppedByGate.length
    ? positionGapsToFill(pack, droppedByGate.map((d) => ({ team: d.pl.team, pos: d.pos })), posAllowed)
    : [];
  let backstopped = 0;
  for (const i of gapIdx) {
    const d = droppedByGate[i];
    pack.push({
      id: d.pl.player_id,
      name: d.pl.full_name,
      pos: d.pos,
      team: d.pl.team,
      age: d.pl.age || null,
      bye: d.pl.bye_week || null,
      adp: null, adpLo: null, adpHi: null, trend: null, sampleN: 0, adpSrc: null, adpDegraded: false, pubFmt: null,
      inj: d.pl.injury_status || null,
      injPart: d.pl.injury_part || d.pl.injury_body_part || null,
      injNote: d.pl.injury_detail || d.pl.injury_notes || null,
      injReturn: d.pl.injury_return || null,
      injSrc: d.pl.injury_sources || null,
      injSince: d.pl.injury_start_date || null,
      injAt: d.pl.injury_at ? Date.parse(d.pl.injury_at) : (d.pl.news_updated != null ? Number(d.pl.news_updated) : null),
      rookie: d.pl.years_exp != null && d.pl.years_exp === 0,
      sos: sosFor(d.pl.team, d.pos),
      stats: {},
      floor: null, ceil: null,
      // Says WHY he is here, so this row can be told from a priced one rather than looking like a starter
      // whose numbers went missing for no reason.
      backstop: true,
    });
    backstopped++;
  }

  // sort by ADP (players without ADP sink to the bottom, ordered by having a projection)
  pack.sort((a, b) => {
    if (a.adp == null && b.adp == null) return 0;
    if (a.adp == null) return 1;
    if (b.adp == null) return -1;
    return a.adp - b.adp;
  });

  const adpSources = pack.reduce((acc, p) => {
    const k = p.adpSrc || 'none'; acc[k] = (acc[k] || 0) + 1; return acc;
  }, {});
  const body = { format: usedFormat, publishedFormat: usedPubFormat, requestedFormat: format, season, count: pack.length, adpSources, harvestChainTried, harvestFormatUsed: adpRows.length ? usedFormat : null,
    // How many players are on the board only because their team had nobody at that position. A number that
    // creeps up is the projections feed falling behind, and it is worth being able to see that from outside.
    backstopped,
    // Provenance for the SOS column. In August these ranks are LAST season's, and the UI says so — an
    // unlabelled number would imply a currency it does not have.
    sosMeta: sosData ? { weeks: sosData.weeks, basis: sosData.basis, teams: sosData.teams } : null,
    players: pack };
  packCacheSet(cacheKey, body);
  res.set('Cache-Control', 'public, max-age=300');
  res.set('X-Pack-Cache', 'MISS');
  res.json(body);
});
