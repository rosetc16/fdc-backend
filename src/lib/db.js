// Postgres connection pool + a tiny query helper. Single pool for the whole process.
import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30000,
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
