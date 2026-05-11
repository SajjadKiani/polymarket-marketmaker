import type { Inventory, MarketMeta } from '../types.js';
import type { SimFill } from './fills.js';
import { pool } from '../db/pool.js';

type Fill = SimFill;

export function emptyInventory(): Inventory {
  return { yesShares: 0, noShares: 0, cashUsd: 0 };
}

// Apply a fill to inventory. Maker BUY at price p costs p USDC per share, gains 1 share.
// Maker SELL at price p receives p USDC per share, loses 1 share. We allow negative
// share balances (synthetic short via the complement token won't be modeled in v1).
export function applyFill(inv: Inventory, f: Fill, m: MarketMeta): void {
  const isYes = f.tokenId === m.yesTokenId;
  const shareDelta = f.side === 'BUY' ? f.size : -f.size;
  const cashDelta = f.side === 'BUY' ? -f.price * f.size : f.price * f.size;
  if (isYes) inv.yesShares += shareDelta;
  else inv.noShares += shareDelta;
  inv.cashUsd += cashDelta;
}

export type Outcome = 'YES' | 'NO' | 'UNKNOWN';

// Resolve the market by looking up underlying spot at slot_start and slot_end.
// YES wins iff close > open. We use the closest underlying tick to each boundary.
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
     ORDER BY abs(extract(epoch FROM ts - $2::timestamptz))
     LIMIT 1`,
    [symbol, at],
  );
  if (r.rows.length === 0) return null;
  const v = Number(r.rows[0]!.price);
  return Number.isFinite(v) ? v : null;
}

// Settle held shares at the resolved outcome and roll the proceeds into cashUsd.
// YES shares pay $1 if outcome=YES, $0 otherwise; NO shares pay $1 if outcome=NO.
export function settleInventory(inv: Inventory, outcome: Outcome): number {
  let pnl = 0;
  if (outcome === 'YES') pnl += inv.yesShares * 1.0;
  if (outcome === 'NO') pnl += inv.noShares * 1.0;
  inv.cashUsd += pnl;
  inv.yesShares = 0;
  inv.noShares = 0;
  return pnl;
}

