import type { Strategy, MarketState, Quote, Inventory } from '../../types.js';

// Symmetric quoting around mid on both YES and NO tokens.
// Skips quoting entirely when the spread is so tight (or so wide) that the bid/ask
// midpoint is undefined or too close to 0/1 — both signal a market we don't want.
export interface FlatMidParams {
  spreadBps: number;     // distance from mid, in basis points (100 bps = 1¢ at mid=0.5)
  sizeUsd: number;       // notional per side. shares = sizeUsd / price.
  refreshMs: number;     // re-quote cadence
  minPrice: number;      // skip if mid < this
  maxPrice: number;      // skip if mid > this
}

const DEFAULT_PARAMS: FlatMidParams = {
  spreadBps: 200,
  sizeUsd: 10,
  refreshMs: 5_000,
  minPrice: 0.05,
  maxPrice: 0.95,
};

function clampPrice(p: number): number {
  return Math.max(0.01, Math.min(0.99, Math.round(p * 100) / 100));
}

export function flatMid(partial: Partial<FlatMidParams> = {}): Strategy {
  const params: FlatMidParams = { ...DEFAULT_PARAMS, ...partial };
  return {
    name: 'flat_mid',
    params: params as unknown as Record<string, unknown>,
    onBookUpdate(state: MarketState, _inv: Inventory): Quote[] {
      const out: Quote[] = [];
      for (const book of [state.yesBook, state.noBook]) {
        if (!book.bids.length || !book.asks.length) continue;
        const bid = book.bids[0]!.price;
        const ask = book.asks[0]!.price;
        const mid = (bid + ask) / 2;
        if (mid < params.minPrice || mid > params.maxPrice) continue;
        const delta = mid * (params.spreadBps / 10_000);
        const quoteBidPrice = clampPrice(mid - delta);
        const quoteAskPrice = clampPrice(mid + delta);
        if (quoteBidPrice >= quoteAskPrice) continue;
        const buySize = params.sizeUsd / quoteBidPrice;
        const sellSize = params.sizeUsd / quoteAskPrice;
        out.push({
          tokenId: book.tokenId,
          side: 'BUY',
          price: quoteBidPrice,
          size: buySize,
          ttlMs: params.refreshMs,
        });
        out.push({
          tokenId: book.tokenId,
          side: 'SELL',
          price: quoteAskPrice,
          size: sellSize,
          ttlMs: params.refreshMs,
        });
      }
      return out;
    },
  };
}
