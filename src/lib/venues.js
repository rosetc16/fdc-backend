/* WHERE EACH TEAM PLAYS, AND WHETHER THE SKY CAN REACH IT.
 *
 * Trey: "It would also be cool if you could have a weather toggle as well. Flag players that could be a
 * concern (i.e. big snow storm... or lots of rain. If it's sunny, then you wouldn't list them. If they are
 * in a dome, don't list them. If it's light rain, don't list them)."
 *
 * The roof column is the most important thing in this file and the reason it exists as data rather than as a
 * lookup somewhere else: a third of the league plays indoors, and a weather feature that lists a dome game
 * because it is raining in Detroit is worse than no weather feature — it teaches you to ignore the whole
 * panel. `roof` is one of:
 *   dome        — permanently enclosed. Conditions are irrelevant, always. Never flagged.
 *   retractable — enclosed when they choose. Treated as OPEN, because we cannot know the decision and a
 *                 missed real-weather game costs more than a false alarm you can dismiss in a second. The
 *                 flag says the roof can close, so the read is honest rather than confident.
 *   open        — outdoors.
 *
 * ⚠ THE COORDINATES ARE THE STADIUM, NOT THE CITY. MetLife is in East Rutherford, not Manhattan; the Bills
 *   play in Orchard Park, seventeen miles from downtown Buffalo and on the wrong side of a lake-effect snow
 *   belt that regularly puts a foot on the stadium and nothing on the city. Rounding a venue to its city is
 *   exactly how a snow game gets missed.
 *
 * ⚠ NEUTRAL-SITE AND INTERNATIONAL GAMES ARE NOT HANDLED and are deliberately left as a known gap rather
 *   than guessed at. A London or Munich game resolves to the nominal home team's own stadium and will report
 *   the wrong weather. The schedule feed does not carry a venue, so there is nothing here to key off; the
 *   honest fix is a venue field upstream, not a hardcoded list of which weeks are in London this year, which
 *   would be wrong by next season and silently so.
 */
export const VENUES = {
  ARI: { name: 'State Farm Stadium', lat: 33.5277, lon: -112.2626, roof: 'retractable' },
  ATL: { name: 'Mercedes-Benz Stadium', lat: 33.7554, lon: -84.4008, roof: 'retractable' },
  BAL: { name: 'M&T Bank Stadium', lat: 39.2780, lon: -76.6227, roof: 'open' },
  BUF: { name: 'Highmark Stadium', lat: 42.7738, lon: -78.7870, roof: 'open' },
  CAR: { name: 'Bank of America Stadium', lat: 35.2258, lon: -80.8528, roof: 'open' },
  CHI: { name: 'Soldier Field', lat: 41.8623, lon: -87.6167, roof: 'open' },
  CIN: { name: 'Paycor Stadium', lat: 39.0955, lon: -84.5161, roof: 'open' },
  CLE: { name: 'Huntington Bank Field', lat: 41.5061, lon: -81.6995, roof: 'open' },
  DAL: { name: 'AT&T Stadium', lat: 32.7473, lon: -97.0945, roof: 'retractable' },
  DEN: { name: 'Empower Field at Mile High', lat: 39.7439, lon: -105.0201, roof: 'open' },
  DET: { name: 'Ford Field', lat: 42.3400, lon: -83.0456, roof: 'dome' },
  GB:  { name: 'Lambeau Field', lat: 44.5013, lon: -88.0622, roof: 'open' },
  HOU: { name: 'NRG Stadium', lat: 29.6847, lon: -95.4107, roof: 'retractable' },
  IND: { name: 'Lucas Oil Stadium', lat: 39.7601, lon: -86.1639, roof: 'retractable' },
  JAX: { name: 'EverBank Stadium', lat: 30.3239, lon: -81.6373, roof: 'open' },
  KC:  { name: 'GEHA Field at Arrowhead', lat: 39.0489, lon: -94.4839, roof: 'open' },
  LAC: { name: 'SoFi Stadium', lat: 33.9535, lon: -118.3392, roof: 'dome' },
  LAR: { name: 'SoFi Stadium', lat: 33.9535, lon: -118.3392, roof: 'dome' },
  LV:  { name: 'Allegiant Stadium', lat: 36.0909, lon: -115.1833, roof: 'dome' },
  MIA: { name: 'Hard Rock Stadium', lat: 25.9580, lon: -80.2389, roof: 'open' },
  MIN: { name: 'U.S. Bank Stadium', lat: 44.9738, lon: -93.2578, roof: 'dome' },
  NE:  { name: 'Gillette Stadium', lat: 42.0909, lon: -71.2643, roof: 'open' },
  NO:  { name: 'Caesars Superdome', lat: 29.9511, lon: -90.0812, roof: 'dome' },
  NYG: { name: 'MetLife Stadium', lat: 40.8135, lon: -74.0745, roof: 'open' },
  NYJ: { name: 'MetLife Stadium', lat: 40.8135, lon: -74.0745, roof: 'open' },
  PHI: { name: 'Lincoln Financial Field', lat: 39.9008, lon: -75.1675, roof: 'open' },
  PIT: { name: 'Acrisure Stadium', lat: 40.4468, lon: -80.0158, roof: 'open' },
  SEA: { name: 'Lumen Field', lat: 47.5952, lon: -122.3316, roof: 'open' },
  SF:  { name: "Levi's Stadium", lat: 37.4033, lon: -121.9694, roof: 'open' },
  TB:  { name: 'Raymond James Stadium', lat: 27.9759, lon: -82.5033, roof: 'open' },
  TEN: { name: 'Nissan Stadium', lat: 36.1665, lon: -86.7713, roof: 'open' },
  WAS: { name: 'Northwest Stadium', lat: 38.9077, lon: -76.8645, roof: 'open' },
};

