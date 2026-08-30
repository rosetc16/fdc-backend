// PROJECTION DIAGNOSTIC — what stat keys does the live feed ACTUALLY carry, per position?
//
// Trey: "can you check DST point projections… most/all are coming up as 0 (and VBD is 0). I also think the
// Kicker projected points is extremely low (in the 40s)."
//
// The DST half was a certainty — mapStats had no team-defense branch, so every defense reached the engine
// with an empty stat object. The kicker half is NOT a certainty: 40-ish points is what a kicker scores from
// extra points alone, which says the made field goals are missing, but WHICH key they are missing under is
// something only the live data can answer. Sleeper is not reachable from a sandbox, so rather than guess a
// third spelling and ship it, this prints the truth: for every position, how many players have a projection
// at all, which raw keys those projections carry, and what the engine's mapper makes of them.
//
// This is the same lesson as the injury saga (112-115) and the SOS one: four rounds went by there because
// every job reported a clean success. Build the instrument first.
import { q } from './db.js';

// The keys the front-end's scoreFromStats actually reads, by position — so the report can say not just
// "here is what arrived" but "here is what arrived that we can USE".
const USED = {
  K: ['fg', 'fg50', 'pat', 'fgMiss'],
  DST: ['sack', 'dint', 'dfr', 'dtd', 'pa'],
  QB: ['passYd', 'passTD', 'INT', 'rushYd', 'rushTD', 'fum'],
  RB: ['rushYd', 'rushTD', 'rec', 'recYd', 'recTD', 'fum'],
  WR: ['rec', 'recYd', 'recTD', 'rushYd', 'rushTD', 'fum'],
  TE: ['rec', 'recYd', 'recTD', 'fum'],
};

export async function projDiagnose(season, mapStats) {
  const out = { season, positions: {}, hints: [] };
  const { rows } = await q(
    `SELECT p.player_id, p.position AS pos, pr.stats
       FROM players p LEFT JOIN projections pr
         ON pr.player_id = p.player_id AND pr.season = $1 AND pr.source = 'sleeper'
      WHERE p.position IS NOT NULL`, [season]
  );
  if (!rows.length) { out.hints.push('no players in the database — run Full refresh first'); return out; }

  const byPos = new Map();
  rows.forEach((r) => {
    const pos = String(r.pos || '').toUpperCase();
    if (!byPos.has(pos)) byPos.set(pos, []);
    byPos.get(pos).push(r);
  });

  for (const [pos, list] of byPos) {
    const withProj = list.filter((r) => r.stats && Object.keys(r.stats).length);
    const rawKeys = new Map();
    withProj.forEach((r) => Object.keys(r.stats).forEach((k) => rawKeys.set(k, (rawKeys.get(k) || 0) + 1)));
    // What the mapper produces, and how often each mapped key survives.
    const mappedKeys = new Map();
    let mappedEmpty = 0;
    withProj.forEach((r) => {
      const m = mapStats(r.stats) || {};
      const ks = Object.keys(m);
      if (!ks.length) mappedEmpty++;
      ks.forEach((k) => mappedKeys.set(k, (mappedKeys.get(k) || 0) + 1));
    });
    const top = (m, n2 = 24) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n2)
      .map(([k, v]) => `${k}:${v}`);
    const used = USED[pos] || null;
    const missing = used ? used.filter((k) => !mappedKeys.has(k)) : [];
    out.positions[pos] = {
      players: list.length,
      withProjection: withProj.length,
      mappedToNothing: mappedEmpty,
      rawKeys: top(rawKeys),
      mappedKeys: top(mappedKeys),
      ...(used ? { engineReads: used, missingAfterMapping: missing } : {}),
      // one real example, so an unrecognised shape is visible rather than merely counted
      sample: withProj[0] ? { player_id: withProj[0].player_id, raw: withProj[0].stats, mapped: mapStats(withProj[0].stats) } : null,
    };
    if (used && withProj.length && missing.length) {
      out.hints.push(`${pos}: ${missing.join(', ')} never survive mapping — the engine scores ${pos}s without them. Raw keys present: ${top(rawKeys, 12).join(' ')}`);
    }
    if (withProj.length === 0 && list.length > 0) {
      out.hints.push(`${pos}: ${list.length} players and NOT ONE projection row — syncProjections has never stored one for this position.`);
    }
  }
  if (!out.hints.length) out.hints.push('every position maps every stat the engine reads — projections are not the problem.');
  return out;
}
