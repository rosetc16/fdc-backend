// READING AN UNOFFICIAL FEED WITHOUT LYING ABOUT IT.
//
// This file is the injury saga distilled. That feature took FOUR deploys, and not one of them was a logic
// bug — every round was a DIAGNOSTIC failure, where the job reported a clean success while understanding
// nothing:
//
//   112  a table that didn't exist          → the job died before doing anything
//   113  an envelope we assumed             → matched nothing, warned about nothing, reported 32/32 OK
//   114  a URL that answered 200 with `{}`  → 32 successful requests, zero information
//   115  detection conflated with identity  → readable records reported as an unreadable payload
//
// The pattern behind all four: when you cannot see the response, every assumption you make silently becomes
// an assertion about reality, and a wrong one is indistinguishable from "there is nothing there". So this
// module holds the three defences that finally ended it, in a form any future feed reader can use:
//
//   1. describeShape  — say what you got, structurally, without being drowned in content
//   2. findRecords    — recognise records by their OWN fields, scored, not by a path you guessed
//   3. trySources     — never one URL; a chain, with the winner and every failure reported by name
//
// Use these for anything reading ESPN, Sleeper, or any other feed we do not control.

// ---- 1. WHAT DID WE ACTUALLY GET? ------------------------------------------------------------------------
//
// A STRUCTURAL map of a payload: keys and types, arrays collapsed to a count plus their first element.
// Never content — the version of this that sampled 600 raw characters had its entire budget eaten by one
// 400-character blurb about a kicker's field-goal percentage, so the part that mattered was cut off
// mid-sentence. A diagnostic that samples content can be starved by content.
export function describeShape(v, depth = 0, maxDepth = 6) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return depth >= maxDepth ? `[${v.length}]`
    : `[${v.length}]` + (v.length ? describeShape(v[0], depth + 1, maxDepth) : '');
  const t = typeof v;
  if (t !== 'object') return t === 'string' ? 'str' : t === 'number' ? 'num' : t === 'boolean' ? 'bool' : t;
  if (depth >= maxDepth) return '{…}';
  const keys = Object.keys(v);
  const shown = keys.slice(0, 14).map((k) => `${k}:${describeShape(v[k], depth + 1, maxDepth)}`);
  if (keys.length > 14) shown.push(`+${keys.length - 14} more`);
  return `{${shown.join(',')}}`;
}

// ---- 2. FIND THE RECORDS WHEREVER THEY ARE ---------------------------------------------------------------
//
// Walk a payload and collect every object that looks like the record you want, SCORING its own fields rather
// than demanding a shape. The rule that failed was "it's a record IF it has X where I expect it AND a Y":
// one field in an unforeseen place made a perfectly readable record vanish, and — worse — made the whole
// payload get reported as unreadable, which is a lie in the most expensive direction.
//
// `fields` is the list a real record tends to carry. Score >= `min` matches. Pick `min` by checking what the
// DECOY objects in the same payload score: lookup blocks and metadata typically hit 0-1, real records 4-7.
//
// BFS, not DFS: popping a stack reverses document order, which silently broke a test the first time.
// Depth- and node-capped so a hostile or enormous payload cannot spin.
export function findRecords(root, fields, min = 3, { cap = 6000, maxDepth = 9 } = {}) {
  const found = [];
  let refsSeen = 0;                       // $ref links handed to us instead of data — its own diagnosis
  const seen = new Set();
  const queue = [[root, 0]];
  let head = 0, visited = 0;
  while (head < queue.length && visited < cap) {
    const [node, depth] = queue[head++];
    if (!node || typeof node !== 'object' || depth > maxDepth) continue;
    if (seen.has(node)) continue;
    seen.add(node);
    visited++;
    if (Array.isArray(node)) { for (const child of node) queue.push([child, depth + 1]); continue; }
    let score = 0;
    for (const f of fields) if (node[f] != null) score++;
    if (score >= min) { found.push(node); continue; }      // don't descend into a matched record
    if (node.$ref && score === 0) refsSeen++;
    for (const k of Object.keys(node)) queue.push([node[k], depth + 1]);
  }
  found.refsSeen = refsSeen;
  found.truncated = visited >= cap;
  return found;
}

// Turn "we found nothing" into a diagnosis that names itself. The distinctions matter: an EMPTY body and an
// UNFAMILIAR one are different problems, and printing them the same way produced a bare
// `shape-unrecognized:` with no keys after it — which reads like the diagnostic is broken rather than like
// the endpoint is wrong.
export function diagnoseEmpty(payload, records) {
  if (records && records.refsSeen) return 'unexpanded-ref';
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && !Object.keys(payload).length) return 'empty-object';
  if (Array.isArray(payload) && !payload.length) return 'empty-array';
  if (records && records.truncated) return 'walk-truncated';
  const keys = (payload && typeof payload === 'object' && !Array.isArray(payload))
    ? Object.keys(payload).slice(0, 12) : (Array.isArray(payload) ? ['<array>'] : [typeof payload]);
  return 'shape-unrecognized:' + keys.join(',');
}

// ---- 3. NEVER ONE URL ------------------------------------------------------------------------------------
export async function getJson(url, ms = 7000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(t); }
}

// Work down an ordered list of sources and STOP at the first that yields records.
//
// A single hard-coded URL against an unofficial API is a guess with no fallback and no way to tell a wrong
// guess from "there is genuinely nothing". The chain plus a recorded winner turns the next time the provider
// moves something into a line in the result box instead of another deploy cycle.
//
// Each source: { name, urls: [...], map(payload) -> { records, warnings } }.
// Returns { records, attempts, used, shape } — `shape` is present ONLY when nothing worked, which is exactly
// when somebody needs to see it.
export async function trySources(sources, { timeoutMs = 7000 } = {}) {
  const attempts = [];
  let shape = null;
  for (const src of sources) {
    let ok = 0, failed = 0;
    const warnings = [];
    const records = [];
    for (const url of src.urls) {
      const j = await getJson(url, timeoutMs);
      if (!j) { failed++; continue; }
      ok++;
      if (shape == null) { try { shape = describeShape(j).slice(0, 1200); } catch { shape = '<undescribable>'; } }
      let r;
      try { r = src.map(j); } catch (e) { warnings.push('map-threw:' + String(e.message).slice(0, 60)); continue; }
      (r.warnings || []).forEach((w) => warnings.push(w));
      (r.records || []).forEach((x) => records.push(x));
    }
    attempts.push({ source: src.name, calls: src.urls.length, ok, failed, records: records.length,
      warnings: [...new Set(warnings)].slice(0, 4) });
    if (records.length) return { records, attempts, used: src.name, shape: null };
  }
  return { records: [], attempts, used: null, shape };
}
