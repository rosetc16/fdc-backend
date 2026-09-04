/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
   FANTRAX — a semi-official API, and the best credential story of the six
   ───────────────────────────────────────────────────────────────────────────────────────────────────
   Fantrax has a partner API (they call it FXEA) that is not published on a docs page but IS handed to
   developers who ask, and is what production league-sync products use. What makes it worth building is
   the credential:

       the user copies a "Secret ID" from their own Fantrax profile page.

   Not a password, not a session cookie, not a token that authenticates their whole account elsewhere —
   a value Fantrax minted for exactly this purpose, which the user can regenerate to revoke us. That is
   a better deal than ESPN's cookies by a distance, and it is why this one is safe to store and poll.

   ⚠ getLeagueInfo DOES NOT RETURN THE LEAGUE NAME. It is a known gap in the beta API, so the name comes
     from getLeagues (which does) and the UI asks if that lookup was skipped. Do not "fix" this by leaving
     the name blank — an unnamed league in a list of leagues is the bug users report.

   ⚠ THE ENDPOINT SET IS A MOVING TARGET. It is a beta API with no public spec; treat every field as
     optional and never let a missing one throw. If Fantrax changes something the import should degrade
     to "we got the settings but not the rosters", not to a 500.
   ═══════════════════════════════════════════════════════════════════════════════════════════════════ */
import { withPlayerNames } from './playerIds.js';

const BASE = 'https://www.fantrax.com/fxea/general';
const UA = 'FantasyDraftCompass/1.0 (+https://www.fantasydraftcompass.com)';

