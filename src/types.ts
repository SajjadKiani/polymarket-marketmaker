export type Side = 'BUY' | 'SELL';

export interface BookLevel {
  price: number;
  size: number;
}

export interface BookState {
  tokenId: string;
  ts: number; // ms epoch of latest update
  bids: BookLevel[]; // sorted desc by price
  asks: BookLevel[]; // sorted asc by price
}

export interface MarketMeta {
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  question: string;
  underlying: string | null;
  slotStart: Date;
  slotEnd: Date;
  feeRateBps: number;
  rebateEligible: boolean;
}

export interface MarketState {
  meta: MarketMeta;
  yesBook: BookState;
  noBook: BookState;
  lastTradePriceYes: number | null;
  lastTradePriceNo: number | null;
  now: number; // ms epoch of the current replay event
}

export interface Inventory {
  // shares held on each token. Positive = long (we bought), negative not used in v1
  // because we can't go short without already holding (no margin in this sim).
  yesShares: number;
  noShares: number;
  cashUsd: number;
}

export interface Quote {
  tokenId: string;
  side: Side;
  price: number; // 0..1
  size: number;  // shares
  ttlMs: number; // how long the quote should sit before being refreshed
}

export interface Strategy {
  name: string;
  params: Record<string, unknown>;
  onBookUpdate(state: MarketState, inv: Inventory): Quote[];
}

// ---- raw event types streamed from the CLOB market WS ----

export type IngestEventKind = 'snapshot' | 'delta' | 'trade';

export interface SnapshotEvent {
  kind: 'snapshot';
  tokenId: string;
  ts: number;
  seq: number;
  bids: BookLevel[];
  asks: BookLevel[];
  reason: 'initial_dump' | 'reconnect' | 'periodic';
}

export interface DeltaEvent {
  kind: 'delta';
  tokenId: string;
  ts: number;
  seq: number;
  side: 0 | 1; // 0=bid, 1=ask
  price: number;
  size: number; // absolute size at that level (0 = level removed)
}

export interface TradeEvent {
  kind: 'trade';
  tokenId: string;
  ts: number;
  seq: number;
  price: number;
  size: number;
  takerSide: 0 | 1; // 0=BUY (lifted ask), 1=SELL (hit bid)
  tradeId?: string;
}

export type IngestEvent = SnapshotEvent | DeltaEvent | TradeEvent;
