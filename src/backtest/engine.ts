import { log } from '../util/log.js';
import { Book } from './book.js';
import { applyCancelAhead, applyTrade, placeQuote, type RestingQuote, type SimFill } from './fills.js';
import { applyFill, emptyInventory, resolveOutcome, settleInventory } from './inventory.js';
import { computeMarketRebate } from './rebate.js';
import { listMarketsInWindow, streamMarketEvents } from './replay.js';
import type {
  IngestEvent,
  Inventory,
  MarketMeta,
  MarketState,
  Strategy,
  TradeEvent,
} from '../types.js';

export interface MarketResult {
  meta: MarketMeta;
  fills: number;
  myFeeEq: number;
  totalFeeEq: number;
  shareOfPool: number;
  rebateUsd: number;
  invPnlUsd: number;
  quoteDollarSeconds: number;
}

export interface RunResult {
  capitalUsd: number;
  markets: MarketResult[];
  fills: number;
  grossRebateUsd: number;
  inventoryPnlUsd: number;
  netPnlUsd: number;
}

interface RunOptions {
  strategy: Strategy;
  capitalUsd: number;
  from: Date;
  to: Date;
}

export async function runBacktest(opts: RunOptions): Promise<RunResult> {
  const markets = await listMarketsInWindow(opts.from, opts.to);
  log.info({ from: opts.from.toISOString(), to: opts.to.toISOString(), markets: markets.length }, 'backtest start');

  const results: MarketResult[] = [];
  let totalFills = 0;
  let totalRebate = 0;
  let totalInvPnl = 0;

  for (const m of markets) {
    try {
      const r = await runOneMarket(m, opts.strategy);
      results.push(r);
      totalFills += r.fills;
      totalRebate += r.rebateUsd;
      totalInvPnl += r.invPnlUsd;
    } catch (e) {
      log.warn({ err: e, cid: m.conditionId }, 'market backtest failed; skipping');
    }
  }
  const net = totalRebate + totalInvPnl;
  log.info({ totalFills, totalRebate, totalInvPnl, net }, 'backtest done');

  return {
    capitalUsd: opts.capitalUsd,
    markets: results,
    fills: totalFills,
    grossRebateUsd: totalRebate,
    inventoryPnlUsd: totalInvPnl,
    netPnlUsd: net,
  };
}

async function runOneMarket(m: MarketMeta, strategy: Strategy): Promise<MarketResult> {
  const yesBook = new Book(m.yesTokenId);
  const noBook = new Book(m.noTokenId);
  const inv: Inventory = emptyInventory();
  const resting: RestingQuote[] = [];
  const fills: SimFill[] = [];
  const recentTrades: TradeEvent[] = [];

  let lastQuoteTs = 0;
  let quoteDollarSeconds = 0;
  let lastEvalTs = 0;

  const reissueQuotes = (now: number): void => {
    // Account dollar-seconds for currently resting quotes before replacement.
    if (lastEvalTs > 0 && resting.length > 0) {
      const dt = (now - lastEvalTs) / 1000;
      for (const rq of resting) quoteDollarSeconds += rq.remaining * rq.q.price * dt;
    }
    lastEvalTs = now;

    // Rebuild state and ask strategy for new quotes.
    const lastTradeYes = lastTradePrice(recentTrades, m.yesTokenId);
    const lastTradeNo = lastTradePrice(recentTrades, m.noTokenId);
    const state: MarketState = {
      meta: m,
      yesBook: yesBook.snapshot(),
      noBook: noBook.snapshot(),
      lastTradePriceYes: lastTradeYes,
      lastTradePriceNo: lastTradeNo,
      now,
    };
    const quotes = strategy.onBookUpdate(state, inv);
    resting.length = 0;
    for (const q of quotes) {
      const book = q.tokenId === m.yesTokenId ? yesBook : noBook;
      resting.push(placeQuote(book, q, now));
    }
    lastQuoteTs = now;
  };

  for await (const ev of streamMarketEvents(m)) {
    if (ev.kind === 'snapshot') {
      const b = ev.tokenId === m.yesTokenId ? yesBook : noBook;
      b.applySnapshot(ev);
    } else if (ev.kind === 'delta') {
      const b = ev.tokenId === m.yesTokenId ? yesBook : noBook;
      const { prev } = b.applyDelta(ev);
      applyCancelAhead(resting, ev, prev, recentTrades);
    } else {
      // trade
      recentTrades.push(ev);
      if (recentTrades.length > 256) recentTrades.shift();
      const matched = applyTrade(resting, ev);
      for (const f of matched) {
        applyFill(inv, f, m);
        fills.push(f);
      }
    }
    // Re-quote on cadence. Most strategies set refreshMs ~ 5s; placing a new
    // quote set may revise queueAhead.
    if (ev.ts - lastQuoteTs >= 1000 || lastQuoteTs === 0) {
      reissueQuotes(ev.ts);
    }
  }

  // Settle inventory at resolution.
  const outcome = await resolveOutcome(m);
  // Inventory P&L = settlement value of held shares minus cash spent acquiring them
  // plus cash received from sells. We tracked cashUsd as we filled; settle() adds
  // settlement value to cashUsd. Final cash = invPnl.
  const invPnlContribution = settleInventory(inv, outcome);
  void invPnlContribution;
  const invPnl = inv.cashUsd;

  const rebate = await computeMarketRebate(
    m.yesTokenId,
    m.noTokenId,
    m.slotStart,
    m.slotEnd,
    fills,
  );

  return {
    meta: m,
    fills: fills.length,
    myFeeEq: rebate.myFeeEq,
    totalFeeEq: rebate.totalFeeEq,
    shareOfPool: rebate.shareOfPool,
    rebateUsd: rebate.rebateUsd,
    invPnlUsd: invPnl,
    quoteDollarSeconds,
  };
}

function lastTradePrice(trades: TradeEvent[], tokenId: string): number | null {
  for (let i = trades.length - 1; i >= 0; i--) {
    if (trades[i]!.tokenId === tokenId) return trades[i]!.price;
  }
  return null;
}
