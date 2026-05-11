import { Command } from 'commander';
import { migrate } from '../db/migrate.js';
import { pool } from '../db/pool.js';
import { log } from '../util/log.js';
import { runBacktest } from './engine.js';
import { persistRun, printSummary } from './report.js';
import { flatMid } from './strategies/flat_mid.js';
import { inventorySkew } from './strategies/inventory_skew.js';
import type { Strategy } from '../types.js';

const program = new Command();

program
  .name('bt')
  .description('Polymarket maker-rebate backtester');

program
  .command('run')
  .requiredOption('--strategy <name>', 'flat_mid | inventory_skew')
  .requiredOption('--from <iso>', 'window start, ISO 8601 UTC')
  .requiredOption('--to <iso>', 'window end, ISO 8601 UTC')
  .option('--capital <usd>', 'simulated capital', (v) => Number(v), 1000)
  .option('--spread-bps <bps>', 'quote spread basis points', (v) => Number(v), 200)
  .option('--size-usd <usd>', 'notional per side', (v) => Number(v), 10)
  .option('--refresh-ms <ms>', 're-quote cadence', (v) => Number(v), 5000)
  .option('--max-inventory-usd <usd>', 'inventory_skew only', (v) => Number(v), 100)
  .option('--skew-bps-per-pct <bps>', 'inventory_skew only', (v) => Number(v), 2)
  .option('--no-persist', 'skip writing backtest_runs row')
  .action(async (opts) => {
    await migrate();
    const from = new Date(opts.from);
    const to = new Date(opts.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new Error('invalid --from/--to ISO timestamp');
    }
    const strategy = buildStrategy(opts);
    const result = await runBacktest({
      strategy,
      capitalUsd: opts.capital,
      from,
      to,
    });
    printSummary(result, strategy, from, to);
    if (opts.persist !== false) {
      await persistRun(strategy, from, to, result, '');
    }
    await pool.end();
  });

program
  .command('list')
  .description('list recent backtest runs')
  .option('--limit <n>', 'number of runs to show', (v) => Number(v), 20)
  .action(async (opts) => {
    const r = await pool.query<{
      id: string;
      created_at: string;
      strategy: string;
      data_from: string;
      data_to: string;
      net_pnl_usd: string;
      gross_rebate_usd: string;
      inventory_pnl_usd: string;
      fills: number;
    }>(
      `SELECT id, created_at, strategy, data_from, data_to,
              net_pnl_usd, gross_rebate_usd, inventory_pnl_usd, fills
       FROM backtest_runs ORDER BY id DESC LIMIT $1`,
      [opts.limit],
    );
    for (const row of r.rows) {
      // eslint-disable-next-line no-console
      console.log(
        `#${row.id}  ${row.strategy.padEnd(16)}  ${row.data_from}→${row.data_to}  ` +
          `fills=${row.fills}  rebate=$${Number(row.gross_rebate_usd).toFixed(4)}  ` +
          `inv=$${Number(row.inventory_pnl_usd).toFixed(4)}  net=$${Number(row.net_pnl_usd).toFixed(4)}`,
      );
    }
    await pool.end();
  });

function buildStrategy(opts: Record<string, unknown>): Strategy {
  const name = String(opts.strategy);
  if (name === 'flat_mid') {
    return flatMid({
      spreadBps: opts.spreadBps as number,
      sizeUsd: opts.sizeUsd as number,
      refreshMs: opts.refreshMs as number,
    });
  }
  if (name === 'inventory_skew') {
    return inventorySkew({
      spreadBps: opts.spreadBps as number,
      sizeUsd: opts.sizeUsd as number,
      refreshMs: opts.refreshMs as number,
      maxInventoryUsd: opts.maxInventoryUsd as number,
      skewBpsPerPct: opts.skewBpsPerPct as number,
    });
  }
  throw new Error(`unknown strategy: ${name}`);
}

program.parseAsync(process.argv).catch((e) => {
  log.error({ err: e }, 'backtest cli failed');
  process.exit(1);
});
