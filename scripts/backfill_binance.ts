// Backfill underlying_prices from Binance public REST klines. Use when the
// live WS underlying ingest was misbehaving and you need to re-run a backtest
// over historical data that doesn't have rows.
//
// Usage:
//   npx tsx scripts/backfill_binance.ts --from 2026-05-11T00:00:00Z --to 2026-05-12T00:00:00Z
//   docker compose exec app entrypoint shell -c "npx tsx scripts/backfill_binance.ts --from ..."
//
// Binance public REST: GET /api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=...&endTime=...
// 1000-row max per call; the script paginates. No auth required.
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { insertUnderlyingPrices } from '../src/db/repo.js';
import { migrate } from '../src/db/migrate.js';
import { log } from '../src/util/log.js';

const BINANCE_BASES = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
];
const INTERVAL_MS = 60_000;
const MAX_LIMIT = 1000;

interface Args {
  from: Date;
  to: Date;
  symbols: string[];
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  const fromStr = get('--from');
  const toStr = get('--to');
  const symbolsStr = get('--symbols') ?? config.UNDERLYING_SYMBOLS.join(',');
  if (!fromStr || !toStr) {
    // eslint-disable-next-line no-console
    console.error('usage: backfill_binance.ts --from <iso> --to <iso> [--symbols btcusdt,ethusdt,...]');
    process.exit(2);
  }
  return {
    from: new Date(fromStr),
    to: new Date(toStr),
    symbols: symbolsStr.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  };
}

interface Kline {
  ts: number;   // ms epoch of kline open
  close: number;
}

async function fetchKlines(symbolUpper: string, start: number, end: number): Promise<Kline[]> {
  let lastErr: unknown = null;
  for (const base of BINANCE_BASES) {
    const url =
      `${base}/api/v3/klines?symbol=${encodeURIComponent(symbolUpper)}&interval=1m` +
      `&startTime=${start}&endTime=${end}&limit=${MAX_LIMIT}`;
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (!r.ok) {
        lastErr = new Error(`GET ${url} → ${r.status}`);
        continue;
      }
      const arr = (await r.json()) as Array<unknown[]>;
      return arr.map((row) => ({
        ts: Number(row[0]),
        close: Number(row[4]),
      })).filter((k) => Number.isFinite(k.ts) && Number.isFinite(k.close));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('all binance bases failed');
}

async function backfillSymbol(symbol: string, fromMs: number, toMs: number): Promise<number> {
  const symbolUpper = symbol.toUpperCase();
  let cursor = fromMs;
  let total = 0;
  while (cursor < toMs) {
    const end = Math.min(cursor + MAX_LIMIT * INTERVAL_MS - 1, toMs);
    const rows = await fetchKlines(symbolUpper, cursor, end);
    if (rows.length === 0) break;
    await insertUnderlyingPrices(
      rows.map((k) => ({
        symbol,
        source: 'binance-rest',
        ts: k.ts,
        price: k.close,
      })),
    );
    total += rows.length;
    log.info({ symbol, batch: rows.length, total }, 'backfill batch');
    const last = rows[rows.length - 1]!.ts;
    cursor = last + INTERVAL_MS;
    if (rows.length < MAX_LIMIT) break;
  }
  return total;
}

async function main(): Promise<void> {
  await migrate();
  const args = parseArgs();
  log.info(
    { from: args.from.toISOString(), to: args.to.toISOString(), symbols: args.symbols },
    'backfill start',
  );
  const fromMs = args.from.getTime();
  const toMs = args.to.getTime();
  let grand = 0;
  for (const sym of args.symbols) {
    try {
      const n = await backfillSymbol(sym, fromMs, toMs);
      grand += n;
      log.info({ symbol: sym, rows: n }, 'backfill symbol done');
    } catch (e) {
      log.error({ err: e, symbol: sym }, 'backfill symbol failed');
    }
  }
  log.info({ rows: grand }, 'backfill complete');
  await pool.end();
}

main().catch((e) => {
  log.error({ err: e }, 'backfill crashed');
  process.exit(1);
});
