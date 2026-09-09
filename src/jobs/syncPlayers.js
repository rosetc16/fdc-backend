// JOB: sync the canonical players table from Sleeper's master player list.
// Run daily. This is the identity spine — every ADP/projection resolves to a player_id here.
import { getAllPlayers } from '../lib/sleeper.js';
import { normName } from '../lib/names.js';
import { q, tx } from '../lib/db.js';
import { log } from '../lib/log.js';
import { recordJob } from '../lib/jobs.js';
import { byeForTeam } from '../lib/byeWeeks.js';

/* ⭐⭐⭐⭐ EVERY SLOT A PLATFORM WILL LET YOU START THIS PLAYER IN, best-first.
   Feedback via Trey: "Travis Hunter is not available to select in their league. I'm wondering if that's
   because he's listed as both a wide receiver and a defensive back."
   That was it. Sleeper publishes `fantasy_positions` as an ARRAY — Hunter's is ["WR","DB"] — and the sync
   read `p.position` first, used the array only as a fallback, and then kept element [0] and threw the rest
   away. Whichever position survived, the other was gone; and two gates downstream then dropped him for not
   being the position they wanted (the pack's SQL lists nine positions and its posAllowed() refuses IDP
   unless the league starts defenders). A player stored as DB is therefore ABSENT from an ordinary league,
   not greyed out — which is exactly what "not available to select" looks like from the outside.
   ⚠ THE ARRAY IS THE AUTHORITY, not `position`. fantasy_positions is the list of slots a platform will
     actually start him in, which is the question a draft board is asking; `position` is his listed role,
     which is the question nobody asked. They agree for every ordinary player and differ for precisely the
     players this bug is about.
   ⚠ AND THE DEFENSIVE SPELLINGS ARE NORMALISED HERE, at the point of entry, rather than three layers later.
     Sleeper says CB, S, DE, DT; the pack's SQL, the roster settings and the rest of the app say DB and DL.
     The old keep-list let CB and S into the database and the pack's WHERE clause then silently discarded
     them — kept by one filter, dropped by the next, which is the most expensive shape a filter bug has
     because nothing anywhere reports it.
   ⚠ OFFENCE SORTS FIRST, and that ordering is load-bearing rather than cosmetic: callers take [0] as the
     player's headline position, and for a two-way player the fantasy-relevant one is the offensive one. */
