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
import { getUserDrafts, getDraft, getDraftPicks, getUser, getUserLeagues, getLeagueUsers, getLeagueDrafts } from '../lib/sleeper.js';
import { cfgFromSleeperDraft, formatKey } from '../lib/formatKey.js';
import { q } from '../lib/db.js';
import { log } from '../lib/log.js';
import { recordJob } from '../lib/jobs.js';

// Seed usernames to bootstrap discovery before you have connected users. Replace/expand freely.
const SEED_USERNAMES = (process.env.HARVEST_SEED_USERS || '').split(',').map((s) => s.trim()).filter(Boolean);
// One-hop expansion: from each seed user, also discover their leaguemates and harvest THEIR drafts
// too. This multiplies the draft pool from the same seed list and pulls in many more redraft/SF
// drafts. Controlled by env so you can cap API usage. Default on.
const EXPAND_HOP = process.env.HARVEST_EXPAND !== '0';
const MAX_SEED_USERS = Number(process.env.HARVEST_MAX_USERS || 400); // safety cap on discovered users

async function seedUserIds() {
  // connected users who linked Sleeper (stored on leagues.connect)
  const { rows } = await q(
    `SELECT DISTINCT connect->>'external_user_id' AS uid
       FROM leagues WHERE connect->>'platform' = 'sleeper' AND connect ? 'external_user_id'`
  );
  const connected = rows.map((r) => r.uid).filter(Boolean);
  const seeds = [];
  for (const uname of SEED_USERNAMES) {
    const u = await getUser(uname);
    if (u?.user_id) seeds.push(u.user_id);
  }
  return [...new Set([...connected, ...seeds])];
}

// One-hop: expand a set of user ids by adding everyone who shares a league with them this season.
async function expandByLeaguemates(userIds, season, cap) {
  const expanded = new Set(userIds);
  for (const uid of userIds) {
    if (expanded.size >= cap) break;
    let leagues = [];
    try { leagues = (await getUserLeagues(uid, season)) || []; } catch { /* skip */ }
    for (const lg of leagues) {
      if (!lg.league_id) continue;
      let members = [];
      try { members = (await getLeagueUsers(lg.league_id)) || []; } catch { /* skip */ }
      for (const m of members) { if (m.user_id) expanded.add(m.user_id); }
      if (expanded.size >= cap) break;
    }
  }
  return [...expanded].slice(0, cap);
}

export async function harvestSleeperDrafts({ season = config.activeSeason, maxDrafts = config.harvest.batch } = {}) {
  const started = Date.now();
  let userIds = await seedUserIds();
  if (userIds.length === 0) {
    const detail = { skipped: 'no seed/connected Sleeper users yet', hint: 'set HARVEST_SEED_USERS or connect a Sleeper account' };
    log.warn(detail, 'harvest: nothing to discover');
    await recordJob('harvestSleeperDrafts', true, detail);
    return detail;
  }

  const seedCount = userIds.length;
  if (EXPAND_HOP) {
    userIds = await expandByLeaguemates(userIds, season, MAX_SEED_USERS);
  }

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
  for (const draftId of todo) {
    const draft = await getDraft(draftId);
    if (!draft || draft.sport !== 'nfl') continue;
    const cfg = cfgFromSleeperDraft(draft);
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

  const detail = { seedUsers: seedCount, expandedUsers: userIds.length, candidates: ids.length, harvested: drafted, observations, byFormat, ms: Date.now() - started };
  log.info(detail, 'harvestSleeperDrafts done');
  await recordJob('harvestSleeperDrafts', true, detail);
  return detail;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  harvestSleeperDrafts().then(() => process.exit(0)).catch((e) => { log.error(e); process.exit(1); });
}