export const isIndoors = (team) => {
  const v = VENUES[String(team || '').toUpperCase()];
  return !!v && v.roof === 'dome';
};

/* ⭐⭐⭐⭐ WHAT COUNTS AS WEATHER WORTH A MANAGER'S ATTENTION.
 * Trey drew the line himself and it is the whole specification: "If it's sunny, then you wouldn't list them…
 * If it's light rain, don't list them." A panel that lists every game with a cloud over it is a panel nobody
 * opens twice, so the thresholds below are set where the football actually changes, not where the weather
 * becomes noticeable:
 *   WIND is the one that moves fantasy scoring most and it is not close — it is the only common condition
 *     that reliably suppresses passing and kicking. 15mph sustained is where kickers start to miss and deep
 *     balls start to die; 25mph is a different game.
 *   SNOW at all is worth knowing, because it comes with wind and footing and because it is rare enough that
 *     saying so is never noise.
 *   RAIN has to be heavy to matter. Light rain is a normal football condition and flagging it is exactly the
 *     false alarm he asked not to have; the bar is a rate you would call a downpour, not a drizzle.
 *   COLD alone is mostly a myth as a fantasy factor, so it only appears in the read when it is severe enough
 *     to be a story on its own, and never as the sole reason to flag a game.
 * Returns null when there is nothing to say — the caller renders nothing rather than "fine", because a list
 * of games with no problem is not a list of problems.
 */
export function weatherConcern(w) {
  if (!w) return null;
  const wind = Number(w.windGust != null ? w.windGust : w.wind) || 0;
  const rain = Number(w.rain) || 0;         // mm over the game window
  const snow = Number(w.snow) || 0;         // cm over the game window
  const temp = w.tempF == null ? null : Number(w.tempF);
  const bits = [];
  let sev = 0;                              // 0 none · 1 watch · 2 concern · 3 severe

  if (snow >= 5) { bits.push(`heavy snow (${snow.toFixed(1)}cm)`); sev = Math.max(sev, 3); }
  else if (snow >= 1) { bits.push(`snow (${snow.toFixed(1)}cm)`); sev = Math.max(sev, 2); }

  if (rain >= 12) { bits.push(`heavy rain (${rain.toFixed(0)}mm)`); sev = Math.max(sev, 3); }
  else if (rain >= 5) { bits.push(`steady rain (${rain.toFixed(0)}mm)`); sev = Math.max(sev, 2); }

  if (wind >= 25) { bits.push(`wind ${Math.round(wind)}mph`); sev = Math.max(sev, 3); }
  else if (wind >= 18) { bits.push(`wind ${Math.round(wind)}mph`); sev = Math.max(sev, 2); }
  else if (wind >= 15) { bits.push(`breezy ${Math.round(wind)}mph`); sev = Math.max(sev, 1); }

  // Cold rides along with a flag it never raises by itself.
  if (temp != null && temp <= 20 && sev > 0) bits.push(`${Math.round(temp)}°F`);
  else if (temp != null && temp <= 10) { bits.push(`${Math.round(temp)}°F`); sev = Math.max(sev, 2); }

  if (!sev || !bits.length) return null;
  return { severity: sev, label: sev >= 3 ? 'Severe' : sev === 2 ? 'Concern' : 'Watch', text: bits.join(' · ') };
}
