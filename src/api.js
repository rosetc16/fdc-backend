// Backend API client. Points at the fdc-backend you deployed.
//
// Set VITE_API_URL (e.g. https://fdc-backend.onrender.com) in your environment / Render settings.
// If it's NOT set, the app runs in LOCAL mode: accounts/payments are simulated and data comes from
// the built-in engine. This means the site always works even before the backend is connected —
// connecting the backend is a pure upgrade, not a requirement to launch.

const API = import.meta.env.VITE_API_URL || '';
export const hasBackend = !!API;

const TOKEN_KEY = 'fdc:token';
// Remembers the server's most-recent state updated_at, used for optimistic-concurrency on writes.
let _lastStateUpdatedAt = null;
export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = (t) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} };

// `timeoutMs`   — override the per-attempt timeout. Long admin jobs (harvest, full refresh) run SYNCHRONOUSLY
//                 on the server and can take minutes; the default 45s ceiling aborts them client-side long
//                 before they finish, which surfaces as a bogus "BACKEND_WAKING" even though the job is fine.
// `retries`     — set to 0 for anything NON-IDEMPOTENT. Aborting a fetch does NOT cancel the server, so a
//                 retry can stack a second harvest/refresh on top of the first one that's still running.
async function call(path, { method = 'GET', body, auth = true, retries = 2, timeoutMs } = {}) {
  if (!API) throw new Error('NO_BACKEND');
  const headers = { 'Content-Type': 'application/json' };
  const token = auth ? getToken() : null;
  if (token) headers.Authorization = `Bearer ${token}`;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      // Render free/starter dynos can cold-start slowly; give the FIRST attempt a long leash (45s) so a
      // waking server isn't reported as a hard failure, then shorter timeouts on retries. A caller-supplied
      // timeoutMs wins outright, and applies to EVERY attempt (a retry that's shorter than a cold start is
      // guaranteed to fail, which is exactly what made long jobs look permanently broken).
      const perAttempt = timeoutMs != null ? timeoutMs : (attempt === 0 ? 45000 : 20000);
      const to = setTimeout(() => ctrl.abort(), perAttempt);
      let res;
      try {
        res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
      } finally { clearTimeout(to); }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 5xx from a still-booting backend is worth a retry; 4xx (bad credentials etc.) is not.
        if (res.status >= 500 && attempt < retries) { lastErr = Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data }); await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
        throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
      }
      return data;
    } catch (e) {
      // Network-level failure ("Failed to fetch") or timeout (AbortError) — the backend is likely cold-starting
      // or briefly unreachable. Retry with backoff before giving up so users aren't locked out by a cold dyno.
      const transient = e.name === 'AbortError' || e.message === 'Failed to fetch' || /NetworkError|network|fetch/i.test(e.message || '');
      if (transient && attempt < retries) { lastErr = e; await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
      if (transient) throw new Error('BACKEND_WAKING');
      throw e;
    }
  }
  throw lastErr || new Error('BACKEND_WAKING');
}

