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
  if (!res.ok) { const e = new Error(`Yahoo returned ${res.status}.`); e.status = 502; throw e; }
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
  list(teamsJson?.fantasy_content?.league?.[1]?.teams || {}).forEach((t, i) => {
    const b = bag(t);
    if (!b.team_key) return;
    const slot = i + 1;
    slotOfTeamKey[b.team_key] = slot;
    slotNames[slot] = b.name || `Team ${slot}`;
  });

  const picks = list(draftJson?.fantasy_content?.league?.[1]?.draft_results || {})
    .map((d) => bag(d))
    .filter((d) => d.player_key)
    .sort((a, b) => (Number(a.pick) || 0) - (Number(b.pick) || 0))
    .map((d) => ({
      overall: Number(d.pick) || null,
      round: Number(d.round) || null,
      slot: slotOfTeamKey[d.team_key] || null,
      player_id: String(d.player_key).split('.').pop(),
      name: null,
      keeper: false,
    }));

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
    yourSlot: null,
    slotNames, tradedPicks: [], keepers: [], existingRosters: null,
    picks,
    /* ⚠ NO LIVE DRAFT. Yahoo's draft room is a separate real-time client with no public streaming or push
       endpoint; `draftresults` is a post-hoc resource and polling it during a live draft is neither
       supported nor reliable. Saying so here keeps the UI from promising a sync that does not exist. */
    liveSync: false,
    attribution: 'Fantasy data provided by Yahoo Fantasy.',
  };
}
