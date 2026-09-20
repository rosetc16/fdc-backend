/* READING SLEEPER'S TRANSACTION FEED WITHOUT LYING ABOUT IT — b161.
 *
 * Trey pasted the raw feed from his own league into the chat and asked what could be built from it:
 * "I would love rjected trades... but that's not hte end of the world. Pending trades is what i really
 * need. If you can't do those, then we can just show a section for recent trades and recent FA / waiver
 * claim pick ups. You can just show transaction history, transaction trends, etc. I would love to see if
 * you can show FAAB for each one as well if possible."
 *
 * ⭐⭐⭐⭐⭐ THE ONE MISTAKE THAT MATTERS IS READING `drops` AS "PLAYERS CUT". On a waiver row that is what
 *   it means. On a TRADE row it means "gave up in the deal" — the same player appears in `adds` under one
 *   roster and `drops` under the other, and a reader that does not know this prints every trade in the
 *   league as both managers releasing their best players. §2 is entirely about that, because it is a
 *   failure that produces plausible-looking output: real names, real teams, completely wrong story.
 *
 * ⚠⚠ AND THE SECOND IS PRETENDING FAAB EXISTS. His own league uses waiver priority, so `waiver_bid` is
 *   absent on every row — and a bid column rendered as "$0" would read as "he got him for nothing" rather
 *   than "this league does not have bidding". §4 pins that a non-FAAB league gets null, not zero.
 */
import assert from 'assert';
import { rosterIndex, normalizeTransaction, transactionTrends } from '../src/lib/transactions.js';

let n = 0;
const ok = (m, x) => { n++; console.log('  PASS  ' + m + (x ? `   [${x}]` : '')); };

const PLAYERS = {
  '4046': { full_name: 'Patrick Mahomes', position: 'QB', team: 'KC' },
  '6794': { first_name: 'Amon-Ra', last_name: 'St. Brown', position: 'WR', team: 'DET' },
  '8146': { full_name: 'Jahmyr Gibbs', position: 'RB', team: 'DET' },
  '1234': { full_name: 'Tyler Bass', position: 'K', team: 'BUF' },
  'DET': { full_name: 'Detroit Lions', position: 'DEF', team: 'DET' },
};
const ROSTERS = [{ roster_id: 1, owner_id: 'u1' }, { roster_id: 2, owner_id: 'u2' }, { roster_id: 3, owner_id: 'u3' }];
const USERS = [
  { user_id: 'u1', display_name: 'trey', metadata: { team_name: 'Allegheny Anchors' } },
  { user_id: 'u2', display_name: 'dana', metadata: {} },
  { user_id: 'u3', display_name: 'sam', metadata: { team_name: 'Steel City' } },
];
const index = rosterIndex({ rosters: ROSTERS, users: USERS, myRosterId: 1 });
const ctx = (over = {}) => ({ index, players: PLAYERS, faab: true, myRosterId: 1, leagueId: 'L1', leagueName: 'Test', ...over });

/* ── 1 ── THE ROSTER INDEX ───────────────────────────────────────────────────────────────────── */
{
  assert.strictEqual(index.get(1).teamName, 'Allegheny Anchors', 'a team name wins over the display name');
  /* ⚠ AND A MANAGER WHO NEVER SET ONE STILL GETS A NAME. Sleeper leaves `team_name` unset by default, so
     the common case is the fallback — "Team 2" everywhere would make the whole feature unreadable in a
     league where nobody has bothered. */
  assert.strictEqual(index.get(2).teamName, 'dana', 'no team name falls back to the display name, not "Team 2"');
  assert.strictEqual(index.get(1).isMe, true);
  assert.strictEqual(index.get(2).isMe, false);
  ok('1 · ⭐⭐⭐ rosters resolve to the names a manager would recognise, mine marked');
}

