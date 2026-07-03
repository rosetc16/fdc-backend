// JOB: harvest completed Sleeper drafts and turn their picks into format-tagged ADP observations.
// This is your ADP "moat" — your own ADP computed from thousands of real drafts, correctly tagged.
//
// Discovery: Sleeper has no "list all public drafts" endpoint, so drafts are discovered from
// SEED USERS (your connected users + a curated seed list). For each seed user we pull their
// drafts for the season; for each new completed draft we record every pick as an observation
// at its derived format_key. We never re-harvest a draft (harvested_drafts table).
//
// In production you grow the seed set from: (a) every user who connects their Sleeper account,
// (b) league members discovered via those leagues, (c) optional public mock-draft lobby crawling.
import { config } from '../lib/config.js';
import { getUserDrafts, getDraft, getDraftPicks, getUser, getUserLeagues, getLeagueUsers, getLeagueDrafts, getLeague } from '../lib/sleeper.js';
import { cfgFromSleeperDraft, formatKey } from '../lib/formatKey.js';
import { q } from '../lib/db.js';
import { log } from '../lib/log.js';
import { recordJob } from '../lib/jobs.js';

// Idempotently create the tables the harvest depends on, so the job works even on a DB that hasn't had the
// latest schema migration applied. Mirrors db/schema.sql exactly (IF NOT EXISTS — a no-op when they exist).
async function ensureHarvestTables() {
  await q(`CREATE TABLE IF NOT EXISTS discovered_users (
    user_id      TEXT PRIMARY KEY,
    display_name TEXT,
    source       TEXT,
    found_via    TEXT,
    crawled_at   TIMESTAMPTZ,
    drafts_found INT DEFAULT 0,
    created_at   TIMESTAMPTZ DEFAULT now()
  )`).catch((e) => log.error(e, 'ensure discovered_users'));
  await q(`CREATE INDEX IF NOT EXISTS idx_discovered_uncrawled ON discovered_users (crawled_at NULLS FIRST, created_at)`).catch(() => {});
  await q(`CREATE TABLE IF NOT EXISTS harvested_drafts (
    draft_id     TEXT PRIMARY KEY,
    format_key   TEXT,
    season       INT,
    pick_count   INT,
    harvested_at TIMESTAMPTZ DEFAULT now()
  )`).catch((e) => log.error(e, 'ensure harvested_drafts'));
}

// Seed usernames to bootstrap discovery before you have connected users. Replace/expand freely.
const SEED_USERNAMES = (process.env.HARVEST_SEED_USERS || '').split(',').map((s) => s.trim()).filter(Boolean);
// Breadth-first crawl of the Sleeper league graph. Each run pulls a batch of not-yet-crawled users
// from discovered_users (the "frontier"), expands each into all their leaguemates (adding NEW users
// to the frontier for future runs), and harvests their drafts. This keeps reaching fresh leagues every
// night instead of re-walking the same cluster — which is how you broaden ADP across many league types.
const EXPAND_HOP = process.env.HARVEST_EXPAND !== '0';
const FRONTIER_BATCH = Number(process.env.HARVEST_FRONTIER_BATCH || 150); // users to crawl per run
const MAX_SEED_USERS = Number(process.env.HARVEST_MAX_USERS || 600);      // cap users touched per run

