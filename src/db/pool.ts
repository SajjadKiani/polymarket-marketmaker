import pg from 'pg';
import { config } from '../config.js';

// Pg returns NUMERIC as string by default to preserve precision; we keep that
// behavior. Callers explicitly parseFloat() where math is needed.
export const pool = new pg.Pool({
  connectionString: config.PG_URL,
  max: 8,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  // Don't crash on idle-client errors; log and let next query reconnect.
  console.error('pg idle client error', err);
});

export type PoolClient = pg.PoolClient;
