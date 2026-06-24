// Applies db/schema.sql to the database. Run once at setup and after schema changes.
//   npm run migrate
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from '../src/lib/db.js';
import { log } from '../src/lib/log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  // citext gives us case-insensitive emails; pgcrypto is handy for ids if needed later.
  await pool.query('CREATE EXTENSION IF NOT EXISTS citext;');
  const sql = await readFile(join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
  log.info('migration applied');
}

migrate().then(() => process.exit(0)).catch((e) => { log.error(e); process.exit(1); });
