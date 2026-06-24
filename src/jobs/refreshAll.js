// Runs the full daily data refresh in the correct order. Used by the cron job and `npm run refresh`.
//   1) players (identity spine)  2) projections  3) harvest drafts  4) recompute ADP consensus
import { syncPlayers } from './syncPlayers.js';
import { syncProjections } from './syncProjections.js';
import { harvestSleeperDrafts } from './harvestSleeperDrafts.js';
import { refreshConsensus } from './refreshConsensus.js';
import { log } from '../lib/log.js';

export async function refreshAll() {
  const out = {};
  try { out.players = await syncPlayers(); } catch (e) { out.players = { error: e.message }; log.error(e); }
  try { out.projections = await syncProjections(); } catch (e) { out.projections = { error: e.message }; log.error(e); }
  try { out.harvest = await harvestSleeperDrafts(); } catch (e) { out.harvest = { error: e.message }; log.error(e); }
  try { out.consensus = await refreshConsensus(); } catch (e) { out.consensus = { error: e.message }; log.error(e); }
  log.info(out, 'refreshAll complete');
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  refreshAll().then(() => process.exit(0)).catch((e) => { log.error(e); process.exit(1); });
}
