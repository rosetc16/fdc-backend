/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
   THE INSTRUMENT FOR THE MFL / FANTRAX PICK SYNC — built before it is needed, on purpose.
   ───────────────────────────────────────────────────────────────────────────────────────────────────
   The live pick sync shipped in 29an rests entirely on a translation nobody has ever seen work against
   the real thing. Both platforms answer with player IDs and no names; the draft room places picks BY
   NAME; so src/lib/playerIds.js fetches each platform's own directory and fills the names in. That
   parser was written from documentation and tested against a stub written from the same documentation —
   which proves the two agree with each other and NOTHING about whether either agrees with production.
   MyFantasyLeague and Fantrax are both unreachable from the sandbox the code was written in.

   ⭐ THE THROUGH-LINE OF FOUR BACKEND ROUNDS (112-115) WAS THAT EVERY ONE WAS A DIAGNOSTIC PROBLEM, NOT A
     LOGIC PROBLEM, and each was invisible because the job reported a clean success. Each fix was mostly
     better reporting, and each next round then took one deploy. The failure mode here is the same shape
     and worse: `withPlayerNames` degrades rather than throwing, so a directory in an unexpected shape
     produces a poll that returns tidy picks, reports itself healthy, and leaves the board empty.

   So this prints every link in that chain, for a real league, on demand:
     · did the directory fetch at all, how many entries, and what do three of them look like
     · does a name from it survive normalisation into something a board could match
     · did the league's picks fetch, how many came back
     · ⭐ HOW MANY OF THEM CARRY A NAME — the one number that decides whether the feature works
     · and, when they do not, the raw keys the upstream payload actually used, which is the thing that
       tells us what to change

   ⚠ IT NEVER ECHOES THE CREDENTIAL. The caller passes an MFL API key or a Fantrax Secret ID; nothing
     derived from it appears in the output, because a diagnostic gets pasted into a chat window.
   ═══════════════════════════════════════════════════════════════════════════════════════════════════ */
import { playerDirectory } from './playerIds.js';
import { normName } from './names.js';

const UA = 'FantasyDraftCompass/1.0 (+https://www.fantasydraftcompass.com)';

// A peek at the RAW upstream payload, so a shape we did not expect can be seen rather than guessed at.
async function rawShape(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': UA } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON — that is itself the finding */ }
    if (json == null) {
      return { ok: res.ok, status: res.status, parsed: false, firstBytes: text.slice(0, 200) };
    }
    const topKeys = Array.isArray(json) ? ['(array)'] : Object.keys(json).slice(0, 12);
    // One record, whatever nesting it is under — the keys ARE the answer when a parser reads nothing.
    let sample = null;
    const dig = (v, depth = 0) => {
      if (sample || depth > 4 || v == null) return;
      if (Array.isArray(v)) { if (v.length && typeof v[0] === 'object') sample = v[0]; else v.slice(0, 2).forEach((x) => dig(x, depth + 1)); return; }
      if (typeof v === 'object') {
        const vals = Object.values(v);
        if (vals.length && vals.every((x) => x && typeof x === 'object' && !Array.isArray(x))) { sample = vals[0]; return; }
        vals.slice(0, 8).forEach((x) => dig(x, depth + 1));
      }
    };
    dig(json);
    return {
      ok: res.ok, status: res.status, parsed: true, topKeys,
      sampleRecordKeys: sample ? Object.keys(sample).slice(0, 16) : null,
      sampleRecord: sample ? JSON.stringify(sample).slice(0, 300) : null,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  } finally { clearTimeout(timer); }
}

/* ⭐ THE VERDICT IS A PURE FUNCTION OF WHAT WAS OBSERVED, SEPARATE FROM THE FETCHING.
   MFL and Fantrax are unreachable from the sandbox — which is the entire reason this file exists — so a
   diagnostic whose reasoning can only be exercised by calling them is a diagnostic nobody has ever seen
   run. The hosts deliberately stay hardcoded (mfl.js explains why: MFL rotates numbered hosts and only the
   api host redirects correctly, so an override invites the exact failure that comment warns about). So the
   REASONING is split out and tested directly, and the fetching around it stays thin enough to read.
   ⚠ The distinction that matters most is between "no picks" and "picks that none of us can identify" —
     they look identical on a board, and only the second means the translation layer is broken. */
