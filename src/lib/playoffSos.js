// PLAYOFF-WEIGHTED STRENGTH OF SCHEDULE.
//
// THE IDEA, and why it is worth building: fantasy seasons are decided in weeks 15-17, but essentially every
// strength-of-schedule number in the industry averages all eighteen weeks. That buries the only three that
// decide a title under fifteen that do not. A back who draws three of the softest run defences in the league
// during the fantasy playoffs is genuinely more valuable than his season-long schedule implies, and almost
// nobody prices it.
//
// It also sits on the right side of the moat. Anything that leans on knowing the whole league's rosters is
// defensible; a stat anyone can copy is not. This is closer to the first: it combines a schedule, a
// positional difficulty model, and — crucially — THE LEAGUE'S OWN PLAYOFF WEEKS, which we know from the
// connected league's settings and a generic ranking site cannot.
//
import { normTeam } from './nflSchedule.js';

// ⚠ WHAT THIS IS NOT. It is not a projection and it must never be folded silently into VBD. Schedule is a
// weak signal next to talent and role: defences change between seasons, and the ranking it leans on is LAST
// season's. Shown as its own number a drafter can weigh, it is genuinely useful; multiplied into the value
// engine, it would quietly move every recommendation on the strength of the shakiest input we have.

// Which weeks are the fantasy playoffs. A connected league tells us where its playoffs start; anything else
// gets the 15-17 default. `weeks` is capped at 18 — a league whose playoffs start in week 18 has one week.
export function playoffWeeks(playoffStartWeek = 15, rounds = 3, lastWeek = 18) {
  const start = Math.max(1, Math.min(Number(playoffStartWeek) || 15, lastWeek));
  const out = [];
  for (let w = start; w < start + rounds && w <= lastWeek; w++) out.push(w);
  return out;
}

