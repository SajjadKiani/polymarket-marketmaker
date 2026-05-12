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

// Polymarket Real-Time Data Socket. The protocol (per docs/market-data/websocket/rtds):
//   {
//     "action": "subscribe",
//     "subscriptions": [{ "topic": "crypto_prices", "type": "update", "filters": "btcusdt,ethusdt" }]
//   }
//
// Server emits:
//   { "topic": "crypto_prices", "type": "update", "timestamp": <ms>,
//     "payload": { "symbol": "btcusdt", "timestamp": <ms>, "value": 67234.50 } }
//
// PING every 5s. Both Binance (`crypto_prices`, lowercase symbols like btcusdt) and
// Chainlink (`crypto_prices_chainlink`, slash symbols like btc/usd) are supported.
// We subscribe to both. Chainlink is authoritative for 15-min market resolution;
// Binance is a denser feed used for monitoring.
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

      // Server rejects CSV filters despite what the published docs say
      // (regex requires JSON `[`/`{`). Empirically, subscribing without filters
      // delivers all symbols, including the ones we care about — we filter
      // client-side in handleMessage to avoid persisting noise.
      const sub = {
        action: 'subscribe',
        subscriptions: [
          { topic: 'crypto_prices', type: 'update' },
        ],
      };
      try {
        ws.send(JSON.stringify(sub));
      } catch (e) {
        log.warn({ err: e }, 'ws_underlying subscribe failed');
      }

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
      if (text === 'PONG' || text === 'pong') return;
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
      const topic = String(obj.topic ?? '');
      if (topic !== 'crypto_prices' && topic !== 'crypto_prices_chainlink') continue;

      const type = String(obj.type ?? '');
      const payload = (obj.payload ?? {}) as Record<string, unknown>;
      const symbol = String(payload.symbol ?? '').toLowerCase();
      if (!symbol) continue;
      if (!config.UNDERLYING_SYMBOLS.includes(symbol)) continue;

      const source = topic === 'crypto_prices' ? 'binance' : 'chainlink';
      const normalizedSymbol = source === 'chainlink' ? symbol.replace('/', '') : symbol;

      if (type === 'subscribe' && Array.isArray(payload.data)) {
        // Batch snapshot sent right after subscribe. Each entry is { timestamp, value }.
        for (const p of payload.data as Array<Record<string, unknown>>) {
          const ts = normalizeTsMs(p.timestamp ?? obj.timestamp);
          const value = Number(p.value ?? p.price);
          if (!Number.isFinite(value)) continue;
          this.listener({ symbol: normalizedSymbol, source, ts, price: value });
        }
        continue;
      }

      // Single tick: { topic, type=update, payload: { symbol, timestamp, value } }.
      const ts = normalizeTsMs(payload.timestamp ?? obj.timestamp);
      const value = Number(payload.value ?? payload.price ?? payload.last_price);
      if (!Number.isFinite(value)) continue;
      this.listener({ symbol: normalizedSymbol, source, ts, price: value });
    }
  }
}

function normalizeTsMs(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  if (!Number.isFinite(n)) return Date.now();
  return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
}
