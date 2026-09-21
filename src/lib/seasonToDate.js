// SEASON-TO-DATE PLAYER TOTALS — b164.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Trey: "For the trade calculator... is the projected points of value taking into account what they have
// already done this season? I just want to make sure it's as dynamic as possible with changing values
// weekly."
//
// It was not. Every season-level number in the app — trade values, trade ideas, power rankings — was
// Sleeper's full-season PROJECTION, refreshed daily, with nothing about what a player had actually scored.
// A receiver averaging 19 a game against a 12-point projection was still valued at 12. This module
// supplies the missing half: each player's summed actual stat line across the COMPLETED weeks of the
// season, plus how many games he actually played. The client blends it with the projection.
//
// ⭐ THE STATS GO THROUGH THE PLAYER PACK'S OWN `mapStats`, the function that turns Sleeper's projection
//   keys into the engine's (passYd, recTD, …). Same translation, same scorer on the client, same league
//   scoring — so an actual rate and a projected rate are measured on exactly the same basis. A second
//   translation would be the classic way for "actual" and "projected" to disagree about what a touchdown
//   is worth.
// ⭐ RAW STATS, NOT POINTS. Sleeper's actuals carry pts_ppr etc., but this app scores with each league's
//   own settings (TE premium, per-carry, bonuses), so pre-summed points would be wrong for most leagues.
//
// Design copied from defVsPos.js on purpose, including its most important property: the READ is
// cache-only and never runs the expensive walk inline, so it cannot slow a hub load. One Sleeper actuals
// call per completed week, cached in `season_to_date` keyed by (season, through_week), plus a short memo.

import { q } from './db.js';
import { getWeeklyStats } from './sleeper.js';
import { mapStatsForDiag as mapStats } from '../routes/playerPack.js';

const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB'];

let memo = { key: null, table: null, at: 0 };
const MEMO_MS = 5 * 60 * 1000;

async function ensureTable() {
  try {
    await q(`CREATE TABLE IF NOT EXISTS season_to_date (
      season INT NOT NULL, through_week INT NOT NULL, table_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (season, through_week)
    );`);
  } catch { /* surfaced at call time if truly broken */ }
}

/* Did he actually PLAY that week? Sleeper publishes a row for inactive players too, so presence is not
   participation. `gp` is the field Sleeper uses; snap counts are the fallback for rows that omit it.
   ⚠ A PLAYER WHO WAS ACTIVE AND SCORED ZERO PLAYED — he must count, or a dud week vanishes from his
   average and flatters it. That is why this reads participation fields and never points. */
export function playedIn(stats) {
  if (!stats) return false;
  if (stats.gp != null) return Number(stats.gp) > 0;
  const snaps = (Number(stats.off_snp) || 0) + (Number(stats.def_snp) || 0) + (Number(stats.st_snp) || 0);
  if (snaps > 0) return true;
  /* No participation field at all — fall back to any recorded activity. Worse than `gp`, better than
     counting every inactive row as a game. */
  return Object.keys(stats).some((k) => !/^(pts_|rank_|pos_rank|gms_active|adp)/.test(k) && Number(stats[k]) !== 0);
}

/* Sum one week's raw rows into the running totals. Exported for the test. */
export function addWeek(acc, rows) {
  for (const row of rows || []) {
    const sid = row && (row.player_id || (row.player && row.player.player_id));
    if (!sid) continue;
    const st = row.stats;
    if (!playedIn(st)) continue;
    const mapped = mapStats(st);
    const cur = acc[sid] || (acc[sid] = { gp: 0, s: {} });
    cur.gp += 1;
    for (const k of Object.keys(mapped)) {
      const v = Number(mapped[k]);
      if (!Number.isFinite(v)) continue;
      cur.s[k] = Math.round(((cur.s[k] || 0) + v) * 10) / 10;
    }
  }
  return acc;
}

