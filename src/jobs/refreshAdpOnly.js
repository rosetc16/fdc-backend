// Fast ADP refresh: pulls Sleeper's PUBLISHED ADP and recomputes consensus — WITHOUT the slow harvest
// crawl. This is the quickest way to get clean, real Sleeper ADP into the board (run when the full daily
// refresh is overkill, or the harvest crawl is timing out in a shell). Order: published ADP -> consensus.
//
// Run with:  npm run adp
import { syncPublishedAdp } from './syncPublishedAdp.js';
import { refreshConsensus } from './refreshConsensus.js';
import { log } from '../lib/log.js';

export async function refreshAdpOnly() {
  const out = {};
  try { out.publishedAdp = await syncPublishedAdp(); } catch (e) { out.publishedAdp = { error: e.message }; log.error(e); }
  try { out.consensus = await refreshConsensus(); } catch (e) { out.consensus = { error: e.message }; log.error(e); }
  log.info(out, 'refreshAdpOnly complete');
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  refreshAdpOnly().then((d) => { console.log(JSON.stringify(d, null, 2)); process.exit(0); }).catch((e) => { log.error(e); process.exit(1); });
}
