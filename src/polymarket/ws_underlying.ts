import WebSocket from 'ws';
import { config } from '../config.js';
import { log } from '../util/log.js';
import { nextBackoff } from '../util/retry.js';

export interface UnderlyingTick {
  symbol: string;
  source: string;
  ts: number;
  price: number;
}

type Listener = (t: UnderlyingTick) => void;
type StateListener = (event: 'open' | 'close', detail?: unknown) => void;

// Polymarket Real-Time Data Socket (ws-live-data). Exposes Binance and Chainlink
// price streams. The subscription shape isn't tightly documented in the public docs
// we have access to; we send a best-effort subscribe for each configured symbol and
// also tolerate the server pushing without an explicit subscribe.
export class UnderlyingWsClient {
  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private listener: Listener;
  private stateListener?: StateListener;
  private shuttingDown = false;

  constructor(listener: Listener, stateListener?: StateListener) {
    this.listener = listener;
    this.stateListener = stateListener;
  }

  start(): void {
    this.connect();
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
    log.info({ url: config.LIVE_DATA_WS_URL }, 'ws_underlying connecting');
    const ws = new WebSocket(config.LIVE_DATA_WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempt = 0;
      this.stateListener?.('open');
      // Best-effort subscription. Two shapes we cover:
      // 1) { type: "subscribe", topic: "crypto_prices", symbols: [...] }
      // 2) Per-symbol: { action: "subscribe", channel: "ticker", symbol: "btcusdt" }
      for (const sym of config.UNDERLYING_SYMBOLS) {
        const msg = { action: 'subscribe', channel: 'crypto_prices', symbol: sym };
        try {
          ws.send(JSON.stringify(msg));
        } catch {
          /* ignore */
        }
      }
      try {
        ws.send(
          JSON.stringify({ type: 'subscribe', topic: 'crypto_prices', symbols: config.UNDERLYING_SYMBOLS }),
        );
      } catch {
        /* ignore */
      }
      // PING cadence: docs suggest 5s for the live-data socket.
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send('PING');
          } catch {
            /* ignore */
          }
        }
      }, 5000);
    });

    ws.on('message', (raw) => {
      const text = raw.toString();
      if (text === 'PONG') return;
      try {
        this.handleMessage(text);
      } catch (e) {
        log.warn({ err: e, raw: text.slice(0, 200) }, 'ws_underlying parse error');
      }
    });

    ws.on('error', (err) => {
      log.warn({ err: err.message }, 'ws_underlying error');
    });

    ws.on('close', (code, reason) => {
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
      log.info({ delay, attempt: this.reconnectAttempt }, 'ws_underlying reconnecting');
      setTimeout(() => this.connect(), delay);
    });
  }

  private handleMessage(text: string): void {
    const parsed: unknown = JSON.parse(text);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      const symbol = String(obj.symbol ?? obj.s ?? obj.asset ?? '').toLowerCase();
      const source = String(obj.source ?? obj.exchange ?? 'binance').toLowerCase();
      const ts = normalizeTs(obj.timestamp ?? obj.ts ?? obj.t ?? Date.now());
      const price = Number(obj.price ?? obj.p ?? obj.last_price);
      if (!symbol || !Number.isFinite(price)) continue;
      this.listener({ symbol, source, ts, price });
    }
  }
}

function normalizeTs(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  if (!Number.isFinite(n)) return Date.now();
  return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
}
