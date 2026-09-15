/* ⭐⭐⭐⭐⭐ WHO SHOULD I BE ROOTING FOR — b134.
 * ==================================================================================================
 * Trey: "I also want to be able to track all leagues live during games to see scores, trends, etc.
 * basically have this be my hub for what should I be rooting for (especially if you have a lot of leagues
 * and you have stakes in a ton of players, so it would basically show you who you have the most shares in
 * and who you have the most shares to root against."
 *
 * In one league a Sunday is simple: you want your guys to score. In fifteen it is not simple at all, and
 * the reason is that the SAME player is on your side in some leagues and against you in others. Josh Jacobs
 * in six of your lineups and in two opponents' lineups is a net +4 — cheer. Josh Jacobs in one of yours and
 * five opponents' is a net −4 — the opposite, and nobody can hold that in their head across fifteen
 * matchups while a game is on. That arithmetic is this file.
 *
 * ⚠ NET IS THE HEADLINE, NOT THE RAW COUNT. "You have 6 shares of Jacobs" is the number every other site
 *   shows and it is the wrong one: it ignores that you are ALSO facing him twice, which is what actually
 *   decides whether his touchdown is good news. `net = for - against`, and the board sorts by |net| so the
 *   players whose day genuinely swings your Sunday come first — in either direction.
 *
 * ⚠ AND A PLAYER'S POINTS ARE NOT ONE NUMBER. Every league scores him under its own rules: the same
 *   catch is worth 1.0 in PPR and 0 in standard, the same passing TD 4 or 6. Sleeper hands us points that
 *   are ALREADY league-scored, which is right, but it means a player in six leagues has up to six
 *   different totals. Collapsing that to one average and printing it as "his points" would be a quiet lie,
 *   so `pts` carries the spread and `varies` says whether it is worth showing.
 */

/* ⭐⭐⭐ HAS HE PLAYED YET — the column that decides how to feel about a scoreline.
   Trailing by 20 with four players still to kick off is a different afternoon from trailing by 20 with
   none, and no scoreboard on its own tells you which one you are in.
   ⚠ THIS IS A WINDOW, NOT A GAME CLOCK. We know kickoff times from the NFL schedule and nothing else —
   there is no live game state in any feed this app already talks to. So `pre` is CERTAIN (the game has
   not kicked off), while `live` and `done` are a three-and-a-half-hour window around kickoff and are
   honest approximations. The UI leans on `pre`, which is the one that carries the meaning. */
const GAME_MS = 3.5 * 60 * 60 * 1000;
export function gameState(kickoffIso, now = Date.now()) {
  if (!kickoffIso) return 'unknown';
  const t = Date.parse(kickoffIso);
  if (!Number.isFinite(t)) return 'unknown';
  if (now < t) return 'pre';
  return now - t < GAME_MS ? 'live' : 'done';
}

/* ⭐⭐⭐⭐ WHERE THE NFL WEEK IS UP TO — b135.
   Trey: "when a week is live… the live badge shows up on the home page to see live results… then once
   games have finished (I'm thinking any game that's finished). There should be a review tab next to live."
   Two different questions, and the home page has to answer both without a second round-trip: is anything
   on RIGHT NOW (show the badge, poll fast), and has anything finished (offer the review). They are not
   opposites — Sunday at 4pm is both at once, which is exactly the moment the page is most useful.
   ⚠ `allDone` is the strict one, and it is what gates reviewing a week rather than merely showing the tab:
   a review of a week with a Monday-night game still to come would tell you to bench the player who has
   not kicked off. One game short is not done. */
