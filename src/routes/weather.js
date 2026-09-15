/* GET /api/weather/week?week=N[&season=YYYY]
 *
 * Trey: "It would also be cool if you could have a weather toggle as well. Flag players that could be a
 * concern (i.e. big snow storm... or lots of rain. If it's sunny, then you wouldn't list them. If they are in
 * a dome, don't list them. If it's light rain, don't list them)."
 *
 * Answers, for one NFL week, which GAMES have weather worth a manager's attention — never which players. The
 * caller already knows who it starts in fifteen leagues; joining a team abbreviation to a roster is its job
 * and doing it here would mean this route needed to know about leagues, which it does not.
 *
 * ⭐ THE FILTERING IS THE FEATURE, and most of it happens before a single forecast is fetched:
 *   • A DOME GAME IS NEVER FETCHED. Not fetched, not scored, not returned — the sky cannot reach it, so its
 *     forecast is not merely irrelevant, it is a wrong answer waiting to be rendered. Roughly a third of the
 *     league is indoors, so this is also most of the cost saving.
 *   • A GAME WITH NO KICKOFF TIME IS SKIPPED. A forecast is a forecast OF a moment; without the hour we would
 *     be reporting the weather at an arbitrary time of day and calling it the game's.
 *   • ONLY GAMES THAT CLEAR THE BAR COME BACK. `weatherConcern` returns null for anything short of it, and a
 *     null is dropped here rather than sent as "fine" — see venues.js for where the bar sits and why.
 * What is left is a short list, usually a handful of games, which is the only size at which a weather panel
 * is worth opening.
 *
 * ⚠ OPEN-METEO, AND WHY NOT A KEYED PROVIDER. It needs no API key, which means no secret to leak, rotate, or
 *   forget on a redeploy, and no per-request cost to reason about. It also takes latitude/longitude directly,
 *   which is what venues.js already has, and answers hour by hour so a 1pm kickoff and a 8:20pm kickoff at
 *   the same stadium get different answers — which they should.
 *
 * ⚠ FORECASTS BEYOND ABOUT A WEEK ARE NOT WORTH PRINTING. The API answers 16 days ahead and the answer for
 *   day 12 is climatology with a number on it. Past FORECAST_HORIZON_DAYS this returns the games with a flag
 *   saying the forecast is too far out rather than a confident-looking number nobody should act on.
 */
import express from 'express';
import { q } from '../lib/db.js';
import { getJson } from '../lib/shapes.js';
import { VENUES, weatherConcern } from '../lib/venues.js';
import { log } from '../lib/log.js';
import { config } from '../lib/config.js';

export const weatherRouter = express.Router();

const FORECAST_HORIZON_DAYS = 9;

/* WHICH GAMES ARE EVEN WORTH A FORECAST — everything the route decides BEFORE it touches the network.
 *
 * ⚠⚠ THIS IS A SEPARATE FUNCTION BECAUSE THE RULE IT CARRIES HAD NO REAL TEST. Inline in the route, the
 *   only things a test could reach were the VENUES table ("HOU is recorded as retractable") and a stub's
 *   hand-written response ("the fixture contains no roofed games") — and BOTH of those stay green when the
 *   filter itself is deleted. That is the unfailable-assertion failure this project has now produced five
 *   times, and the fix is the same one every time: put the decision somewhere a test can call it and hand
 *   it an input that must come back changed.
 *
 * ⭐⭐⭐⭐⭐ ANY ROOF AT ALL, NOT JUST A FIXED ONE — 29x, and this REVERSES a deliberate earlier call.
 *   Trey: "that one is in HOU and it says 'roof can close' — if it has a roof, they should just never hit
 *   the report."
 *
 *   The old rule treated retractable as open, reasoning that we cannot know whether they closed it and a
 *   missed snow game costs more than a flag you dismiss in a second. That argument is about the COST OF
 *   BEING WRONG; his is about whether the row is ACTIONABLE, and on this page his wins. A weather flag
 *   exists to change a lineup decision. "It might rain, unless they shut the roof, which they probably
 *   will, and we have no way to find out" changes nothing — it is a row you read, shrug at, and learn to
 *   skip, and rows like that are what stop anybody reading the ones that matter.
 * ⚠ THE COUNT STILL SEES THEM, so "12 games, 3 indoors" continues to add up and the omission is visible
 *   rather than silent.
 */
