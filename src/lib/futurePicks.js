/* ⭐⭐⭐⭐⭐ WHO OWNS WHICH FUTURE DRAFT PICK — b166.
   Trey: "For leagues that allow draft pick trading, those also need to be in the trade calculator and need
   you to place them in there based on value."
   Sleeper does not publish an ownership table. It publishes the DEFAULT (every roster owns its own pick in
   every round of every future season) implicitly, and the EXCEPTIONS explicitly: GET
   /league/{id}/traded_picks returns every pick that has changed hands, as { season, round, roster_id
   (the ORIGINAL owner), owner_id (the CURRENT owner) }. The table is the default with the exceptions laid
   over it — this module, pure, so it can be tested without Sleeper.
   ⚠ `roster_id` IS WHOSE PICK IT IS, NOT WHO HAS IT. The pick keeps its original team's name forever —
     "Team 4's 2027 1st" — because that team's finish decides where in the round it lands. Confusing the
     two fields would hand every traded pick back to the team that traded it away.
   ⚠ WHICH SEASONS: the next three drafts, which is what Sleeper lets a league trade. Once this season's
     draft is done the next one is `season + 1`.
   ⚠ WHETHER PICKS TRADE AT ALL: Sleeper has no single field for it. Keeper (type 1) and dynasty (type 2)
     leagues can; so can any league where a pick HAS been traded — that is proof, whatever the settings say.
     A redraft league with no traded picks gets `enabled: false` and the client offers no picks. */
export function futurePicks({ league, rosters, traded, season, years = 3 }) {
  const s = (league && league.settings) || {};
  const type = Number(s.type || 0);
  const list = Array.isArray(traded) ? traded.filter((t) => t && t.season != null && t.round != null) : [];
  const enabled = type === 1 || type === 2 || list.length > 0;
  if (!enabled) return { enabled: false, seasons: [], rounds: 0, picks: [] };
  /* Dynasty rookie drafts are short; Sleeper's `draft_rounds` is the NEXT draft's length. A startup-sized
     number in a dynasty league would be the startup draft, which never repeats — cap at 5 for type 2. */
  let rounds = Number(s.draft_rounds) || (type === 2 ? 4 : 0);
  if (type === 2 && rounds > 5) rounds = 5;
  const tradedRounds = list.map((t) => Number(t.round)).filter(Number.isFinite);
  rounds = Math.max(rounds, ...(tradedRounds.length ? tradedRounds : [0]));
  if (!rounds) return { enabled: false, seasons: [], rounds: 0, picks: [] };
  const first = Number(season) + 1;
  const seasons = Array.from({ length: years }, (_, i) => String(first + i));
  const ids = (rosters || []).map((r) => Number(r && r.roster_id)).filter(Number.isFinite);
  const own = new Map();
  seasons.forEach((yr) => { for (let rd = 1; rd <= rounds; rd++) ids.forEach((rid) => own.set(`${yr}|${rd}|${rid}`, rid)); });
  list.forEach((t) => {
    const k = `${String(t.season)}|${Number(t.round)}|${Number(t.roster_id)}`;
    if (own.has(k) && Number.isFinite(Number(t.owner_id))) own.set(k, Number(t.owner_id));
  });
  const picks = [];
  own.forEach((owner, k) => {
    const [yr, rd, orig] = k.split('|');
    picks.push({ season: yr, round: Number(rd), originalRosterId: Number(orig), ownerRosterId: owner });
  });
  return { enabled: true, seasons, rounds, picks };
}