/* ── 2 ── A TRADE HAS TWO SIDES AND `drops` IS NOT "CUT" ─────────────────────────────────────── */
{
  /* Roster 1 sends Mahomes and gets Gibbs; roster 2 does the mirror. This is exactly the shape Sleeper
     publishes: two flat maps, no nesting by team. */
  const tx = {
    transaction_id: 't1', type: 'trade', status: 'complete', leg: 3, status_updated: 1700000000000,
    roster_ids: [1, 2],
    adds: { 4046: 2, 8146: 1 },
    drops: { 4046: 1, 8146: 2 },
    draft_picks: [{ season: '2027', round: 2, roster_id: 2, previous_owner_id: 2, owner_id: 1 }],
    waiver_budget: [{ sender: 1, receiver: 2, amount: 15 }],
  };
  const r = normalizeTransaction(tx, ctx());
  const me = r.teams.find((t) => t.rosterId === 1), them = r.teams.find((t) => t.rosterId === 2);
  assert.strictEqual(r.type, 'trade');
  assert.strictEqual(r.mine, true, 'a trade I am in is mine');
  /* ⭐⭐⭐⭐⭐ THE HEADLINE. If `drops` were read as "cut", BOTH managers would show Mahomes and Gibbs as
     released and neither would show anything received. */
  assert.deepStrictEqual(me.got.map((p) => p.name), ['Jahmyr Gibbs'], `I received Gibbs, got ${JSON.stringify(me.got)}`);
  assert.deepStrictEqual(me.gave.map((p) => p.name), ['Patrick Mahomes'], 'I gave up Mahomes');
  assert.deepStrictEqual(them.got.map((p) => p.name), ['Patrick Mahomes'], 'they received Mahomes');
  assert.deepStrictEqual(them.gave.map((p) => p.name), ['Jahmyr Gibbs'], 'they gave up Gibbs');
  ok('2 · ⭐⭐⭐⭐⭐ both sides of a trade are reconstructed — `drops` is "gave up", never "cut"',
    `${me.gave[0].name} ⇄ ${me.got[0].name}`);

  /* ⚠ A PICK IS PART OF THE DEAL AND BELONGS TO WHOEVER ENDED UP WITH IT. */
  assert.strictEqual(me.picks.length, 1, 'the pick went to me');
  assert.ok(/2027 2nd rd/.test(me.picks[0].label), me.picks[0].label);
  assert.strictEqual(them.picks.length, 0);
  ok('2b · ⭐⭐⭐⭐ …and a draft pick in the deal lands on the side that received it', me.picks[0].label);

  /* ⚠ FAAB IN A TRADE IS A TRANSFER, AND IT HAS A DIRECTION. A single net number per roster would have
     hidden a deal where budget moved both ways. */
  assert.strictEqual(me.faabOut, 15); assert.strictEqual(me.faabIn, 0);
  assert.strictEqual(them.faabIn, 15); assert.strictEqual(them.faabOut, 0);
  ok('2c · ⭐⭐⭐⭐ …and traded FAAB keeps its direction rather than collapsing to a net', 'out 15 / in 15');

  /* ⭐⭐⭐⭐ A THREE-TEAM TRADE IS THE SAME SHAPE, which is the reason this is built per roster instead of
     as a "you / them" pair. A two-sided model would have to pick which two of the three to show. */
  const three = normalizeTransaction({
    transaction_id: 't2', type: 'trade', status: 'complete', leg: 4, status_updated: 1,
    roster_ids: [1, 2, 3], adds: { 4046: 2, 8146: 3, 6794: 1 }, drops: { 4046: 1, 8146: 2, 6794: 3 },
  }, ctx());
  assert.strictEqual(three.teams.length, 3, 'three rosters, three sides');
  assert.ok(three.teams.every((t) => t.got.length === 1 && t.gave.length === 1));
  ok('2d · ⭐⭐⭐⭐⭐ …and a three-team trade needs no special case at all', '3 sides, each 1 for 1');
}

