// Records job runs to the job_runs table so you can see in the DB whether nightly jobs succeeded.
import { pool, q } from './db.js';
import { log } from './log.js';

/* ⭐⭐⭐ RUN A JOB ON EXACTLY ONE INSTANCE, WHATEVER THE INSTANCE COUNT.
 *
 * Every data job here is scheduled by an in-process cron, and several also run as a catch-up shortly after
 * boot. With one web instance that is fine. The moment the app scales out — which is the FIRST thing that
 * happens under a traffic spike, and the whole point of being ready for one — every instance runs every
 * job: N nightly refreshes, N harvests crawling the same Sleeper league graph, N writers racing on the same
 * adp_observations rows. The two consequences are not symmetric. Duplicate DB writes are wasteful; N
 * simultaneous harvests are dangerous, because they multiply upstream traffic against the same ~1000/min
 * Sleeper ceiling that the live-draft path depends on. Autoscaling would take the app down by doing
 * exactly what it was told to do.
 *
 * A Postgres ADVISORY LOCK fixes it with no new infrastructure: it is held on a connection, released
 * automatically if that instance dies mid-job (no stuck-lock recovery to write), and needs no table. We
 * take it with the non-blocking pg_try_advisory_lock, so a second instance skips the run instead of
 * queueing up to repeat it a minute later.
 */
function lockKeyFor(name) {
  // Stable 32-bit key from the job name (FNV-1a), so the same job always maps to the same lock.
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h | 0; // signed 32-bit, which is what pg_try_advisory_lock(int) wants
}

export async function withJobLock(name, fn) {
  let client;
  try { client = await pool.connect(); } catch (e) {
    log.error({ err: e.message, job: name }, 'job lock: could not get a connection — running unguarded');
    return fn();
  }
  const key = lockKeyFor(name);
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS got', [key]);
    if (!rows[0] || rows[0].got !== true) {
      log.info({ job: name }, 'job lock: another instance is running this job — skipping');
      return { skipped: 'lock held by another instance' };
    }
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

export async function recordJob(job, ok, detail) {
  try {
    await q(
      `INSERT INTO job_runs (job, ok, detail, started_at, finished_at)
       VALUES ($1, $2, $3, now(), now())`,
      [job, ok, detail ? JSON.stringify(detail) : null]
    );
  } catch (e) {
    log.error({ err: e.message }, 'failed to record job run');
  }
}
