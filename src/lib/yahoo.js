/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
   YAHOO FANTASY — the only sanctioned OAuth of the six, and the only one with a lawyer attached
   ───────────────────────────────────────────────────────────────────────────────────────────────────
   Yahoo is the one platform here with a real, current, supported public API. The user experience is the
   best of the lot: a "Sign in with Yahoo" button and a consent screen. No cookies out of dev tools, no
   passwords, no pasted keys.

   TWO THINGS MAKE IT DIFFERENT FROM THE OTHERS, AND BOTH ARE CONSTRAINTS, NOT DETAILS:

   1. IT IS GATED. Yahoo reviews each application before granting access (sports.yahoo.com/developer/access).
      You state the product, the data you need and your user count. Read access only; there is no write.
      Nothing here works until that approval lands and YAHOO_CLIENT_ID / YAHOO_CLIENT_SECRET are set —
      which is why every route below answers a clear "not configured" rather than a 500.

   2. THEIR TERMS SAY DELETE USER DATA WITHIN 24 HOURS unless the docs explicitly allow storing it.
      That is a hard architectural rule, not a footnote: we may hold the OAuth tokens (that is what they
      are for) but we must NOT build a Yahoo league history that outlives a day. So the import writes a
      league into the user's own state — which is theirs, on their device and their account — and the
      backend keeps nothing but the tokens. No Yahoo-derived cache tables. Attribution is required
      wherever the data is shown: "Fantasy data provided by Yahoo Fantasy."

   ⚠ ACCESS TOKENS LAST ONE HOUR and the refresh token may be ROTATED on every refresh. Storing the old
     refresh token after a refresh is how a connection silently dies a week later; `refresh()` always
     writes back whatever came home.
   ⚠ YAHOO DOES NOT ACCEPT localhost AS A REDIRECT. Development uses the deployed callback or `oob`.
   ⚠ THE API IS XML BY DEFAULT. Every call appends ?format=json, and the JSON is a positional-array
     shape that is genuinely awkward — see `bag()`.
   ═══════════════════════════════════════════════════════════════════════════════════════════════════ */
const AUTH = 'https://api.login.yahoo.com/oauth2/request_auth';
const TOKEN = 'https://api.login.yahoo.com/oauth2/get_token';
const API = 'https://fantasysports.yahooapis.com/fantasy/v2';
const UA = 'FantasyDraftCompass/1.0 (+https://www.fantasydraftcompass.com)';

export const yahooConfigured = () => !!(process.env.YAHOO_CLIENT_ID && process.env.YAHOO_CLIENT_SECRET && process.env.YAHOO_REDIRECT_URI);

export function yahooAuthUrl(state) {
  if (!yahooConfigured()) { const e = new Error('Yahoo is not configured on this server yet.'); e.status = 501; e.code = 'YAHOO_UNCONFIGURED'; throw e; }
  const q = new URLSearchParams({
    client_id: process.env.YAHOO_CLIENT_ID,
    redirect_uri: process.env.YAHOO_REDIRECT_URI,
    response_type: 'code',
    state: String(state || ''),
  });
  return `${AUTH}?${q}`;
}

