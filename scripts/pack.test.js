// WHAT THE PACK'S STAT MAPPER DOES WITH A KICKER AND A TEAM DEFENSE.
//
// Trey: "can you check DST point projections… most/all are coming up as 0 (and VBD is 0). I also think the
// Kicker projected points is extremely low (in the 40s)."
//
// The defense half was not a rounding problem or a scoring-settings problem: `mapStats` had no team-defense
// branch at all, so every DST reached the front end with an EMPTY stat object and the engine's formula
// (`max(0, 35 - (pa ?? 350)/10) * paPer` plus nothing else) evaluated to a clean zero. A wrong number gets
// argued with; a confident zero gets believed.
//
// The kicker half is the same shape one level down: 40-ish points is exactly what a kicker scores from extra
// points alone, which means the made field goals never arrived under the key the mapper was reading.
// Sleeper is unreachable from the sandbox, so the mapper now accepts every spelling I know of and the admin
// `proj-check` job reports which one the live feed actually uses.
import assert from 'assert';
import { mapStatsForDiag as mapStats } from '../src/routes/playerPack.js';

let pass = 0;
const ok = (n) => { console.log('  PASS  ' + n); pass++; };

// The front end's scoreFromStats, for the two positions under test — copied deliberately rather than
// imported, because the point is to prove the BACKEND hands over something that position can score.
const DEFAULT = { fg: 3, fg50: 2, pat: 1, fgMiss: -1, sack: 1, dint: 2, dfr: 2, dtd: 6, paPer: 1 };
const scoreK = (s) => (s.fg || 0) * DEFAULT.fg + (s.fg50 || 0) * DEFAULT.fg50 + (s.pat || 0) * DEFAULT.pat + (s.fgMiss || 0) * DEFAULT.fgMiss;
const scoreD = (s) => (s.sack || 0) * DEFAULT.sack + (s.dint || 0) * DEFAULT.dint + (s.dfr || 0) * DEFAULT.dfr
  + (s.dtd || 0) * DEFAULT.dtd + Math.max(0, 35 - (s.pa || 350) / 10) * DEFAULT.paPer;

// ---- 1 · ⭐⭐ A TEAM DEFENSE NO LONGER MAPS TO NOTHING -------------------------------------------
{
  const raw = { sack: 45, int: 16, fum_rec: 11, def_td: 4, pts_allow: 300, safe: 1 };
  const m = mapStats(raw);
  ['sack', 'dint', 'dfr', 'dtd', 'pa'].forEach((k) => assert.ok(m[k] != null, `${k} is missing from the mapped defense`));
  assert.strictEqual(m.sack, 45); assert.strictEqual(m.dint, 16);
  assert.strictEqual(m.dfr, 11); assert.strictEqual(m.dtd, 4); assert.strictEqual(m.pa, 300);
  const pts = scoreD(m);
  // ⚠ THE FAILABLE HALF, and the exact number Trey saw: the OLD mapper produced {} for this same input.
  assert.strictEqual(scoreD({}), 0, 'an empty stat object should score 0 — that is what made this invisible');
  assert.ok(pts > 100, `a top defense should be worth well over 100 points, got ${pts}`);
  ok(`1 · ⭐⭐ a team defense maps to real stats and scores ${Math.round(pts)} points, where an unmapped one scores exactly 0`);
}

// ---- 2 · ⭐ AND ITS RANGE IS REAL, not a constant ------------------------------------------------
// Every defense scoring the same number is the other way this can look "fine" and be broken.
{
  const elite = mapStats({ sack: 55, int: 20, fum_rec: 14, def_td: 6, pts_allow: 260 });
  const poor = mapStats({ sack: 28, int: 8, fum_rec: 6, def_td: 1, pts_allow: 470 });
  const a = scoreD(elite), b = scoreD(poor);
  assert.ok(a - b > 40, `the best and worst defense are only ${Math.round(a - b)} points apart — the spread is not real`);
  ok(`2 · ⭐ and the range is real — ${Math.round(a)} for a top unit vs ${Math.round(b)} for a bad one`);
}

