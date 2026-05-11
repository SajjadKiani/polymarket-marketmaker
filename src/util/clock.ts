import { SLOT_SECONDS } from '../config.js';

// Align an epoch-ms timestamp down to the nearest 15-minute slot boundary.
export function slotStartMs(tsMs: number): number {
  const slotMs = SLOT_SECONDS * 1000;
  return Math.floor(tsMs / slotMs) * slotMs;
}

// Next slot boundary strictly after `tsMs`.
export function nextSlotBoundaryMs(tsMs: number): number {
  const slotMs = SLOT_SECONDS * 1000;
  return Math.floor(tsMs / slotMs) * slotMs + slotMs;
}

// Sleep until `tsMs` (or `now()` if already past). Resolves on time.
export function sleepUntil(tsMs: number, signal?: AbortSignal): Promise<void> {
  const delay = Math.max(0, tsMs - Date.now());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