async function tokenCall(body) {
  const basic = Buffer.from(`${process.env.YAHOO_CLIENT_ID}:${process.env.YAHOO_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
    body: new URLSearchParams({ redirect_uri: process.env.YAHOO_REDIRECT_URI, ...body }),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !j.access_token) {
    const e = new Error(`Yahoo sign-in failed${j && j.error_description ? `: ${j.error_description}` : ''}.`);
    e.status = 502; e.code = 'YAHOO_TOKEN'; throw e;
  }
  return {
    accessToken: j.access_token,
    // ⚠ ALWAYS TAKE THE NEW REFRESH TOKEN when one comes back — Yahoo rotates them.
    refreshToken: j.refresh_token || body.refresh_token || null,
    expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000,
  };
}

export const yahooExchange = (code) => tokenCall({ grant_type: 'authorization_code', code });
export const yahooRefresh = (refreshToken) => tokenCall({ grant_type: 'refresh_token', refresh_token: refreshToken });

async function yGet(path, accessToken) {
  const res = await fetch(`${API}/${path}${path.includes('?') ? '&' : '?'}format=json`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'user-agent': UA },
  });
  if (res.status === 401) { const e = new Error('Yahoo session expired.'); e.status = 401; e.code = 'YAHOO_EXPIRED'; throw e; }
  /* ⭐⭐⭐⭐ SAY WHAT HAPPENED, NOT WHAT THE PROTOCOL CALLED IT — b152. This used to surface as "Yahoo
     returned 403." on the connect screen. Trey: "I don't want it to say 403 because no one knows what
     that means." He is right, and the number was worse than useless here — it sat beside our own "No NFL
     leagues on that Yahoo account for this season", so the screen offered a plausible wrong explanation
     next to an unreadable right one, and the obvious conclusion was that the leagues were missing.
     ⚠ BUT NOT "no leagues found" EITHER, which is what he suggested. A 403 is Yahoo refusing this
       application access to the Fantasy API — usually because the developer app has not been provisioned
       yet, which is a completely different thing to do about it than an empty account. Printing the
       comfortable message would send the next person hunting for a league that was never the problem;
       that is the same class of mistake as a fixture that cannot fail. Plain words, true cause, and the
       status code kept in `detail` for a log or a bug report. */
  if (res.status === 403) {
    const e = new Error("Yahoo isn't allowing this app to read fantasy data yet. That's approval on Yahoo's side, not anything wrong with your account or your league.");
    e.status = 502; e.code = 'YAHOO_NOT_APPROVED'; e.detail = 'HTTP 403 from the Yahoo Fantasy API'; throw e;
  }
  if (res.status === 429) {
    const e = new Error('Yahoo is rate-limiting us right now. Give it a minute and try again.');
    e.status = 502; e.code = 'YAHOO_RATE'; e.detail = 'HTTP 429 from the Yahoo Fantasy API'; throw e;
  }
  if (!res.ok) {
    const e = new Error("Yahoo couldn't be reached just now. Try again in a moment.");
    e.status = 502; e.code = 'YAHOO_UPSTREAM'; e.detail = `HTTP ${res.status} from the Yahoo Fantasy API`; throw e;
  }
  return res.json();
}

/* ⚠ YAHOO'S JSON IS AN ARRAY PRETENDING TO BE AN OBJECT. A resource comes back as a numerically-keyed
   bag whose entries are sometimes objects and sometimes arrays of single-key objects, and the useful
   fields are scattered across both. Flattening once here keeps that ugliness in one function instead of
   spreading it through every caller. */
function bag(node) {
  const out = {};
  const eat = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(eat); return; }
    Object.entries(n).forEach(([k, v]) => {
      if (k === 'count' || /^\d+$/.test(k)) { eat(v); return; }
      /* ⚠ AN ARRAY VALUE HAS TO BE WALKED INTO, NOT JUST ASSIGNED. Yahoo wraps a team as
         { team: [ [ {team_key}, {name} ] ] } — the fields are two levels down inside nested arrays, so a
         mapper that assigns the array and stops finds no team_key and silently attributes every draft
         pick to slot null. */
      if (v && typeof v === 'object') { if (!(k in out)) out[k] = v; eat(v); return; }
      if (!(k in out)) out[k] = v;
    });
  };
  eat(node);
  return out;
}
const list = (node) => {
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).filter(([k]) => /^\d+$/.test(k)).map(([, v]) => v);
};

export async function yahooMyLeagues(accessToken) {
  const j = await yGet('users;use_login=1/games;game_keys=nfl/leagues', accessToken);
  const users = list(j?.fantasy_content?.users || {});
  const out = [];
  users.forEach((u) => {
    list(bag(u).games || {}).forEach((g) => {
      list(bag(g).leagues || {}).forEach((l) => {
        const b = bag(l);
        if (b.league_key) out.push({ league_key: b.league_key, league_id: b.league_id, name: b.name, teams: Number(b.num_teams) || null, season: b.season });
      });
    });
  });
  return out;
}

const POS = (p) => ({ QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', K: 'K', DEF: 'DST' })[String(p || '').toUpperCase()] || null;

/* ⭐⭐⭐⭐⭐ YAHOO'S DRAFT RESULTS CARRY NO NAMES, AND THAT IS A SHIPPED BUG — b161.
   ==================================================================================================
   `draftresults` returns `{ pick, round, team_key, player_key }` and nothing else. The draft room places
   an incoming pick by looking its NAME up in the player pool (`nameToId[normName(pk.name)]`) — our ids
   are Sleeper's, so the name is the only identifier a Yahoo league and our pool have in common. Until
   now `yahooLeague` set `name: null` on every pick and nothing filled it in, which means a completed
   Yahoo league imported as a tidy list of 180 picks, every one of them unresolvable, and the board
   filled with holes WHILE REPORTING A HEALTHY IMPORT.

   ⚠⚠ THAT IS EXACTLY THE FAILURE lib/playerIds.js WAS WRITTEN TO PREVENT — for MFL and Fantrax, which
     both publish a bulk directory. Yahoo does not, so it was skipped, and the same bug shipped in the
     platform the directory file's own header warns about. "No sync is visibly manual, whereas this looks
     connected right up until you notice the picks are missing."

   ⭐ YAHOO'S ANSWER IS A BULK KEY LOOKUP: `league/{key}/players;player_keys=a,b,c` takes up to 25 keys a
     call, so a 12×15 draft is eight requests rather than the hundreds a paginated crawl of the whole
     player universe would need. Fetched once per import, not once per pick.
   ⚠ A FAILED LOOKUP MUST NOT TAKE THE PICKS WITH IT — the same rule playerIds.js states. A batch that
     errors leaves those picks name-less, which is today's behaviour, rather than failing the import. */
const YAHOO_KEY_BATCH = 25;
export async function yahooPlayerNames(leagueKey, playerKeys, accessToken) {
  const keys = [...new Set((playerKeys || []).map((k) => String(k || '').trim()).filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < keys.length; i += YAHOO_KEY_BATCH) {
    const chunk = keys.slice(i, i + YAHOO_KEY_BATCH);
    let j = null;
    try {
      j = await yGet(`league/${leagueKey}/players;player_keys=${chunk.join(',')}`, accessToken);
    } catch { continue; }                    // this batch is nameless; the rest still resolve
    parsePlayerBag(j).forEach((v, k) => out.set(k, v));
  }
  return out;
}

/* The pure half, so it can be tested against a recorded Yahoo payload without a network call.
   ⚠ KEYED BOTH WAYS — by the full `nfl.p.12345` player_key and by the bare id — because `draftresults`
     hands back a key while a roster entry is read for its id, and one map serving both callers is how
     the two cannot disagree about who a player is. */
export function parsePlayerBag(json) {
  const out = new Map();
  const root = json?.fantasy_content?.league;
  const node = Array.isArray(root) ? root.find((x) => x && x.players) : (root && root.players ? root : null);
  const players = (node && node.players) || root?.[1]?.players || {};
  list(players).forEach((p) => {
    const b = bag(p);
    if (!b.player_key) return;
    /* Yahoo's name node is `{ full, first, last, ascii_first, ascii_last }`; `bag` flattens it, so
       `full` is already at the top level. The fallback is for a shape that only carries the parts. */
    const full = b.full || [b.first, b.last].filter(Boolean).join(' ') || null;
    if (!full) return;
    const rec = {
      name: full,
      pos: POS(b.display_position || b.primary_position) || null,
      team: b.editorial_team_abbr ? String(b.editorial_team_abbr).toUpperCase() : null,
    };
    out.set(String(b.player_key), rec);
    out.set(String(b.player_key).split('.').pop(), rec);
  });
  return out;
}

export async function yahooLeague(leagueKey, accessToken) {
  const key = String(leagueKey || '').trim();
  if (!key) { const e = new Error('A Yahoo league key is required.'); e.status = 400; throw e; }
  const [settingsJson, teamsJson, draftJson] = await Promise.all([
    yGet(`league/${key}/settings`, accessToken),
    yGet(`league/${key}/teams`, accessToken).catch(() => null),
    yGet(`league/${key}/draftresults`, accessToken).catch(() => null),
  ]);

  const lg = bag(settingsJson?.fantasy_content?.league || {});
  const st = bag(lg.settings || {});
  const teams = Number(lg.num_teams) || 12;

  const start = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DST: 0, FLEX: 0, SUPER: 0 };
  let bench = 0;
  list(st.roster_positions || {}).forEach((rp) => {
    /* ⚠ READ THE ROSTER POSITION DIRECTLY, NOT THROUGH bag(). `bag` deliberately swallows the key
       "count", because Yahoo uses it as the size marker on every collection — but a roster position's
       own `count` is the NUMBER OF THAT SLOT, which is the one field this loop exists to read. Going
       through the flattener returned 0 starters at every position and a zero-round draft. */
    const r = (rp && rp.roster_position) || bag(rp);
    const n = Number(r.count) || 0;
    const pos = String(r.position || '').toUpperCase();
    if (pos === 'BN' || pos === 'IR') { bench += n; return; }
    const p = POS(pos);
    if (p) start[p] += n;
    else if (/^W\/R\/T$|^W\/R$|^FLEX$/.test(pos)) start.FLEX += n;
    else if (/^Q\/W\/R\/T$|^SUPERFLEX$|^OP$/.test(pos)) start.SUPER += n;
  });

  // Points per reception, from the stat modifiers. Yahoo's "Rec" stat is stat_id 11.
  let rec = 0;
  list(bag(st.stat_modifiers || {}).stats || {}).forEach((s) => {
    const m = bag(s);
    if (String(m.stat_id) === '11') rec = Number(m.value) || 0;
  });

  const slotNames = {};
  const slotOfTeamKey = {};
  /* ⭐⭐⭐⭐⭐ WHICH OF THESE TWELVE IS HIS — b161, and `yourSlot` has been null since this was written.
     Yahoo marks the signed-in user's team with `is_owned_by_current_login: 1` in the teams collection,
     so the answer is already in a payload we were fetching and discarding. ⚠ WITHOUT IT EVERY
     IN-SEASON SCREEN IS DARK: "which roster is mine" is the question My Week, the matchup, the trade
     finder and the roster tab are all built on — the exact fault b132 documented for Sleeper, where a
     league you could see but that could not see YOU dropped silently out of every personalised view. */
  let yourSlot = null;
  let yourTeamKey = null;
  list(teamsJson?.fantasy_content?.league?.[1]?.teams || {}).forEach((t, i) => {
    const b = bag(t);
    if (!b.team_key) return;
    const slot = i + 1;
    slotOfTeamKey[b.team_key] = slot;
    slotNames[slot] = b.name || `Team ${slot}`;
    if (yourSlot == null && (Number(b.is_owned_by_current_login) === 1 || b.is_owned_by_current_login === '1')) {
      yourSlot = slot; yourTeamKey = b.team_key;
    }
  });

  const rawPicks = list(draftJson?.fantasy_content?.league?.[1]?.draft_results || {})
    .map((d) => bag(d))
    .filter((d) => d.player_key)
    .sort((a, b) => (Number(a.pick) || 0) - (Number(b.pick) || 0));
  /* ⭐ THE NAMES, IN BULK. Without this every pick is unresolvable in the draft room — see
     `yahooPlayerNames`. A lookup that fails leaves the name null, which is the old behaviour, rather
     than failing the whole import. */
  const names = rawPicks.length
    ? await yahooPlayerNames(key, rawPicks.map((d) => d.player_key), accessToken).catch(() => new Map())
    : new Map();
  const picks = rawPicks.map((d) => {
    const hit = names.get(String(d.player_key)) || null;
    return {
      overall: Number(d.pick) || null,
      round: Number(d.round) || null,
      slot: slotOfTeamKey[d.team_key] || null,
      player_id: String(d.player_key).split('.').pop(),
      name: hit ? hit.name : null,
      pos: hit ? hit.pos : null,
      team: hit ? hit.team : null,
      keeper: false,
    };
  });

  const cfg = {
    name: lg.name || `Yahoo league ${lg.league_id || ''}`.trim(),
    teams,
    rounds: Object.values(start).reduce((a, b) => a + b, 0) + bench,
    type: String(lg.league_type || '').toLowerCase() === 'keeper' ? 'keeper' : 'redraft',
    order: 'snake',
    sf: start.SUPER > 0,
    tePremMult: 0,
    start,
    scoring: { rec },
    caps: {}, keepers: [], pickTrades: [],
  };

  return {
    league_id: String(lg.league_id || key), league_key: key, name: cfg.name, platform: 'yahoo',
    cfg, teams,
    draftType: String(st.draft_type || '').toLowerCase() === 'auction' ? 'auction' : 'snake',
    status: String(lg.draft_status || '') === 'postdraft' ? 'complete' : picks.length ? 'drafting' : 'pre_draft',
    yourSlot, yourTeamKey,
    slotNames, slotOfTeamKey, tradedPicks: [], keepers: [], existingRosters: null,
    picks,
    /* ⚠ NO LIVE DRAFT. Yahoo's draft room is a separate real-time client with no public streaming or push
       endpoint; `draftresults` is a post-hoc resource and polling it during a live draft is neither
       supported nor reliable. Saying so here keeps the UI from promising a sync that does not exist. */
    liveSync: false,
    attribution: 'Fantasy data provided by Yahoo Fantasy.',
  };
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
   THE IN-SEASON SIDE — b161
   ───────────────────────────────────────────────────────────────────────────────────────────────────
   Trey: "I want to build Yahoo so that you can also get live roster recommendations, free agents, league
   trends, etc. like we have for the in-season view for Sleeper."

   ⭐⭐⭐⭐⭐ THE DESIGN DECISION IS THAT THERE IS NO YAHOO HUB. The in-season screens — My Week, the
     matchup, free agents, the trade finder, the league tab, the weekly review — are several thousand
     lines that have been corrected against Trey's screenshots for months, and every one of them reads
     ONE payload shape: the Sleeper team-hub's. So these functions exist to produce THAT SHAPE from
     Yahoo's data. A parallel Yahoo hub would be a second implementation of every screen and a second
     place for each of those fixes to be re-learned; the 29y one-number rule, applied to a whole product
     surface rather than to a number.

   ⚠⚠ WHICH MEANS THE HARD PART IS IDENTITY, NOT DATA. Every one of those screens is keyed by SLEEPER
     PLAYER ID, because that is what our projection pack is keyed by. Yahoo hands back its own ids and
     its own names. See lib/yahooIds.js for the bridge and why it prefers an id over a name.

   ⚠ THE FETCHES ARE SPLIT FROM THE PARSING on purpose. Yahoo's JSON is an array pretending to be an
     object (see `bag`), the shapes are undocumented, and this app cannot reach Yahoo from its test
     environment at all — so the parsers take a recorded payload and are tested against it, and the
     fetchers are three lines each with nothing in them to get wrong.
   ══════════════════════════════════════════════════════════════════════════════════════════════════ */

/* Every team's roster for a week, in ONE call. Yahoo allows `teams/roster` as a sub-resource, which is
   the difference between 1 request and 12 — and at 12 the rate limiter starts to matter on a Sunday. */
export async function yahooRosters(leagueKey, accessToken, week) {
  const wk = Number(week) > 0 ? `;week=${Number(week)}` : '';
  return parseRosters(await yGet(`league/${leagueKey}/teams/roster${wk}/players`, accessToken));
}
export async function yahooScoreboard(leagueKey, accessToken, week) {
  const wk = Number(week) > 0 ? `;week=${Number(week)}` : '';
  return parseScoreboard(await yGet(`league/${leagueKey}/scoreboard${wk}`, accessToken));
}
export async function yahooStandings(leagueKey, accessToken) {
  return parseStandings(await yGet(`league/${leagueKey}/standings`, accessToken));
}

/* One team's roster → { teamKey, teamName, slot?, isMine, players:[{yahooId,name,pos,team,slot,starting}] }
   ⚠ `selected_position` IS THE SLOT HE IS IN THIS WEEK, and "BN" / "IR" are slots like any other. A
     starter is anyone NOT in one of those, which is the same rule the Sleeper side applies to an empty
     slot: read the layout, do not guess from the position he plays. */
export function parseRosters(json) {
  const teams = list(json?.fantasy_content?.league?.[1]?.teams || json?.fantasy_content?.league?.teams || {});
  return teams.map((t) => {
    const b = bag(t);
    const players = list(bag(b.roster || {}).players || {}).map((p) => {
      const raw = Array.isArray(p && p.player) ? p.player : ((p && p.player) ? [p.player] : [p]);
      const pb = bag(raw);
      if (!pb.player_key) return null;
      /* ⚠⚠ READ `selected_position` OFF ITS OWN NODE, NOT THROUGH bag(). It is
         `[{coverage_type},{position}]`, so the flattener lifts a bare `position` to the top level where
         it sits beside `display_position` and `primary_position` — three fields with similar names, one
         of which means something completely different (the slot he is in this week versus the position
         he plays). Reading the flattened one made EVERY player a starter, because the slot was never
         "BN". Same trap as `roster_position.count` in yahooLeague, thirty lines up. */
      const spNode = raw.find((x) => x && x.selected_position);
      const sp = spNode ? bag(spNode.selected_position) : {};
      const slot = String(sp.position || '').toUpperCase() || null;
      return {
        yahooId: String(pb.player_key).split('.').pop(),
        playerKey: String(pb.player_key),
        name: pb.full || [pb.first, pb.last].filter(Boolean).join(' ') || null,
        pos: POS(pb.display_position || pb.primary_position) || null,
        team: pb.editorial_team_abbr ? String(pb.editorial_team_abbr).toUpperCase() : null,
        slot,
        starting: !!slot && slot !== 'BN' && slot !== 'IR',
        /* Yahoo's own injury designation, which is the one thing here our own feed cannot always beat:
           it is the league's view of the player, and it is what the manager sees in his own app. */
        status: pb.status || null,
      };
    }).filter(Boolean);
    return {
      teamKey: b.team_key || null,
      teamName: b.name || null,
      isMine: Number(b.is_owned_by_current_login) === 1 || b.is_owned_by_current_login === '1',
      players,
    };
  }).filter((t) => t.teamKey);
}

/* The week's matchups → [{ week, teams:[{teamKey, points, projected}] }].
   ⚠ `team_points` AND `team_projected_points` ARE DIFFERENT NODES with the same inner shape, and `bag`
     flattens both into one object — so the second silently overwrites the first. They are read off the
     raw team node instead, which is the whole reason this parser does not use `bag` for the points. */
export function parseScoreboard(json) {
  const lg = json?.fantasy_content?.league;
  const sb = (Array.isArray(lg) ? lg.find((x) => x && x.scoreboard) : lg?.scoreboard ? lg : null);
  const matchups = list(bag((sb && sb.scoreboard) || {}).matchups || {});
  return matchups.map((m) => {
    const mb = (m && m.matchup) || m;
    const teams = list(bag(mb || {}).teams || {}).map((t) => {
      const raw = Array.isArray(t?.team) ? t.team : (t?.team ? [t.team] : [t]);
      const b = bag(raw);
      const pts = raw.find((x) => x && x.team_points);
      const proj = raw.find((x) => x && x.team_projected_points);
      return {
        teamKey: b.team_key || null,
        teamName: b.name || null,
        points: pts && pts.team_points && pts.team_points.total != null ? Number(pts.team_points.total) : null,
        projected: proj && proj.team_projected_points && proj.team_projected_points.total != null
          ? Number(proj.team_projected_points.total) : null,
      };
    }).filter((x) => x.teamKey);
    const b = bag(mb || {});
    return { week: Number(b.week) || null, teams };
  }).filter((x) => x.teams.length);
}

/* Records and season points → [{ teamKey, teamName, wins, losses, ties, pointsFor, pointsAgainst, rank }] */
export function parseStandings(json) {
  const lg = json?.fantasy_content?.league;
  const node = Array.isArray(lg) ? lg.find((x) => x && x.standings) : (lg?.standings ? lg : null);
  const teams = list(bag((node && node.standings) || {}).teams || {});
  return teams.map((t) => {
    const raw = Array.isArray(t?.team) ? t.team : (t?.team ? [t.team] : [t]);
    const b = bag(raw);
    /* ⚠ `team_standings` CARRIES ITS OWN `rank` AND A NESTED `outcome_totals`. Flattening the whole team
       node would put the roster's `rank` (if any) and the standings `rank` in the same slot, so the
       standings node is located and read on its own. */
    const stNode = raw.find((x) => x && x.team_standings);
    const st = bag((stNode && stNode.team_standings) || {});
    return {
      teamKey: b.team_key || null,
      teamName: b.name || null,
      rank: Number(st.rank) || null,
      wins: Number(st.wins) || 0,
      losses: Number(st.losses) || 0,
      ties: Number(st.ties) || 0,
      pointsFor: st.points_for != null ? Number(st.points_for) : null,
      pointsAgainst: st.points_against != null ? Number(st.points_against) : null,
    };
  }).filter((x) => x.teamKey);
}
