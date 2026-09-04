/* WHICH DRAFTS A LEAGUE'S ADP IS MADE OF.
 *
 * Trey, on a 2QB board: "I feel like QBs are being undervalued by a lot / are you pulling from the right
 * drafts on sleeper for ADP?"
 *
 * He was pointing at this file. The format key is the bucket every ADP observation is filed under and
 * every league is served from, and its QB dimension had two values for three formats: 1QB, and SF for
 * everything else. So a true 2QB league — two DEDICATED starting QB slots, no opting out — was priced from
 * a bucket dominated by superflex drafts, where the second quarterback is optional and a running back goes
 * in that slot whenever the QBs dry up. Those rooms take quarterbacks later. Averaging them into a 2QB
 * league's market makes the position his format is built around look systematically cheap, which is
 * exactly the complaint, arriving by a route nobody would guess from the screen.
 *
 * ⚠⚠ THE ARITHMETIC OF THE BLEND IS WHY THE LABEL MATTERED SO MUCH. A harvested draft writes weight 0.34
 *    per pick; Sleeper's published `adp_2qb` writes 6. Eighteen superflex drafts therefore outvote the one
 *    number that IS the 2QB market — and the SF bucket has far more than eighteen. The published field was
 *    filed under SF too, so the 2QB market was a minority inside its own data.
 */
import assert from 'assert';
import { formatKey, formatFallbacks, qbClass, isSuperflex, cfgFromSleeperDraft } from '../src/lib/formatKey.js';

let n = 0;
const ok = (m) => { n++; console.log('  PASS  ' + m); };

const cfg = (start, over = {}) => ({ teams: 12, type: 'redraft', scoring: { rec: 1 }, start, ...over });
const BASE = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, SUPER: 0 };

// ---- 1 · ⭐⭐⭐⭐ the three formats are three buckets ------------------------------------------------
{
  assert.strictEqual(qbClass(cfg({ ...BASE })), '1QB');
  assert.strictEqual(qbClass(cfg({ ...BASE, SUPER: 1 })), 'SF');
  assert.strictEqual(qbClass(cfg({ ...BASE, QB: 2 })), '2QB');
  // ⚠ A DEDICATED SLOT IS THE TEST, NOT THE COUNT OF QBs YOU END UP STARTING. A superflex league starts two
  //   quarterbacks most weeks and is still not a 2QB league: the slot can hold anybody, and that optionality
  //   is the entire difference in how the two rooms draft.
  assert.strictEqual(qbClass(cfg({ ...BASE }, { sf: true })), 'SF', 'a legacy sf flag is superflex, not 2QB');
  assert.strictEqual(qbClass(cfg({ ...BASE, QB: 2, SUPER: 1 })), '2QB', 'two dedicated slots plus a super is still 2QB');
  ok('1 · ⭐⭐⭐⭐ 1QB, superflex and 2QB are three distinct buckets — a SUPER slot is not a second QB slot');
}

// ---- 2 · isSuperflex still answers the old question, for everyone who asks it ------------------------
{
  // Half the engine asks "is this a QB-premium format at all". That question has not changed and must keep
  // returning true for both — splitting the ADP bucket is not a licence to re-answer it.
  assert.ok(isSuperflex(cfg({ ...BASE, SUPER: 1 })));
  assert.ok(isSuperflex(cfg({ ...BASE, QB: 2 })));
  assert.ok(!isSuperflex(cfg({ ...BASE })));
  ok('2 · isSuperflex still means "QB-premium format" and covers both — only the ADP bucket split');
}

// ---- 3 · ⭐⭐⭐ a thin 2QB bucket borrows SUPERFLEX, never 1QB ---------------------------------------
{
  const key = formatKey(cfg({ ...BASE, QB: 2 }, { teams: 8 }));
  assert.strictEqual(key, 'PPR|2QB|STD|REDRAFT|8-10');
  const chain = formatFallbacks(key);

  // Its own format is exhausted first — a 2QB league with real 2QB data must not be handed superflex data
  // just because its team-size bucket is thin.
  const firstSF = chain.findIndex((k) => k.includes('|SF|'));
  const lastTwo = chain.map((k) => k.includes('|2QB|')).lastIndexOf(true);
  assert.ok(firstSF > lastTwo, 'every 2QB variant must be tried before the first superflex one');

  // ⚠ AND 1QB IS NEVER REACHABLE. It is the one market that is definitely wrong for this league, and a
  //   new bucket starts EMPTY — so without this the split would have made things worse on day one, serving
  //   a 2QB drafter the single-quarterback board.
  assert.ok(!chain.some((k) => k.includes('|1QB|')), 'a 2QB league must never fall back to the 1QB board');
  ok(`3 · ⭐⭐⭐ 2QB exhausts its own bucket, then borrows superflex, and never reaches 1QB (${chain.length} steps)`);
}

// ---- 4 · and superflex borrows 2QB the same way ------------------------------------------------------
{
  const chain = formatFallbacks(formatKey(cfg({ ...BASE, SUPER: 1 })));
  assert.ok(chain.some((k) => k.includes('|2QB|')), 'superflex should borrow the neighbouring multi-QB market');
  assert.ok(!chain.some((k) => k.includes('|1QB|')), 'and never the single-QB board');
  const first1 = chain.findIndex((k) => k.includes('|2QB|'));
  const lastSF = chain.map((k) => k.includes('|SF|')).lastIndexOf(true);
  assert.ok(first1 > lastSF, 'superflex data first, always');
  ok('4 · superflex exhausts its own bucket, then borrows 2QB — the relationship is symmetric');
}

// ---- 5 · a 1QB league is untouched by all of this -----------------------------------------------------
{
  const chain = formatFallbacks(formatKey(cfg({ ...BASE })));
  assert.ok(chain.every((k) => k.includes('|1QB|')), 'a 1QB league must never be served multi-QB data');
  ok('5 · ⭐ a 1QB league sees only 1QB buckets — the split cannot leak QB-premium prices into it');
}

// ---- 6 · ⭐⭐ a harvested Sleeper draft lands in the right bucket by its own settings ------------------
{
  // This is what makes the split fill itself: the harvester already reads slots_qb and slots_super_flex, so
  // real 2QB drafts start accumulating in the 2QB bucket from the next run onward, with no backfill.
  const twoQbDraft = { settings: { rounds: 16, teams: 12, slots_qb: 2, slots_super_flex: 0, slots_te: 1 } };
  const sfDraft = { settings: { rounds: 16, teams: 12, slots_qb: 1, slots_super_flex: 1, slots_te: 1 } };
  assert.strictEqual(qbClass(cfgFromSleeperDraft(twoQbDraft)), '2QB');
  assert.strictEqual(qbClass(cfgFromSleeperDraft(sfDraft)), 'SF');
  assert.strictEqual(qbClass(cfgFromSleeperDraft({ settings: { rounds: 16, teams: 12, slots_qb: 1 } })), '1QB');
  ok('6 · ⭐⭐ the harvester files a real 2QB draft as 2QB and a superflex one as SF — the bucket fills itself');
}

console.log(`\n${n}/${n} format-key checks passed`);
