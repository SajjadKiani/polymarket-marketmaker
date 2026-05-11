import { log } from '../util/log.js';
import { migrate } from '../db/migrate.js';
import { pool } from '../db/pool.js';
import { SubscriptionRegistry } from './subscriptions.js';
import { runDiscovery } from './discovery.js';
import { runMarketIngest } from './market_ingest.js';
import { runUnderlyingIngest } from './underlying_ingest.js';

async function main(): Promise<void> {
  await migrate();
  const ctrl = new AbortController();

  process.once('SIGINT', () => {
    log.info('SIGINT received, shutting down');
    ctrl.abort();
  });
  process.once('SIGTERM', () => {
    log.info('SIGTERM received, shutting down');
    ctrl.abort();
  });

  let currentTokens: string[] = [];
  const reg = new SubscriptionRegistry((tokens) => {
    currentTokens = tokens;
  });

  log.info('orchestrator starting');

  const tasks = [
    runDiscovery(reg, ctrl.signal),
    runMarketIngest(reg, ctrl.signal),
    runUnderlyingIngest(ctrl.signal),
  ];

  // Periodic health log so we can eyeball it in tail -f.
  const heartbeat = setInterval(() => {
    log.info({ markets: reg.size(), tokens: currentTokens.length }, 'orchestrator heartbeat');
  }, 30_000);

  try {
    await Promise.all(tasks);
  } finally {
    clearInterval(heartbeat);
    await pool.end();
    log.info('orchestrator stopped');
  }
}

main().catch((e) => {
  log.error({ err: e }, 'orchestrator crashed');
  process.exit(1);
});
