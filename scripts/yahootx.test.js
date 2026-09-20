/* YAHOO TRANSACTIONS — b163.
 *
 * Trey's activity feed named the Yahoo leagues it could not cover and skipped them; his own account is
 * mixed, so the feed was a league short every time he opened it.
 *
 * ⚠⚠⚠⚠⚠ THE APP CANNOT REACH YAHOO FROM ANYWHERE IT IS TESTED, so — exactly as scripts/yahoo.test.js
 *   records for the roster and scoreboard parsers — these fixtures are RECORDED SHAPES and they are the
 *   only instrument this feature has. Two pieces of Yahoo's ugliness are load-bearing and are here on
 *   purpose, because a tidied fixture would test a parser against a payload it will never receive:
 *     · `transaction_data` appears BOTH as a bare object and as an array of one, in the same response;
 *     · a player's fields sit two levels down inside nested arrays.
 *
 * ⭐⭐⭐⭐⭐ AND THE THING THIS UNLOCKS: Yahoo publishes PENDING and REJECTED trades. Sleeper does not, which
 *   is why both screens carry a sentence saying pending offers cannot be read — it was the first thing
 *   Trey asked for and the one thing I had to tell him was impossible. On Yahoo it is possible, so §4
 *   pins it: a proposed trade survives the parser as `pending` rather than being dropped or, worse,
 *   rendered as something that happened.
 */
import assert from 'assert';
import { parseTransactions } from '../src/lib/yahoo.js';

let n = 0;
const ok = (m, x) => { n++; console.log('  PASS  ' + m + (x ? `   [${x}]` : '')); };

const TK = 'nfl.l.99';
const team = (i) => `${TK}.t.${i}`;
const OPTS = {
  slotOfTeamKey: { [team(1)]: 1, [team(2)]: 2, [team(3)]: 3 },
  slotNames: { 1: 'Yinzer Bombers', 2: 'Steel City Sharks', 3: 'Allegheny Anchors' },
  yourTeamKey: team(1),
  weekOf: () => 3,
};

/* A player node exactly as Yahoo nests it: an array of single-key objects, two levels down. */
const player = (id, full, pos, tm, tdata) => ({
  player: [
    [{ player_key: `nfl.p.${id}` }, { player_id: String(id) }, { name: { full } },
      { editorial_team_abbr: tm }, { display_position: pos }],
    /* ⚠ THE CALLER DECIDES ARRAY-OR-OBJECT, because Yahoo does — see the header. */
    tdata,
  ],
});

const FIX = {
  fantasy_content: {
    league: [
      { league_key: TK },
      { transactions: {
        /* 0 — a WAIVER add with a FAAB bid, and a cut in the same click. `transaction_data` as an
           ARRAY OF ONE on the add and a BARE OBJECT on the drop: both forms, one transaction. */
        0: { transaction: [
          { transaction_key: `${TK}.tr.11`, transaction_id: '11', type: 'add/drop',
            status: 'successful', timestamp: '1792368000', faab_bid: '17' },
          { players: {
            0: player(2001, 'Courtland Sutton', 'WR', 'den',
              { transaction_data: [{ type: 'add', source_type: 'waivers', destination_type: 'team', destination_team_key: team(1) }] }),
            1: player(2002, 'Adonai Mitchell', 'WR', 'ind',
              { transaction_data: { type: 'drop', source_type: 'team', source_team_key: team(1), destination_type: 'waivers' } }),
            count: 2,
          } },
        ] },
        /* 1 — a FREE-AGENT add. Same shape, `source_type: freeagents`, no bid. */
        1: { transaction: [
          { transaction_key: `${TK}.tr.12`, transaction_id: '12', type: 'add',
            status: 'successful', timestamp: '1792281600' },
          { players: {
            0: player(2003, 'Quinshon Judkins', 'RB', 'cle',
              { transaction_data: { type: 'add', source_type: 'freeagents', destination_type: 'team', destination_team_key: team(2) } }),
            count: 1,
          } },
        ] },
        /* 2 — A THREE-TEAM TRADE, which is the shape a give/get pair cannot render. Slot 1 both
           receives and sends, so it is also the row that proves a side is built per TEAM. */
        2: { transaction: [
          { transaction_key: `${TK}.tr.13`, transaction_id: '13', type: 'trade',
            status: 'successful', timestamp: '1792195200' },
          { players: {
            0: player(2004, 'Justin Jefferson', 'WR', 'min',
              { transaction_data: { type: 'trade', source_team_key: team(2), destination_team_key: team(1) } }),
            1: player(2005, 'Ashton Jeanty', 'RB', 'lv',
              { transaction_data: [{ type: 'trade', source_team_key: team(1), destination_team_key: team(3) }] }),
            2: player(2006, 'Dalton Kincaid', 'TE', 'buf',
              { transaction_data: { type: 'trade', source_team_key: team(3), destination_team_key: team(2) } }),
            count: 3,
          } },
        ] },
        /* 3 — A TRADE STILL WAITING ON A DECISION. The thing Sleeper cannot express. */
        3: { transaction: [
          { transaction_key: `${TK}.tr.14`, transaction_id: '14', type: 'trade',
            status: 'pending', timestamp: '1792108800' },
          { players: {
            0: player(2007, 'Bijan Robinson', 'RB', 'atl',
              { transaction_data: { type: 'trade', source_team_key: team(3), destination_team_key: team(1) } }),
            1: player(2008, 'Bucky Irving', 'RB', 'tb',
              { transaction_data: { type: 'trade', source_team_key: team(1), destination_team_key: team(3) } }),
            count: 2,
          } },
        ] },
        /* 4 — A TRADE THAT WAS TURNED DOWN. */
        4: { transaction: [
          { transaction_key: `${TK}.tr.15`, transaction_id: '15', type: 'trade',
            status: 'rejected', timestamp: '1792022400' },
          { players: {
            0: player(2009, 'Jared Goff', 'QB', 'det',
              { transaction_data: { type: 'trade', source_team_key: team(2), destination_team_key: team(3) } }),
            count: 1,
          } },
        ] },
        count: 5,
      } },
    ],
  },
};