// Seed the discovered_users table from connected accounts + env seed usernames (idempotent).
async function seedFrontier(season) {
  // Connected Sleeper accounts. These live on the USERS table (users.sleeper_user_id) once someone links
  // their Sleeper account — that's the real seed for a fresh install. (We also check the older leagues.connect
  // location for backward compatibility.) Without at least one connected user or an env seed, there's nothing
  // to crawl and the harvest yields 0 — so this query matters.
  const seedUids = new Set();
  try {
    const { rows } = await q(`SELECT DISTINCT sleeper_user_id AS uid FROM users WHERE sleeper_user_id IS NOT NULL AND sleeper_user_id <> ''`);
    rows.forEach((r) => r.uid && seedUids.add(r.uid));
  } catch (e) { log.error(e, 'seed from users.sleeper_user_id'); }
  try {
    const { rows } = await q(
      `SELECT DISTINCT connect->>'external_user_id' AS uid
         FROM leagues WHERE connect->>'platform' = 'sleeper' AND connect ? 'external_user_id'`
    );
    rows.forEach((r) => r.uid && seedUids.add(r.uid));
  } catch { /* leagues.connect may not carry it — fine */ }
  for (const uid of seedUids) {
    await q(
      `INSERT INTO discovered_users (user_id, source, found_via) VALUES ($1,'connected','connect')
       ON CONFLICT (user_id) DO NOTHING`, [uid]
    );
  }
  for (const uname of SEED_USERNAMES) {
    try {
      const u = await getUser(uname);
      if (u?.user_id) {
        await q(
          `INSERT INTO discovered_users (user_id, display_name, source, found_via)
           VALUES ($1,$2,'seed','env') ON CONFLICT (user_id) DO NOTHING`,
          [u.user_id, u.display_name || uname]
        );
      }
    } catch { /* skip bad usernames */ }
  }
  log.info({ seeds: seedUids.size, envSeeds: SEED_USERNAMES.length }, 'harvest frontier seeded');
}

// Pull the next frontier batch (never-crawled users first), expand each user's leagues into NEW
// discovered users, mark them crawled, and return the set of user ids to harvest drafts from.
async function crawlFrontier(season, cap) {
  const { rows: frontier } = await q(
    `SELECT user_id FROM discovered_users
      WHERE crawled_at IS NULL
      ORDER BY created_at ASC
      LIMIT $1`, [Math.min(FRONTIER_BATCH, cap)]
  );
  const toHarvest = new Set(frontier.map((r) => r.user_id));
  if (!EXPAND_HOP) return [...toHarvest];

  let touched = 0;
  for (const { user_id: uid } of frontier) {
    if (touched >= cap) break;
    let leagues = [];
    try { leagues = (await getUserLeagues(uid, season)) || []; } catch { /* skip */ }
    for (const lg of leagues) {
      if (!lg.league_id) continue;
      let members = [];
      try { members = (await getLeagueUsers(lg.league_id)) || []; } catch { /* skip */ }
      for (const m of members) {
        if (!m.user_id) continue;
        toHarvest.add(m.user_id);
        // add newly-seen users to the frontier for FUTURE runs (dedup via PK)
        await q(
          `INSERT INTO discovered_users (user_id, display_name, source, found_via)
           VALUES ($1,$2,'leaguemate',$3) ON CONFLICT (user_id) DO NOTHING`,
          [m.user_id, m.display_name || null, lg.league_id]
        );
      }
      touched += members.length;
      if (touched >= cap) break;
    }
    // mark this frontier user crawled so we don't re-expand them next run
    await q(`UPDATE discovered_users SET crawled_at = now() WHERE user_id = $1`, [uid]);
  }
  return [...toHarvest].slice(0, cap);
}

