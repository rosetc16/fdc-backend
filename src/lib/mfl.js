/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
   MYFANTASYLEAGUE — the one platform that wants you here
   ───────────────────────────────────────────────────────────────────────────────────────────────────
   MFL publishes an official, free, documented developer API with no approval gate, and it is the only
   platform of the six that answers LIVE DRAFT PICKS to a plain server-side poll. No extension, no
   reverse engineering, no cookies:

       https://api.myfantasyleague.com/{year}/export?TYPE=draftResults&L={id}&JSON=1

   updates while the draft is running. That single fact makes MFL cheaper to support well than any of
   the others, so it is built first even though fewer people use it.

   AUTH, for a private league: an APIKEY, which the commissioner generates per league from that league's
   Developer's API page. ⚠ THIS IS THE PART WORTH NOTICING — it is a read key scoped to ONE league. It is
   not an account password and not a session cookie, so unlike ESPN it can be stored without holding
   someone's whole account, which is what makes a background live sync defensible here.

   ⚠ ALWAYS ENTER VIA api.myfantasyleague.com. MFL rotates numbered hosts (www4x.myfantasyleague.com…)
     and a league answers on whichever it currently lives on; the api host redirects for you. Hard-coding
     a numbered host works right up until the league is migrated and then fails for one user at a time.
   ⚠ IDENTIFY YOURSELF IN User-Agent. MFL asks for it and rate-limits anonymous callers harder.
   ═══════════════════════════════════════════════════════════════════════════════════════════════════ */
const BASE = 'https://api.myfantasyleague.com';
const UA = 'FantasyDraftCompass/1.0 (+https://www.fantasydraftcompass.com)';