export function weekStateFrom(kickoffs, now = Date.now()) {
  const times = [...new Set((kickoffs || []).filter(Boolean))];
  if (!times.length) return { known: false, anyLive: false, anyDone: false, allDone: false, games: 0, done: 0, live: 0 };
  const states = times.map((t) => gameState(t, now));
  const done = states.filter((s) => s === 'done').length;
  const live = states.filter((s) => s === 'live').length;
  return {
    known: true,
    anyLive: live > 0,
    anyDone: done > 0,
    allDone: done === states.length,
    /* ⚠ These count distinct KICKOFF SLOTS, not games — the three 1pm games are one entry. That is the
       right unit for "is anything on" and "is everything over", and the wrong one for "how many games are
       left", so nothing renders them as a game count. */
    games: states.length, done, live,
    // The next kickoff still ahead of us, so a quiet page can say when it stops being quiet.
    nextKickoff: times.filter((t) => Date.parse(t) > now).sort()[0] || null,
  };
}

/* One roster's side of one matchup, reduced to what a scoreboard row needs. `starters` may contain nulls
   (an empty slot) and ids the pack has never heard of; both survive as rows rather than vanishing. */
export function sideOf(entry, { ptsOf, stateOf }) {
  if (!entry) return null;
  const starters = (entry.starters || []).filter(Boolean).map(String);
  const players = starters.map((sid) => ({ sid, pts: ptsOf(sid, entry), state: stateOf(sid) }));
  const count = (s) => players.filter((p) => p.state === s).length;
  return {
    rosterId: entry.rosterId,
    teamName: entry.teamName || null,
    pts: r2(Number.isFinite(entry.points) ? entry.points : players.reduce((s, p) => s + (p.pts || 0), 0)),
    players,
    /* ⚠ "YET TO PLAY" MEANS UNDECIDED, AND IT HAS TO MEAN THAT EVERYWHERE — 29u.
       This counted ONLY `pre` while the live route's own decorate step counts everything that is not
       `done`, so one field name carried two different definitions depending on which function built the
       row. Nothing was visibly wrong today, because every caller happens to decorate afterwards and the
       decorated value wins — which is exactly what makes it dangerous: the next caller to use `sideOf`
       directly inherits the pre-b140 semantics with nothing to warn it, and the symptom would be a
       "left" column that goes quiet during the only games anyone is watching.
       `notStarted` is the pre-only count for anywhere that genuinely wants "has not kicked off". */
    yetToPlay: players.length - count('done'),
    notStarted: count('pre'),
    playing: count('live'),
    played: count('done'),
  };
}

/* ⭐⭐⭐⭐⭐ THE BOARD. Every player you have a stake in this week, with which side of it you are on.
   `rows` is one entry per league: { leagueId, leagueName, me:{starters,points...}, opp:{...} }.
   A player appears once, carrying the leagues that put him on each side of you. */
/* ⭐⭐⭐⭐ `remainOf` IS OPTIONAL AND THE BOARD CARRIES WHAT IT RETURNS — 29t.
   Game Day colours each points cell by how unusual the day is for the position, and while a game is on
   that judgement needs to know how much of the game has been played: 7.4 points is a poor week for a
   quarterback and a fine first half. The client used to derive that from the payload's `at` stamp minus
   the kickoff map — arithmetic on two fields that are only guaranteed to share a clock in production, and
   which the stub stamps from the real one, so the screen was tinting live players toward failure and no
   fixture could show it. The share belongs on the row, from the SAME function the forecast uses, so the
   colour and the projection can never tell different stories about the same player. */
