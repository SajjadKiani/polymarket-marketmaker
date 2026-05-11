import { log } from '../util/log.js';
import { config, SLOT_SECONDS } from '../config.js';
import { nextSlotBoundaryMs, sleep } from '../util/clock.js';
import {
  listRewardMarkets,
  parseSlotStart,
  parseUnderlying,
  pickUpDownTokens,
  type RewardMarket,
} from '../polymarket/gamma.js';
import { upsertMarket } from '../db/repo.js';
import type { SubscriptionRegistry } from './subscriptions.js';
import type { MarketMeta } from '../types.js';

const SLOT_MS = SLOT_SECONDS * 1000;

function toMeta(rm: RewardMarket): MarketMeta | null {
  const tokens = pickUpDownTokens(rm.tokens);
  if (!tokens) return null;
  const slotStart = parseSlotStart(rm.market_slug);
  if (!slotStart) return null;
  const slotEnd = new Date(slotStart.getTime() + SLOT_MS);
  const underlying = parseUnderlying(rm.market_slug, rm.question);
  return {
    conditionId: rm.condition_id.toLowerCase(),
    yesTokenId: tokens.yes,
    noTokenId: tokens.no,
    question: rm.question ?? '',
    underlying,
    slotStart,
    slotEnd,
    feeRateBps: 700, // crypto
    rebateEligible: true, // present in rewards endpoint = eligible
  };
}

async function runOnce(reg: SubscriptionRegistry): Promise<{ tracked: number; total: number }> {
  const now = Date.now();
  const all = await listRewardMarkets('15m');
  let tracked = 0;

  for (const rm of all) {
    const meta = toMeta(rm);
    if (!meta) continue;
    // Skip slots that already closed more than 60s ago — nothing to ingest.
    if (meta.slotEnd.getTime() < now - 60_000) continue;
    // Skip slots more than 30 minutes in the future — nothing to subscribe to yet.
    if (meta.slotStart.getTime() > now + 30 * 60_000) continue;
    try {
      await upsertMarket(meta, rm as unknown);
      const changed = reg.upsert(meta);
      if (changed) tracked++;
    } catch (e) {
      log.warn({ err: e, cid: meta.conditionId }, 'upsertMarket failed');
    }
  }
  reg.sweep(now);
  return { tracked, total: reg.size() };
}

export async function runDiscovery(reg: SubscriptionRegistry, signal: AbortSignal): Promise<void> {
  // Two loops in one: a slot-aligned trigger at (next boundary - 30s) so we
  // pre-subscribe before the new 15-min market opens, plus a 60s background
  // safety poll for late-listed markets.
  const slotLoop = (async () => {
    while (!signal.aborted) {
      const nextBoundary = nextSlotBoundaryMs(Date.now());
      const wakeAt = nextBoundary - 30_000;
      const delay = Math.max(0, wakeAt - Date.now());
      await sleep(delay);
      if (signal.aborted) break;
      try {
        const r = await runOnce(reg);
        log.info({ trigger: 'slot', ...r }, 'discovery slot-poll');
      } catch (e) {
        log.error({ err: e }, 'discovery slot-poll failed');
      }
    }
  })();

  const safetyLoop = (async () => {
    try {
      const r = await runOnce(reg);
      log.info({ trigger: 'boot', ...r }, 'discovery initial');
    } catch (e) {
      log.error({ err: e }, 'discovery initial failed');
    }
    while (!signal.aborted) {
      await sleep(config.DISCOVERY_POLL_MS);
      if (signal.aborted) break;
      try {
        const r = await runOnce(reg);
        log.debug({ trigger: 'safety', ...r }, 'discovery safety-poll');
      } catch (e) {
        log.error({ err: e }, 'discovery safety-poll failed');
      }
    }
  })();

  await Promise.all([slotLoop, safetyLoop]);
}
