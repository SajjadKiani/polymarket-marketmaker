import type { Quote, TradeEvent, DeltaEvent } from '../types.js';
import type { Book } from './book.js';

// State for one of our simulated quotes resting on the book.
export interface RestingQuote {
  q: Quote;
  remaining: number;     // size still un-filled
  queueAhead: number;    // size in front of us at this price + better prices on our side
  placedTs: number;
}

export interface SimFill {
  ts: number;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
}

// Place a new simulated quote: snapshot the book and compute initial queue_ahead.
export function placeQuote(book: Book, q: Quote, ts: number): RestingQuote {
  const queueAhead = book.sizeAtOrBetter(q.side, q.price);
  return { q, remaining: q.size, queueAhead, placedTs: ts };
}

// Consume from queue first, then from our quote.
// Returns the actual taker volume the quote+queue absorbed (queueEat + fill).
// `filled` is just the fill portion; that's what creates a SimFill row.
function consume(rq: RestingQuote, takerSize: number): { absorbed: number; filled: number } {
  let remaining = takerSize;
  let queueEat = 0;
  if (rq.queueAhead > 0) {
    queueEat = Math.min(rq.queueAhead, remaining);
    rq.queueAhead -= queueEat;
    remaining -= queueEat;
  }
  const fill = Math.min(rq.remaining, remaining);
  rq.remaining -= fill;
  return { absorbed: queueEat + fill, filled: fill };
}

// A taker BUY print at price P qualifies a SELL quote at price <= P (taker lifted ask).
// A taker SELL print at price P qualifies a BUY quote at price >= P (taker hit bid).
function qualifies(rq: RestingQuote, ev: TradeEvent): boolean {
  if (rq.q.side === 'SELL') return ev.takerSide === 0 && ev.price >= rq.q.price;
  return ev.takerSide === 1 && ev.price <= rq.q.price;
}

// Distribute a taker print across our resting quotes at the same token+side that
// qualify. Most-aggressive quote (closest to the print price) goes first.
export function applyTrade(resting: RestingQuote[], ev: TradeEvent): SimFill[] {
  const candidates = resting
    .filter((rq) => rq.q.tokenId === ev.tokenId && qualifies(rq, ev) && rq.remaining > 0)
    .sort((a, b) =>
      a.q.side === 'SELL' ? a.q.price - b.q.price : b.q.price - a.q.price,
    );

  const fills: SimFill[] = [];
  let remaining = ev.size;
  for (const rq of candidates) {
    if (remaining <= 0) break;
    const { absorbed, filled } = consume(rq, remaining);
    if (filled > 0) {
      fills.push({
        ts: ev.ts,
        tokenId: rq.q.tokenId,
        side: rq.q.side,
        price: rq.q.price,
        size: filled,
      });
    }
    remaining -= absorbed;
    if (absorbed <= 0) break; // queue saturation reached and nothing filled — others won't either
  }
  return fills;
}

// When a book delta shrinks a level on our side with no corresponding trade in
// the immediate vicinity, treat the decrement as a cancel-ahead and reduce
// queueAhead at qualifying levels. This is the realism refinement that makes the
// fill model less optimistic than naive "any qualifying print fills us."
export function applyCancelAhead(
  resting: RestingQuote[],
  ev: DeltaEvent,
  prevSize: number,
  recentTrades: TradeEvent[],
): void {
  const shrink = prevSize - ev.size;
  if (shrink <= 0) return;

  // If there's a trade within ±50ms at this price level on the matching side,
  // the decrement is consumption (already handled by applyTrade), not a cancel.
  const matching = recentTrades.find(
    (t) =>
      t.tokenId === ev.tokenId &&
      Math.abs(t.ts - ev.ts) <= 50 &&
      Math.abs(t.price - ev.price) < 1e-9 &&
      ((ev.side === 0 && t.takerSide === 1) || (ev.side === 1 && t.takerSide === 0)),
  );
  if (matching) return;

  for (const rq of resting) {
    if (rq.q.tokenId !== ev.tokenId) continue;
    const sideMatch =
      (rq.q.side === 'BUY' && ev.side === 0) || (rq.q.side === 'SELL' && ev.side === 1);
    if (!sideMatch) continue;
    const better =
      (rq.q.side === 'BUY' && ev.price >= rq.q.price) ||
      (rq.q.side === 'SELL' && ev.price <= rq.q.price);
    if (!better) continue;
    rq.queueAhead = Math.max(0, rq.queueAhead - shrink);
  }
}
