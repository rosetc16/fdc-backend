// Records job runs to the job_runs table so you can see in the DB whether nightly jobs succeeded.
import { q } from './db.js';
import { log } from './log.js';

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
