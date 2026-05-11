import { feeEqCrypto } from '../polymarket/fees.js';
import { CRYPTO_REBATE_FRACTION, REBATE_MIN_USD } from '../config.js';
import type { SimFill } from './fills.js';
import { pool } from '../db/pool.js';

// Compute rebate for a single (market, run). The pool's denominator is the sum
// of taker fees in that market over the relevant UTC day. We aggregate over the
// market's whole life (which fits inside a single UTC day for 15-min crypto markets).
//
// Slice formula derivation:
//   my_rebate = 0.20 * total_taker_fees * (my_fee_eq / total_fee_eq)
// and in a CLOB, sum(taker_fees) == sum(maker_fee_eq) == total_fee_eq, so:
//   my_rebate = 0.20 * my_fee_eq
//
// We still surface (total_fee_eq, share) so the reports can flag illiquid markets
// where our share is implausibly large (e.g., > 50%).

export interface MarketRebate {
  myFeeEq: number;
  totalFeeEq: number;
  shareOfPool: number;
  rebateUsd: number;
}

export async function computeMarketRebate(
  yesTokenId: string,
  noTokenId: string,
  fromTs: Date,
  toTs: Date,
  myFills: SimFill[],
): Promise<MarketRebate> {
  const r = await pool.query<{ price: string; size: string }>(
    `SELECT price::text, size::text FROM trades
     WHERE token_id IN ($1, $2) AND ts >= $3 AND ts <= $4`,
    [yesTokenId, noTokenId, fromTs, toTs],
  );
  let totalFeeEq = 0;
  for (const row of r.rows) {
    totalFeeEq += feeEqCrypto(Number(row.size), Number(row.price));
  }
  let myFeeEq = 0;
  for (const f of myFills) myFeeEq += feeEqCrypto(f.size, f.price);
  const shareOfPool = totalFeeEq > 0 ? myFeeEq / totalFeeEq : 0;
  const rebateUsd = CRYPTO_REBATE_FRACTION * myFeeEq;
  return { myFeeEq, totalFeeEq, shareOfPool, rebateUsd };
}

// Apply the $1 minimum-payout threshold per UTC day (sum across markets).
export function applyDailyThreshold(rebatesByDay: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [day, total] of rebatesByDay) {
    out.set(day, total >= REBATE_MIN_USD ? total : 0);
  }
  return out;
}