async function fx(path, params = {}, { timeoutMs = 10000 } = {}) {
  const q = new URLSearchParams(params);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try { res = await fetch(`${BASE}/${path}?${q}`, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': UA } }); }
  catch { const e = new Error("Couldn't reach Fantrax. Try again in a moment."); e.status = 502; throw e; }
  finally { clearTimeout(timer); }
  if (res.status === 401 || res.status === 403) {
    const e = new Error('Fantrax rejected that Secret ID. Open Fantrax → your profile → Secret ID, copy it again, and check there is no trailing space.');
    e.status = 403; e.code = 'FANTRAX_AUTH'; throw e;
  }
  if (!res.ok) { const e = new Error(`Fantrax returned ${res.status}.`); e.status = 502; throw e; }
  try { return await res.json(); } catch { const e = new Error('Fantrax returned something we could not read.'); e.status = 502; throw e; }
}

const POS = (p) => {
  const s = String(p || '').toUpperCase();
  if (/^QB/.test(s)) return 'QB'; if (/^RB/.test(s)) return 'RB'; if (/^WR/.test(s)) return 'WR';
  if (/^TE/.test(s)) return 'TE'; if (/^(K|PK)$/.test(s)) return 'K'; if (/^(D|DST|DEF)/.test(s)) return 'DST';
  return null;
};

/* Which leagues does this Secret ID own? This is also the credential check — if it answers, the ID is
   good, and the user picks from a list instead of hunting for a league id. */
export async function fantraxLeagues(secretId) {
  const sid = String(secretId || '').trim();
  if (!sid) { const e = new Error('A Fantrax Secret ID is required.'); e.status = 400; throw e; }
  const j = await fx('getLeagues', { userSecretId: sid });
  const list = Array.isArray(j?.leagues) ? j.leagues : Object.values(j?.leagues || {});
  return list
    .filter((l) => l && (l.leagueId || l.id))
    .map((l) => ({
      league_id: String(l.leagueId || l.id),
      name: l.leagueName || l.name || null,
      sport: l.sport || null,
      season: l.season || null,
    }))
    // Football only — a Fantrax account is very often mostly baseball and hockey leagues.
    .filter((l) => !l.sport || /football|nfl/i.test(l.sport));
}

export async function fantraxLeague(leagueId, { secretId = null, name = null } = {}) {
  const id = String(leagueId || '').trim();
  if (!id) { const e = new Error('A Fantrax league ID is required.'); e.status = 400; throw e; }
  const auth = secretId ? { userSecretId: String(secretId).trim() } : {};

  const [info, rosters, draft] = await Promise.all([
    fx('getLeagueInfo', { leagueId: id, ...auth }),
    fx('getTeamRosters', { leagueId: id, ...auth }).catch(() => null),
    fx('getDraftPicks', { leagueId: id, ...auth }).catch(() => null),
  ]);

  const teamList = Array.isArray(info?.teams) ? info.teams : Object.values(info?.teams || {});
  const teams = teamList.length || Number(info?.numTeams) || 12;
  const slotOfTeam = {};
  const slotNames = {};
  teamList.forEach((t, i) => {
    const slot = Number(t.draftSlot || t.slot) || i + 1;
    slotOfTeam[String(t.teamId || t.id)] = slot;
    slotNames[slot] = t.teamName || t.name || `Team ${slot}`;
  });

  // Starting lineup, from whatever shape the roster-limits block arrives in.
  const start = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0, FLEX: 0, SUPER: 0 };
  const limits = info?.rosterInfo?.positionConstraints || info?.positionConstraints || {};
  Object.entries(limits).forEach(([k, v]) => {
    const p = POS(k);
    const n = Number(v?.minActive ?? v?.numStarters ?? v?.min ?? 0) || 0;
    if (p) start[p] += n;
    else if (/flex|w\/r\/t|wrt/i.test(k)) start.FLEX += n;
    else if (/super|op|q\/w\/r\/t/i.test(k)) start.SUPER += n;
  });
  if (!Object.values(start).some(Boolean)) Object.assign(start, { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1 });

  const rounds = Number(info?.rosterInfo?.maxTotal || info?.rosterSize) || 16;
  const cfg = {
    name: name || info?.leagueName || `Fantrax league ${id}`,
    teams, rounds,
    type: /dynasty|keeper/i.test(String(info?.leagueType || '')) ? 'dynasty' : 'redraft',
    order: /linear|straight/i.test(String(info?.draftType || '')) ? 'linear' : 'snake',
    sf: start.SUPER > 0, tePremMult: 0,
    start,
    scoring: { rec: Number(info?.scoringSystem?.receptions) || 1 },
    caps: {}, keepers: [], pickTrades: [],
  };

  /* ⭐⭐ Both lists go through the id directory for anything the feed left name-less — a roster or a
     keeper list of bare Fantrax ids leaves every one of those players sitting on the board as
     available. getTeamRosters usually does carry names, so this is normally a no-op that costs
     nothing; when it doesn't, it is the difference between an import that works and one that doesn't. */
  const existingRosters = {};
  const rosterSlots = [];
  const rosterRows = [];
  const rosterEntries = rosters?.rosters || rosters || {};
  Object.entries(rosterEntries).forEach(([teamId, r]) => {
    const slot = slotOfTeam[String(teamId)]; if (!slot) return;
    const players = Array.isArray(r?.rosterItems) ? r.rosterItems : Array.isArray(r) ? r : [];
    players.forEach((p) => {
      const pid = String(p.id || p.playerId || '');
      if (!pid) return;
      rosterSlots.push(slot);
      rosterRows.push({ player_id: pid, name: p.name || null, pos: POS(p.position) });
    });
  });
  (await withPlayerNames(rosterRows, 'fantrax')).forEach((row, i) => {
    const slot = rosterSlots[i];
    (existingRosters[slot] = existingRosters[slot] || []).push(row);
  });

  const rawPicks = Array.isArray(draft?.draftPicks) ? draft.draftPicks : Array.isArray(draft) ? draft : [];
  const picks = await withPlayerNames(
    rawPicks
      .filter((p) => p && (p.playerId || p.player))
      .sort((a, b) => (Number(a.overall || a.pick) || 0) - (Number(b.overall || b.pick) || 0))
      .map((p, i) => ({
        overall: Number(p.overall || p.pick) || i + 1,
        round: Number(p.round) || null,
        slot: slotOfTeam[String(p.teamId || p.team)] || null,
        player_id: String(p.playerId || p.player),
        name: p.playerName || null,
        keeper: false,
      })),
    'fantrax',
  );

  return {
    league_id: id, name: cfg.name, platform: 'fantrax',
    cfg, teams, draftType: cfg.order,
    status: picks.length ? (picks.length >= teams * rounds ? 'complete' : 'drafting') : 'pre_draft',
    yourSlot: null, slotNames, tradedPicks: [], keepers: [],
    existingRosters: Object.keys(existingRosters).length ? existingRosters : null,
    picks,
    liveSync: true,
  };
}

export async function fantraxPicks(leagueId, { secretId = null } = {}) {
  const draft = await fx('getDraftPicks', { leagueId: String(leagueId).trim(), ...(secretId ? { userSecretId: String(secretId).trim() } : {}) });
  const raw = Array.isArray(draft?.draftPicks) ? draft.draftPicks : Array.isArray(draft) ? draft : [];
  const picks = raw.filter((p) => p && (p.playerId || p.player))
    .map((p, i) => ({
      overall: Number(p.overall || p.pick) || i + 1,
      round: Number(p.round) || null,
      team: String(p.teamId || p.team || ''),
      player_id: String(p.playerId || p.player),
      // Fantrax's own feed carries the name sometimes and not others; when it does, it wins.
      name: p.playerName || p.name || null,
    }));
  /* ⭐⭐⭐ NAMES, OR THIS FEED IS DECORATIVE — the board places picks by name, not by Fantrax id.
     See src/lib/playerIds.js. Free when the feed already supplied every name. */
  return withPlayerNames(picks, 'fantrax');
}
