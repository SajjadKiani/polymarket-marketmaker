import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './pool.js';
import { log } from '../util/log.js';

const here = dirname(fileURLToPath(import.meta.url));
const sqlDir = join(here, '..', '..', 'sql');

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedSet(): Promise<Set<string>> {
  const r = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  return new Set(r.rows.map((x) => x.filename));
}

export async function migrate(): Promise<void> {
  await ensureMigrationsTable();
  const applied = await appliedSet();
  const files = (await readdir(sqlDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (applied.has(f)) {
      log.debug({ f }, 'migration already applied');
      continue;
    }
    const sql = await readFile(join(sqlDir, f), 'utf8');
    log.info({ f }, 'applying migration');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [f]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  log.info({ count: files.length }, 'migrations complete');
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (isMain) {
  migrate()
    .then(() => pool.end())
    .catch((e) => {
      log.error({ err: e }, 'migration failed');
      process.exit(1);
    });
}