export function rootingBoard(rows, { nameOf, posOf, teamOf, stateOf, oppOf, remainOf }) {
  const byPlayer = new Map();
  const touch = (sid) => {
    const k = String(sid);
    if (!byPlayer.has(k)) {
      const st = stateOf(k);
      // Played share: none before kickoff, all after the whistle, and 1 − remaining while it is on.
      let elapsed = st === 'done' ? 1 : st === 'live' ? 0.5 : null;
      if (st === 'live' && typeof remainOf === 'function') {
        const r = Number(remainOf(k));
        if (Number.isFinite(r)) elapsed = Math.max(0, Math.min(1, 1 - r));
      }
      byPlayer.set(k, { sid: k, name: nameOf(k), pos: posOf(k), team: teamOf(k), opp: oppOf ? oppOf(k) : null,
        state: st, elapsed, forLeagues: [], againstLeagues: [], ptsByLeague: {} });
    }
    return byPlayer.get(k);
  };

  for (const row of rows || []) {
    if (!row || !row.me) continue;
    const tag = { leagueId: row.leagueId, leagueName: row.leagueName };
    /* ⚠ ONE LEAGUE IS ONE SHARE, however many times the id appears in the lineup. A player listed twice on
       one side is malformed data (a slot mapping gone wrong upstream, a co-owned roster echoed) — but the
       damage it does here is specific and bad: it inflates the stake, and the stake is the whole number
       this board exists to report. Counting leagues rather than roster entries makes that impossible. */
    const takeSide = (players, key) => {
      const seen = new Set();
      for (const p of players || []) {
        const sid = String(p.sid);
        if (p.pts != null) touch(sid).ptsByLeague[row.leagueId] = r2(p.pts);
        if (seen.has(sid)) continue;
        seen.add(sid);
        touch(sid)[key].push(tag);
      }
    };
    takeSide(row.me.players, 'forLeagues');
    takeSide(row.opp && row.opp.players, 'againstLeagues');
  }

  const out = [...byPlayer.values()].map((e) => {
    const vals = Object.values(e.ptsByLeague).filter(Number.isFinite);
    const lo = vals.length ? Math.min(...vals) : null;
    const hi = vals.length ? Math.max(...vals) : null;
    return {
      ...e,
      for: e.forLeagues.length,
      against: e.againstLeagues.length,
      net: e.forLeagues.length - e.againstLeagues.length,
      /* ⚠ THE SPREAD, NOT AN AVERAGE. Different leagues score him differently and pretending otherwise
         would put a number on screen that is true in none of them. `varies` is the flag the UI uses to
         decide between "18.4" and "18.4–21.0"; half a point is inside the rounding nobody cares about. */
      pts: vals.length ? { lo: r2(lo), hi: r2(hi), median: medianOf(vals), varies: hi - lo > 0.5 } : null,
    };
  });

  /* ⭐⭐⭐⭐ SORTED BY HOW MUCH HIS DAY MOVES YOURS, in either direction — a player you are against in five
     leagues matters exactly as much as one you are for in five, and burying him under everyone you own
     would defeat the point. Ties break on total involvement, then on points already scored, so the guy
     currently doing something outranks the guy who has not kicked off. */
  out.sort((a, b) => Math.abs(b.net) - Math.abs(a.net)
    || (b.for + b.against) - (a.for + a.against)
    || ((b.pts && b.pts.median) || 0) - ((a.pts && a.pts.median) || 0)
    || String(a.name || '').localeCompare(String(b.name || '')));
  return out;
}

/* The one-line state of your Sunday: how many matchups you are winning, and — the part a plain
   record cannot tell you — how many are close enough to still care about. */
export function dayTotals(rows) {
  const live = (rows || []).filter((r) => r && r.me && r.opp);
  const margin = (r) => r2(r.me.pts - r.opp.pts);
  const close = live.filter((r) => Math.abs(margin(r)) <= 15);
  return {
    leagues: live.length,
    winning: live.filter((r) => margin(r) > 0).length,
    losing: live.filter((r) => margin(r) < 0).length,
    tied: live.filter((r) => margin(r) === 0).length,
    close: close.length,
    // Yet to play across every lineup — the single best predictor of whether the afternoon can still move.
    yetToPlay: live.reduce((s, r) => s + (r.me.yetToPlay || 0), 0),
    oppYetToPlay: live.reduce((s, r) => s + (r.opp.yetToPlay || 0), 0),
    pointsFor: r2(live.reduce((s, r) => s + (r.me.pts || 0), 0)),
    pointsAgainst: r2(live.reduce((s, r) => s + (r.opp.pts || 0), 0)),
  };
}

function medianOf(values) {
  const v = values.slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return r2(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2);
}
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);
