// ADP read API. Powers the front-end ADP Intelligence view: consensus, per-source breakdown,
// spread, and trend — by format, with graceful fallback to a richer profile when a format is thin.
import { Router } from 'express';
import { config } from '../lib/config.js';
import { q } from '../lib/db.js';
import { formatFallbacks } from '../lib/formatKey.js';

export const adpRouter = Router();

// GET /api/adp/raw-projection?season=2026 — fetch ONE live Sleeper projection object and dump its raw
// keys, so we can see EXACTLY what ADP fields Sleeper provides (and where). Definitive check for whether
// ADP lives in the projections payload and under what key names. Open in a browser.
adpRouter.get('/raw-projection', async (req, res) => {
  const season = Number(req.query.season || config.activeSeason);
  try {
    const { getSeasonProjections } = await import('../lib/sleeper.js');
    const rows = await getSeasonProjections(season);
    const n = (rows || []).length;
    if (!n) return res.json({ season, rowsReturned: 0, note: 'Sleeper returned no projections for this season — it may not be published yet, or the endpoint/season is off.' });
    const sample = rows.find((r) => r.stats && Object.keys(r.stats).some((k) => k.includes('adp'))) || rows[0];
    const adpKeysAnywhere = new Set();
    for (const r of rows.slice(0, 300)) {
      Object.keys(r || {}).forEach((k) => { if (k.toLowerCase().includes('adp')) adpKeysAnywhere.add('TOP:' + k); });
      Object.keys((r && r.stats) || {}).forEach((k) => { if (k.toLowerCase().includes('adp')) adpKeysAnywhere.add('stats:' + k); });
    }
    res.json({
      season, rowsReturned: n,
      sampleTopLevelKeys: Object.keys(sample || {}),
      sampleStatsKeys: Object.keys((sample && sample.stats) || {}),
      allAdpKeysFound: [...adpKeysAnywhere],
      hint: adpKeysAnywhere.size ? 'ADP keys exist — see allAdpKeysFound for exact names.' : 'No ADP keys in projections — Sleeper ADP comes from elsewhere; we will switch sources.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/adp/overlay?format=PPR|SF|TEP|DYNASTY|12&season=2026
// Returns { format, adp: { "normalized name": pickNumber } } for a specific format, using PUBLISHED
// Sleeper ADP (with the same fallback chain as the player pack). The frontend overlays these numbers
// onto its stable player pool BY NAME — so the board shows the correct-format ADP WITHOUT swapping the
// pool (which would corrupt picks). This is the safe way to make ADP format-accurate.
adpRouter.get('/overlay', async (req, res) => {
  const season = Number(req.query.season || config.activeSeason);
  const format = String(req.query.format || 'PPR|1QB|STD|REDRAFT|12');
  try {
    const pubFallbacks = (key) => {
      const [scoring, qb, te, pool, teams] = key.split('|');
      const pools = pool === 'ROOKIE' || pool === 'KEEPER' ? [pool, 'DYNASTY', 'REDRAFT'] : pool === 'BESTBALL' ? [pool, 'REDRAFT'] : [pool];
      const qbs = qb === 'SF' ? ['SF', '1QB'] : ['1QB'];
      const scorings = [scoring, 'PPR'];
      const out = [];
      for (const pl of pools) for (const qx of qbs) for (const sc of scorings) for (const tx of [te, 'STD']) for (const tm of [teams, '12'])
        out.push([sc, qx, tx, pl, tm].join('|'));
      return [...new Set(out)];
    };
    let used = null, rows = [];
    for (const fkey of pubFallbacks(format)) {
      const r = await q(
        `SELECT p.full_name, o.pick FROM adp_observations o JOIN players p ON p.player_id=o.player_id
          WHERE o.season=$1 AND o.source='sleeper_published' AND o.format_key=$2`,
        [season, fkey]
      );
      if (r.rows.length > 20) { used = fkey; rows = r.rows; break; }
    }
    const adp = {};
    for (const r of rows) {
      const nm = String(r.full_name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (nm && (adp[nm] == null || Number(r.pick) < adp[nm])) adp[nm] = Number(r.pick);
    }
    res.json({ format, usedFormat: used, season, count: Object.keys(adp).length, adp });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/adp/diag?season=2026 — quick data-health check so you can SEE what's in the DB without
// guessing whether the refresh job ran. Reports published-ADP coverage, harvested coverage, sample
// players (Tua, a top rookie), and which published formats exist. Open this in a browser after a deploy.
adpRouter.get('/diag', async (req, res) => {
  const season = Number(req.query.season || config.activeSeason);
  try {
    const pubCount = (await q(`SELECT count(*)::int n, count(DISTINCT player_id)::int players, count(DISTINCT format_key)::int formats FROM adp_observations WHERE season=$1 AND source='sleeper_published'`, [season])).rows[0];
    const pubFormats = (await q(`SELECT format_key, count(*)::int n FROM adp_observations WHERE season=$1 AND source='sleeper_published' GROUP BY format_key ORDER BY n DESC LIMIT 20`, [season])).rows;
    const harvestCount = (await q(`SELECT count(*)::int n FROM adp_observations WHERE season=$1 AND source != 'sleeper_published'`, [season])).rows[0];
    const consensusCount = (await q(`SELECT count(*)::int n, count(DISTINCT format_key)::int formats FROM adp_consensus WHERE season=$1`, [season])).rows[0];
    const projCount = (await q(`SELECT count(*)::int n FROM projections WHERE season=$1`, [season])).rows[0];
    const lastJobs = (await q(`SELECT name, ok, detail, created_at FROM job_runs ORDER BY created_at DESC LIMIT 8`).catch(() => ({ rows: [] }))).rows;
    // sample a couple of players' published ADP across formats
    const sample = async (nameLike) => (await q(
      `SELECT p.full_name, p.position, o.format_key, o.pick FROM adp_observations o JOIN players p ON p.player_id=o.player_id
        WHERE o.season=$1 AND o.source='sleeper_published' AND p.full_name ILIKE $2 ORDER BY o.format_key LIMIT 12`,
      [season, `%${nameLike}%`]
    )).rows;
    res.json({
      season,
      published: pubCount, publishedFormats: pubFormats,
      harvestedObservations: harvestCount, consensus: consensusCount, projections: projCount,
      sampleTua: await sample('Tua'), sampleBrazzell: await sample('Brazzell'),
      recentJobs: lastJobs,
      hint: published_hint(pubCount),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
function published_hint(pub) {
  if (!pub || pub.n === 0) return 'NO published ADP in the DB — run `npm run refresh` (or `npm run published-adp`) in the Render shell. This is almost certainly why ADP looks wrong.';
  return `Published ADP present: ${pub.players} players across ${pub.formats} formats.`;
}


// GET /api/adp/board?format=PPR|1QB|STD|REDRAFT|12&season=2026&limit=300
// Returns the consensus board for a format (sorted by consensus ADP), with fallback.
adpRouter.get('/board', async (req, res) => {
  const season = Number(req.query.season || config.activeSeason);
  const format = String(req.query.format || 'PPR|1QB|STD|REDRAFT|12');
  const limit = Math.min(500, Number(req.query.limit || 300));
  for (const fkey of formatFallbacks(format)) {
    const { rows } = await q(
      `SELECT c.player_id, p.full_name, p.position, p.team, p.bye_week,
              c.consensus, c.lo, c.hi, c.stdev, c.sample_n, c.trend
         FROM adp_consensus c JOIN players p ON p.player_id = c.player_id
        WHERE c.format_key=$1 AND c.season=$2
        ORDER BY c.consensus ASC LIMIT $3`,
      [fkey, season, limit]
    );
    if (rows.length) {
      return res.json({ format: fkey, requestedFormat: format, fallback: fkey !== format, season, players: rows });
    }
  }
  res.json({ format, requestedFormat: format, fallback: false, season, players: [], note: 'No ADP yet for this format — harvest needs to run.' });
});

// GET /api/adp/player/:playerId?format=...&season=...
// Full per-source breakdown for one player (the detail panel).
adpRouter.get('/player/:playerId', async (req, res) => {
  const season = Number(req.query.season || config.activeSeason);
  const format = String(req.query.format || 'PPR|1QB|STD|REDRAFT|12');
  const playerId = req.params.playerId;
  for (const fkey of formatFallbacks(format)) {
    const { rows } = await q(
      `SELECT c.*, p.full_name, p.position, p.team, p.bye_week
         FROM adp_consensus c JOIN players p ON p.player_id=c.player_id
        WHERE c.player_id=$1 AND c.format_key=$2 AND c.season=$3`,
      [playerId, fkey, season]
    );
    if (rows[0]) {
      const r = rows[0];
      return res.json({
        format: fkey, requestedFormat: format, fallback: fkey !== format, season,
        player: { id: r.player_id, name: r.full_name, position: r.position, team: r.team, bye: r.bye_week },
        consensus: r.consensus, lo: r.lo, hi: r.hi, stdev: r.stdev, sampleN: r.sample_n, trend: r.trend,
        sources: r.sources || [],
      });
    }
  }
  res.status(404).json({ error: 'No ADP for that player/format yet' });
});