export function reportableGames(rows, { now = Date.now(), venues = VENUES, horizonDays = FORECAST_HORIZON_DAYS } = {}) {
  const candidates = [];
  let indoors = 0, noTime = 0, tooFar = 0, unknownVenue = 0;
  for (const g of rows || []) {
    const home = String((g && g.team) || '').toUpperCase();
    const v = venues[home];
    if (!v) { unknownVenue++; continue; }
    if (v.roof === 'dome' || v.roof === 'retractable') { indoors++; continue; }
    if (!g.kickoff) { noTime++; continue; }
    const kickIso = new Date(g.kickoff).toISOString();
    if ((new Date(kickIso).getTime() - now) / 86400000 > horizonDays) { tooFar++; continue; }
    candidates.push({ game: g, home, venue: v, kickIso });
  }
  return { candidates, counts: { indoors, noTime, tooFar, unknownVenue } };
}
const CACHE_TTL_MS = 30 * 60 * 1000;         // forecasts do not move fast enough to justify less
const cache = new Map();                      // key -> { at, value }

const mps2mph = (v) => (v == null ? null : v * 2.236936);
const c2f = (v) => (v == null ? null : v * 9 / 5 + 32);

/* One venue, one kickoff. Open-Meteo answers hourly; we take the three hours from kickoff, because that is
   the game, and a game is not a moment — rain that arrives in the fourth quarter still changed the game. */
