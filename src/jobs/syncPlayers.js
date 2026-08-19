// JOB: sync the canonical players table from Sleeper's master player list.
// Run daily. This is the identity spine — every ADP/projection resolves to a player_id here.
import { getAllPlayers } from '../lib/sleeper.js';
import { normName } from '../lib/names.js';
import { q, tx } from '../lib/db.js';
import { log } from '../lib/log.js';
import { recordJob } from '../lib/jobs.js';

// Official 2026 NFL bye weeks (source: NFL.com schedule release). Sleeper's player feed doesn't reliably carry
// bye weeks, and byes are a property of the TEAM's schedule, so we resolve each player's bye from his team.
// Update this map each season when the schedule is released. Keys are Sleeper team abbreviations.
const BYES_2026 = {
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
const TEAM_ALIAS = { LA: 'LAR', STL: 'LAR', SD: 'LAC', OAK: 'LV', WSH: 'WAS', JAC: 'JAX', ARZ: 'ARI', LVR: 'LV' };
const byeForTeam = (team) => {
  if (!team) return null;
  const t = String(team).toUpperCase();
  return BYES_2026[t] != null ? BYES_2026[t] : (TEAM_ALIAS[t] && BYES_2026[TEAM_ALIAS[t]] != null ? BYES_2026[TEAM_ALIAS[t]] : null);
};

export async function syncPlayers() {
  const started = Date.now();
  const players = await getAllPlayers({ force: true });
  const ids = Object.keys(players || {});
  let upserts = 0;

  // Defensive: make sure the news_updated column exists before we reference it. If a deploy shipped this
  // code before the migration ran, the INSERT below would throw and roll back the WHOLE player sync —
  // which empties the players table and cascades (no players → no projections → near-empty board). This
  // idempotent ALTER guarantees the column is present so that can't happen.
  try { await q('ALTER TABLE players ADD COLUMN IF NOT EXISTS news_updated BIGINT;'); } catch (e) { log.error(e, 'ensure news_updated column'); }
  try { await q('ALTER TABLE players ADD COLUMN IF NOT EXISTS bye_week SMALLINT;'); } catch (e) { log.error(e, 'ensure bye_week column'); }

  await tx(async (client) => {
    for (const sid of ids) {
      const p = players[sid];
      if (!p || !p.full_name && !p.last_name) continue;
      const pos = p.position || (p.fantasy_positions && p.fantasy_positions[0]) || null;
      // We only care about fantasy-relevant positions (incl. IDP + DST)
      const keep = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB', 'CB', 'S', 'DE', 'DT'];
      if (pos && !keep.includes(pos)) continue;
      const fullName = p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || sid;
      // Team defenses (DEF) key their bye off the team code itself (player_id === team abbrev on Sleeper).
      const teamForBye = p.team || (pos === 'DEF' ? sid : null);
      const bye = byeForTeam(teamForBye);
      await client.query(
        `INSERT INTO players (player_id, sleeper_id, espn_id, yahoo_id, rotowire_id, sportradar_id, gsis_id,
            full_name, norm_name, team, position, age, years_exp, injury_status, news_updated, bye_week, active, updated_at)
         VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
         ON CONFLICT (player_id) DO UPDATE SET
            espn_id=EXCLUDED.espn_id, yahoo_id=EXCLUDED.yahoo_id, rotowire_id=EXCLUDED.rotowire_id,
            sportradar_id=EXCLUDED.sportradar_id, gsis_id=EXCLUDED.gsis_id,
            full_name=EXCLUDED.full_name, norm_name=EXCLUDED.norm_name, team=EXCLUDED.team,
            position=EXCLUDED.position, age=EXCLUDED.age, years_exp=EXCLUDED.years_exp,
            injury_status=EXCLUDED.injury_status, news_updated=EXCLUDED.news_updated,
            bye_week=COALESCE(EXCLUDED.bye_week, players.bye_week), active=EXCLUDED.active, updated_at=now()`,
        [sid, p.espn_id || null, p.yahoo_id || null, p.rotowire_id || null,
         p.sportradar_id || null, p.gsis_id || null,
         fullName, normName(fullName), p.team || null, pos, p.age || null,
         (p.years_exp != null ? p.years_exp : null),
         p.injury_status || null, (p.news_updated != null ? Number(p.news_updated) : null), bye, p.active !== false]
      );
      upserts++;
    }
  });

  const detail = { upserts, total: ids.length, ms: Date.now() - started };
  log.info(detail, 'syncPlayers done');
  await recordJob('syncPlayers', true, detail);
  return detail;
}

// Resolve an external (name, team, pos) to a canonical player_id. Exact normalized match only;
// ambiguous/no matches return null (caller should queue for review rather than guess).
export async function resolvePlayer({ name, team, position }) {
  const nn = normName(name);
  if (!nn) return null;
  const { rows } = await q(
    `SELECT player_id FROM players
      WHERE norm_name=$1 ${position ? 'AND position=$2' : ''}
      ${team ? `AND (team=$${position ? 3 : 2} OR team IS NULL)` : ''}
      LIMIT 2`,
    position && team ? [nn, position, team] : position ? [nn, position] : team ? [nn, team] : [nn]
  );
  if (rows.length === 1) return rows[0].player_id;
  return null; // 0 or ambiguous → caller queues for review
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  syncPlayers().then(() => process.exit(0)).catch((e) => { log.error(e); process.exit(1); });
}
