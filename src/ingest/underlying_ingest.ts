import { UnderlyingWsClient, type UnderlyingTick } from '../polymarket/ws_underlying.js';
import { insertUnderlyingPrices, openWsSession, closeWsSession } from '../db/repo.js';
import { log } from '../util/log.js';

const FLUSH_INTERVAL_MS = 500;
const FLUSH_MAX_ROWS = 500;

export async function runUnderlyingIngest(signal: AbortSignal): Promise<void> {
  let sessionId: number | null = null;
  const buf: UnderlyingTick[] = [];

  const flush = async (): Promise<void> => {
    if (buf.length === 0) return;
    const rows = buf.splice(0, buf.length);
    try {
      await insertUnderlyingPrices(rows);
    } catch (e) {
      log.warn({ err: e, n: rows.length }, 'insertUnderlyingPrices failed');
    }
  };

  const client = new UnderlyingWsClient(
    (t) => {
      buf.push(t);
      if (buf.length >= FLUSH_MAX_ROWS) flush().catch(() => {});
    },
    (event, detail) => {
      if (event === 'open') {
        openWsSession('underlying').then((id) => {
          sessionId = id;
          log.info({ sessionId: id }, 'ws_underlying session opened');
        });
      } else if (sessionId != null) {
        closeWsSession(sessionId, JSON.stringify(detail ?? {})).catch(() => {});
        sessionId = null;
      }
    },
  );

  client.start();
  const flushTimer = setInterval(() => flush().catch(() => {}), FLUSH_INTERVAL_MS);

  await new Promise<void>((resolve) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    signal.addEventListener('abort', onAbort);
  });

  clearInterval(flushTimer);
  await flush();
  client.stop();
  if (sessionId != null) await closeWsSession(sessionId, 'shutdown');
}