// ---- 3 · ⭐⭐ A KICKER'S MADE FIELD GOALS SURVIVE, WHATEVER SLEEPER CALLS THEM ---------------------
{
  const shapes = [
    ['fgm/xpm', { fgm: 34, xpm: 40, fgm_50_59: 4, fgm_60p: 1, fgmiss: 5 }],
    ['fg_made/pat_made', { fg_made: 34, pat_made: 40, fgm_50p: 5, fg_miss: 5 }],
    ['fga minus misses', { fga: 39, fgmiss: 5, xpm: 40 }],
  ];
  const scored = shapes.map(([name, raw]) => {
    const m = mapStats(raw);
    assert.ok(m.fg > 0, `${name}: made field goals did not survive mapping`);
    assert.ok(m.pat > 0, `${name}: extra points did not survive mapping`);
    return [name, scoreK(m)];
  });
  scored.forEach(([name, v]) => assert.ok(v > 100, `${name} scores ${Math.round(v)} — that is the "kickers are in the 40s" bug`));
  // ⚠ THE FAILABLE HALF: extra points ALONE is the ~40 he reported. If the field goals are dropped this is
  //   what you get, and it looks like a plausible projection rather than an error.
  const patOnly = scoreK(mapStats({ xpm: 40 }));
  assert.ok(patOnly > 35 && patOnly < 50, `expected the pat-only case to land in the 40s, got ${patOnly}`);
  ok(`3 · ⭐⭐ a kicker scores ${scored.map(([n, v]) => `${Math.round(v)} (${n})`).join(', ')} — against ${Math.round(patOnly)} when only the extra points arrive, which is what he was seeing`);
}

// ---- 4 · ⭐ NO DOUBLE COUNTING ACROSS ALIASES ----------------------------------------------------
// Accepting several spellings is only safe if a feed carrying two of them doesn't add them together.
{
  const both = mapStats({ fgm: 30, fgm_50_59: 3, fgm_60p: 1, fgm_50p: 4, xpm: 30 });
  assert.strictEqual(both.fg50, 4, `50+ field goals double-counted: ${both.fg50}`);
  const tds = mapStats({ def_td: 3, def_st_td: 2, st_td: 2 });
  assert.strictEqual(tds.dtd, 5, `defensive/special-teams touchdowns double-counted: ${tds.dtd}`);
  ok('4 · ⭐ a feed carrying two spellings of the same stat is not counted twice');
}

// ---- 5 · A SKILL PLAYER IS UNCHANGED ------------------------------------------------------------
// The whole point is that this was an unmapped-position bug, so the positions that already worked must not
// have moved a point.
{
  const m = mapStats({ rush_att: 300, rush_yd: 1350, rush_td: 12, rec: 45, rec_tgt: 60, rec_yd: 380, rec_td: 3, fum_lost: 2 });
  assert.strictEqual(m.rushYd, 1350); assert.strictEqual(m.rec, 45); assert.strictEqual(m.recTD, 3);
  assert.strictEqual(m.fum, 2);
  assert.ok(m.sack === undefined && m.fg === undefined, 'defensive/kicking keys leaked onto a running back');
  ok('5 · a running back maps exactly as before, with no kicking or defensive keys attached');
}

// ---- 6 · ⭐⭐ SLEEPER'S FIELD-GOAL DISTANCE SETTINGS ARE VALUES, NOT BONUSES -----------------------
// Trey: "I wonder if you're not taking into account the rules for different points for different length
// field goals… or the value of PATs. Something is off."
// Two separate things were wrong. The engine had no 40-49 bonus at all, so a league scoring long field
// goals at 4 graded every one of them as a 3. And Sleeper expresses distance scoring as ABSOLUTE VALUES
// (`fgm_0_19 … fgm_50p`, default 3/3/3/4/5) while the engine models a base plus bonuses — importing 4
// straight into the bonus would have scored a 45-yarder as 3 + 4 = 7, overshooting in the other direction.
import { mapSleeperScoringForDiag as mapScoring } from '../src/routes/connect.js';
{
  const dflt = mapScoring({ fgm_0_19: 3, fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4, fgm_50p: 5, xpm: 1, fgmiss: -1 });
  assert.strictEqual(dflt.fg, 3, `base field goal came through as ${dflt.fg}`);
  assert.strictEqual(dflt.fg40, 1, `a 40-49 yarder worth 4 should be a +1 bonus, got ${dflt.fg40}`);
  assert.strictEqual(dflt.fg50, 2, `a 50+ yarder worth 5 should be a +2 bonus, got ${dflt.fg50}`);
  assert.strictEqual(dflt.pat, 1);
  // a generous league: 5 / 6 for the long ones
  const rich = mapScoring({ fgm_0_19: 3, fgm_40_49: 5, fgm_50p: 6, xpm: 1 });
  assert.strictEqual(rich.fg40, 2); assert.strictEqual(rich.fg50, 3);
  // ⚠ a flat-scoring league must not gain phantom bonuses
  const flat = mapScoring({ fgm: 3, xpm: 1 });
  assert.strictEqual(flat.fg, 3);
  assert.ok(flat.fg40 === undefined && flat.fg50 === undefined, `a flat league picked up distance bonuses: ${JSON.stringify(flat)}`);
  ok(`6 · ⭐⭐ distance scoring converts to bonuses (4 → +1, 5 → +2; a generous 5/6 → +2/+3) and a flat league gains none`);
}

console.log(`\n${pass}/6 player-pack mapping checks passed`);
process.exit(0);
