import { log } from '../util/log.js';
import type { MarketMeta } from '../types.js';

// Tracks which markets the ingest worker should be subscribed to. Each market
// contributes two token_ids (YES and NO). Drops a market ~60s after its slot_end.
export class SubscriptionRegistry {
  private markets = new Map<string, MarketMeta>(); // condition_id -> meta
  private listener: (tokens: string[]) => void;
  private dropDelayMs: number;

  constructor(listener: (tokens: string[]) => void, dropDelayMs = 60_000) {
    this.listener = listener;
    this.dropDelayMs = dropDelayMs;
  }

  // Add or update a market. Returns true if subscription set changed.
  upsert(m: MarketMeta): boolean {
    const existing = this.markets.get(m.conditionId);
    this.markets.set(m.conditionId, m);
    const changed =
      !existing ||
      existing.yesTokenId !== m.yesTokenId ||
      existing.noTokenId !== m.noTokenId;
    if (changed) this.emit();
    return changed;
  }

  // Sweep markets that ended more than dropDelayMs ago.
  sweep(now = Date.now()): number {
    let dropped = 0;
    for (const [k, m] of this.markets) {
      if (m.slotEnd.getTime() + this.dropDelayMs < now) {
        this.markets.delete(k);
        dropped++;
      }
    }
    if (dropped > 0) this.emit();
    return dropped;
  }

  tokens(): string[] {
    const out: string[] = [];
    for (const m of this.markets.values()) {
      out.push(m.yesTokenId, m.noTokenId);
    }
    return out;
  }

  size(): number {
    return this.markets.size;
  }

  private emit(): void {
    const t = this.tokens();
    log.debug({ markets: this.markets.size, tokens: t.length }, 'subscription set updated');
    this.listener(t);
  }
}
