// JOB: pull free player news + injury notes from ESPN's public (unofficial) API and cache them in
// player_news, matched to our players by espn_id (which Sleeper already gives us). This is best-effort:
// ESPN is unofficial and can change or rate-limit, so every fetch is wrapped and failures are swallowed
// — the draft UI simply omits the news line when we have nothing. We NEVER block a draft on this.
//
// Sources (all free, no key):
//   - League news feed:        https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50
//   - Per-athlete news:        .../nfl/athletes/{espnId}/news?limit=3   (used for top-of-board players)
//   - Team injuries (core API): https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/teams/{id}/injuries
//
// We keep this lightweight: the league feed + a bounded set of per-athlete pulls for the most relevant
// players (those with an espn_id and a projection), so we stay well under any rate limits.

import { q } from '../lib/db.js';
import { log } from '../lib/log.js';
import { recordJob } from '../lib/jobs.js';

const NEWS_FEED = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50';
const ATHLETE_NEWS = (espnId) => `https://site.api.espn.com/apis/site/v2/sports/football/nfl/athletes/${espnId}/news?limit=2`;

async function getJson(url, ms = 7000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function shorten(text, n = 280) {
  if (!text) return null;
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n - 1).trimEnd() + '…' : clean;
}

// Extract the athlete espn ids that a news article references (ESPN tags them in `categories`).
function athleteIdsFrom(article) {
  const ids = new Set();
  for (const c of (article.categories || [])) {
    if (c && (c.type === 'athlete' || c.athleteId) && (c.athleteId || (c.athlete && c.athlete.id))) {
      ids.add(String(c.athleteId || c.athlete.id));
    }
  }
  return [...ids];
}

export async function syncPlayerNews() {
  const started = Date.now();
  let wrote = 0;

  // Map espn_id -> player_id for players we care about (have an espn_id).
  const { rows: pls } = await q(
    `SELECT player_id, espn_id FROM players WHERE espn_id IS NOT NULL AND espn_id <> ''`
  );
  const byEspn = new Map(pls.map((r) => [String(r.espn_id), r.player_id]));
  if (!byEspn.size) {
    await recordJob('syncPlayerNews', true, { skipped: 'no espn_ids', ms: Date.now() - started });
    return { wrote: 0 };
  }

  const upserts = [];

  // 1) League-wide news feed — tags athletes, so we can attribute blurbs to specific players.
  const feed = await getJson(NEWS_FEED);
  if (feed && Array.isArray(feed.articles)) {
    for (const a of feed.articles) {
      const headline = a.headline || a.title || null;
      const body = a.description || (a.story ? a.story.replace(/<[^>]+>/g, ' ') : null);
      const when = a.published || a.lastModified || null;
      for (const espnId of athleteIdsFrom(a)) {
        const pid = byEspn.get(espnId);
        if (!pid) continue;
        upserts.push({ pid, headline: shorten(headline, 160), body: shorten(body, 320), type: 'news', source: 'espn', when });
      }
    }
  }

  // 2) Per-athlete news for the most relevant players that didn't get a league-feed hit. We bound this
  // to keep request volume sane (top ~120 by projection). The playerPack route already knows projection
  // relevance; here we approximate via players that have a projection row this season.
  const covered = new Set(upserts.map((u) => u.pid));
  const { rows: relevant } = await q(
    `SELECT p.player_id, p.espn_id
       FROM players p
       JOIN projections pr ON pr.player_id = p.player_id
      WHERE p.espn_id IS NOT NULL AND p.espn_id <> ''
        AND p.position IN ('QB','RB','WR','TE')
      ORDER BY pr.season DESC
      LIMIT 140`
  );
  let pulls = 0;
  for (const r of relevant) {
    if (covered.has(r.player_id)) continue;
    if (pulls >= 120) break; // hard cap on per-athlete calls
    pulls++;
    const j = await getJson(ATHLETE_NEWS(r.espn_id));
    const art = j && Array.isArray(j.articles) && j.articles[0];
    if (art) {
      const headline = art.headline || art.title || null;
      const body = art.description || (art.story ? art.story.replace(/<[^>]+>/g, ' ') : null);
      upserts.push({ pid: r.player_id, headline: shorten(headline, 160), body: shorten(body, 320), type: 'news', source: 'espn', when: art.published || art.lastModified || null });
    }
  }

  // Write everything (latest wins per player). Keep only the freshest note per player.
  const latest = new Map();
  for (const u of upserts) {
    const prev = latest.get(u.pid);
    const ut = u.when ? Date.parse(u.when) : 0;
    if (!prev || ut >= (prev.when ? Date.parse(prev.when) : 0)) latest.set(u.pid, u);
  }
  for (const u of latest.values()) {
    if (!u.headline && !u.body) continue;
    await q(
      `INSERT INTO player_news (player_id, headline, body, news_type, source, published_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (player_id) DO UPDATE SET
         headline=EXCLUDED.headline, body=EXCLUDED.body, news_type=EXCLUDED.news_type,
         source=EXCLUDED.source, published_at=EXCLUDED.published_at, updated_at=now()`,
      [u.pid, u.headline, u.body, u.type, u.source, u.when ? new Date(u.when) : null]
    );
    wrote++;
  }

  const detail = { wrote, feedArticles: feed && feed.articles ? feed.articles.length : 0, athletePulls: pulls, ms: Date.now() - started };
  log.info(detail, 'syncPlayerNews done');
  await recordJob('syncPlayerNews', true, detail);
  return detail;
}
