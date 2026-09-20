/* WHAT ACTUALLY HAPPENED IN THE LEAGUE — b161.
 * ───────────────────────────────────────────────────────────────────────────────────────────────────
 * Trey: "I would also love the ability to see uh, trades that are currently pending, uh, aka someone has
 * sent me a trade or I have sent them a trade... just see an aggregated list of connected leagues... And
 * then you can look at another section that says like recently rejected or recently accepted trades. I
 * want that to be only ones that I show, but I also want to be able to toggle to show the entire league on
 * trades that have been accepted recently."
 * And, after reading the raw feed himself: "I would love rjected trades... but that's not hte end of the
 * world. Pending trades is what i really need. If you can't do those, then we can just show a section for
 * recent trades and recent FA / waiver claim pick ups. You can just show transaction history, transaction
 * trends, etc. I would love to see if you can show FAAB for each one as well if possible."
 *
 * ⚠⚠⚠⚠⚠ THE HEADLINE ASK CANNOT BE BUILT, AND SAYING SO IS PART OF THE FEATURE.
 *   Sleeper's `/league/{id}/transactions/{week}` publishes transactions that have RESOLVED. Across the
 *   32 real transactions in his own league every single one carried `complete` or `failed`; there is no
 *   `pending` row, and a proposal that was declined leaves no row at all — it simply never appears. So:
 *     · PENDING TRADES  — not available. Nothing we can do from a public read-only API.
 *     · REJECTED TRADES — not available, for the same reason, and worse: they are indistinguishable from
 *       trades that were never sent.
 *     · ACCEPTED TRADES — fully available, both sides reconstructable.
 *     · WAIVERS AND FREE AGENTS — available, including the FAAB bid and whether the claim failed.
 *   `pendingSupported` is on the payload so the screen can say this in plain language instead of showing
 *   an empty "Pending" section that reads as "nobody has offered you anything". An empty section is a
 *   claim about the league; a missing capability is a claim about us, and only one of those is true.
 *
 * ⭐⭐⭐⭐⭐ THE TWO SIDES OF A TRADE ARE `adds` AND `drops`, AND THEY ARE NOT WHAT THE NAMES SUGGEST.
 *   Both are flat maps of playerId → rosterId with no nesting by team, so the shape carries a two-team
 *   trade and a three-team trade identically. `adds[p] = R` means R RECEIVED p; `drops[p] = R` means R
 *   GAVE UP p. A trade is therefore reconstructed per roster, never per "side" — and the same player id
 *   appears in both maps, under two different rosters. Reading `drops` as "players cut" (which is what it
 *   means on a waiver row) would print every trade as both managers releasing their best players.
 *
 * ⚠ FAAB MOVES TWO DIFFERENT WAYS and they are different fields. `settings.waiver_bid` is what a claim
 *   cost; `waiver_budget` is a list of budget transfers inside a TRADE. A league that uses waiver
 *   priority rather than FAAB has neither, and must not be shown a column of zeroes — see `faab`.
 */

const POS_OK = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DST']);

function playerOf(sid, players) {
  const p = (players && players[String(sid)]) || null;
  if (!p) return { sid: String(sid), name: `Player ${sid}`, pos: null, team: null };
  const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ') || String(sid);
  const pos = String(p.position || (Array.isArray(p.fantasy_positions) ? p.fantasy_positions[0] : '') || '').toUpperCase();
  return { sid: String(sid), name, pos: POS_OK.has(pos) ? (pos === 'DEF' ? 'DST' : pos) : (pos || null), team: p.team || null };
}

/* A roster id → { teamName, ownerName, isMe }. Built once per league by the caller, because the same
   lookup is wanted on every one of a season's transactions. */
