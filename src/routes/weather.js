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
  let indoors = 0, noTime = 0, tooFar = 0, checked = 0;

  for (const g of rows) {
    const home = String(g.team || '').toUpperCase();
    const v = VENUES[home];
    if (!v) continue;
    // Dome: the answer is "it does not matter", and that answer belongs in the counts, not the list.
    if (v.roof === 'dome') { indoors++; continue; }
    if (!g.kickoff) { noTime++; continue; }
    const kickIso = new Date(g.kickoff).toISOString();
    const days = (new Date(kickIso).getTime() - now) / 86400000;
    if (days > FORECAST_HORIZON_DAYS) { tooFar++; continue; }

    checked++;
    const w = await forecastFor(v.lat, v.lon, kickIso);
    if (!w) continue;
    const concern = weatherConcern(w);
    if (!concern) continue;                       // sunny, or light rain — exactly what he asked us not to list
    out.push({
      home, away: String(g.opponent || '').toUpperCase(), kickoff: kickIso,
      venue: v.name, roof: v.roof,
      // A retractable roof is treated as open (we cannot know the call), and says so, so the read is honest.
      mayClose: v.roof === 'retractable',
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
