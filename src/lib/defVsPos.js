// Season-to-date DEFENSE VS POSITION difficulty — the same method the major fantasy sites use: for each
// NFL defense, total the actual fantasy points ALLOWED to each position across completed weeks, then rank
// all defenses (1 = toughest / fewest points allowed). This replaces the earlier projection-derived
// version, which conflicted with Sleeper because projections price in the opposing OFFENSE, not just the
// defense.
//
// Design: expensive to compute (one Sleeper actuals call per completed week), so we cache the result in the
// `def_vs_pos` table keyed by (season, through_week) and also hold a short in-process memo. A hub request
// recomputes only when a new week has completed since the last cache entry.

import { q } from './db.js';
import { getWeeklyStats } from './sleeper.js';

const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

// In-process memo so bursts of hub loads in the same minute don't even hit the DB.
let memo = { key: null, table: null, at: 0 };
const MEMO_MS = 5 * 60 * 1000;

async function ensureTable() {
  try {
    await q(`CREATE TABLE IF NOT EXISTS def_vs_pos (
      season INT NOT NULL, through_week INT NOT NULL, table_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (season, through_week)
    );`);
  } catch { /* surfaced at call time if truly broken */ }
}

// Points-allowed uses PPR as a neutral, league-independent yardstick (matchup difficulty is about the
// defense, not any one league's scoring). We read the pre-summed pts_ppr from actuals; if absent we skip
// that row rather than guess.
function pprOf(stats) {
  if (!stats) return null;
  if (stats.pts_ppr != null) return Number(stats.pts_ppr);
  if (stats.pts_half_ppr != null) return Number(stats.pts_half_ppr);
  if (stats.pts_std != null) return Number(stats.pts_std);
  return null;
}

// Build the table from scratch by walking weeks 1..throughWeek of ACTUALS.
async function compute(season, throughWeek) {
  // allow[def][pos] = { total, games:Set(week) } — points allowed and how many weeks contributed.
  const allow = {};
  for (let wk = 1; wk <= throughWeek; wk++) {
    let rows = [];
    try { rows = (await getWeeklyStats(season, wk)) || []; } catch { rows = []; }
    for (const row of rows) {
      const pos = row.player && row.player.position;
      const def = row.opponent; // the defense this player faced that week
      if (!def || !POSITIONS.includes(pos)) continue;
      const pts = pprOf(row.stats);
      if (pts == null) continue;
      if (!allow[def]) allow[def] = {};
      if (!allow[def][pos]) allow[def][pos] = { total: 0, weeks: new Set() };
      allow[def][pos].total += pts;
      allow[def][pos].weeks.add(wk);
    }
  }

  const defs = Object.keys(allow);
  const n = defs.length;
  if (n < 8) return null; // not enough of a slate to be meaningful

  // For each position, rank defenses by points allowed PER GAME (so a team on bye a week isn't penalized).
  const table = {};
  POSITIONS.forEach((pos) => {
    const rows = defs.map((def) => {
      const a = allow[def][pos] || { total: 0, weeks: new Set() };
      const games = a.weeks.size || 1;
      return { def, pg: a.total / games, total: a.total, games: a.weeks.size };
    });
    // ascending pg = toughest first (allows fewest points per game)
    rows.sort((x, y) => x.pg - y.pg);
    rows.forEach((r, i) => {
      const rank = i + 1;
      const tier = rank <= Math.ceil(n / 3) ? 'tough' : rank <= Math.ceil((2 * n) / 3) ? 'neutral' : 'soft';
      if (!table[r.def]) table[r.def] = {};
      table[r.def][pos] = { rank, of: n, tier, pg: Math.round(r.pg * 10) / 10 };
    });
  });
  return table;
}

// Public: get the season-to-date table through the last COMPLETED week (currentWeek - 1). Returns {} when
// there's no completed week yet (e.g. very start of the season) — callers treat {} as "no data".
export async function getDefVsPos(season, currentWeek) {
  const throughWeek = Math.max(0, Number(currentWeek || 1) - 1);
  if (throughWeek < 1) return {}; // no games played yet this season
  const key = `${season}:${throughWeek}`;

  // 1) in-process memo
  if (memo.key === key && memo.table && (Date.now() - memo.at) < MEMO_MS) return memo.table;

  await ensureTable();

  // 2) DB cache for this exact (season, through_week)
  try {
    const { rows } = await q('SELECT table_json FROM def_vs_pos WHERE season=$1 AND through_week=$2', [season, throughWeek]);
    if (rows[0] && rows[0].table_json) {
      memo = { key, table: rows[0].table_json, at: Date.now() };
      return rows[0].table_json;
    }
  } catch { /* fall through to compute */ }

  // 3) compute + persist
  let table = {};
  try {
    table = (await compute(season, throughWeek)) || {};
  } catch { table = {}; }
  try {
    if (table && Object.keys(table).length) {
      await q(
        `INSERT INTO def_vs_pos (season, through_week, table_json, updated_at)
         VALUES ($1,$2,$3,now())
         ON CONFLICT (season, through_week) DO UPDATE SET table_json=EXCLUDED.table_json, updated_at=now()`,
        [season, throughWeek, JSON.stringify(table)]
      );
    }
  } catch { /* cache write is best-effort */ }
  memo = { key, table, at: Date.now() };
  return table;
}