export function rosterIndex({ rosters, users, myRosterId }) {
  const byUser = new Map((users || []).map((u) => [String(u.user_id), u]));
  const out = new Map();
  (rosters || []).forEach((r) => {
    const u = byUser.get(String(r.owner_id)) || null;
    out.set(Number(r.roster_id), {
      rosterId: Number(r.roster_id),
      ownerName: (u && u.display_name) || null,
      teamName: (u && u.metadata && u.metadata.team_name) || (u && u.display_name) || `Team ${r.roster_id}`,
      isMe: myRosterId != null && Number(r.roster_id) === Number(myRosterId),
    });
  });
  return out;
}

/* One Sleeper transaction → one row the screen can render without knowing anything about Sleeper.
   Returns null for a shape we do not understand, which is deliberate: a row we cannot read correctly is
   worse than a row we do not show, because the reader has no way to tell a mangled trade from a real one. */
export function normalizeTransaction(tx, ctx) {
  if (!tx || typeof tx !== 'object') return null;
  const { index, players, faab, myRosterId, leagueId, leagueName } = ctx || {};
  const type = String(tx.type || '').toLowerCase();
  if (!type) return null;
  const adds = tx.adds && typeof tx.adds === 'object' ? tx.adds : {};
  const drops = tx.drops && typeof tx.drops === 'object' ? tx.drops : {};
  const involved = new Set();
  (tx.roster_ids || []).forEach((r) => involved.add(Number(r)));
  Object.values(adds).forEach((r) => involved.add(Number(r)));
  Object.values(drops).forEach((r) => involved.add(Number(r)));
  if (!involved.size) return null;

  /* ⚠ FAAB TRANSFERS ARE PER-PAIR, NOT PER-ROSTER. One trade can move budget in both directions, so a
     single signed number per roster would be a net that hides half the deal. Summed per side, with the
     sender's outgoing and the receiver's incoming kept apart. */
  const faabIn = {}, faabOut = {};
  (Array.isArray(tx.waiver_budget) ? tx.waiver_budget : []).forEach((w) => {
    if (!w) return;
    const amt = Number(w.amount) || 0;
    if (!amt) return;
    faabOut[Number(w.sender)] = (faabOut[Number(w.sender)] || 0) + amt;
    faabIn[Number(w.receiver)] = (faabIn[Number(w.receiver)] || 0) + amt;
    involved.add(Number(w.sender)); involved.add(Number(w.receiver));
  });

  const picksFor = (rid) => (Array.isArray(tx.draft_picks) ? tx.draft_picks : [])
    .filter((d) => d && Number(d.owner_id) === Number(rid))
    .map((d) => ({ season: String(d.season || ''), round: Number(d.round) || null,
      from: Number(d.previous_owner_id) || null,
      label: `${d.season} ${ordinalRound(d.round)}${
        Number(d.previous_owner_id) && Number(d.previous_owner_id) !== Number(d.roster_id)
          ? ` (via ${(index && index.get(Number(d.roster_id)) || {}).teamName || `Team ${d.roster_id}`})` : ''}` }));

  const teams = Array.from(involved).sort((a, b) => a - b).map((rid) => {
    const who = (index && index.get(rid)) || { rosterId: rid, teamName: `Team ${rid}`, ownerName: null, isMe: false };
    return {
      ...who,
      /* got = what this roster RECEIVED; gave = what it GAVE UP. See the note at the top: on a trade
         these are two views of one `adds`/`drops` pair, and on a waiver they are the claim and the cut. */
      got: Object.keys(adds).filter((sid) => Number(adds[sid]) === rid).map((sid) => playerOf(sid, players)),
      gave: Object.keys(drops).filter((sid) => Number(drops[sid]) === rid).map((sid) => playerOf(sid, players)),
      picks: picksFor(rid),
      faabIn: faabIn[rid] || 0,
      faabOut: faabOut[rid] || 0,
    };
  });

  const status = String(tx.status || '').toLowerCase() || 'complete';
  const bid = tx.settings && Number(tx.settings.waiver_bid) >= 0 ? Number(tx.settings.waiver_bid) : null;
  const mine = myRosterId != null && teams.some((t) => Number(t.rosterId) === Number(myRosterId));

  return {
    id: String(tx.transaction_id || `${leagueId}-${tx.status_updated || tx.created || Math.random()}`),
    leagueId: leagueId || null,
    leagueName: leagueName || null,
    type: type === 'free_agent' ? 'free_agent' : type === 'waiver' ? 'waiver' : type === 'trade' ? 'trade' : type,
    status,
    /* `leg` is the week the transaction belongs to; `status_updated` is when it resolved. Both are kept
       because they answer different questions — which week's roster it changed, and how long ago. */
    week: Number(tx.leg) || null,
    at: Number(tx.status_updated || tx.created) || null,
    mine,
    teams,
    /* Only meaningful in a FAAB league, and null rather than 0 elsewhere so the screen can leave the
       column out entirely rather than print a budget that does not exist. */
    bid: faab ? bid : null,
    note: (tx.metadata && tx.metadata.notes) || null,
  };
}