const IDP_NORM = { CB: 'DB', S: 'DB', FS: 'DB', SS: 'DB', DE: 'DL', DT: 'DL', NT: 'DL', OLB: 'LB', ILB: 'LB', MLB: 'LB' };
const POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB'];
export function fantasyPositionsOf(p) {
  if (!p) return [];
  const raw = Array.isArray(p.fantasy_positions) && p.fantasy_positions.length
    ? p.fantasy_positions : (p.position ? [p.position] : []);
  const norm = [...new Set(raw.map((x) => IDP_NORM[String(x).toUpperCase()] || String(x).toUpperCase()))]
    .filter((x) => POS_ORDER.includes(x));
  return norm.sort((a, b) => POS_ORDER.indexOf(a) - POS_ORDER.indexOf(b));
}

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
  // Sleeper sends the WHOLE injury picture on every player — the body part, a note, and the date it
  // started — and we were keeping only the one-letter designation and throwing the rest away. That detail
  // is exactly what people otherwise go and dig for on another site, and it costs nothing to keep.
  // `fantasy_positions` is the comma-joined list of EVERY slot a platform will start this player in — the
  // fix for two-way players. Stored as text rather than an array so it reads identically on any Postgres and
  // needs no driver-side array handling for a field that is at most three short tokens.
  for (const col of ['injury_body_part TEXT', 'injury_notes TEXT', 'injury_start_date TEXT', 'fantasy_positions TEXT']) {
    try { await q(`ALTER TABLE players ADD COLUMN IF NOT EXISTS ${col};`); } catch (e) { log.error(e, 'ensure ' + col); }
  }

  await tx(async (client) => {
    for (const sid of ids) {
      const p = players[sid];
      if (!p || !p.full_name && !p.last_name) continue;
      /* ⭐⭐⭐⭐ A TWO-WAY PLAYER HAS TWO POSITIONS AND WE WERE KEEPING ONE OF THEM.
         Feedback via Trey: "Travis Hunter is not available to select in their league… he's listed as both a
         wide receiver and a defensive back."
         Exactly right, and the line above was the whole bug. Sleeper publishes `fantasy_positions` as an
         ARRAY — Hunter's is ["WR","DB"] — and this read `p.position` first and the array only as a fallback,
         then kept a single scalar. Whichever one won, the other was gone, and two independent gates
         downstream then dropped him for not being the position they wanted: the pack's SQL only selects
         QB/RB/WR/TE/K/DEF/DL/LB/DB, and its posAllowed() drops IDP entirely unless the league starts
         defenders. So a player stored as DB (or worse, CB, which the pack's WHERE clause does not even
         list) is invisible in every ordinary league — not hidden, not greyed out, ABSENT — which is exactly
         what "not available to select" looks like from the outside.
         ⚠ FANTASY POSITIONS FIRST, AND ALL OF THEM. `fantasy_positions` is the list of slots a platform will
           actually let you start him in, which is the question the board is asking; `position` is his
           listed role, which is the question nobody asked. They agree for every ordinary player and differ
           for precisely the players this bug is about.
         ⚠ AND THE DEFENSIVE SPELLINGS ARE NORMALISED HERE rather than three layers later. Sleeper says CB,
           S, DE, DT; the pack's SQL, the roster settings and the whole app say DB and DL. The old `keep`
           list let CB and S through into the database and the pack's WHERE clause then silently discarded
           them — a player kept by one filter and dropped by the next, which is the most expensive shape a
           filter bug can have because nothing anywhere reports it. */
      const norm = fantasyPositionsOf(p);
      if (!norm.length) continue;
      const pos = norm[0];
      const fullName = p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || sid;
      // Team defenses (DEF) key their bye off the team code itself (player_id === team abbrev on Sleeper).
      const teamForBye = p.team || (pos === 'DEF' ? sid : null);
      const bye = byeForTeam(teamForBye);
      await client.query(
        `INSERT INTO players (player_id, sleeper_id, espn_id, yahoo_id, rotowire_id, sportradar_id, gsis_id,
            full_name, norm_name, team, position, age, years_exp, injury_status, news_updated, bye_week, active,
            injury_body_part, injury_notes, injury_start_date, fantasy_positions, updated_at)
         VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, now())
         ON CONFLICT (player_id) DO UPDATE SET
            espn_id=EXCLUDED.espn_id, yahoo_id=EXCLUDED.yahoo_id, rotowire_id=EXCLUDED.rotowire_id,
            sportradar_id=EXCLUDED.sportradar_id, gsis_id=EXCLUDED.gsis_id,
            full_name=EXCLUDED.full_name, norm_name=EXCLUDED.norm_name, team=EXCLUDED.team,
            position=EXCLUDED.position, age=EXCLUDED.age, years_exp=EXCLUDED.years_exp,
            injury_status=EXCLUDED.injury_status, news_updated=EXCLUDED.news_updated,
            injury_body_part=EXCLUDED.injury_body_part, injury_notes=EXCLUDED.injury_notes,
            injury_start_date=EXCLUDED.injury_start_date, fantasy_positions=EXCLUDED.fantasy_positions,
            bye_week=COALESCE(EXCLUDED.bye_week, players.bye_week), active=EXCLUDED.active, updated_at=now()`,
        [sid, p.espn_id || null, p.yahoo_id || null, p.rotowire_id || null,
         p.sportradar_id || null, p.gsis_id || null,
         fullName, normName(fullName), p.team || null, pos, p.age || null,
         (p.years_exp != null ? p.years_exp : null),
         p.injury_status || null, (p.news_updated != null ? Number(p.news_updated) : null), bye, p.active !== false,
         p.injury_body_part || null, p.injury_notes || null, p.injury_start_date || null, norm.join(',')]
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
