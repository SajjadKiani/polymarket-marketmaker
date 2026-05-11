import type { BookLevel, BookState, DeltaEvent, SnapshotEvent } from '../types.js';

// In-memory L2 book for a single token. Levels keyed by price-string.
export class Book {
  tokenId: string;
  ts = 0;
  // Maps price -> size. Use number-keyed Map for speed; we keep numbers with up
  // to 4 decimals (tick size 0.01 typical, 0.001 for some markets).
  private bidMap = new Map<number, number>();
  private askMap = new Map<number, number>();

  constructor(tokenId: string) {
    this.tokenId = tokenId;
  }

  applySnapshot(ev: SnapshotEvent): void {
    this.bidMap.clear();
    this.askMap.clear();
    for (const l of ev.bids) if (l.size > 0) this.bidMap.set(l.price, l.size);
    for (const l of ev.asks) if (l.size > 0) this.askMap.set(l.price, l.size);
    this.ts = ev.ts;
  }

  // Returns the previous size at that level so callers (the fill engine) can
  // detect cancels-ahead.
  applyDelta(ev: DeltaEvent): { prev: number; next: number } {
    const map = ev.side === 0 ? this.bidMap : this.askMap;
    const prev = map.get(ev.price) ?? 0;
    if (ev.size <= 0) map.delete(ev.price);
    else map.set(ev.price, ev.size);
    this.ts = ev.ts;
    return { prev, next: ev.size };
  }

  bestBid(): number | null {
    let best = -Infinity;
    for (const p of this.bidMap.keys()) if (p > best) best = p;
    return best === -Infinity ? null : best;
  }

  bestAsk(): number | null {
    let best = Infinity;
    for (const p of this.askMap.keys()) if (p < best) best = p;
    return best === Infinity ? null : best;
  }

  mid(): number | null {
    const b = this.bestBid();
    const a = this.bestAsk();
    if (b == null || a == null) return null;
    return (b + a) / 2;
  }

  // Sum of size at price >= p on the bid side (or <= p on the ask side).
  // Used to seed queue_ahead when a maker quote is placed.
  sizeAtOrBetter(side: 'BUY' | 'SELL', price: number): number {
    let total = 0;
    if (side === 'BUY') {
      for (const [p, sz] of this.bidMap) if (p >= price) total += sz;
    } else {
      for (const [p, sz] of this.askMap) if (p <= price) total += sz;
    }
    return total;
  }

  sizeAt(side: 'BUY' | 'SELL', price: number): number {
    return (side === 'BUY' ? this.bidMap.get(price) : this.askMap.get(price)) ?? 0;
  }

  snapshot(): BookState {
    const bids: BookLevel[] = [...this.bidMap.entries()]
      .map(([price, size]) => ({ price, size }))
      .sort((a, b) => b.price - a.price);
    const asks: BookLevel[] = [...this.askMap.entries()]
      .map(([price, size]) => ({ price, size }))
      .sort((a, b) => a.price - b.price);
    return { tokenId: this.tokenId, ts: this.ts, bids, asks };
  }
}
