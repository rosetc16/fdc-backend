# Fantasy Draft Compass — Backend

The API + data-aggregation layer for Fantasy Draft Compass. Node (ESM) + Express 5 + Postgres.

You do **not** need to be a developer to deploy this — see the step-by-step in the repo's
`LAUNCH-PLAYBOOK.md`. This README is the technical reference.

## What it does
- **Auth** — email/password accounts, JWT tokens. Admin is decided server-side from an allowlist.
- **Payments** — Stripe Checkout for the season pass; a webhook marks users paid.
- **Data layer** — builds your own format-tagged ADP from real Sleeper drafts, syncs projections
  and players from Sleeper, and computes a recency-weighted ADP consensus daily.
- **Read APIs** — ADP board + per-source breakdown, projections, leagues/drafts.

## Requirements
- Node 20+
- A Postgres database
- (For payments) a Stripe account

## Quick start (local)
```bash
cp .env.example .env        # then fill in DATABASE_URL, JWT_SECRET, etc.
npm install
npm run migrate             # creates all tables (needs the citext extension; migrate enables it)
npm run refresh             # pulls players + projections + harvests drafts + builds ADP consensus
npm start                   # starts the API on PORT (default 8080)
```

## Environment variables
See `.env.example`. The important ones:
- `DATABASE_URL` — Postgres connection string
- `JWT_SECRET` — any long random string
- `ADMIN_EMAILS` — comma-separated admin emails (server-side authority)
- `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` — payments
- `ACTIVE_SEASON` — current NFL season (the refresh jobs use this)
- `HARVEST_SEED_USERS` — comma-separated Sleeper usernames to bootstrap draft discovery before
  you have connected users (the harvester finds drafts via these users)

## The data jobs (how live data stays fresh)
Run order matters; `refreshAll` does them in sequence:
1. `npm run -s harvest` is part of it, but individually:
   - `node src/jobs/syncPlayers.js` — canonical players from Sleeper (identity spine)
   - `node src/jobs/syncProjections.js` — season projections from Sleeper
   - `node src/jobs/harvestSleeperDrafts.js` — turn real drafts into ADP observations
   - `node src/jobs/refreshConsensus.js` — recompute the weighted ADP consensus
2. Or all at once: `npm run refresh` (= `node src/jobs/refreshAll.js`)

**Scheduling:** the server has a built-in daily cron (4:15am) for single-instance hosting. On
Render/Railway, prefer their managed **Cron Jobs** pointing at `npm run refresh`, and set
`DISABLE_INPROCESS_CRON=1` so it doesn't double-run.

## Deploy on Render (managed, no-server-admin path)
1. **Postgres:** New → Postgres. Copy its Internal Connection String → `DATABASE_URL`.
2. **Web Service:** New → Web Service from this repo. Build: `npm install`. Start: `npm start`.
   Add all env vars. After first deploy, open a Shell and run `npm run migrate` once.
3. **Cron Job:** New → Cron Job, command `npm run refresh`, schedule `15 4 * * *` (daily).
   Set `DISABLE_INPROCESS_CRON=1` on the web service.
4. **Stripe webhook:** add endpoint `https://YOUR-API/api/payments/webhook`, paste its signing
   secret into `STRIPE_WEBHOOK_SECRET`, redeploy.

## API surface (for the front-end)
```
POST /api/auth/signup            {email,password} -> {token,user}
POST /api/auth/signin            {email,password} -> {token,user}
GET  /api/auth/me                (Bearer)         -> {user}

GET  /api/adp/board?format=..&season=..           -> {players:[{player_id,consensus,trend,...}]}
GET  /api/adp/player/:id?format=..&season=..       -> {consensus,lo,hi,trend,sources:[...]}
GET  /api/projections?season=..                    -> {players:[{player_id,stats,...}]}

GET    /api/leagues              (Bearer)
POST   /api/leagues              (Bearer) {name,cfg,connect?,draftMode?}
PATCH  /api/leagues/:id          (Bearer)
DELETE /api/leagues/:id          (Bearer)
GET    /api/leagues/:id/drafts   (Bearer)
POST   /api/leagues/:id/drafts   (Bearer) {kind,picks,preds,complete}

POST /api/payments/checkout      (Bearer) -> {url}   (redirect user to Stripe)
POST /api/payments/webhook       (Stripe only; raw body)

POST /api/admin/comp             (Admin) {email,scope}
POST /api/admin/revoke-comp      (Admin) {email}
GET  /api/admin/jobs             (Admin) -> recent data-job runs
GET  /api/admin/health           (Admin) -> row counts (players, adp, projections, drafts)

GET  /api/health                 -> {ok,season,env}
```

## Format keys
ADP is bucketed by `SCORING|QB|TE|POOL|TEAMS`, e.g. `PPR|SF|TEP|DYNASTY|12`. The same derivation
runs on the front-end engine and here, so the numbers line up. Thin formats fall back to a richer
profile automatically (see `src/lib/formatKey.js`).

## Honest notes
- **Sleeper is read-only** and free; it's the stable backbone. It has no "ADP endpoint" — we build
  ADP ourselves from real drafts (the harvester). This is the durable, low-maintenance core.
- **Adding scraped sources** (ESPN/Yahoo/CBS pages) is optional and higher-maintenance; add later
  via new entries that write `adp_observations` with their own `source`/`weight`. The blender and
  read APIs need no changes.
- **Admin is enforced server-side** here — the front-end gate is only UX.
- **Calibration:** the blend constants in `src/lib/adpConsensus.js` (`BLEND`) are sensible defaults;
  tune them against real data once it's flowing.
```