export function verdictFor({ dirSize, pickCount, named }) {
  if (!dirSize) {
    return { level: 'broken', text: 'The player directory is empty, so every pick will arrive without a name and the draft board cannot place any of them. The raw shape above is what the platform actually returned — compare it with the parser in src/lib/playerIds.js.' };
  }
  if (pickCount == null) {
    return { level: 'ok', text: `Directory is healthy (${dirSize} players). Pass a league id to check an actual draft feed end to end.` };
  }
  if (!pickCount) {
    return { level: 'unknown', text: 'The feed answered, but with no picks. Either the draft has not started, or the league id/credential is pointing somewhere unexpected.' };
  }
  if (named === 0) {
    return { level: 'broken', text: `${pickCount} picks came back and NONE of them resolved to a player. The directory has ${dirSize} entries, so the ids in this league's feed are not the ids the directory is keyed by — compare the picks' player_id above with the directory's sample ids.` };
  }
  if (named < pickCount) {
    return { level: 'partial', text: `${named} of ${pickCount} picks resolved. The unresolved ids are listed above — a handful is normal (a player the directory does not carry); a large share means the directory is stale and should be refetched.` };
  }
  return { level: 'ok', text: `Healthy: all ${pickCount} picks resolved to named players, and the draft room can place every one of them.` };
}

/**
 * @param {'mfl'|'fantrax'} platform
 * @param {object} opts { leagueId, season, credential }
 */
export async function connectDiagnose(platform, { leagueId = null, season = null, credential = null } = {}) {
  const yr = Number(season) || new Date().getUTCFullYear();
  const out = { platform, season: yr, leagueId: leagueId || null, steps: [], verdict: null };
  const step = (name, data) => out.steps.push({ step: name, ...data });

  // ---- 1 · the directory, which is the whole feature -----------------------------------------------
  let dir = new Map();
  try {
    dir = await playerDirectory(platform, yr);
  } catch (e) {
    step('directory', { ok: false, error: String((e && e.message) || e).slice(0, 200) });
  }
  const sample = [...dir.entries()].slice(0, 3).map(([id, v]) => ({ id, ...v }));
  step('directory', {
    ok: dir.size > 0,
    entries: dir.size,
    sample,
    // ⚠ A directory that parses but yields unusable names is a DIFFERENT failure from one that does not
    //   parse, and it looks identical from the outside. MFL writes "Last, First"; if the flip ever stops
    //   happening, every name is still present and nothing matches.
    normalisedSample: sample.map((s) => normName(s.name)),
  });
  if (!dir.size) {
    step('directory-raw', await rawShape(platform === 'mfl'
      ? `https://api.myfantasyleague.com/${yr}/export?TYPE=players&DETAILS=1&JSON=1`
      : 'https://www.fantrax.com/fxea/general/getPlayerIds?sport=NFL'));
    out.verdict = verdictFor({ dirSize: 0 }).text;
    return out;
  }

  // ---- 2 · a real league's picks, end to end -------------------------------------------------------
  if (!leagueId) {
    out.verdict = verdictFor({ dirSize: dir.size }).text;
    return out;
  }
  let picks = [];
  try {
    if (platform === 'mfl') {
      const { mflPicks } = await import('./mfl.js');
      picks = await mflPicks(leagueId, yr, { apiKey: credential });
    } else {
      const { fantraxPicks } = await import('./fantrax.js');
      picks = await fantraxPicks(leagueId, { secretId: credential });
    }
  } catch (e) {
    step('picks', { ok: false, error: String((e && e.message) || e).slice(0, 250) });
    out.verdict = 'The picks call itself failed — the message above is what the platform said. Nothing downstream of this can work until it does.';
    return out;
  }
  const named = picks.filter((p) => p && p.name).length;
  step('picks', {
    ok: true,
    count: picks.length,
    withName: named,          // ⭐ THE NUMBER THAT DECIDES WHETHER THE FEATURE WORKS
    withSlot: picks.filter((p) => p && p.slot != null).length,
    sample: picks.slice(0, 3),
  });

  if (named === 0 && picks.length) {
    step('picks-raw', await rawShape(platform === 'mfl'
      ? `https://api.myfantasyleague.com/${yr}/export?TYPE=draftResults&L=${encodeURIComponent(leagueId)}&JSON=1`
      : `https://www.fantrax.com/fxea/general/getDraftPicks?leagueId=${encodeURIComponent(leagueId)}`));
  } else if (named < picks.length) {
    step('unresolved-ids', { ids: picks.filter((p) => p && !p.name).slice(0, 8).map((p) => p.player_id) });
  }
  out.verdict = verdictFor({ dirSize: dir.size, pickCount: picks.length, named }).text;
  return out;
}
