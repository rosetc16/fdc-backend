// Normalize a player name for cross-source matching: lowercase, strip punctuation, suffixes,
// and accents. Used to resolve external names to a canonical player when no ID is provided.
export function normName(name) {
  if (!name) return '';
  return String(name)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '')        // drop generational suffixes
    .replace(/[^a-z0-9 ]/g, '')                          // drop punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

// A defensive-team name like "Seahawks D/ST" -> normalized form for DST matching.
export function normTeamName(name) {
  return normName(String(name).replace(/d\/?st|defense|dst/gi, '')).trim();
}
