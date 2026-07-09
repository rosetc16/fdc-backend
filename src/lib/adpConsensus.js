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

// ---------------------------------------------------------------------------------------------------
// PLAYER EVENTS — stale-sample down-weighting
//
// When something changes a player's value on a known date (season-ending injury, lost his job, suspension,
// trade, retirement), every draft that happened BEFORE that date was made under information that is now
// obsolete. Those pre-event picks are stale SAMPLES for that player. Drafts after the date already price the
// news in and are left alone.
//
// We DOWN-WEIGHT rather than delete pre-event observations. That matters: right after news breaks there may be
// only two or three post-event drafts, and discarding everything else would make ADP thrash wildly. Keeping the
// old samples at reduced weight anchors the number, and as real post-event drafts accumulate at FULL weight
// they naturally take over. The system self-corrects with no special-case "bridge" logic, and — because we only
// ever reweight REAL drafts, never invent a value — a mistaken event entry degrades gracefully instead of
// corrupting the board. Existing staleness age-out means events stop mattering once all pre-event observations
// have aged out of the window entirely.
//
// The redraft/dynasty split is the subtle part. The SAME event means very different things:
//   • A season-ending ACL in August is catastrophic for redraft (he is worth nothing this year) but only mildly
//     negative for dynasty (he's 24, he'll be back, some managers buy low).
//   • A veteran losing his starting job is a moderate redraft hit but closer to a dynasty cliff.
//   • A suspension barely dents dynasty value at all.
// Consensus is already computed per (player, format_key), and format_key encodes REDRAFT vs DYNASTY — so one
// stored event row can apply a different pre-event weight per format at blend time.
//
// Each profile is the multiplier applied to a PRE-event observation's weight. 1 = unaffected, 0 = ignored.
export const EVENT_PROFILES = {
  season_ending_injury: { redraft: 0.05, dynasty: 0.55, label: 'Season-ending injury' },
  multi_year_injury:    { redraft: 0.05, dynasty: 0.20, label: 'Multi-year / major injury' },
  lost_starting_job:    { redraft: 0.15, dynasty: 0.30, label: 'Lost starting job' },
  suspension:           { redraft: 0.35, dynasty: 0.85, label: 'Suspension' },
  role_change:          { redraft: 0.40, dynasty: 0.45, label: 'Trade / role change' },
  retirement:           { redraft: 0.02, dynasty: 0.02, label: 'Retirement' },
};

// Floor on how far an event may pull the weight down, so a single event can never fully erase the
// pre-event market — bounded influence is one of the guardrails this feature depends on.
const EVENT_WEIGHT_FLOOR = 0.02;

// A format_key looks like `PPR|SF|TEP|DYNASTY|12`. Anything not explicitly DYNASTY/KEEPER is treated as redraft.
export function isDynastyFormat(formatKey) {
  return /\|(DYNASTY|KEEPER)\|/i.test(String(formatKey || ''));
}

// Resolve the pre-event weight multiplier for one event in one format.
// `event`: { event_date, event_type } — or null/undefined when the player has no event.
export function preEventWeightFactor(event, formatKey) {
  if (!event || !event.event_type) return 1;
  const prof = EVENT_PROFILES[event.event_type];
  if (!prof) return 1; // unknown type → no-op rather than a guess
  const f = isDynastyFormat(formatKey) ? prof.dynasty : prof.redraft;
  return Math.max(EVENT_WEIGHT_FLOOR, Math.min(1, f));
}

// Source types whose rows are INDEPENDENT SAMPLES (one real draft each). These must NOT be deduped —
// collapsing them would throw away the entire harvest and leave a single draft standing in for hundreds.
const SAMPLE_TYPES = new Set(['aggregated_drafts']);

// Group observations by source, taking each source's most recent observation as its current read.
//
// IMPORTANT: this dedup exists for FEED-style sources (e.g. `sleeper_published`), which get re-synced on a
// schedule — each sync is a RESTATEMENT of the same number, so only the newest read should count. It must NOT
// be applied to DRAFT-style sources, where every row is an independent observation of a distinct real draft.
// Those are kept in full. (Previously everything was deduped by `source`, which silently collapsed every
// harvested draft down to one observation, discarding almost all of the harvest's signal.)
function latestPerSource(observations) {
  const samples = [];
  const bySrc = new Map();
  for (const o of observations) {
    if (SAMPLE_TYPES.has(o.source_type)) { samples.push(o); continue; }
    const prev = bySrc.get(o.source);
    if (!prev || new Date(o.observed_at) > new Date(prev.observed_at)) bySrc.set(o.source, o);
  }
  return [...bySrc.values(), ...samples];
}

