import type { Strategy, MarketState, Quote, Inventory } from '../../types.js';

// Skews the quote pair toward unwinding inventory. When we're long YES shares,
// quote sells more aggressively (closer to mid) and quote buys less aggressively
// (further below mid). Mirrors when long NO. Caps total inventory at maxInventoryUsd
// — refuse to add to the heavy side beyond that.
export interface InventorySkewParams {
  spreadBps: number;
  sizeUsd: number;
  refreshMs: number;
  minPrice: number;
  maxPrice: number;
  maxInventoryUsd: number;
  skewBpsPerPct: number; // bps tightening per 1% of (inventory_usd / maxInventoryUsd)
}

const DEFAULT_PARAMS: InventorySkewParams = {
  spreadBps: 200,
  sizeUsd: 10,
  refreshMs: 5_000,
  minPrice: 0.05,
  maxPrice: 0.95,
  maxInventoryUsd: 100,
  skewBpsPerPct: 2,
};

function clamp(p: number, lo = 0.01, hi = 0.99): number {
  return Math.max(lo, Math.min(hi, Math.round(p * 100) / 100));
}

export function inventorySkew(partial: Partial<InventorySkewParams> = {}): Strategy {
  const params: InventorySkewParams = { ...DEFAULT_PARAMS, ...partial };
  return {
    name: 'inventory_skew',
    params: params as unknown as Record<string, unknown>,
    onBookUpdate(state: MarketState, inv: Inventory): Quote[] {
      const out: Quote[] = [];
      for (const book of [state.yesBook, state.noBook]) {
        const isYes = book.tokenId === state.meta.yesTokenId;
        const heldShares = isYes ? inv.yesShares : inv.noShares;
        const mid = midOf(book);
        if (mid == null) continue;
        if (mid < params.minPrice || mid > params.maxPrice) continue;
        // Inventory dollar load, signed (positive = long this token).
        const invDollars = heldShares * mid;
        const loadPct = invDollars / params.maxInventoryUsd; // can exceed 1
        const skewBps = params.skewBpsPerPct * loadPct * 100;
        const half = mid * (params.spreadBps / 10_000);
        const tighten = mid * (skewBps / 10_000);
        // Long → tighten sell (closer to mid), widen buy.
        const bidPrice = clamp(mid - half - tighten);
        const askPrice = clamp(mid + half - tighten);
        if (bidPrice >= askPrice) continue;

        const overCap = Math.abs(invDollars) >= params.maxInventoryUsd;
        const wouldAddLong = invDollars >= 0;
        if (!(overCap && wouldAddLong)) {
          out.push({
            tokenId: book.tokenId,
            side: 'BUY',
            price: bidPrice,
            size: params.sizeUsd / bidPrice,
            ttlMs: params.refreshMs,
          });
        }
        if (!(overCap && !wouldAddLong)) {
          out.push({
            tokenId: book.tokenId,
            side: 'SELL',
            price: askPrice,
            size: params.sizeUsd / askPrice,
            ttlMs: params.refreshMs,
          });
        }
      }
      return out;
    },
  };
}

function midOf(book: { bids: { price: number }[]; asks: { price: number }[] }): number | null {
  if (!book.bids.length || !book.asks.length) return null;
  return (book.bids[0]!.price + book.asks[0]!.price) / 2;
}