/* `fetchWeek` is injectable for the test — production always uses Sleeper's weekly actuals. */
async function compute(season, throughWeek, fetchWeek) {
  const get = fetchWeek || ((wk) => getWeeklyStats(season, wk, { positions: POSITIONS }));
  const acc = {};
  for (let wk = 1; wk <= throughWeek; wk++) {
    let rows = [];
    try { rows = (await get(wk)) || []; } catch { rows = []; }
    addWeek(acc, rows);
  }
  /* A slate this thin means the feed failed rather than that nobody played. Refuse to cache it, so a
     transient outage cannot freeze a week of "nobody has done anything" into the table. */
  return Object.keys(acc).length >= 100 ? acc : null;
}

// Public read: the table through the last COMPLETED week. Cache-only; kicks a background warm on a miss
// and returns {} (which the client reads as "projections only") rather than making a hub load wait.
export async function getSeasonToDate(season, currentWeek, opts = {}) {
  const throughWeek = Math.max(0, Number(currentWeek || 1) - 1);
  if (throughWeek < 1) return { throughWeek: 0, players: {} };
  const key = `${season}:${throughWeek}`;
  if (memo.key === key && memo.table && (Date.now() - memo.at) < MEMO_MS) return { throughWeek, players: memo.table };
  await ensureTable();
  try {
    const { rows } = await q('SELECT table_json FROM season_to_date WHERE season=$1 AND through_week=$2', [season, throughWeek]);
    if (rows[0] && rows[0].table_json) {
      memo = { key, table: rows[0].table_json, at: Date.now() };
      return { throughWeek, players: rows[0].table_json };
    }
  } catch { /* fall through */ }
  /* ⭐⭐⭐⭐ b165 — WAIT FOR IT, BOUNDED. b164 answered a cold cache with `players: {}` and warmed in the
     background, so the first load after a new week showed PROJECTIONS ONLY and a later load showed blended
     values. Trey priced a trade on one and checked the result on the other, and the whole league had been
     re-valued underneath him: "it told me I wouldn't move... then I made the trade and I dropped 3 spots."
     The calculator was right both times; the ground moved. This endpoint is fetched in the background by
     the hub — nothing renders waiting on it — so it can afford to finish the job: up to `wait` ms for the
     build (about one Sleeper call per completed week), and only then fall back to the warming answer. */
  const build = warmSeasonToDate(season, currentWeek, opts).catch(() => ({}));
  if (opts.wait > 0) {
    const t = await Promise.race([build, new Promise((r) => setTimeout(() => r(null), opts.wait))]);
    if (t && Object.keys(t).length) return { throughWeek, players: t };
  }
  return { throughWeek, players: {}, warming: true };
}

/* In-flight builds by key. ⚠ A MAP OF PROMISES, NOT A SET — b165. A Set could only say "someone is already
   building" and hand the second caller `{}`, so two hubs opening together meant one got blended values and
   the other got projections. Now every caller for the same week waits on the same build. */
const inflight = new Map();
export async function warmSeasonToDate(season, currentWeek, opts = {}) {
  const throughWeek = Math.max(0, Number(currentWeek || 1) - 1);
  if (throughWeek < 1) return {};
  const key = `${season}:${throughWeek}`;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    await ensureTable();
    try {
      const { rows } = await q('SELECT table_json FROM season_to_date WHERE season=$1 AND through_week=$2', [season, throughWeek]);
      if (rows[0] && rows[0].table_json) { memo = { key, table: rows[0].table_json, at: Date.now() }; return rows[0].table_json; }
    } catch { /* compute */ }
    let table = null;
    try { table = await compute(season, throughWeek, opts.fetchWeek); } catch { table = null; }
    if (table) {
      try {
        await q(
          `INSERT INTO season_to_date (season, through_week, table_json, updated_at)
           VALUES ($1,$2,$3,now())
           ON CONFLICT (season, through_week) DO UPDATE SET table_json=EXCLUDED.table_json, updated_at=now()`,
          [season, throughWeek, JSON.stringify(table)]
        );
      } catch { /* best-effort */ }
      memo = { key, table, at: Date.now() };
    }
    return table || {};
  })();
  inflight.set(key, p);
  try { return await p; } finally { inflight.delete(key); }
}
