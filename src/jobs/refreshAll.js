// Runs the full daily data refresh in the correct order. Used by the cron job and `npm run refresh`.
//   1) players (identity spine)  2) projections  3) published ADP  4) harvest drafts  5) recompute consensus
import { syncPlayers } from './syncPlayers.js';
import { syncProjections } from './syncProjections.js';
import { syncInjuries } from './syncInjuries.js';
import { syncPublishedAdp } from './syncPublishedAdp.js';
import { harvestSleeperDrafts } from './harvestSleeperDrafts.js';
import { refreshConsensus } from './refreshConsensus.js';
import { pruneObservations } from './pruneObservations.js';
import { log } from '../lib/log.js';

export async function refreshAll() {
  const out = {};
  try { out.players = await syncPlayers(); } catch (e) { out.players = { error: e.message }; log.error(e); }
  try { out.projections = await syncProjections(); } catch (e) { out.projections = { error: e.message }; log.error(e); }
  // Straight after players, so the detail is merged onto designations that were written moments ago.
  // Wrapped like everything else: ESPN being down must never fail the nightly refresh.
  try { out.injuries = await syncInjuries(); } catch (e) { out.injuries = { error: e.message }; log.error(e); }
  // Published ADP gives broad, clean veteran coverage immediately; harvested drafts refine specific
  // buckets. Both are observations the consensus step blends — published must land before consensus.
  try { out.publishedAdp = await syncPublishedAdp(); } catch (e) { out.publishedAdp = { error: e.message }; log.error(e); }
  try { out.harvest = await harvestSleeperDrafts(); } catch (e) { out.harvest = { error: e.message }; log.error(e); }
  try { out.consensus = await refreshConsensus(); } catch (e) { out.consensus = { error: e.message }; log.error(e); }
  // Prune AFTER consensus is recomputed from the full pool, so trimming never starves the numbers the board
  // uses. This keeps adp_observations from growing without bound (the cause of the storage outage) — it self-
  // caps every refresh instead of relying on someone remembering to click the manual cleanup button.
  try { out.prune = await pruneObservations(); } catch (e) { out.prune = { error: e.message }; log.error(e); }
  log.info(out, 'refreshAll complete');
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  refreshAll().then(() => process.exit(0)).catch((e) => { log.error(e); process.exit(1); });
}