function ordinalRound(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'pick';
  const s = ['th', 'st', 'nd', 'rd'], m = v % 100;
  return `${v}${s[(m - 20) % 10] || s[m] || s[0]} rd`;
}

/* ⭐⭐⭐⭐ THE TRENDS ARE THE PART THAT NEEDS A WHOLE SEASON, which is why they are computed here rather
   than in the screen: the screen shows a window of recent rows, and a trend built from the window would
   say "nobody trades in this league" about a quiet fortnight.
   ⚠ COUNTED ON COMPLETED ROWS ONLY. A failed waiver claim is a thing that happened to a manager, not a
     move he made, and folding the two together would rank the manager with the worst waiver priority as
     the most active in the league. `failedClaims` keeps them, separately, because "half my claims fail"
     is a real finding about a league. */
export function transactionTrends(items, { myRosterId } = {}) {
  const done = (items || []).filter((x) => x && x.status === 'complete');
  const byRoster = new Map();
  const bump = (rid, k, v = 1) => {
    if (!byRoster.has(rid)) byRoster.set(rid, { rosterId: rid, teamName: null, trades: 0, waivers: 0, freeAgents: 0, faabSpent: 0, failedClaims: 0 });
    byRoster.get(rid)[k] += v;
  };
  done.forEach((x) => {
    x.teams.forEach((t) => {
      bump(t.rosterId, x.type === 'trade' ? 'trades' : x.type === 'waiver' ? 'waivers' : 'freeAgents');
      byRoster.get(t.rosterId).teamName = t.teamName;
      if (x.type === 'waiver' && x.bid && t.got.length) bump(t.rosterId, 'faabSpent', x.bid);
    });
  });
  (items || []).filter((x) => x && x.status === 'failed').forEach((x) => {
    x.teams.forEach((t) => { bump(t.rosterId, 'failedClaims'); byRoster.get(t.rosterId).teamName = t.teamName; });
  });
  const rows = Array.from(byRoster.values())
    .sort((a, b) => (b.trades + b.waivers + b.freeAgents) - (a.trades + a.waivers + a.freeAgents));
  const mine = myRosterId != null ? rows.find((r) => Number(r.rosterId) === Number(myRosterId)) || null : null;
  return {
    rows,
    mine,
    totals: {
      trades: done.filter((x) => x.type === 'trade').length,
      waivers: done.filter((x) => x.type === 'waiver').length,
      freeAgents: done.filter((x) => x.type === 'free_agent').length,
      failed: (items || []).filter((x) => x && x.status === 'failed').length,
      faabSpent: done.filter((x) => x.type === 'waiver' && x.bid).reduce((s, x) => s + x.bid, 0),
    },
    /* Where MY activity sits against the league — the one comparison a manager actually wants out of a
       transaction log, and it is null rather than a rank of 1 when there is nobody to compare against. */
    myRank: mine && rows.length > 1 ? rows.indexOf(mine) + 1 : null,
    teams: rows.length,
  };
}
