import { pool } from '../db/pool.js';
import { log } from '../util/log.js';
import type { RunResult } from './engine.js';
import type { Strategy } from '../types.js';

export async function persistRun(
  strategy: Strategy,
  from: Date,
  to: Date,
  result: RunResult,
  notes = '',
): Promise<number> {
  const insert = await pool.query<{ id: string }>(
    `INSERT INTO backtest_runs
       (strategy, params, data_from, data_to, capital_usd,
        net_pnl_usd, gross_rebate_usd, inventory_pnl_usd, fills, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      strategy.name,
      strategy.params,
      from,
      to,
      result.capitalUsd,
      result.netPnlUsd,
      result.grossRebateUsd,
      result.inventoryPnlUsd,
      result.fills,
      notes,
    ],
  );
  const runId = Number(insert.rows[0]!.id);

  for (const m of result.markets) {
    if (m.fills === 0 && m.totalFeeEq === 0) continue;
    await pool.query(
      `INSERT INTO backtest_market_summary
         (run_id, condition_id, fills, my_fee_eq, total_fee_eq,
          rebate_usd, inv_pnl_usd, quote_dollar_seconds)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (run_id, condition_id) DO UPDATE SET
         fills = EXCLUDED.fills,
         my_fee_eq = EXCLUDED.my_fee_eq,
         total_fee_eq = EXCLUDED.total_fee_eq,
         rebate_usd = EXCLUDED.rebate_usd,
         inv_pnl_usd = EXCLUDED.inv_pnl_usd,
         quote_dollar_seconds = EXCLUDED.quote_dollar_seconds`,
      [
        runId,
        m.meta.conditionId,
        m.fills,
        m.myFeeEq,
        m.totalFeeEq,
        m.rebateUsd,
        m.invPnlUsd,
        m.quoteDollarSeconds,
      ],
    );
  }
  log.info({ runId }, 'backtest persisted');
  return runId;
}

export function printSummary(result: RunResult, strategy: Strategy, from: Date, to: Date): void {
  const total = result.marketsEligible + result.skippedUnknownOutcome;
  const skippedPct = total > 0 ? (100 * result.skippedUnknownOutcome) / total : 0;
  const lines: string[] = [];
  lines.push('');
  lines.push(`backtest: strategy=${strategy.name}`);
  lines.push(`window:   ${from.toISOString()} → ${to.toISOString()}`);
  lines.push(`capital:  $${result.capitalUsd.toFixed(2)}`);
  lines.push(
    `markets:  ${result.marketsEligible} eligible / ${result.skippedUnknownOutcome} skipped ` +
      `(${skippedPct.toFixed(1)}% missing underlying)`,
  );
  lines.push(`fills:    ${result.fills}`);
  lines.push(`gross rebate:  $${result.grossRebateUsd.toFixed(4)}`);
  lines.push(`inventory P&L: $${result.inventoryPnlUsd.toFixed(4)}`);
  lines.push(`NET P&L:       $${result.netPnlUsd.toFixed(4)}`);
  if (skippedPct > 5) {
    lines.push('');
    lines.push(`WARNING: ${skippedPct.toFixed(1)}% of markets were skipped due to missing`);
    lines.push('  underlying-price data. Headline numbers may be unrepresentative.');
    lines.push('  Backfill underlying_prices (scripts/backfill_binance.ts) and re-run.');
  }
  lines.push('');
  lines.push('caveat: queue-position fill model assumes zero quote latency and');
  lines.push('  no adverse selection. Subtract ~30% from headline net P&L as a');
  lines.push('  rule-of-thumb haircut before judging the live edge.');
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}
