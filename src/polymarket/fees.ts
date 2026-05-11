import { CRYPTO_FEE_RATE, CRYPTO_REBATE_FRACTION } from '../config.js';

// Fee per trade in crypto markets: size * rate * p * (1-p). Exponent = 1.
// `size` is in shares (1 share = $1 at resolution); `p` is the share price 0..1.
export function feeEqCrypto(size: number, price: number): number {
  if (size <= 0 || price <= 0 || price >= 1) return 0;
  return size * CRYPTO_FEE_RATE * price * (1 - price);
}

// Convenience: given a list of trade prints, sum fee-equivalent across all of them.
export function totalFeeEqCrypto(prints: Array<{ size: number; price: number }>): number {
  let s = 0;
  for (const t of prints) s += feeEqCrypto(t.size, t.price);
  return s;
}

// rebate = (my_fee_eq / total_fee_eq) * 0.20 * total_taker_fees.
// And in a CLOB, sum(taker_fees) == sum(maker_fee_eq), so this simplifies to:
// rebate_usd = 0.20 * my_fee_eq.
//
// More precisely: if you assume every taker print is exactly one taker paying fee F,
// then total_taker_fees = total_fee_eq. So your slice = 0.20 * (my_fee_eq / total_fee_eq) * total_fee_eq
// = 0.20 * my_fee_eq. We retain the fraction form below for callers that want to surface
// the share of the pool as a metric.
export function rebateUsd(myFeeEq: number): number {
  return CRYPTO_REBATE_FRACTION * myFeeEq;
}

export function poolShare(myFeeEq: number, totalFeeEq: number): number {
  if (totalFeeEq <= 0) return 0;
  return myFeeEq / totalFeeEq;
}
