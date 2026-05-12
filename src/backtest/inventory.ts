import type { Inventory, MarketMeta } from '../types.js';
import type { SimFill } from './fills.js';
import { pool } from '../db/pool.js';

type Fill = SimFill;

export function emptyInventory(): Inventory {
  return { yesShares: 0, noShares: 0, cashUsd: 0 };
}

export function applyFill(inv: Inventory, f: Fill, m: MarketMeta): void {
  const isYes = f.tokenId === m.yesTokenId;
  const shareDelta = f.side === 'BUY' ? f.size : -f.size;
  const cashDelta = f.side === 'BUY' ? -f.price * f.size : f.price * f.size;
  if (isYes) inv.yesShares += shareDelta;
  else inv.noShares += shareDelta;
  inv.cashUsd += cashDelta;
}

export type Outcome = 'YES' | 'NO' | 'UNKNOWN';

// Resolve via underlying spot at slot_start and slot_end. Chainlink is preferred
// (matches the actual resolution source) but Binance is accepted as a fallback.
export async function resolveOutcome(m: MarketMeta): Promise<Outcome> {
  if (!m.underlying) return 'UNKNOWN';
  const symbol = `${m.underlying.toLowerCase()}usdt`;

  const open = await closestPrice(symbol, m.slotStart);
  const close = await closestPrice(symbol, m.slotEnd);
  if (open == null || close == null) return 'UNKNOWN';
  return close > open ? 'YES' : 'NO';
}

async function closestPrice(symbol: string, at: Date): Promise<number | null> {
  const r = await pool.query<{ price: string }>(
    `SELECT price::text FROM underlying_prices
     WHERE symbol = $1 AND ts BETWEEN $2::timestamptz - interval '60 seconds'
                                 AND $2::timestamptz + interval '60 seconds'
     ORDER BY
       CASE WHEN source = 'chainlink' THEN 0 ELSE 1 END,
       abs(extract(epoch FROM ts - $2::timestamptz))
     LIMIT 1`,
    [symbol, at],
  );
  if (r.rows.length === 0) return null;
  const v = Number(r.rows[0]!.price);
  return Number.isFinite(v) ? v : null;
}

// Settle. Returns the settlement cash delta.
// IMPORTANT: callers MUST handle outcome='UNKNOWN' as "skip this market" — do not
// invoke settleInventory at all in that case, otherwise positions silently vanish
// and shorts retain the proceeds with no offsetting liability.
export function settleInventory(inv: Inventory, outcome: Outcome): number {
  if (outcome === 'UNKNOWN') {
    throw new Error('settleInventory called with UNKNOWN; caller must skip');
  }
  let pnl = 0;
  if (outcome === 'YES') pnl += inv.yesShares * 1.0;
  if (outcome === 'NO') pnl += inv.noShares * 1.0;
  inv.cashUsd += pnl;
  inv.yesShares = 0;
  inv.noShares = 0;
  return pnl;
}
