import { MarketWsClient } from '../polymarket/ws_market.js';
import { log } from '../util/log.js';
import { config } from '../config.js';
import {
  insertSnapshot,
  insertDeltas,
  insertTrades,
  openWsSession,
  closeWsSession,
} from '../db/repo.js';
import type { SubscriptionRegistry } from './subscriptions.js';
import type { DeltaEvent, IngestEvent, SnapshotEvent, TradeEvent } from '../types.js';
import { getBook, levelsFromRaw } from '../polymarket/clob.js';

const FLUSH_INTERVAL_MS = 250;
const FLUSH_MAX_ROWS = 500;

export async function runMarketIngest(reg: SubscriptionRegistry, signal: AbortSignal): Promise<void> {
  let sessionId: number | null = null;

  const deltaBuf: DeltaEvent[] = [];
  const tradeBuf: TradeEvent[] = [];

  const flush = async (): Promise<void> => {
    if (deltaBuf.length > 0) {
      const rows = deltaBuf.splice(0, deltaBuf.length);
      try {
        await insertDeltas(rows);
      } catch (e) {
        log.warn({ err: e, n: rows.length }, 'insertDeltas failed');
      }
    }
    if (tradeBuf.length > 0) {
      const rows = tradeBuf.splice(0, tradeBuf.length);
      try {
        await insertTrades(rows);
      } catch (e) {
        log.warn({ err: e, n: rows.length }, 'insertTrades failed');
      }
    }
  };

  const onEvent = (e: IngestEvent): void => {
    if (e.kind === 'snapshot') {
      insertSnapshot(e as SnapshotEvent).catch((err) =>
        log.warn({ err, token: e.tokenId }, 'insertSnapshot failed'),
      );
      return;
    }
    if (e.kind === 'delta') {
      deltaBuf.push(e as DeltaEvent);
      if (deltaBuf.length >= FLUSH_MAX_ROWS) flush().catch(() => {});
      return;
    }
    if (e.kind === 'trade') {
      tradeBuf.push(e as TradeEvent);
      if (tradeBuf.length >= FLUSH_MAX_ROWS) flush().catch(() => {});
      return;
    }
  };

  const client = new MarketWsClient(onEvent, (event, detail) => {
    if (event === 'open') {
      openWsSession('market').then((id) => {
        sessionId = id;
        log.info({ sessionId: id }, 'ws_market session opened');
      });
    } else {
      if (sessionId != null) {
        closeWsSession(sessionId, JSON.stringify(detail ?? {})).catch(() => {});
        sessionId = null;
      }
    }
  });

  client.start(reg.tokens());

  // Reflect subscription changes from registry into client.
  const subscriptionPoll = setInterval(() => {
    client.setSubscriptions(reg.tokens());
  }, 1000);

  // Flush buffers regularly.
  const flushTimer = setInterval(() => {
    flush().catch(() => {});
  }, FLUSH_INTERVAL_MS);

  // Periodic REST resync: every PERIODIC_SNAPSHOT_MS, pull /book for each token
  // and write a snapshot with reason='periodic'. Cheap insurance against drift.
  const periodicTimer = setInterval(() => {
    const tokens = reg.tokens();
    void resync(tokens).catch((e) => log.warn({ err: e }, 'periodic resync failed'));
  }, config.PERIODIC_SNAPSHOT_MS);

  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    signal.addEventListener('abort', onAbort);
  });

  clearInterval(subscriptionPoll);
  clearInterval(flushTimer);
  clearInterval(periodicTimer);
  await flush();
  client.stop();
  if (sessionId != null) await closeWsSession(sessionId, 'shutdown');
}

async function resync(tokens: string[]): Promise<void> {
  for (const t of tokens) {
    try {
      const raw = await getBook(t);
      const bids = levelsFromRaw(raw.bids ?? []);
      const asks = levelsFromRaw(raw.asks ?? []);
      const ts = Number(raw.timestamp);
      await insertSnapshot({
        kind: 'snapshot',
        tokenId: t,
        ts: Number.isFinite(ts) ? (ts < 1e12 ? ts * 1000 : ts) : Date.now(),
        seq: Date.now(),
        bids,
        asks,
        reason: 'periodic',
      });
    } catch (e) {
      log.debug({ err: e, t }, 'resync /book failed');
    }
  }
}