/* ── 3 ── WAIVERS AND FREE AGENTS ────────────────────────────────────────────────────────────── */
{
  const claim = normalizeTransaction({
    transaction_id: 'w1', type: 'waiver', status: 'complete', leg: 5, status_updated: 2,
    roster_ids: [2], adds: { 6794: 2 }, drops: { 1234: 2 }, settings: { waiver_bid: 34, seq: 1 },
  }, ctx());
  const t = claim.teams[0];
  assert.strictEqual(claim.bid, 34);
  assert.strictEqual(claim.mine, false, 'somebody else\'s claim is not mine');
  assert.deepStrictEqual(t.got.map((p) => p.name), ['Amon-Ra St. Brown'], 'name assembled from first+last');
  assert.deepStrictEqual(t.gave.map((p) => p.name), ['Tyler Bass'], 'on a WAIVER, a drop really is a cut');
  ok('3 · ⭐⭐⭐⭐⭐ a waiver claim carries its bid, the man in and the man out', `$${claim.bid} · ${t.got[0].name} for ${t.gave[0].name}`);

  /* ⚠ A FAILED CLAIM IS A ROW, NOT AN ABSENCE. It is the only way a manager ever learns he was outbid,
     and folding it in with the completed ones would credit him with a move he did not make. */
  const failed = normalizeTransaction({
    transaction_id: 'w2', type: 'waiver', status: 'failed', leg: 5, status_updated: 3,
    roster_ids: [1], adds: { 8146: 1 }, settings: { waiver_bid: 5 }, metadata: { notes: 'Invalid transaction — outbid' },
  }, ctx());
  assert.strictEqual(failed.status, 'failed');
  assert.strictEqual(failed.bid, 5);
  assert.ok(/outbid/i.test(failed.note || ''), 'the reason survives');
  ok('3b · ⭐⭐⭐⭐ a failed claim keeps its status, its bid and the reason it failed', failed.note);

  const fa = normalizeTransaction({
    transaction_id: 'f1', type: 'free_agent', status: 'complete', leg: 6, status_updated: 4,
    roster_ids: [3], adds: { DET: 3 },
  }, ctx());
  assert.strictEqual(fa.type, 'free_agent');
  assert.strictEqual(fa.teams[0].got[0].pos, 'DST', 'DEF is normalised to the DST this app uses everywhere');
  ok('3c · ⭐⭐⭐⭐ a free-agent add needs no bid, and a defence is called DST like everywhere else');
}

/* ── 4 ── A LEAGUE WITHOUT FAAB MUST NOT BE SHOWN A BUDGET ───────────────────────────────────── */
{
  /* ⚠⚠ THIS IS TREY'S OWN LEAGUE. It runs waiver priority, so the bid is meaningless there — and "$0"
     beside a claim reads as "he got him for nothing", which is a statement about the auction rather than
     about the absence of one. */
  const r = normalizeTransaction({
    transaction_id: 'w3', type: 'waiver', status: 'complete', leg: 5, status_updated: 5,
    roster_ids: [1], adds: { 8146: 1 }, settings: { waiver_bid: 0 },
  }, ctx({ faab: false }));
  assert.strictEqual(r.bid, null, 'no FAAB in this league means no bid, not a bid of zero');
  const withFaab = normalizeTransaction({
    transaction_id: 'w4', type: 'waiver', status: 'complete', leg: 5, status_updated: 6,
    roster_ids: [1], adds: { 8146: 1 }, settings: { waiver_bid: 0 },
  }, ctx({ faab: true }));
  assert.strictEqual(withFaab.bid, 0, 'in a FAAB league a zero bid IS the fact — he claimed for nothing');
  ok('4 · ⭐⭐⭐⭐⭐ a waiver-priority league gets null, a FAAB league gets the real zero', 'null vs 0');
}

