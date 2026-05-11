import { pool } from '../db/pool.js';
import type {
  DeltaEvent,
  IngestEvent,
  MarketMeta,
  SnapshotEvent,
  TradeEvent,
} from '../types.js';

export interface MarketWindow {
  meta: MarketMeta;
  from: Date;
  to: Date;
}

export async function listMarketsInWindow(from: Date, to: Date): Promise<MarketMeta[]> {
  const r = await pool.query<{
    condition_id: string;
    yes_token_id: string;
    no_token_id: string;
    question: string;
    underlying: string | null;
    slot_start: string;
    slot_end: string;
    fee_rate_bps: number;
    rebate_eligible: boolean;
  }>(
    `SELECT condition_id, yes_token_id, no_token_id, question, underlying,
            slot_start, slot_end, fee_rate_bps, rebate_eligible
     FROM markets
     WHERE slot_start >= $1 AND slot_end <= $2
     ORDER BY slot_start`,
    [from, to],
  );
  return r.rows.map((row) => ({
    conditionId: row.condition_id,
    yesTokenId: row.yes_token_id,
    noTokenId: row.no_token_id,
    question: row.question,
    underlying: row.underlying,
    slotStart: new Date(row.slot_start),
    slotEnd: new Date(row.slot_end),
    feeRateBps: row.fee_rate_bps,
    rebateEligible: row.rebate_eligible,
  }));
}

// Stream all events for one market (both YES and NO tokens) in (ts, seq) order.
// We pull each event class with a single query and merge via a small heap because
// memory-resident merge of three sorted sequences is fast and the per-market
// volume for a 15-min slot is small (<10k events typical).
export async function* streamMarketEvents(m: MarketMeta): AsyncGenerator<IngestEvent> {
  const tokens = [m.yesTokenId, m.noTokenId];
  const windowStart = new Date(m.slotStart.getTime() - 5 * 60_000);
  const windowEnd = new Date(m.slotEnd.getTime() + 5 * 60_000);

  const [snapsR, deltasR, tradesR] = await Promise.all([
    pool.query<{ token_id: string; ts: string; seq: string; bids: string; asks: string; reason: string }>(
      `SELECT token_id, ts, seq, bids::text, asks::text, reason FROM book_snapshots
       WHERE token_id = ANY($1) AND ts BETWEEN $2 AND $3
       ORDER BY ts ASC, seq ASC`,
      [tokens, windowStart, windowEnd],
    ),
    pool.query<{ token_id: string; ts: string; seq: string; side: number; price: string; size: string }>(
      `SELECT token_id, ts, seq, side, price::text, size::text FROM book_deltas
       WHERE token_id = ANY($1) AND ts BETWEEN $2 AND $3
       ORDER BY ts ASC, seq ASC`,
      [tokens, windowStart, windowEnd],
    ),
    pool.query<{ token_id: string; ts: string; seq: string; price: string; size: string; side: number; trade_id: string | null }>(
      `SELECT token_id, ts, seq, price::text, size::text, side, trade_id FROM trades
       WHERE token_id = ANY($1) AND ts BETWEEN $2 AND $3
       ORDER BY ts ASC, seq ASC`,
      [tokens, windowStart, windowEnd],
    ),
  ]);

  const snaps: SnapshotEvent[] = snapsR.rows.map((r) => ({
    kind: 'snapshot',
    tokenId: r.token_id,
    ts: Date.parse(r.ts),
    seq: Number(r.seq),
    bids: JSON.parse(r.bids),
    asks: JSON.parse(r.asks),
    reason: r.reason as SnapshotEvent['reason'],
  }));
  const deltas: DeltaEvent[] = deltasR.rows.map((r) => ({
    kind: 'delta',
    tokenId: r.token_id,
    ts: Date.parse(r.ts),
    seq: Number(r.seq),
    side: r.side as 0 | 1,
    price: Number(r.price),
    size: Number(r.size),
  }));
  const trades: TradeEvent[] = tradesR.rows.map((r) => ({
    kind: 'trade',
    tokenId: r.token_id,
    ts: Date.parse(r.ts),
    seq: Number(r.seq),
    price: Number(r.price),
    size: Number(r.size),
    takerSide: r.side as 0 | 1,
    tradeId: r.trade_id ?? undefined,
  }));

  // Merge three pre-sorted arrays.
  let i = 0;
  let j = 0;
  let k = 0;
  const key = (e: IngestEvent): number => e.ts * 1e6 + e.seq;
  while (i < snaps.length || j < deltas.length || k < trades.length) {
    const a = i < snaps.length ? snaps[i] : null;
    const b = j < deltas.length ? deltas[j] : null;
    const c = k < trades.length ? trades[k] : null;
    const candidates: Array<[IngestEvent, 'a' | 'b' | 'c']> = [];
    if (a) candidates.push([a, 'a']);
    if (b) candidates.push([b, 'b']);
    if (c) candidates.push([c, 'c']);
    candidates.sort((x, y) => key(x[0]) - key(y[0]));
    const [chosen, source] = candidates[0]!;
    if (source === 'a') i++;
    else if (source === 'b') j++;
    else k++;
    yield chosen;
  }
}
