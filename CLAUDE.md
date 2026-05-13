# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Phase 1 read-only measurement pipeline + backtester for Polymarket's maker-rebate program on 15-minute crypto markets. **No order placement, no signing, no wallet** — the goal is to log live book/trade/underlying data and replay it through a simulated maker to decide whether the rebate strategy is worth funding a real bot for.

The strategy thesis is in `PROMPT.md`. Read it before changing fee math, rebate fraction, or strategy logic.

## Commands

```bash
npm run migrate      # apply sql/*.sql against PG_URL
npm run ingest       # long-running: discovery + market WS + underlying WS
npm run smoke        # 5-min sanity check ingest, asserts data lands
npm run health       # one-shot 24h coverage report
npm run typecheck    # tsc --noEmit (no separate lint step)
npm run bt -- run --strategy flat_mid       --from <iso> --to <iso>  [--spread-bps 200 --size-usd 10 --capital 1000]
npm run bt -- run --strategy inventory_skew --from <iso> --to <iso>  [--max-inventory-usd 100 --skew-bps-per-pct 2]
npm run bt -- list --limit 20

# Diagnostic probes (need only a stubbed PG_URL — they don't touch Postgres):
npx tsx scripts/probe_discovery.ts   # currently-open 15-min markets
npx tsx scripts/probe_ws.ts          # open one market WS for 30s, count events
npx tsx scripts/backfill_binance.ts --from <iso> --to <iso>   # fill underlying_prices from Binance REST
```

Production deploy is Docker Compose (`docker-compose.yml` spins `app` ingest + `health` cron + `postgres`). Inside a container, `entrypoint <subcommand>` dispatches (`ingest`, `migrate`, `health`, `health-cron`, `smoke`, `bt …`, `shell`).

## Architecture

### Ingest pipeline (`src/ingest/`)

`orchestrator.ts` runs three concurrent tasks against one shared `SubscriptionRegistry`:

1. **`discovery.ts`** polls `GET /rewards/markets/multi?tag_slug=15m` on a slot-aligned schedule (wakes 30s before each 15-min boundary) plus a 60s safety loop. **The correct slug is `15m`, not `crypto`** — `crypto` returns long-running prediction markets, not the 15-min slots we care about. Slot start is parsed from `market_slug` (`{asset}-updown-15m-{unix_seconds}`), not from any API field. Markets are upserted into `markets` and pushed to the registry.
2. **`market_ingest.ts`** drives `MarketWsClient` against `wss://ws-subscriptions-clob.polymarket.com/ws/market`. Buffers `book_deltas` / `trades` and flushes every 250ms or 500 rows; snapshots write through immediately. Every 5 min it also pulls REST `/book` per token as a `reason='periodic'` snapshot — cheap drift insurance against WS gaps. WS subscribe shape is the documented `{type:"market", assets_ids, initial_dump, level}`.
3. **`underlying_ingest.ts`** drives the Polymarket RTDS socket (`wss://ws-live-data.polymarket.com`) for spot prices. **Both Binance feed (`crypto_prices`, lowercase `btcusdt`) and Chainlink feed (`crypto_prices_chainlink`, slash form like `btc/usd`) are subscribed. Chainlink is the authoritative resolution source — the backtester prefers Chainlink rows when both are present.** Past bug: filtering subscriptions by CSV breaks the server contract; the subscribe payload must be the documented shape with both `subscribe` and `update` types handled. See commit 6644410.

The registry deduplicates token IDs across the slot lifecycle and sweeps slots whose `slot_end` is more than 60s in the past.

### Storage (`sql/001_init.sql`, `src/db/`)

All timestamps are `TIMESTAMPTZ`, producer always supplies UTC. Tables: `markets`, `book_snapshots`, `book_deltas`, `trades`, `underlying_prices`, `ws_sessions`, `backtest_runs`, `backtest_market_summary`. Hot columns have BRIN indexes on `ts` (append-only time-series workload).

`underlying_prices` is keyed `(symbol, source, ts)` — Binance and Chainlink rows coexist for the same symbol/timestamp; the backtester picks Chainlink first.

### Backtester (`src/backtest/`)

`engine.ts → runOneMarket` is the unit of work — one market = one 15-min slot, replayed end-to-end:

1. `replay.ts::streamMarketEvents` pulls `book_snapshots`, `book_deltas`, `trades` for both YES and NO tokens over `[slot_start - 5min, slot_end + 5min]` and merges them in `(ts, seq)` order via in-memory three-way merge (per-market volume is small, <10k events typical).
2. `book.ts` maintains an L2 book from snapshots + deltas.
3. On each event the engine re-quotes at most every 1s. Strategies (`strategies/flat_mid.ts`, `strategies/inventory_skew.ts`) return a list of `Quote` objects per book update.
4. `fills.ts` is a **queue-position model with cancel-ahead detection**: when a quote is placed, `queueAhead = sizeAtOrBetter(side, price)`. Taker trades consume the queue first, then us. Book deltas that shrink a level *without* a matching trade within ±50ms are treated as cancels and reduce `queueAhead`. This is the realism refinement that keeps fills from being trivially optimistic.
5. **Settlement (`inventory.ts::resolveOutcome`) reads spot prices from `underlying_prices` ±60s of slot boundaries, preferring `source='chainlink'`. If either boundary lookup returns null, the function returns `'UNKNOWN'` and the engine *skips the market entirely* — `settleInventory` throws if called with UNKNOWN. Silently zeroing UNKNOWN positions is what produced the bogus +$31k P&L in run #1 (see commit 04c374a). The CLI surfaces a warning if >5% of markets are skipped.**
6. `rebate.ts` computes per-market rebate using `feeEqCrypto(size, p) = size * 0.07 * p * (1 - p)` and `rebate_usd = 0.20 * my_fee_eq` (the share-of-pool form collapses because in a CLOB `sum(taker_fees) == sum(maker_fee_eq)`). Constants live in `src/config.ts` (`CRYPTO_FEE_RATE=0.07`, `CRYPTO_REBATE_FRACTION=0.20`).

The CLI prints a fixed "subtract ~30% from headline net P&L" haircut caveat — that's the latency/adverse-selection placeholder, not actually modeled.

### Config (`src/config.ts`)

All env parsing goes through one `zod` schema with defaults. `PG_URL` is the only required var. `UNDERLYING_SYMBOLS` defaults to `btcusdt,ethusdt,solusdt,xrpusdt` but discovery surfaces markets in other assets (DOGE, BNB, HYPE, …) — markets in unsubscribed assets won't have underlying rows and will be skipped by the backtester. Widen `UNDERLYING_SYMBOLS` in `.env` or backfill via `scripts/backfill_binance.ts` to fix.

## Conventions worth knowing

- **`type: "module"`** — internal imports use `.js` extension even from `.ts` source files (TS resolves them via `tsconfig.json`'s `moduleResolution`).
- **No test runner is configured.** `typecheck` is the only static check; correctness is validated by `npm run smoke` (5-min live ingest with assertions) and re-running backtests after schema/fill-model changes.
- Logging is `pino`. `LOG_PRETTY=true` for local, `false` in containers.
- Polymarket REST/WS quirks are isolated in `src/polymarket/{gamma,clob,ws_market,ws_underlying,fees}.ts` — keep parsing tolerant there; upstream payload shapes drift.

## Deployment

the project is deploy in `root@192.3.142.143` so all of data are in this server docker containers, 
if u want to test or see the result of your code in every change in server u should commit it first, push in repo then in server pull it and rebuild the container
