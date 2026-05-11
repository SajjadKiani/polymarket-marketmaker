// Health / data-quality report. Prints counts and gaps over a configurable
// window (default last 24h) and exits 0 unless something looks very wrong.
import { pool } from '../src/db/pool.js';
import { log } from '../src/util/log.js';

const WINDOW_HOURS = Number(process.env.HEALTH_WINDOW_HOURS ?? 24);
const LATE_OPEN_THRESHOLD_SEC = 30;
const LATE_OPEN_ALARM_PCT = 10;

async function main(): Promise<void> {
  const rows = await pool.query<{
    day: string;
    markets: string;
    snapshots: string;
    deltas: string;
    trades: string;
    underlying: string;
  }>(
    `SELECT date_trunc('day', now()) AS day,
       (SELECT count(*)::text FROM markets
          WHERE slot_start >= now() - ($1::text || ' hours')::interval) AS markets,
       (SELECT count(*)::text FROM book_snapshots
          WHERE ts >= now() - ($1::text || ' hours')::interval) AS snapshots,
       (SELECT count(*)::text FROM book_deltas
          WHERE ts >= now() - ($1::text || ' hours')::interval) AS deltas,
       (SELECT count(*)::text FROM trades
          WHERE ts >= now() - ($1::text || ' hours')::interval) AS trades,
       (SELECT count(*)::text FROM underlying_prices
          WHERE ts >= now() - ($1::text || ' hours')::interval) AS underlying`,
    [String(WINDOW_HOURS)],
  );
  const r = rows.rows[0]!;
  // eslint-disable-next-line no-console
  console.log(`window: last ${WINDOW_HOURS}h`);
  // eslint-disable-next-line no-console
  console.log(
    `  markets=${r.markets}  snapshots=${r.snapshots}  deltas=${r.deltas}  trades=${r.trades}  underlying=${r.underlying}`,
  );

  // Late market openings: first trade more than N seconds after slot_start.
  const late = await pool.query<{ late: string; total: string }>(
    `WITH first_trade AS (
       SELECT m.condition_id,
              m.slot_start,
              (SELECT min(ts) FROM trades t
                 WHERE t.token_id IN (m.yes_token_id, m.no_token_id)
                   AND t.ts >= m.slot_start - interval '5 minutes'
                   AND t.ts <= m.slot_end + interval '5 minutes') AS first_ts
       FROM markets m
       WHERE m.slot_start >= now() - ($1::text || ' hours')::interval
         AND m.slot_end <= now()
     )
     SELECT
       count(*) FILTER (WHERE first_ts IS NOT NULL
                          AND extract(epoch FROM first_ts - slot_start) > $2)::text AS late,
       count(*) FILTER (WHERE first_ts IS NOT NULL)::text AS total
     FROM first_trade`,
    [String(WINDOW_HOURS), String(LATE_OPEN_THRESHOLD_SEC)],
  );
  const lateN = Number(late.rows[0]!.late);
  const totalN = Number(late.rows[0]!.total);
  const pct = totalN > 0 ? (100 * lateN) / totalN : 0;
  // eslint-disable-next-line no-console
  console.log(`  late-open markets: ${lateN}/${totalN} (${pct.toFixed(1)}%)`);

  const reconnects = await pool.query<{ market: string; underlying: string }>(
    `SELECT
       count(*) FILTER (WHERE channel='market' AND started_at >= now() - ($1::text || ' hours')::interval)::text AS market,
       count(*) FILTER (WHERE channel='underlying' AND started_at >= now() - ($1::text || ' hours')::interval)::text AS underlying
     FROM ws_sessions`,
    [String(WINDOW_HOURS)],
  );
  // eslint-disable-next-line no-console
  console.log(
    `  ws sessions opened: market=${reconnects.rows[0]!.market}  underlying=${reconnects.rows[0]!.underlying}`,
  );

  // Storage growth: total table sizes.
  const sizes = await pool.query<{ table: string; size: string }>(
    `SELECT relname AS table, pg_size_pretty(pg_total_relation_size(c.oid)) AS size
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND relname IN ('markets','book_snapshots','book_deltas','trades','underlying_prices','ws_sessions','backtest_runs','backtest_market_summary')
     ORDER BY pg_total_relation_size(c.oid) DESC`,
  );
  // eslint-disable-next-line no-console
  console.log('  table sizes:');
  for (const s of sizes.rows) {
    // eslint-disable-next-line no-console
    console.log(`    ${s.table.padEnd(28)} ${s.size}`);
  }

  await pool.end();

  if (pct > LATE_OPEN_ALARM_PCT) {
    // eslint-disable-next-line no-console
    console.error(`ALARM: late-open market rate ${pct.toFixed(1)}% exceeds ${LATE_OPEN_ALARM_PCT}%`);
    process.exit(2);
  }
}

main().catch((e) => {
  log.error({ err: e }, 'health failed');
  process.exit(1);
});