// Weighted, recency-decayed, staleness-aware consensus for ONE (player, format, season).
// observations: [{source, source_type, pick, weight, observed_at}]
// now: Date (defaults to current time)
export function blendConsensus(observations, now = new Date(), opts = {}) {
  if (!observations || observations.length === 0) {
    return { consensus: null, lo: null, hi: null, stdev: null, sampleN: 0, sources: [], lowConfidence: true };
  }
  const { event = null, formatKey = null } = opts;
  const eventAt = event && event.event_date ? new Date(event.event_date) : null;
  const preFactor = eventAt ? preEventWeightFactor(event, formatKey) : 1;

  const latest = latestPerSource(observations);

  // tag staleness + effective weight (base weight decayed by age, then down-weighted if the observation
  // predates a known value-changing event for this player)
  const tagged = latest.map((o) => {
    const obsAt = new Date(o.observed_at);
    const ageDays = Math.max(0, (now - obsAt) / DAY_MS);
    const stale = ageDays > BLEND.staleDays;
    const preEvent = !!(eventAt && obsAt < eventAt);
    const base = Math.max(0, (Number(o.weight) || 1) * (1 - ageDays * BLEND.decayPerDay));
    const effWeight = preEvent ? base * preFactor : base;
    return {
      source: o.source, sourceType: o.source_type, value: Number(o.pick),
      ageDays, stale, preEvent, weight: effWeight,
    };
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

  // Outlier guard when we have enough live sources: drop values far from the median.
  //
  // Event-aware. After an event, the pre- and post-event picks form two legitimately different populations —
  // that separation IS the signal. Pooling them and filtering against a single median would delete one whole
  // group (whichever is smaller), turning our intended DOWN-WEIGHT into a silent DELETE and erasing the
  // redraft/dynasty distinction entirely. So each group is judged only against its own median: we still catch a
  // genuine fat-fingered pick inside either population, but never discard a population for disagreeing with
  // the other. Without an event this behaves exactly as before.
  const guard = (group) => {
    if (group.length < 4) return group; // too few to judge outliers meaningfully
    const vals = group.map((t) => t.value).sort((a, b) => a - b);
    const med = vals[Math.floor(vals.length / 2)];
    const sd = stdev(vals) || 1;
    return group.filter((t) => Math.abs(t.value - med) <= BLEND.outlierStdev * sd);
  };
  if (live.length >= 4) {
    if (eventAt) {
      live = [...guard(live.filter((t) => t.preEvent)), ...guard(live.filter((t) => !t.preEvent))];
    } else {
      live = guard(live);
    }
  }

  const wsum = live.reduce((s, t) => s + t.weight, 0);
  const consensus = wsum ? live.reduce((s, t) => s + t.weight * t.value, 0) / wsum : median(live.map((t) => t.value));
  const vals = live.map((t) => t.value);

  const postN = live.filter((t) => !t.preEvent).length;
  return {
    consensus: round1(consensus),
    lo: round1(Math.min(...vals)),
    hi: round1(Math.max(...vals)),
    stdev: round1(stdev(vals)),
    sampleN: live.length,
    sources: tagged.map((t) => ({ ...t, value: round1(t.value) })),
    lowConfidence: live.length < BLEND.minSample,
    // event context (null when no event applies) — surfaced so admin/debug views can explain a moved ADP
    eventApplied: eventAt ? { type: event.event_type, date: event.event_date, preFactor, postSampleN: postN } : null,
  };
}

// Trend: compare the recency-weighted consensus over the trailing window vs the prior window.
// Negative = rising (going earlier); positive = falling (sliding later).
export function computeTrend(observations, now = new Date(), opts = {}) {
  if (!observations || observations.length < 4) return 0;
  const { event = null } = opts;
  const eventAt = event && event.event_date ? new Date(event.event_date) : null;

  // If a value-changing event sits between the prior and recent windows, a naive comparison reports the event
  // itself as a "trend" (a huge slide the moment news breaks). That's misleading — trend should describe how
  // the market is drifting under CURRENT information. So once an event applies we only compare observations
  // from after it, and report no trend until there's enough post-event data on both sides to say anything.
  const pool = eventAt ? observations.filter((o) => new Date(o.observed_at) >= eventAt) : observations;
  if (pool.length < 4) return 0;

  const winMs = BLEND.trendWindowDays * DAY_MS;
  const recent = pool.filter((o) => (now - new Date(o.observed_at)) <= winMs);
  const prior = pool.filter((o) => {
    const age = now - new Date(o.observed_at);
    return age > winMs && age <= winMs * 2;
  });
  if (!recent.length || !prior.length) return 0;
  const avg = (arr) => arr.reduce((s, o) => s + Number(o.pick), 0) / arr.length;
  return round1(avg(recent) - avg(prior));
}

// Build the full consensus record (consensus + trend) for storage.
// opts: { event, formatKey } — pass the player's event (if any) and the format being computed.
export function buildConsensusRecord(observations, now = new Date(), opts = {}) {
  const c = blendConsensus(observations, now, opts);
  const trend = computeTrend(observations, now, opts);
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