export async function harvestSleeperDrafts({ season = config.activeSeason, maxDrafts = config.harvest.batch } = {}) {
  const started = Date.now();
  // 0) Ensure the tables this job depends on exist. Normally `npm run migrate` creates them, but if a deploy
  //    added a table to the schema without a migrate run, the job would crash with "relation does not exist".
  //    Creating them defensively here (IF NOT EXISTS) makes the harvest self-healing — no shell command needed.
  await ensureHarvestTables();
  // 1) make sure connected + seed users are on the frontier, then 2) crawl a fresh batch.
  await seedFrontier(season);
  const userIds = await crawlFrontier(season, MAX_SEED_USERS);
  if (userIds.length === 0) {
    const detail = { skipped: 'frontier empty', hint: 'set HARVEST_SEED_USERS or connect a Sleeper account; frontier refills as it crawls' };
    log.warn(detail, 'harvest: nothing to discover');
    await recordJob('harvestSleeperDrafts', true, detail);
    return detail;
  }
  const seedCount = userIds.length;

  // collect candidate draft ids from each user — both their personal drafts AND their leagues'
  // drafts (league drafts catch redraft/keeper drafts that user-drafts sometimes miss).
  const candidateDraftIds = new Set();
  for (const uid of userIds) {
    try {
      const drafts = await getUserDrafts(uid, season);
      (drafts || []).forEach((d) => { if (d.draft_id && d.status === 'complete') candidateDraftIds.add(d.draft_id); });
    } catch { /* skip */ }
    if (candidateDraftIds.size >= maxDrafts) break;
  }

  // skip ones we've already harvested
  const ids = [...candidateDraftIds];
  const { rows: known } = await q(
    `SELECT draft_id FROM harvested_drafts WHERE draft_id = ANY($1)`, [ids]
  );
  const knownSet = new Set(known.map((r) => r.draft_id));
  const todo = ids.filter((id) => !knownSet.has(id)).slice(0, maxDrafts);

  let drafted = 0, observations = 0;
  const byFormat = {};
  const leagueCache = new Map(); // league_id -> league object (avoid refetching within a run)
  for (const draftId of todo) {
    const draft = await getDraft(draftId);
    if (!draft || draft.sport !== 'nfl') continue;
    // Fetch the LEAGUE too — it's the only reliable source for dynasty vs redraft (league.settings.type)
    // and for TE-premium / superflex roster settings. Without it every draft looks like redraft, which is
    // why the pool was all-REDRAFT. Cached per run so we don't refetch a shared league.
    let league = null;
    if (draft.league_id) {
      if (leagueCache.has(draft.league_id)) league = leagueCache.get(draft.league_id);
      else { try { league = await getLeague(draft.league_id); } catch { league = null; } leagueCache.set(draft.league_id, league); }
    }
    const cfg = cfgFromSleeperDraft(draft, league);
    const fkey = formatKey(cfg);
    const picks = await getDraftPicks(draftId);
    if (!picks || picks.length === 0) continue;

    const values = [];
    for (const pk of picks) {
      const sid = pk.player_id;
      if (!sid || !pk.pick_no) continue;
      values.push([sid, fkey, season, 'sleeper_harvest', 'aggregated_drafts', pk.pick_no, 0.34]);
    }
    if (values.length) {
      const { rows: knownP } = await q(
        `SELECT player_id FROM players WHERE player_id = ANY($1)`,
        [values.map((v) => v[0])]
      );
      const haveSet = new Set(knownP.map((r) => r.player_id));
      const good = values.filter((v) => haveSet.has(v[0]));
      for (const v of good) {
        await q(
          `INSERT INTO adp_observations (player_id, format_key, season, source, source_type, pick, weight)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`, v
        );
        observations++;
      }
    }
    await q(
      `INSERT INTO harvested_drafts (draft_id, format_key, season, pick_count)
       VALUES ($1,$2,$3,$4) ON CONFLICT (draft_id) DO NOTHING`,
      [draftId, fkey, season, picks.length]
    );
    byFormat[fkey] = (byFormat[fkey] || 0) + 1;
    drafted++;
  }

  // report how big the frontier still is, so you can see the crawl growing
  const { rows: fr } = await q(`SELECT count(*)::int AS n FROM discovered_users WHERE crawled_at IS NULL`);
  const { rows: tot } = await q(`SELECT count(*)::int AS n FROM discovered_users`);
  const detail = { usersHarvested: seedCount, frontierRemaining: fr[0]?.n ?? 0, totalDiscovered: tot[0]?.n ?? 0, candidates: ids.length, harvested: drafted, observations, byFormat, ms: Date.now() - started };
  log.info(detail, 'harvestSleeperDrafts done');
  await recordJob('harvestSleeperDrafts', true, detail);
  return detail;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  harvestSleeperDrafts().then(() => process.exit(0)).catch((e) => { log.error(e); process.exit(1); });
}