// Build { [team]: { [pos]: { score, rank, of, opps:[{week,opp,rank,of,tier,bye}] } } }.
//
//   schedule   [{ week, team, opponent }]        — from the schedule table
//   defTable   { [def]: { [pos]: {rank, of, tier} } } — from defVsPos, LAST completed season
//   weeks      [15,16,17]                        — this league's actual playoff weeks
//
// `score` is 1-10, where 10 is the EASIEST slate. Ranks are 1 = toughest defence, so a high opponent rank
// means a soft matchup; we average the opponents' ranks and rescale. A bye inside the playoff weeks is not a
// soft matchup — it is a zero, and treating it as "no data" would flatter exactly the players a drafter most
// needs warning about.
export function computePlayoffSos(schedule, defTable, weeks, positions = ['QB', 'RB', 'WR', 'TE']) {
  // ⭐⭐ NORMALISE BOTH SIDES BEFORE JOINING THEM.
  //
  // The schedule's team codes come from one feed and the defence table's from another, and the NFL has half a
  // dozen abbreviations that differ between sources (JAC/JAX, WSH/WAS, LA/LAR, OAK/LV). A join on raw strings
  // does not fail loudly — it just matches nothing, every team ends with no rated opponents, the table comes
  // back empty, and the whole feature renders as a column of dashes with both jobs reporting success. That is
  // precisely the failure mode this codebase keeps rediscovering, so the join is defended rather than trusted.
  const norm = (t) => normTeam(t) || (t == null ? null : String(t).trim().toUpperCase());
  const def = {};
  for (const k of Object.keys(defTable || {})) {
    const nk = norm(k);
    if (nk) def[nk] = defTable[k];
  }
  defTable = def;
  const byTeamWeek = new Map();
  for (const r of schedule || []) {
    const t = norm(r.team), o = norm(r.opponent);
    if (t && o) byTeamWeek.set(`${t}:${r.week}`, o);
  }
  const teams = [...new Set((schedule || []).map((r) => norm(r.team)).filter(Boolean))].sort();
  if (!teams.length || !weeks || !weeks.length) return {};

  const raw = {};   // team -> pos -> { sum, n, opps, byes }
  for (const team of teams) {
    raw[team] = {};
    for (const pos of positions) {
      const opps = [];
      let sum = 0, n = 0, byes = 0;
      for (const w of weeks) {
        const opp = byTeamWeek.get(`${team}:${w}`) || null;
        if (!opp) {
          // ⭐ A BYE IN THE FANTASY PLAYOFFS IS THE HEADLINE, not a gap. Silently skipping it would make a
          // player who cannot play in week 16 look identical to one who can.
          byes++;
          opps.push({ week: w, opp: null, rank: null, of: null, tier: 'bye', bye: true });
          continue;
        }
        const d = defTable && defTable[opp] && defTable[opp][pos];
        if (!d || d.rank == null) { opps.push({ week: w, opp, rank: null, of: null, tier: null, bye: false }); continue; }
        sum += d.rank; n++;
        opps.push({ week: w, opp, rank: d.rank, of: d.of, tier: d.tier, bye: false });
      }
      raw[team][pos] = { sum, n, opps, byes };
    }
  }

  // Rank teams against each other, PER POSITION — a schedule is only hard or easy relative to the other 31.
  const out = {};
  for (const pos of positions) {
    const scored = teams
      .map((t) => {
        const r = raw[t][pos];
        if (!r.n) return { t, avg: null };
        // A playoff bye is a real cost, so it drags the average toward "hard" rather than being ignored.
        // Weighted as a bottom-third matchup (rank 1 of the scale) because the player scores nothing at all.
        const of = (r.opps.find((o) => o.of) || {}).of || 32;
        const avg = (r.sum + r.byes * 1) / (r.n + r.byes);
        return { t, avg, of };
      })
      .filter((x) => x.avg != null);
    if (!scored.length) continue;
    // Descending avg = EASIEST first (higher opponent rank = weaker defence).
    scored.sort((a, b) => b.avg - a.avg);
    const N = scored.length;
    scored.forEach((s, i) => {
      const rank = i + 1;                                    // 1 = easiest playoff slate
      const score = Math.round((10 - (9 * i) / Math.max(1, N - 1)) * 10) / 10;   // 10 easiest → 1 hardest
      const r = raw[s.t][pos];
      if (!out[s.t]) out[s.t] = {};
      out[s.t][pos] = {
        score, rank, of: N,
        tier: rank <= Math.ceil(N / 3) ? 'easy' : rank <= Math.ceil((2 * N) / 3) ? 'neutral' : 'hard',
        byes: r.byes,
        opps: r.opps,
      };
    });
  }
  return out;
}

// One short sentence a drafter can act on. Kept here rather than in the UI so the panel, the hover and any
// future export cannot drift apart — the same reason buildDigest is one function.
export function sosBlurb(entry, pos, weeks) {
  if (!entry) return null;
  const wk = !weeks || !weeks.length ? 'the fantasy playoffs'
    : weeks.length === 1 ? `week ${weeks[0]}`
    : `weeks ${weeks[0]}–${weeks[weeks.length - 1]}`;
  const named = entry.opps.filter((o) => o.opp).map((o) => o.opp).join(', ');
  const bye = entry.byes ? ` He is on BYE in week ${(entry.opps.find((o) => o.bye) || {}).week}, which costs a playoff week outright.` : '';
  // ⚠ Only make a league-wide claim when we actually ranked a league. With a handful of teams on file,
  // "one of the softest slates in the league" is an overclaim dressed as a finding — the same species of
  // error as printing a body part we were never told.
  const leagueWide = entry.of >= 24;
  const read = !leagueWide ? `${entry.rank} of ${entry.of} teams on file`
    : entry.tier === 'easy' ? `one of the softest ${pos} slates in the league`
    : entry.tier === 'hard' ? `one of the toughest ${pos} slates in the league`
    : `a middling ${pos} slate`;
  return `${wk}: ${named || 'no opponents on file'} — ${read}${leagueWide ? ` (${entry.rank} of ${entry.of} easiest)` : ''}.${bye}`;
}