async function forecastFor(lat, lon, kickoffIso) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}@${kickoffIso.slice(0, 13)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${lat}&longitude=${lon}`
    + '&hourly=temperature_2m,precipitation,rain,snowfall,wind_speed_10m,wind_gusts_10m'
    + '&wind_speed_unit=ms&temperature_unit=celsius&forecast_days=16&timezone=UTC';
  let j = null;
  try { j = await getJson(url, 9000); } catch (e) { log.error(e, 'weather: forecast fetch'); return null; }
  const h = j && j.hourly;
  if (!h || !Array.isArray(h.time)) return null;

  const start = new Date(kickoffIso).getTime();
  const idx = [];
  for (let i = 0; i < h.time.length; i++) {
    const t = new Date(`${h.time[i]}Z`).getTime();
    if (t >= start - 30 * 60 * 1000 && t <= start + 3 * 60 * 60 * 1000) idx.push(i);
  }
  if (!idx.length) return null;
  const at = (arr, i) => (Array.isArray(arr) && arr[i] != null ? Number(arr[i]) : 0);
  const sum = (arr) => idx.reduce((a, i) => a + at(arr, i), 0);
  const max = (arr) => idx.reduce((a, i) => Math.max(a, at(arr, i)), 0);
  const avg = (arr) => idx.reduce((a, i) => a + at(arr, i), 0) / idx.length;
  const value = {
    tempF: Math.round(c2f(avg(h.temperature_2m))),
    wind: Math.round(mps2mph(avg(h.wind_speed_10m))),
    windGust: Math.round(mps2mph(max(h.wind_gusts_10m))),
    rain: Math.round(sum(h.rain) * 10) / 10,          // mm across the game window
    snow: Math.round(sum(h.snowfall) * 10) / 10,      // cm across the game window
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}

weatherRouter.get('/week', async (req, res) => {
  const week = Number(req.query.week);
  /* ⚠ config.activeSeason, NOT the calendar year. Everything else in the app reads the season from config
     (playerPack, connect, playoff SOS), and getUTCFullYear() disagrees with it twice: whenever ACTIVE_SEASON
     is pinned, and every January, when the calendar rolls over and the NFL season does not — which is
     exactly when week 18 and the playoffs are being played in the snow. */
  const season = Number(req.query.season) || Number(config.activeSeason) || new Date().getUTCFullYear();
  if (!Number.isFinite(week) || week < 1 || week > 22) return res.status(400).json({ error: 'week is required (1-22)' });

  /* ⚠⚠ THREE WAYS TO HAVE NO WEATHER, AND THEY NEEDED THREE DIFFERENT ANSWERS.
     Trey, on the live site: "weather, it's just no forecast yet. The NFL schedule hasn't been loaded."
     That message was this route's catch-all, and it was wrong in the way that costs the most time: it named
     a cause. The schedule WAS loaded — playoff SOS reads the same table happily — but `kickoff` is a column
     this feature added, and it only comes into existence when syncSchedule next runs. So the SELECT threw
     on a missing column, the catch printed "the schedule hasn't been loaded", and the true fix ("run the
     schedule job once") was the one thing the message ruled out.
     Now the three states are distinguished and each says what to do about it:
       no table / no rows  → the schedule genuinely has not been synced
       no kickoff column   → the schedule is there, this feature's column is not, run the job once
       rows but no times   → the schedule is there with no kickoff times, same job, same fix
     ⚠ AND IT FALLS BACK RATHER THAN FAILING. If `kickoff` is missing we re-read without it, so the route
       still reports the week's games and the counts; it simply cannot forecast them. A feature that
       degrades to "here is what I know and here is what I am missing" is worth ten that go dark. */
  let rows = [];
  let noKickoffColumn = false;
  const readRows = async (withKickoff) => (await q(
    `SELECT team, opponent, home${withKickoff ? ', kickoff' : ''} FROM nfl_schedule
      WHERE season=$1 AND week=$2 AND home = true`, [season, week])).rows || [];
  try {
    rows = await readRows(true);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/kickoff/i.test(msg)) {
      noKickoffColumn = true;
      try { rows = await readRows(false); } catch (e2) { log.error(e2, 'weather: schedule read (no kickoff)'); rows = []; }
    } else {
      log.error(e, 'weather: schedule read');
      return res.json({ week, season, games: [], unavailable: 'schedule',
        note: `The NFL schedule isn't in the database yet for ${season}. Run Update schedule from the admin panel, or wait for the nightly refresh.` });
    }
  }
  if (!rows.length) return res.json({ week, season, games: [], unavailable: 'schedule',
    note: `No week ${week} games on file for ${season}. Run Update schedule from the admin panel.` });
  if (noKickoffColumn) return res.json({ week, season, games: [], unavailable: 'kickoff',
    counts: { games: rows.length, indoors: 0, noKickoff: rows.length, beyondForecast: 0, checked: 0, flagged: 0 },
    note: `The ${season} schedule is loaded, but it has no kickoff times yet — a forecast needs the hour the game is played. Run Update schedule once and this fills in.` });

  const now = Date.now();
  const out = [];
  const { candidates, counts: preCounts } = reportableGames(rows, { now });
  let { indoors, noTime, tooFar } = preCounts;
  let checked = 0;

  for (const { game: g, home, venue: v, kickIso } of candidates) {
    checked++;
    const w = await forecastFor(v.lat, v.lon, kickIso);
    if (!w) continue;
    const concern = weatherConcern(w);
    if (!concern) continue;                       // sunny, or light rain — exactly what he asked us not to list
    out.push({
      home, away: String(g.opponent || '').toUpperCase(), kickoff: kickIso,
      /* `roof` is always 'open' here now, and is kept because the venue name reads better with it and a
         future rule (a cold-weather open stadium, say) will want it. There is NO `mayClose` any more: the
         only value it could ever have carried was `true`, on games this function no longer returns. */
      venue: v.name, roof: v.roof,
      severity: concern.severity, label: concern.label, text: concern.text,
      temp: w.tempF, wind: w.wind, gust: w.windGust, rain: w.rain, snow: w.snow,
      teams: [home, String(g.opponent || '').toUpperCase()],
    });
  }
  out.sort((a, b) => b.severity - a.severity || new Date(a.kickoff) - new Date(b.kickoff));
  res.json({ week, season, games: out,
    counts: { games: rows.length, indoors, noKickoff: noTime, beyondForecast: tooFar, checked, flagged: out.length },
    horizonDays: FORECAST_HORIZON_DAYS });
});