async function mflGet(year, type, params = {}, { timeoutMs = 10000 } = {}) {
  const q = new URLSearchParams({ TYPE: type, JSON: '1', ...params });
  const url = `${BASE}/${year}/export?${q}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try { res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': UA } }); }
  catch { const e = new Error("Couldn't reach MyFantasyLeague. Try again in a moment."); e.status = 502; throw e; }
  finally { clearTimeout(timer); }
  if (!res.ok) { const e = new Error(`MyFantasyLeague returned ${res.status}.`); e.status = 502; throw e; }
  let json; try { json = await res.json(); } catch { const e = new Error('MyFantasyLeague returned something we could not read.'); e.status = 502; throw e; }
  /* ⚠ MFL ANSWERS 200 FOR ERRORS. A bad league id or a private league with no key comes back as
     {"error":"..."} with an HTTP 200, so checking res.ok is not enough — this is how a "successful"
     import ends up with an empty league and no explanation. */
  if (json && json.error) {
    const msg = String(json.error.$t || json.error);
    const e = new Error(/private|not authori|api key/i.test(msg)
      ? 'That MFL league is private. Ask the commissioner for the league API key (League Setup → Developer\'s API) and paste it here.'
      : `MyFantasyLeague said: ${msg}`);
    e.status = /private|authori|api key/i.test(msg) ? 403 : 400; e.code = 'MFL_ERROR'; throw e;
  }
  return json;
}

// MFL wraps single-element lists as an object rather than a one-item array, everywhere, silently.
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const POS = (p) => ({ QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', PK: 'K', K: 'K', DEF: 'DST', DST: 'DST' })[String(p || '').toUpperCase()] || null;

function startFromMfl(league) {
  /* Roster requirements read as a string like "QB:1,RB:2-4,WR:3-5,TE:1-3,PK:1,DEF:1" plus a total.
     The LOWER bound of each range is the true starting requirement; the upper bound is the cap, which
     the app models separately. Taking the upper bound here would inflate every starter count and quietly
     re-price the entire board. */
  const s = String(league?.starters?.position || '');
  const out = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0, FLEX: 0, SUPER: 0 };
  s.split(',').forEach((part) => {
    const [pos, range] = part.split(':');
    const p = POS(pos); if (!p || !range) return;
    out[p] = Number(String(range).split('-')[0]) || 0;
  });
  const total = Number(league?.starters?.count) || 0;
  const named = Object.values(out).reduce((a, b) => a + b, 0);
  if (total > named) out.FLEX = total - named;      // whatever the total demands beyond the named slots
  return out;
}

export async function mflLeague(leagueId, season, { apiKey = null } = {}) {
  const id = String(leagueId || '').trim();
  if (!/^\d+$/.test(id)) { const e = new Error('An MFL league ID is the number in your league URL.'); e.status = 400; throw e; }
  const yr = Number(season) || new Date().getUTCFullYear();
  const auth = apiKey ? { APIKEY: String(apiKey).trim() } : {};

  const [lg, rules, ros, dr] = await Promise.all([
    mflGet(yr, 'league', { L: id, ...auth }),
    mflGet(yr, 'rules', { L: id, ...auth }).catch(() => null),
    mflGet(yr, 'rosters', { L: id, ...auth }).catch(() => null),
    mflGet(yr, 'draftResults', { L: id, ...auth }).catch(() => null),
  ]);
  const league = lg?.league;
  if (!league) { const e = new Error('MFL returned no league for that ID.'); e.status = 404; throw e; }

  const franchises = arr(league?.franchises?.franchise);
  const teams = franchises.length || Number(league?.franchises?.count) || 12;
  const slotNames = {};
  const slotOfFranchise = {};
  franchises.forEach((f, i) => {
    // A franchise id is "0001".."00NN"; its numeric value is the slot in every MFL league I can find.
    const slot = Number(String(f.id).replace(/\D/g, '')) || i + 1;
    slotOfFranchise[f.id] = slot;
    slotNames[slot] = f.name || `Team ${slot}`;
  });

  const start = startFromMfl(league);
  const rounds = Number(league?.rosterSize) || Object.values(start).reduce((a, b) => a + b, 0) + 6;
  const isDynasty = /dynasty|keeper/i.test(String(league?.h2h || '') + String(league?.name || ''));

  const cfg = {
    name: league.name || `MFL league ${id}`,
    teams, rounds,
    type: isDynasty ? 'dynasty' : 'redraft',
    order: 'snake',
    sf: (start.SUPER || 0) > 0,
    tePremMult: 0,
    start,
    scoring: { rec: 1 },                       // refined below from the rules export when it is readable
    caps: {}, keepers: [], pickTrades: [],
  };
  /* Points per reception, dug out of the scoring rules. MFL's rule grammar is a small expression
     language, and reading all of it is a project; the ONE number that changes every valuation is PPR,
     so that is what is extracted, and anything else is left at the default rather than half-guessed. */
  try {
    const rr = arr(rules?.rules?.positionRules).flatMap((p) => arr(p.rule));
    const recRule = rr.find((r) => /(^|[^A-Z])CC([^A-Z]|$)/.test(String(r?.event?.$t || r?.event || '')));
    const pts = recRule ? Number(String(recRule?.points?.$t || recRule?.points || '').replace(/[^\d.-]/g, '')) : null;
    if (Number.isFinite(pts)) cfg.scoring.rec = pts;
  } catch { /* leave the default — a wrong PPR is worse than a stated default */ }

  const existingRosters = {};
  arr(ros?.rosters?.franchise).forEach((f) => {
    const slot = slotOfFranchise[f.id]; if (!slot) return;
    const list = arr(f.player).map((p) => ({ player_id: String(p.id), name: null, pos: null }));
    if (list.length) existingRosters[slot] = list;
  });

  const picks = arr(dr?.draftResults?.draftUnit)
    .flatMap((u) => arr(u.draftPick))
    .filter((p) => p && p.player && p.timestamp)
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
    .map((p, i) => ({
      overall: i + 1,
      round: Number(p.round) || null,
      slot: slotOfFranchise[p.franchise] || null,
      player_id: String(p.player),
      name: null,
      keeper: false,
    }));

  return {
    league_id: id, name: cfg.name, season: yr, platform: 'mfl',
    cfg, teams, draftType: 'snake',
    status: picks.length ? (picks.length >= teams * rounds ? 'complete' : 'drafting') : 'pre_draft',
    yourSlot: null,                     // MFL does not tell us who is asking; the UI asks once
    slotNames, tradedPicks: [], keepers: [],
    existingRosters: Object.keys(existingRosters).length ? existingRosters : null,
    picks,
    liveSync: true,                     // draftResults updates during the draft — see the header
  };
}

/* The live poll. Deliberately fetches ONLY draftResults: during a draft this runs every few seconds and
   the settings do not change mid-draft. */
export async function mflPicks(leagueId, season, { apiKey = null } = {}) {
  const yr = Number(season) || new Date().getUTCFullYear();
  const dr = await mflGet(yr, 'draftResults', { L: String(leagueId).trim(), ...(apiKey ? { APIKEY: String(apiKey).trim() } : {}) });
  return arr(dr?.draftResults?.draftUnit)
    .flatMap((u) => arr(u.draftPick))
    .filter((p) => p && p.player && p.timestamp)
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
    .map((p, i) => ({ overall: i + 1, round: Number(p.round) || null, franchise: p.franchise, player_id: String(p.player) }));
}
