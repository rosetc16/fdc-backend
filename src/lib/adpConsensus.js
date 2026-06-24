// ADP consensus blender. Pure functions (no DB) so they're unit-testable.
// Implements the spec's rules: weighted + recency-decayed mean, staleness age-out,
// outlier guarding, trend, and min-sample reporting.

const DAY_MS = 864e5;

// Tunable constants — calibrate against real data later (see calibration notes).
export const BLEND = {
  staleDays: 14,        // a source older than this drops OUT of the consensus
  decayPerDay: 0.04,    // recency decay applied to each source's weight per day of age
  outlierStdev: 2.5,    // observations beyond this many stdevs (with small N) are excluded
  minSample: 5,         // below this, mark the format as low-confidence / estimated
  trendWindowDays: 21,  // window for computing the rising/falling trend
};

// Group observations by source, taking each source's most recent observation as its current read.
function latestPerSource(observations) {
  const bySrc = new Map();
  for (const o of observations) {
    const prev = bySrc.get(o.source);
    if (!prev || new Date(o.observed_at) > new Date(prev.observed_at)) bySrc.set(o.source, o);
  }
  return [...bySrc.values()];
}

// Weighted, recency-decayed, staleness-aware consensus for ONE (player, format, season).
// observations: [{source, source_type, pick, weight, observed_at}]
// now: Date (defaults to current time)
export function blendConsensus(observations, now = new Date()) {
  if (!observations || observations.length === 0) {
    return { consensus: null, lo: null, hi: null, stdev: null, sampleN: 0, sources: [], lowConfidence: true };
  }
  const latest = latestPerSource(observations);

  // tag staleness + effective weight (base weight decayed by age)
  const tagged = latest.map((o) => {
    const ageDays = Math.max(0, (now - new Date(o.observed_at)) / DAY_MS);
    const stale = ageDays > BLEND.staleDays;
    const effWeight = Math.max(0, (Number(o.weight) || 1) * (1 - ageDays * BLEND.decayPerDay));
    return { source: o.source, sourceType: o.source_type, value: Number(o.pick), ageDays, stale, weight: effWeight };
  });

  let live = tagged.filter((t) => !t.stale && t.weight > 0);
  if (live.length === 0) {
    // everything stale — fall back to the freshest single source so we still return something
    const fresh = tagged.slice().sort((a, b) => a.ageDays - b.ageDays)[0];
    return {
      consensus: round1(fresh.value), lo: round1(fresh.value), hi: round1(fresh.value),
      stdev: 0, sampleN: 1, sources: tagged, lowConfidence: true,
    };
  }

  // outlier guard when we have enough live sources: drop values far from the median
  if (live.length >= 4) {
    const vals = live.map((t) => t.value).sort((a, b) => a - b);
    const med = vals[Math.floor(vals.length / 2)];
    const sd = stdev(vals) || 1;
    live = live.filter((t) => Math.abs(t.value - med) <= BLEND.outlierStdev * sd);
  }

  const wsum = live.reduce((s, t) => s + t.weight, 0);
  const consensus = wsum ? live.reduce((s, t) => s + t.weight * t.value, 0) / wsum : median(live.map((t) => t.value));
  const vals = live.map((t) => t.value);

  return {
    consensus: round1(consensus),
    lo: round1(Math.min(...vals)),
    hi: round1(Math.max(...vals)),
    stdev: round1(stdev(vals)),
    sampleN: live.length,
    sources: tagged.map((t) => ({ ...t, value: round1(t.value) })),
    lowConfidence: live.length < BLEND.minSample,
  };
}

// Trend: compare the recency-weighted consensus over the trailing window vs the prior window.
// Negative = rising (going earlier); positive = falling (sliding later).
export function computeTrend(observations, now = new Date()) {
  if (!observations || observations.length < 4) return 0;
  const winMs = BLEND.trendWindowDays * DAY_MS;
  const recent = observations.filter((o) => (now - new Date(o.observed_at)) <= winMs);
  const prior = observations.filter((o) => {
    const age = now - new Date(o.observed_at);
    return age > winMs && age <= winMs * 2;
  });
  if (!recent.length || !prior.length) return 0;
  const avg = (arr) => arr.reduce((s, o) => s + Number(o.pick), 0) / arr.length;
  return round1(avg(recent) - avg(prior));
}

// Build the full consensus record (consensus + trend) for storage.
export function buildConsensusRecord(observations, now = new Date()) {
  const c = blendConsensus(observations, now);
  const trend = computeTrend(observations, now);
  return { ...c, trend };
}

// ---- small math helpers ----
function round1(x) { return x == null ? null : Math.round(x * 10) / 10; }
function median(arr) { const a = arr.slice().sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; }
function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = arr.reduce((s, x) => s + x, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}
