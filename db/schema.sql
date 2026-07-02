-- Fantasy Draft Compass — database schema
-- Postgres. Implements the data-layer spec: canonical players, format-tagged ADP
-- observations + consensus, projections, depth charts, news, plus users/leagues/drafts.

-- ============================================================ PLAYERS (canonical identity)
-- The spine. Every external number resolves to one player_id before it is stored.
CREATE TABLE IF NOT EXISTS players (
  player_id      TEXT PRIMARY KEY,          -- our canonical id (we anchor on sleeper_id)
  sleeper_id     TEXT UNIQUE,
  espn_id        TEXT,
  yahoo_id       TEXT,
  rotowire_id    TEXT,
  sportradar_id  TEXT,
  gsis_id        TEXT,
  full_name      TEXT NOT NULL,
  norm_name      TEXT NOT NULL,             -- lowercased, punctuation-stripped, for matching
  team           TEXT,
  position       TEXT,                      -- QB/RB/WR/TE/K/DST/DL/LB/DB
  age            INT,
  years_exp      INT,
  bye_week       INT,
  injury_status  TEXT,
  news_updated   BIGINT,                    -- Sleeper's news_updated epoch ms (recency signal only)
  active         BOOLEAN DEFAULT TRUE,
  updated_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_players_norm ON players (norm_name, position);
CREATE INDEX IF NOT EXISTS idx_players_team ON players (team);

-- Cached player news/notes. We pull free injury + news from ESPN's public API (matched to our players
-- by espn_id) plus Sleeper's news_updated recency timestamp. Refreshed periodically, read at draft time.
CREATE TABLE IF NOT EXISTS player_news (
  player_id      TEXT PRIMARY KEY REFERENCES players(player_id) ON DELETE CASCADE,
  headline       TEXT,            -- short note headline
  body           TEXT,            -- the news blurb / outlook summary
  news_type      TEXT,            -- 'injury' | 'news' | 'note'
  source         TEXT,            -- 'espn' | 'sleeper'
  published_at   TIMESTAMPTZ,     -- when the news broke (from the source)
  updated_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_player_news_updated ON player_news (updated_at);

-- Unresolved external rows go here for review instead of being guessed into the engine.
CREATE TABLE IF NOT EXISTS player_resolution_queue (
  id         BIGSERIAL PRIMARY KEY,
  source     TEXT NOT NULL,
  raw_name   TEXT NOT NULL,
  raw_team   TEXT,
  raw_pos    TEXT,
  payload    JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================ ADP
-- Format key buckets every observation. Example: 'PPR|SF|TEP|DYNASTY|12'.
-- Raw observations from every source (your Sleeper harvest + external feeds).
CREATE TABLE IF NOT EXISTS adp_observations (
  id           BIGSERIAL PRIMARY KEY,
  player_id    TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  format_key   TEXT NOT NULL,
  season       INT NOT NULL,
  source       TEXT NOT NULL,               -- 'sleeper_harvest','fantasypros','yahoo',...
  source_type  TEXT,                        -- 'aggregated_drafts','expert_consensus','platform_adp'
  pick         NUMERIC NOT NULL,            -- the observed ADP/pick (single draft pick OR a source's ADP)
  weight       NUMERIC DEFAULT 1,           -- base source weight (before recency decay)
  observed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_adp_obs_lookup ON adp_observations (player_id, format_key, season, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_adp_obs_source ON adp_observations (source, observed_at);

-- Pre-computed consensus per (player, format, season). Recomputed by the refresh job.
CREATE TABLE IF NOT EXISTS adp_consensus (
  player_id    TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  format_key   TEXT NOT NULL,
  season       INT NOT NULL,
  consensus    NUMERIC NOT NULL,
  lo           NUMERIC,
  hi           NUMERIC,
  stdev        NUMERIC,
  sample_n     INT,
  trend        NUMERIC,                      -- change over the trailing window (negative = rising)
  sources      JSONB,                        -- [{source,value,weight,observed_at,stale}]
  computed_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (player_id, format_key, season)
);
CREATE INDEX IF NOT EXISTS idx_adp_consensus_fmt ON adp_consensus (format_key, season, consensus);

-- ============================================================ PROJECTIONS
-- Store RAW stat projections; the engine converts to points per league scoring.
CREATE TABLE IF NOT EXISTS projections (
  player_id   TEXT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  season      INT NOT NULL,
  source      TEXT NOT NULL,                 -- 'sleeper','espn',...
  stats       JSONB NOT NULL,                -- {passYd, passTD, rushYd, rec, solo, idpSack, ...}
  floor_pts   NUMERIC,
  ceil_pts    NUMERIC,
  updated_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (player_id, season, source)
);
CREATE INDEX IF NOT EXISTS idx_proj_season ON projections (season);

-- ============================================================ DEFENSE VS POSITION (matchup difficulty)
-- Season-to-date actual fantasy points ALLOWED by each NFL defense to each position, computed from weekly
-- actuals. Cached per (season, through_week) so we don't refetch every completed week on each hub load.
-- `table_json` holds the full computed structure: { [defTeam]: { QB:{rank,of,tier,allowed,pg}, RB:{...} } }.
CREATE TABLE IF NOT EXISTS def_vs_pos (
  season       INT NOT NULL,
  through_week INT NOT NULL,                    -- highest completed week included
  table_json   JSONB NOT NULL,
  updated_at   TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (season, through_week)
);

-- ============================================================ DISCOVERED USERS (harvest crawl frontier)
-- Persistent memory of every Sleeper user we've discovered while crawling the league graph. Lets the
-- nightly harvest keep reaching NEW leagues each run (breadth-first) instead of re-walking the same
-- cluster of seed users. `crawled_at` = when we last expanded this user's leagues; NULL = frontier.
CREATE TABLE IF NOT EXISTS discovered_users (
  user_id      TEXT PRIMARY KEY,
  display_name TEXT,
  source       TEXT,                          -- 'seed','connected','leaguemate'
  found_via    TEXT,                          -- league_id or user_id we discovered them through
  crawled_at   TIMESTAMPTZ,                   -- last time we expanded this user's leagues (NULL = not yet)
  drafts_found INT DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_discovered_uncrawled ON discovered_users (crawled_at NULLS FIRST, created_at);

-- ============================================================ DEPTH CHARTS
CREATE TABLE IF NOT EXISTS depth_charts (
  team        TEXT NOT NULL,
  position    TEXT NOT NULL,
  player_id   TEXT REFERENCES players(player_id) ON DELETE CASCADE,
  rank        INT NOT NULL,                  -- 1 = starter
  role        TEXT,                          -- 'starter','committee','backup'
  source      TEXT,
  updated_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (team, position, rank)
);

-- ============================================================ NEWS / TRENDS
CREATE TABLE IF NOT EXISTS news_items (
  id          BIGSERIAL PRIMARY KEY,
  player_id   TEXT REFERENCES players(player_id) ON DELETE SET NULL,
  kind        TEXT,                          -- 'injury','signing','depth_change','suspension'
  headline    TEXT NOT NULL,
  body        TEXT,
  source      TEXT,
  published_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_news_player ON news_items (player_id, published_at DESC);

-- ============================================================ USERS
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         CITEXT UNIQUE NOT NULL,       -- case-insensitive (requires citext extension)
  password_hash TEXT,
  is_admin      BOOLEAN DEFAULT FALSE,        -- SERVER-SIDE authority (set from ADMIN_EMAILS at signup)
  paid_until    TIMESTAMPTZ,                  -- season pass expiry; NULL = not paid
  comp          BOOLEAN DEFAULT FALSE,        -- comped subscription
  disabled      BOOLEAN DEFAULT FALSE,        -- admin can switch off access entirely
  rank_sets     JSONB DEFAULT '[]'::jsonb,    -- personal rankings (mirrors prototype)
  sleeper_user_id   TEXT,                      -- linked Sleeper account id (persists until unlinked)
  sleeper_username  TEXT,                      -- linked Sleeper display username (for showing who's linked)
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Feedback submitted from the site's contact form. Read in the admin inbox.
CREATE TABLE IF NOT EXISTS feedback (
  id          BIGSERIAL PRIMARY KEY,
  email       CITEXT,                          -- submitter email (may be null if not signed in)
  category    TEXT,                            -- bug | idea | question | other
  message     TEXT NOT NULL,
  status      TEXT DEFAULT 'new',              -- new | read | resolved
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Pre-granted free access for emails that may not have signed up yet. On signup, if the email has a
-- pending invite, the account is created already comped.
CREATE TABLE IF NOT EXISTS comp_invites (
  email       CITEXT PRIMARY KEY,
  scope       TEXT DEFAULT 'season',           -- season | forever
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ============================================================ LEAGUES + DRAFTS
CREATE TABLE IF NOT EXISTS leagues (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  cfg         JSONB NOT NULL,                 -- full league config (teams, scoring, slots, sf, te, ...)
  connect     JSONB,                          -- {platform, external_id} when synced
  draft_mode  TEXT,                           -- 'auto'|'manual'|'sleeper'|'espn'|...
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drafts (
  id          BIGSERIAL PRIMARY KEY,
  league_id   BIGINT NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                  -- 'official'|'mock'
  picks       JSONB DEFAULT '[]'::jsonb,      -- [player_id,...] in pick order
  preds       JSONB DEFAULT '[]'::jsonb,
  complete    BOOLEAN DEFAULT FALSE,
  ran_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_drafts_league ON drafts (league_id, ran_at DESC);

-- ============================================================ JOB BOOKKEEPING
CREATE TABLE IF NOT EXISTS job_runs (
  id          BIGSERIAL PRIMARY KEY,
  job         TEXT NOT NULL,
  ok          BOOLEAN,
  detail      JSONB,
  started_at  TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ
);

-- Track which Sleeper drafts we've already harvested so we never double-count.
CREATE TABLE IF NOT EXISTS harvested_drafts (
  draft_id     TEXT PRIMARY KEY,
  format_key   TEXT,
  season       INT,
  pick_count   INT,
  harvested_at TIMESTAMPTZ DEFAULT now()
);
-- ============================================================ PER-USER APP STATE
-- A single JSON blob per user mirroring the client's local "gs-state" (leagues, picks, preds,
-- priority queues, mocks, etc.). This makes a user's data follow them across devices and survive
-- sign-out, without re-architecting the client's local-first model. Last-write-wins by updated_at.
CREATE TABLE IF NOT EXISTS user_state (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ DEFAULT now()
);
