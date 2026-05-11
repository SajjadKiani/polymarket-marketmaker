import { pool } from './pool.js';
import type { MarketMeta, SnapshotEvent, DeltaEvent, TradeEvent } from '../types.js';

export async function upsertMarket(m: MarketMeta, raw: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO markets
       (condition_id, yes_token_id, no_token_id, question, underlying,
        slot_start, slot_end, fee_rate_bps, rebate_eligible, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (condition_id) DO UPDATE SET
       yes_token_id = EXCLUDED.yes_token_id,
       no_token_id  = EXCLUDED.no_token_id,
       question     = EXCLUDED.question,
       underlying   = EXCLUDED.underlying,
       slot_start   = EXCLUDED.slot_start,
       slot_end     = EXCLUDED.slot_end,
       fee_rate_bps = EXCLUDED.fee_rate_bps,
       rebate_eligible = EXCLUDED.rebate_eligible,
       raw          = EXCLUDED.raw`,
    [
      m.conditionId,
      m.yesTokenId,
      m.noTokenId,
      m.question,
      m.underlying,
      m.slotStart,
      m.slotEnd,
      m.feeRateBps,
      m.rebateEligible,
      raw,
    ],
  );
}

export async function insertSnapshot(e: SnapshotEvent): Promise<void> {
  await pool.query(
    `INSERT INTO book_snapshots(token_id, ts, seq, bids, asks, reason)
     VALUES ($1, to_timestamp($2/1000.0), $3, $4, $5, $6)
     ON CONFLICT DO NOTHING`,
    [e.tokenId, e.ts, e.seq, JSON.stringify(e.bids), JSON.stringify(e.asks), e.reason],
  );
}

// Bulk insert for hot paths.
export async function insertDeltas(rows: DeltaEvent[]): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const places: string[] = [];
  rows.forEach((r, i) => {
    const o = i * 6;
    places.push(`($${o + 1}, to_timestamp($${o + 2}/1000.0), $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`);
    values.push(r.tokenId, r.ts, r.seq, r.side, r.price, r.size);
  });
  await pool.query(
    `INSERT INTO book_deltas(token_id, ts, seq, side, price, size)
     VALUES ${places.join(',')}
     ON CONFLICT DO NOTHING`,
    values,
  );
}

export async function insertTrades(rows: TradeEvent[]): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const places: string[] = [];
  rows.forEach((r, i) => {
    const o = i * 7;
    places.push(
      `($${o + 1}, to_timestamp($${o + 2}/1000.0), $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7})`,
    );
    values.push(r.tokenId, r.ts, r.seq, r.price, r.size, r.takerSide, r.tradeId ?? null);
  });
  await pool.query(
    `INSERT INTO trades(token_id, ts, seq, price, size, side, trade_id)
     VALUES ${places.join(',')}
     ON CONFLICT DO NOTHING`,
    values,
  );
}

export async function insertUnderlyingPrices(
  rows: Array<{ symbol: string; source: string; ts: number; price: number }>,
): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const places: string[] = [];
  rows.forEach((r, i) => {
    const o = i * 4;
    places.push(`($${o + 1}, $${o + 2}, to_timestamp($${o + 3}/1000.0), $${o + 4})`);
    values.push(r.symbol, r.source, r.ts, r.price);
  });
  await pool.query(
    `INSERT INTO underlying_prices(symbol, source, ts, price)
     VALUES ${places.join(',')}
     ON CONFLICT DO NOTHING`,
    values,
  );
}

export async function openWsSession(channel: string): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO ws_sessions(channel) VALUES ($1) RETURNING id`,
    [channel],
  );
  return Number(r.rows[0]!.id);
}

export async function closeWsSession(id: number, reason: string): Promise<void> {
  await pool.query(
    `UPDATE ws_sessions SET ended_at = now(), reason = $2 WHERE id = $1 AND ended_at IS NULL`,
    [id, reason],
  );
}