export const api = {
  hasBackend,

  // Wake a sleeping Render dyno before issuing a slow request.
  //
  // The Starter tier sleeps when idle and takes ~10-40s to boot. A long admin job fired at a cold backend
  // spends its whole timeout budget just waiting for the server to exist, then aborts — surfacing as
  // "BACKEND_WAKING" even though nothing is actually wrong. Pinging the cheap, rate-limit-exempt /api/health
  // first separates the two concerns: we wait for the server to come up, THEN start the job with a full,
  // uninterrupted timeout budget. Returns true once the backend answers.
  async wake({ maxWaitMs = 90000, onTick } = {}) {
    if (!API) return false;
    const started = Date.now();
    let tries = 0;
    while (Date.now() - started < maxWaitMs) {
      tries++;
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 10000);
        try {
          const res = await fetch(`${API}/api/health`, { signal: ctrl.signal });
          if (res.ok) return true;
        } finally { clearTimeout(to); }
      } catch { /* still booting */ }
      if (onTick) onTick(Math.round((Date.now() - started) / 1000), tries);
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  },

  // ---- auth ----
  async signup(email, password) {
    const r = await call('/api/auth/signup', { method: 'POST', auth: false, body: { email, password } });
    setToken(r.token); return r.user;
  },
  async signin(email, password) {
    const r = await call('/api/auth/signin', { method: 'POST', auth: false, body: { email, password } });
    setToken(r.token); return r.user;
  },
  async me() {
    if (!getToken()) return null;
    const r = await call('/api/auth/me'); return r.user;
  },
  async saveRankSets(rankSets) {
    const r = await call('/api/auth/rank-sets', { method: 'POST', body: { rankSets } });
    return r.user;
  },
  signout() { setToken(null); },

  // ---- payments ----
  async startCheckout() {
    const r = await call('/api/payments/checkout', {
      method: 'POST',
      body: { successUrl: `${location.origin}/?paid=1`, cancelUrl: `${location.origin}/?canceled=1` },
    });
    return r.url; // caller redirects to Stripe
  },

  // ---- data ----
  async adpBoard(format, season) {
    return call(`/api/adp/board?format=${encodeURIComponent(format)}${season ? `&season=${season}` : ''}`, { auth: false });
  },
  async adpPlayer(playerId, format, season) {
    return call(`/api/adp/player/${playerId}?format=${encodeURIComponent(format)}${season ? `&season=${season}` : ''}`, { auth: false });
  },
  // Aggregated draft trends from the harvested-drafts pool (thousands of real Sleeper drafts).
  async trendsBoard(format, season, opts = {}) {
    const extra = [];
    if (season) extra.push(`season=${season}`);
    if (opts.limit) extra.push(`limit=${opts.limit}`);
    if (opts.minDrafts != null) extra.push(`minDrafts=${opts.minDrafts}`);
    if (opts.minPicks != null) extra.push(`minPicks=${opts.minPicks}`);
    return call(`/api/trends/board?format=${encodeURIComponent(format)}${extra.length ? `&${extra.join('&')}` : ''}`, { auth: false });
  },
  async trendsPlayer(playerId, format, season, teams) {
    const extra = [];
    if (season) extra.push(`season=${season}`);
    if (teams) extra.push(`teams=${teams}`);
    return call(`/api/trends/player/${playerId}?format=${encodeURIComponent(format)}${extra.length ? `&${extra.join('&')}` : ''}`, { auth: false });
  },
  async trendsDiag(season) {
    return call(`/api/trends/diag${season ? `?season=${season}` : ''}`, { auth: false });
  },
  async projections(season) {
    return call(`/api/projections${season ? `?season=${season}` : ''}`, { auth: false });
  },
  async playerPack(format, season, opts = {}) {
    const extra = [];
    if (season) extra.push(`season=${season}`);
    if (opts.k) extra.push("k=1");
    if (opts.dst) extra.push("dst=1");
    if (opts.idp) extra.push("idp=1");
    return call(`/api/player-pack?format=${encodeURIComponent(format)}${extra.length ? "&" + extra.join("&") : ""}`, { auth: false });
  },

  // ---- leagues / drafts ----
  async listLeagues() { return (await call('/api/leagues')).leagues; },
  async createLeague(payload) { return (await call('/api/leagues', { method: 'POST', body: payload })).league; },
  async updateLeague(id, patch) { return (await call(`/api/leagues/${id}`, { method: 'PATCH', body: patch })).league; },
  async deleteLeague(id) { return call(`/api/leagues/${id}`, { method: 'DELETE' }); },
  async saveDraft(leagueId, draft) { return (await call(`/api/leagues/${leagueId}/drafts`, { method: 'POST', body: draft })).draft; },

  // ---- per-user app state (cross-device persistence of the local gs-state blob) ----
  // We remember the updated_at we last saw from the server and send it as baseUpdatedAt on write, so the
  // server can reject a stale overwrite (409) instead of silently clobbering newer data from another device.
  async getState() {
    const r = await call('/api/state');
    if (r && r.updatedAt) _lastStateUpdatedAt = r.updatedAt;
    return r;
  },
  async putState(state) {
    try {
      const r = await call('/api/state', { method: 'PUT', body: { state, baseUpdatedAt: _lastStateUpdatedAt } });
      if (r && r.updatedAt) _lastStateUpdatedAt = r.updatedAt;
      return r;
    } catch (e) {
      // 409 = the server has newer data (another device saved). Return the server's state + updatedAt so the
      // caller can merge and re-save, rather than losing the newer copy.
      if (e && e.status === 409 && e.data) {
        if (e.data.serverUpdatedAt) _lastStateUpdatedAt = e.data.serverUpdatedAt;
        return { ok: false, conflict: true, state: e.data.state || {}, updatedAt: e.data.serverUpdatedAt || null };
      }
      throw e;
    }
  },

  // ---- Sleeper connect / live sync ----
  async sleeperLeagues(username) { return call(`/api/connect/sleeper/leagues?username=${encodeURIComponent(username)}`); },
  async sleeperDraft(leagueId, username) { return call(`/api/connect/sleeper/draft?league_id=${encodeURIComponent(leagueId)}${username ? `&username=${encodeURIComponent(username)}` : ''}`); },
  // Fast picks-only poll for live drafts — much lighter than sleeperDraft (picks + clock only). Pass draftId
  // after the first call to skip the league→draft lookup for the quickest possible round-trip.
  async sleeperPicks(leagueId, draftId) { return call(`/api/connect/sleeper/picks?league_id=${encodeURIComponent(leagueId)}${draftId ? `&draft_id=${encodeURIComponent(draftId)}` : ''}`); },
  // ---- persistent Sleeper account link ----
  async sleeperAccount() { return call('/api/connect/sleeper/account'); },                          // -> { linked, sleeperUserId, sleeperUsername }
  async sleeperLink(username) { return call('/api/connect/sleeper/link', { method: 'POST', body: { username } }); },
  async sleeperUnlink() { return call('/api/connect/sleeper/unlink', { method: 'POST' }); },
  async sleeperMyLeagues(season) { return call(`/api/connect/sleeper/my-leagues${season ? `?season=${season}` : ''}`); },
  async sleeperTeamHub(leagueId, week) { return call(`/api/connect/sleeper/team-hub?league_id=${encodeURIComponent(leagueId)}${week ? `&week=${week}` : ''}`); },
  // Dynasty draft archive: every draft in the league's season chain (startup + each rookie draft), and
  // the finished board of any one of them.
  async sleeperDraftHistory(leagueId) { return call(`/api/connect/sleeper/draft-history?league_id=${encodeURIComponent(leagueId)}`); },
  async sleeperDraftBoard(draftId) { return call(`/api/connect/sleeper/draft-board?draft_id=${encodeURIComponent(draftId)}`); },

  // ---- feedback (public submit) ----
  async submitFeedback(payload) { return call('/api/feedback', { method: 'POST', auth: false, body: payload }); },

  // ---- admin: users ----
  async adminUsers(search) { return call(`/api/admin/users${search ? `?search=${encodeURIComponent(search)}` : ''}`); },
  async adminSetDisabled(email, disabled) { return call('/api/admin/set-disabled', { method: 'POST', body: { email, disabled } }); },
  async adminRevokeComp(email) { return call('/api/admin/revoke-comp', { method: 'POST', body: { email } }); },
  // Admin data jobs run SYNCHRONOUSLY on the server and can take minutes (a full refresh re-crawls real
  // drafts). Two things matter here:
  //   • a long timeout, or the client aborts a job that's working fine
  //   • retries: 0 — a client abort does NOT cancel the server, so retrying stacks a second harvest on top
  //     of the one still running, hammering the DB and duplicating work
  async adminRunJob(job) {
    return call('/api/admin/run-job', { method: 'POST', body: { job }, timeoutMs: 300000, retries: 0 });
  },
  async adminDbSize() { return call('/api/admin/db-size', { timeoutMs: 60000, retries: 0 }); },
  async adminDbCleanup(keepDays) { return call('/api/admin/db-cleanup', { method: 'POST', body: { keepDays }, timeoutMs: 600000, retries: 0 }); },

  // ---- Manual rankings (uploaded expert/consensus rankings, e.g. FantasyPros CSV) ----
  async adminManualRankings() { return call('/api/admin/manual-rankings'); },
  async adminUploadRanking(body) { return call('/api/admin/manual-rankings', { method: 'POST', body, timeoutMs: 120000, retries: 0 }); },
  async adminDeleteRanking(id) { return call(`/api/admin/manual-rankings/${id}`, { method: 'DELETE' }); },
  // ---- admin: invites ----
  async adminInvite(email, scope) { return call('/api/admin/invite', { method: 'POST', body: { email, scope } }); },
  async adminInvites() { return call('/api/admin/invites'); },
  async adminCancelInvite(email) { return call('/api/admin/cancel-invite', { method: 'POST', body: { email } }); },
  // ---- admin: feedback inbox ----
  async adminFeedback() { return call('/api/admin/feedback'); },
  async adminFeedbackStatus(id, status) { return call(`/api/admin/feedback/${id}/status`, { method: 'POST', body: { status } }); },

  // ---- Player events (dated value-changing news that stales out pre-event ADP samples) ----
  async adminEventTypes() { return call('/api/admin/event-types'); },
  async adminPlayerSearch(term) { return call(`/api/admin/player-search?q=${encodeURIComponent(term)}`); },
  async adminEvents() { return call('/api/admin/events'); },
  async adminAddEvent(body) { return call('/api/admin/events', { method: 'POST', body }); },
  async adminDeleteEvent(id) { return call(`/api/admin/events/${id}`, { method: 'DELETE' }); },
};
