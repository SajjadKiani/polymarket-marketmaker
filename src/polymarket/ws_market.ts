import WebSocket from 'ws';
import { config } from '../config.js';
import { log } from '../util/log.js';
import { nextBackoff } from '../util/retry.js';
import type { IngestEvent, BookLevel, SnapshotEvent, DeltaEvent, TradeEvent } from '../types.js';

// Lightweight client for the CLOB market WebSocket channel.
// Subscription message (per docs):
//   { type: "market", assets_ids: [...], initial_dump: true, level: 2 }
// PING every 10s.
// Incoming messages vary in event_type; we tolerate variations.

type Listener = (e: IngestEvent) => void;
type StateListener = (event: 'open' | 'close', detail?: unknown) => void;

export class MarketWsClient {
  private ws: WebSocket | null = null;
  private tokens = new Set<string>();
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private seqCounter = 0; // local fallback when server omits a sequence
  private listener: Listener;
  private stateListener?: StateListener;
  private shuttingDown = false;
  private connecting = false;

  constructor(listener: Listener, stateListener?: StateListener) {
    this.listener = listener;
    this.stateListener = stateListener;
  }

  start(initialTokens: string[] = []): void {
    for (const t of initialTokens) this.tokens.add(t);
    this.connect();
  }

  setSubscriptions(tokens: string[]): void {
    const next = new Set(tokens);
    const toAdd = [...next].filter((t) => !this.tokens.has(t));
    const toRemove = [...this.tokens].filter((t) => !next.has(t));
    this.tokens = next;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (toAdd.length > 0) this.sendSubscribe(toAdd, 'subscribe', true);
      if (toRemove.length > 0) this.sendSubscribe(toRemove, 'unsubscribe', false);
    }
  }

  stop(): void {
    this.shuttingDown = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private connect(): void {
    if (this.connecting) return;
    this.connecting = true;
    log.info({ url: config.CLOB_WS_URL, tokens: this.tokens.size }, 'ws_market connecting');
    const ws = new WebSocket(config.CLOB_WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      this.connecting = false;
      this.reconnectAttempt = 0;
      this.stateListener?.('open');
      if (this.tokens.size > 0) {
        this.sendSubscribe([...this.tokens], 'subscribe', true);
      }
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send('PING');
          } catch {
            /* ignore */
          }
        }
      }, config.WS_PING_MS);
    });

    ws.on('message', (raw) => {
      const text = raw.toString();
      if (text === 'PONG') return;
      try {
        this.handleMessage(text);
      } catch (e) {
        log.warn({ err: e, raw: text.slice(0, 200) }, 'ws_market parse error');
      }
    });

    ws.on('error', (err) => {
      log.warn({ err: err.message }, 'ws_market error');
    });

    ws.on('close', (code, reason) => {
      this.connecting = false;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.ws = null;
      this.stateListener?.('close', { code, reason: reason.toString() });
      if (this.shuttingDown) return;
      const delay = nextBackoff(
        this.reconnectAttempt++,
        config.WS_RECONNECT_MIN_MS,
        config.WS_RECONNECT_MAX_MS,
      );
      log.info({ delay, attempt: this.reconnectAttempt }, 'ws_market reconnecting');
      setTimeout(() => this.connect(), delay);
    });
  }

  private sendSubscribe(tokens: string[], op: 'subscribe' | 'unsubscribe', initialDump: boolean): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const shard = config.SUBSCRIPTION_SHARD_SIZE;
    for (let i = 0; i < tokens.length; i += shard) {
      const chunk = tokens.slice(i, i + shard);
      const msg = {
        type: 'market',
        operation: op,
        assets_ids: chunk,
        initial_dump: initialDump,
        level: config.BOOK_LEVEL,
      };
      try {
        ws.send(JSON.stringify(msg));
      } catch (e) {
        log.warn({ err: e, op, count: chunk.length }, 'ws_market send failed');
      }
    }
  }

  // The CLOB market channel sends one of several event_types. We tolerate many shapes.
  private handleMessage(text: string): void {
    const parsed: unknown = JSON.parse(text);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const type = (obj.event_type ?? obj.type ?? '').toString();
      const tokenId = (obj.asset_id ?? obj.token_id ?? '').toString();
      const tsRaw = obj.timestamp ?? obj.ts ?? obj.match_time ?? Date.now();
      const ts = normalizeTs(tsRaw);
      const seq = this.seq(obj);

      if (!tokenId && type !== 'pong') continue;

      if (type === 'book' || type === 'orderbook') {
        const bids = normLevels(obj.bids);
        const asks = normLevels(obj.asks);
        const ev: SnapshotEvent = {
          kind: 'snapshot',
          tokenId,
          ts,
          seq,
          bids,
          asks,
          reason: 'initial_dump',
        };
        this.listener(ev);
        continue;
      }

      if (type === 'price_change' || type === 'book_update' || type === 'level_update') {
        const changes = (obj.changes ?? obj.price_changes ?? []) as Array<Record<string, unknown>>;
        for (const c of Array.isArray(changes) ? changes : []) {
          const sideStr = (c.side ?? c.s ?? '').toString().toUpperCase();
          const side: 0 | 1 = sideStr === 'BUY' || sideStr === 'BID' || sideStr === '0' ? 0 : 1;
          const price = Number(c.price ?? c.p);
          const size = Number(c.size ?? c.sz ?? c.quantity ?? 0);
          if (!Number.isFinite(price)) continue;
          const ev: DeltaEvent = {
            kind: 'delta',
            tokenId,
            ts,
            seq: this.seq(obj),
            side,
            price,
            size: Number.isFinite(size) ? size : 0,
          };
          this.listener(ev);
        }
        continue;
      }

      if (type === 'last_trade_price' || type === 'trade' || type === 'matched_trade') {
        const sideStr = (obj.side ?? obj.taker_side ?? '').toString().toUpperCase();
        const takerSide: 0 | 1 = sideStr === 'BUY' || sideStr === '0' ? 0 : 1;
        const price = Number(obj.price ?? obj.p);
        const size = Number(obj.size ?? obj.sz ?? obj.quantity ?? 0);
        if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue;
        const ev: TradeEvent = {
          kind: 'trade',
          tokenId,
          ts,
          seq,
          price,
          size,
          takerSide,
          tradeId: (obj.trade_id ?? obj.id ?? undefined) as string | undefined,
        };
        this.listener(ev);
        continue;
      }

      // tick_size_change and other auxiliary events are not stored in v1.
    }
  }

  private seq(obj: Record<string, unknown>): number {
    const s = Number(obj.seq ?? obj.sequence ?? obj.hash ?? NaN);
    if (Number.isFinite(s)) return s;
    return ++this.seqCounter;
  }
}

function normLevels(raw: unknown): BookLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: BookLevel[] = [];
  for (const x of raw) {
    if (x && typeof x === 'object') {
      const obj = x as Record<string, unknown>;
      const price = Number(obj.price ?? obj.p);
      const size = Number(obj.size ?? obj.sz ?? obj.quantity);
      if (Number.isFinite(price) && Number.isFinite(size) && size > 0) {
        out.push({ price, size });
      }
    } else if (Array.isArray(x) && x.length >= 2) {
      const price = Number(x[0]);
      const size = Number(x[1]);
      if (Number.isFinite(price) && Number.isFinite(size) && size > 0) {
        out.push({ price, size });
      }
    }
  }
  return out;
}

function normalizeTs(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  if (!Number.isFinite(n)) return Date.now();
  // Polymarket sometimes sends seconds, sometimes ms. Heuristic: if < 10^12, treat as seconds.
  return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
}
