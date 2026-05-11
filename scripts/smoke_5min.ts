// Boots the full orchestrator for 5 minutes and asserts that the basic data
// surfaces have rows. Exits non-zero on assertion failure so it can be wired
// into CI / cron.
import { setTimeout as wait } from 'node:timers/promises';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { SubscriptionRegistry } from '../src/ingest/subscriptions.js';
import { runDiscovery } from '../src/ingest/discovery.js';
import { runMarketIngest } from '../src/ingest/market_ingest.js';
import { runUnderlyingIngest } from '../src/ingest/underlying_ingest.js';
import { log } from '../src/util/log.js';

const RUN_MS = 5 * 60 * 1000;

async function main(): Promise<void> {
  await migrate();
  const ctrl = new AbortController();
  const reg = new SubscriptionRegistry(() => {});

  const tasks = Promise.allSettled([
    runDiscovery(reg, ctrl.signal),
    runMarketIngest(reg, ctrl.signal),
    runUnderlyingIngest(ctrl.signal),
  ]);

  log.info({ ms: RUN_MS }, 'smoke_5min running');
  await wait(RUN_MS);
  ctrl.abort();
  await tasks;

  const checks = await runChecks();
  await pool.end();
  let failed = 0;
  for (const c of checks) {
    const status = c.ok ? 'OK   ' : 'FAIL ';
    // eslint-disable-next-line no-console
    console.log(`${status} ${c.name}: ${c.detail}`);
    if (!c.ok) failed++;
  }
  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.error(`smoke_5min failed: ${failed} assertion(s)`);
    process.exit(2);
  }
  // eslint-disable-next-line no-console
  console.log('smoke_5min OK');
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function runChecks(): Promise<Check[]> {
  const checks: Check[] = [];

  const markets = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM markets WHERE discovered_at >= now() - interval '10 minutes'`,
  );
  checks.push({
    name: 'markets discovered',
    ok: Number(markets.rows[0]!.n) >= 1,
    detail: `${markets.rows[0]!.n} rows in last 10m`,
  });

  const snapshots = await pool.query<{ tokens: string; total: string }>(
    `SELECT count(DISTINCT token_id)::text AS tokens, count(*)::text AS total
     FROM book_snapshots WHERE ts >= now() - interval '10 minutes'`,
  );
  checks.push({
    name: 'book snapshots',
    ok: Number(snapshots.rows[0]!.tokens) >= 1 && Number(snapshots.rows[0]!.total) >= 1,
    detail: `${snapshots.rows[0]!.tokens} tokens / ${snapshots.rows[0]!.total} rows`,
  });

  const deltas = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM book_deltas WHERE ts >= now() - interval '10 minutes'`,
  );
  checks.push({
    name: 'book deltas',
    ok: Number(deltas.rows[0]!.n) >= 1,
    detail: `${deltas.rows[0]!.n} rows`,
  });

  const underlying = await pool.query<{ symbols: string; rows: string }>(
    `SELECT count(DISTINCT symbol)::text AS symbols, count(*)::text AS rows
     FROM underlying_prices WHERE ts >= now() - interval '10 minutes'`,
  );
  checks.push({
    name: 'underlying prices',
    ok: Number(underlying.rows[0]!.symbols) >= 1,
    detail: `${underlying.rows[0]!.symbols} symbols / ${underlying.rows[0]!.rows} rows`,
  });

  const sessions = await pool.query<{ market: string; underlying: string }>(
    `SELECT
       count(*) FILTER (WHERE channel='market')::text AS market,
       count(*) FILTER (WHERE channel='underlying')::text AS underlying
     FROM ws_sessions WHERE started_at >= now() - interval '10 minutes'`,
  );
  checks.push({
    name: 'ws sessions started',
    ok: Number(sessions.rows[0]!.market) >= 1 && Number(sessions.rows[0]!.underlying) >= 1,
    detail: `market=${sessions.rows[0]!.market} underlying=${sessions.rows[0]!.underlying}`,
  });

  return checks;
}

main().catch((e) => {
  log.error({ err: e }, 'smoke_5min crashed');
  process.exit(1);
});