/* ── 5 ── THE SHAPES WE DO NOT UNDERSTAND ────────────────────────────────────────────────────── */
{
  assert.strictEqual(normalizeTransaction(null, ctx()), null);
  assert.strictEqual(normalizeTransaction({}, ctx()), null, 'no type is not a transaction');
  assert.strictEqual(normalizeTransaction({ type: 'trade' }, ctx()), null, 'no roster on any side is unreadable');
  /* ⚠ AN UNKNOWN PLAYER ID IS NOT A REASON TO DROP THE ROW. Sleeper's player map lags its transaction
     feed by hours for a just-signed practice-squad body, and a row that vanishes is worse than a row
     that says "Player 99999". */
  const unknown = normalizeTransaction({
    transaction_id: 'x', type: 'free_agent', status: 'complete', roster_ids: [1], adds: { 99999: 1 },
  }, ctx());
  assert.ok(unknown && unknown.teams[0].got[0].name === 'Player 99999', 'unknown ids still render');
  assert.strictEqual(unknown.teams[0].got[0].pos, null, 'and claim no position they do not have');
  ok('5 · ⭐⭐⭐⭐ unreadable rows are dropped, but an unknown PLAYER never drops a row');
}

/* ── 6 ── THE TRENDS ─────────────────────────────────────────────────────────────────────────── */
{
  const items = [
    normalizeTransaction({ transaction_id: 'a', type: 'trade', status: 'complete', status_updated: 9, roster_ids: [1, 2], adds: { 4046: 2, 8146: 1 }, drops: { 4046: 1, 8146: 2 } }, ctx()),
    normalizeTransaction({ transaction_id: 'b', type: 'waiver', status: 'complete', status_updated: 8, roster_ids: [2], adds: { 6794: 2 }, settings: { waiver_bid: 20 } }, ctx()),
    normalizeTransaction({ transaction_id: 'c', type: 'waiver', status: 'complete', status_updated: 7, roster_ids: [2], adds: { 1234: 2 }, settings: { waiver_bid: 5 } }, ctx()),
    normalizeTransaction({ transaction_id: 'd', type: 'waiver', status: 'failed', status_updated: 6, roster_ids: [1], adds: { 1234: 1 }, settings: { waiver_bid: 3 } }, ctx()),
    normalizeTransaction({ transaction_id: 'e', type: 'free_agent', status: 'complete', status_updated: 5, roster_ids: [3], adds: { DET: 3 } }, ctx()),
  ];
  const tr = transactionTrends(items, { myRosterId: 1 });
  assert.strictEqual(tr.totals.trades, 1);
  assert.strictEqual(tr.totals.waivers, 2);
  assert.strictEqual(tr.totals.freeAgents, 1);
  assert.strictEqual(tr.totals.failed, 1);
  assert.strictEqual(tr.totals.faabSpent, 25, 'only the claims that landed cost money');
  ok('6 · ⭐⭐⭐⭐ the league totals count each kind once, and only completed claims spend FAAB', JSON.stringify(tr.totals));

  /* ⭐⭐⭐⭐⭐ A FAILED CLAIM IS NOT ACTIVITY. If it were counted as a move, the manager with the worst
     waiver priority — the one whose claims lose — would rank as the busiest in the league. */
  const mine = tr.rows.find((r) => r.rosterId === 1);
  assert.strictEqual(mine.waivers, 0, 'my claim failed, so it is not a waiver I made');
  assert.strictEqual(mine.failedClaims, 1, 'but it is kept, because "my claims keep failing" is a finding');
  assert.strictEqual(mine.trades, 1);
  ok('6b · ⭐⭐⭐⭐⭐ a failed claim is recorded but never counted as a move he made',
    `mine: ${mine.trades} trades, ${mine.waivers} waivers, ${mine.failedClaims} failed`);

  /* The busiest manager leads, and my place in that order is the comparison worth having. */
  assert.strictEqual(tr.rows[0].rosterId, 2, 'roster 2 made three moves');
  assert.ok(tr.myRank >= 1 && tr.myRank <= tr.teams);
  ok('6c · ⭐⭐⭐ …and the league is ordered by activity, with my own place in it', `${tr.rows[0].teamName} leads · I am ${tr.myRank} of ${tr.teams}`);
}

console.log(`\n${n} passed`);
