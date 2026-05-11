import { config } from '../config.js';
import type { BookLevel } from '../types.js';

export interface OrderbookSnapshotRaw {
  market: string;       // condition id
  asset_id: string;     // token id
  timestamp: string;
  last_trade_price?: string;
  tick_size?: string;
  neg_risk?: boolean;
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
}

const CLOB = config.CLOB_BASE_URL;

export async function getBook(tokenId: string): Promise<OrderbookSnapshotRaw> {
  const url = `${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`;
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return (await r.json()) as OrderbookSnapshotRaw;
}

export function levelsFromRaw(raw: Array<{ price: string; size: string }>): BookLevel[] {
  return raw
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0);
}