const rows = parseTransactions(FIX, OPTS);
const byId = (suffix) => rows.find((r) => r.id.endsWith(suffix));

console.log('\n== §1 every transaction survives the parse ==');
{
  /* ⚠ THE COUNT IS THE FIRST THING THAT GOES WRONG. A parser that mishandles one of Yahoo's two
     `transaction_data` shapes drops rows, and a short list looks like a quiet league. */
  assert.strictEqual(rows.length, 5, `expected 5 transactions, got ${rows.length}`);
  ok('⭐⭐⭐⭐⭐ all five transactions parse', `${rows.length}`);
  assert.ok(rows.every((r) => r.at && Number.isFinite(r.at)), 'every row needs a timestamp');
  ok('⭐⭐⭐⭐ …each with a real timestamp, so the feed can date it');
  const ats = rows.map((r) => r.at);
  assert.deepStrictEqual(ats, ats.slice().sort((a, b) => b - a), 'rows must be newest first');
  ok('⭐⭐⭐ …and they come back newest first');
}

console.log('\n== §2 the waiver claim, and both shapes of transaction_data ==');
{
  const w = byId('.tr.11');
  assert.ok(w, 'the waiver row is missing');
  assert.strictEqual(w.type, 'waiver', `a claim off waivers is a waiver, got ${w.type}`);
  ok('⭐⭐⭐⭐ a claim off waivers reads as a waiver, not a free agent', w.type);
  assert.strictEqual(w.bid, 17, `FAAB bid should be 17, got ${w.bid}`);
  ok('⭐⭐⭐⭐ …carrying its FAAB bid', `$${w.bid}`);
  const me = w.teams.find((t) => t.rosterId === 1);
  /* ⭐⭐⭐⭐⭐ THE ADD CAME THROUGH AN ARRAY-WRAPPED `transaction_data` AND THE DROP THROUGH A BARE OBJECT.
     Handling only one of them loses half of every add/drop, silently. */
  assert.strictEqual(me.got.length, 1, `expected 1 add, got ${me.got.length}`);
  assert.strictEqual(me.gave.length, 1, `expected 1 drop, got ${me.gave.length}`);
  ok('⭐⭐⭐⭐⭐ …and BOTH shapes of transaction_data are read — the add and the cut',
    `${me.got[0].name} in, ${me.gave[0].name} out`);
  assert.strictEqual(me.got[0].pos, 'WR');
  assert.strictEqual(me.got[0].team, 'DEN');
  ok('⭐⭐⭐ …with the player fields dug out of the nested arrays', `${me.got[0].pos} ${me.got[0].team}`);
  assert.strictEqual(me.isMe, true, 'the signed-in team must be marked');
  assert.strictEqual(w.mine, true);
  ok('⭐⭐⭐⭐ …and the row knows it is mine');

  const fa = byId('.tr.12');
  assert.strictEqual(fa.type, 'free_agent', `a free-agent add is not a waiver, got ${fa.type}`);
  assert.strictEqual(fa.bid, null, 'a free-agent add has no bid');
  ok('⭐⭐⭐⭐ a free-agent add is its own kind, with no bid', `${fa.type}, bid=${fa.bid}`);
  /* ⚠ AND IT IS NOT MINE. Slot 2 made that one; a parser that marks every row `mine` passes §2 above. */
  assert.strictEqual(fa.mine, false, 'somebody else made that add');
  ok('⭐⭐⭐⭐⭐ …and somebody else\'s move is not reported as mine');
}

