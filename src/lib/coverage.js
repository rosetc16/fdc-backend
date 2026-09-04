/* POSITIONAL COVERAGE BACKSTOP for the player pack.
 *
 *   Trey: "can you please add Chig Okonkwo (TE, Was) to the available players list. Washington has no TE's
 *          listed and somebody in my league just drafted him."
 *
 * The pack's inclusion gate admits a player who has a season projection OR a published ADP, and drops the
 * rest. That gate is right about what it is FOR — it is what keeps long-retired players with stale harvested
 * ADP off the board — but it has a blind spot it cannot see from the inside: a current player whose
 * projection has not landed and whose ADP has not been published looks exactly like a retired one.
 *
 * The costs are not symmetric. A retired player on the board is a row you scroll past. A missing player is a
 * pick you cannot record: somebody in the league drafts him and the board cannot represent what happened,
 * which corrupts every number downstream of it.
 *
 * So this does not relax the gate. It asks a question the gate cannot: does any NFL team have ZERO players at
 * a position every NFL team fields? That is not a judgement call — it is a provable data gap — and the only
 * players readmitted are the ones filling such a hole.
 *
 * Lives in its own file so it can be tested without a database; the route is a 300-line handler that cannot.
 */

export const CORE_COVERAGE = ['QB', 'RB', 'WR', 'TE'];
export const MAX_BACKSTOP_PER_GAP = 3;
/* ⚠ "FA" IS A TEAM CODE THAT IS NOT A TEAM, AND IT IS THE ONE THE RETIRED PLAYERS WEAR. Every ghost in the
   fixture that started this whole line of work — Jerick McKinnon, David Johnson, Damien Williams — carries
   team "FA". Treating that as a roster would let each of them declare a gap at their own position and walk
   straight back in through the door built to keep them out. A free agent belongs to no depth chart, so he can
   never be evidence that a depth chart is missing somebody. */
const NOT_A_TEAM = new Set(['', 'FA', 'FA*', 'NONE', 'RET', 'UFA', 'RFA']);
const realTeam = (t) => !!t && !NOT_A_TEAM.has(String(t).trim().toUpperCase());

/**
 * Which of the dropped players should be readmitted to keep every team's core positions represented?
 *
 * @param {Array<{team:string|null,pos:string}>} included  players that passed the gate on merit
 * @param {Array<{team:string|null,pos:string}>} dropped   players the gate rejected, in pack order
 * @param {(pos:string)=>boolean} posAllowed               does THIS league draft that position at all
 * @returns {number[]} indexes into `dropped` to readmit
 */
export function positionGapsToFill(included, dropped, posAllowed = () => true) {
  const covered = new Map();
  for (const p of included || []) {
    if (!p || !realTeam(p.team) || !CORE_COVERAGE.includes(p.pos)) continue;
    const k = `${p.team}|${p.pos}`;
    covered.set(k, (covered.get(k) || 0) + 1);
  }
  const addedPerGap = new Map();
  const out = [];
  (dropped || []).forEach((d, i) => {
    if (!d || !realTeam(d.team) || !CORE_COVERAGE.includes(d.pos) || !posAllowed(d.pos)) return;
    const k = `${d.team}|${d.pos}`;
    // Only fill a hole that is genuinely empty ON MERIT. Never top up a position that already has somebody —
    // that would be relaxing the gate by the back door, which is the thing this must not do.
    if ((covered.get(k) || 0) > 0) return;
    const n = addedPerGap.get(k) || 0;
    // Capped so a wholesale projections outage cannot flood the board through this door: a real depth chart
    // is two or three deep at these positions, and beyond that we are guessing.
    if (n >= MAX_BACKSTOP_PER_GAP) return;
    addedPerGap.set(k, n + 1);
    out.push(i);
  });
  return out;
}
