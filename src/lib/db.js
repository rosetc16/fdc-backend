// Postgres connection pool + a tiny query helper. Single pool for the whole process.
import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  // Headroom for traffic spikes. With the player-pack cache in front of the DB the steady-state need is small,
  // but bursts (a lot of people opening drafts at once) shouldn't queue behind a 10-connection ceiling.
  // Keep this comfortably under the Postgres plan's own connection limit.
  max: Number(process.env.PG_POOL_MAX || 20),
  idleTimeoutMillis: 30000,
  // Under a real spike, waiting forever for a connection is worse than failing fast: the request piles up,
  // the client retries, and the queue grows. Time out and surface an error instead of hanging.
  connectionTimeoutMillis: 8000,
});

pool.on('error', (err) => {
  // Don't crash the process on an idle client error; log and move on.
  console.error('[db] idle client error', err.message);
});

export const q = (text, params) => pool.query(text, params);

// Run a function inside a transaction, auto rollback on throw.
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