console.log('\n== §3 the three-team trade ==');
{
  const t = byId('.tr.13');
  assert.strictEqual(t.type, 'trade');
  assert.strictEqual(t.teams.length, 3, `a three-team trade has three sides, got ${t.teams.length}`);
  ok('⭐⭐⭐⭐⭐ a three-team trade renders all three sides', t.teams.map((x) => x.teamName).join(' / '));
  /* ⭐⭐⭐⭐⭐ THE "drops MEANS TWO THINGS" TRAP, IN YAHOO'S DIALECT. Every side must show what it RECEIVED
     and what it SENT — read wrong, a trade renders as three managers cutting their best players. */
  t.teams.forEach((s) => {
    assert.ok(s.got.length >= 1 && s.gave.length >= 1,
      `slot ${s.rosterId} should both receive and send: got ${s.got.length}, gave ${s.gave.length}`);
  });
  ok('⭐⭐⭐⭐⭐ …and every side both receives and sends, rather than reading as three cuts');
  const mine = t.teams.find((s) => s.rosterId === 1);
  assert.strictEqual(mine.got[0].name, 'Justin Jefferson');
  assert.strictEqual(mine.gave[0].name, 'Ashton Jeanty');
  ok('⭐⭐⭐⭐⭐ …with each player on the right side of the right team',
    `you get ${mine.got[0].name}, you send ${mine.gave[0].name}`);
  /* ⚠ THIS CHECK IS NARROWER THAN ITS FIRST VERSION, ON PURPOSE. It originally claimed to prove that
     `isMe` survives a slot being reached twice — and the falsification that removed the guard for that
     still passed, because `slotOfTeamKey` is one-to-one and the answer can never change between visits.
     The guard was dead code and the check was vacuous; both are gone. What is worth pinning is that MY
     side of a trade is marked at all, on a row where I appear as both a receiver and a sender. */
  assert.strictEqual(mine.isMe, true, 'my own side of the trade was not marked');
  assert.strictEqual(t.teams.filter((s) => s.isMe).length, 1, 'exactly one side is mine');
  ok('⭐⭐⭐⭐ …and exactly one side of it is marked as mine');
}

console.log('\n== §4 what Sleeper cannot do ==');
{
  const pend = byId('.tr.14');
  assert.ok(pend, 'the pending trade was dropped');
  assert.strictEqual(pend.status, 'pending', `expected pending, got ${pend.status}`);
  ok('⭐⭐⭐⭐⭐ a trade still waiting on a decision survives as PENDING', pend.note);
  /* ⚠⚠ AND IT MUST NOT READ AS SOMETHING THAT HAPPENED. The whole reason the Sleeper screens say
     "pending offers are not available" is that showing an unresolved deal as a completed one is a false
     story about somebody's roster. */
  assert.notStrictEqual(pend.status, 'complete', 'a pending trade must never read as complete');
  ok('⭐⭐⭐⭐⭐ …and is never rendered as a deal that went through');
  const rej = byId('.tr.15');
  assert.strictEqual(rej.status, 'failed', `expected failed, got ${rej.status}`);
  ok('⭐⭐⭐⭐ a rejected trade is kept, and marked as not landing', rej.note);
  const kinds = new Set(rows.map((r) => r.status));
  assert.strictEqual(kinds.size, 3, `expected complete/pending/failed, got ${[...kinds].join(',')}`);
  ok('⭐⭐⭐⭐⭐ …so one league carries all three statuses', [...kinds].join(', '));
}

console.log('\n== §5 nonsense in, nothing out ==');
{
  assert.deepStrictEqual(parseTransactions({}, OPTS), []);
  assert.deepStrictEqual(parseTransactions(null, OPTS), []);
  assert.deepStrictEqual(parseTransactions({ fantasy_content: { league: [{}] } }, OPTS), []);
  ok('⭐⭐⭐⭐ an unexpected payload returns nothing rather than taking the feed down');
  /* ⚠ A TEAM KEY WE DO NOT KNOW MUST DROP THE SIDE, NOT INVENT A SLOT. Attributing a move to the wrong
     manager is the one error on this screen that still looks completely plausible. */
  const stray = parseTransactions(FIX, { ...OPTS, slotOfTeamKey: { [team(2)]: 2 } });
  const t = stray.find((r) => r.id.endsWith('.tr.13'));
  assert.ok(t && t.teams.length === 1 && t.teams[0].rosterId === 2,
    `an unknown team key must be dropped, got ${JSON.stringify(t && t.teams.map((x) => x.rosterId))}`);
  ok('⭐⭐⭐⭐⭐ …and a team key we cannot place is dropped rather than guessed');
}

console.log(`\n${n} passed`);
