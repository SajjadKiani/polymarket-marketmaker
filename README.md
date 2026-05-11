# polymarket-marketmaker

Phase 1: read-only measurement pipeline + backtester for the Polymarket maker-rebate strategy on 15-minute crypto markets.

No order placement, no signing, no wallet. The goal is to log the data needed to decide whether the rebate strategy is worth funding a real bot for.

## What got built

| Component | Files |
|---|---|
| Postgres schema | `sql/001_init.sql` |
| REST + WS clients | `src/polymarket/{gamma,clob,ws_market,ws_underlying,fees}.ts` |
| Ingest | `src/ingest/{orchestrator,discovery,market_ingest,underlying_ingest,subscriptions}.ts` |
| Backtest | `src/backtest/{engine,replay,book,fills,inventory,rebate,report,cli}.ts` |
| Strategies | `src/backtest/strategies/{flat_mid,inventory_skew}.ts` |
| Scripts | `scripts/{smoke_5min,health,probe_discovery,probe_ws}.ts` |

The fill model uses queue-position simulation with cancel-ahead detection (see `fills.ts`). Inventory settles at expiry from logged underlying spot prices.

## Verified against the live API

- Discovery is driven by `GET https://clob.polymarket.com/rewards/markets/multi?tag_slug=15m` (the correct endpoint — `tag_slug=crypto` returns longer-running prediction markets, not the 15-min slots). At time of writing this returns ~676 entries with ~21 currently open across BTC, ETH, SOL, DOGE, XRP, BNB, HYPE.
- 15-minute slot timestamps are encoded in `market_slug` as `{asset}-updown-15m-{unix_seconds}`. The integer is `slot_start`; `slot_end = slot_start + 900s`.
- Each market has two tokens: `outcome=Up` (treated as YES) and `outcome=Down` (NO).
- The CLOB market WebSocket at `wss://ws-subscriptions-clob.polymarket.com/ws/market` accepts the documented subscription shape `{type, assets_ids, initial_dump, level}` and streams `book` / `price_change` / `last_trade_price` events.

## Quick start

```bash
# 1. Install deps
npm install

# 2. Configure
cp .env.example .env       # then edit PG_URL

# 3. Provision Postgres
createdb polymarket
npm run migrate

# 4. Sanity check: 5-minute ingest + assertions
npm run smoke

# 5. Long-running ingest (run under systemd or pm2)
npm run ingest

# 6. Daily health report (set up as cron)
npm run health

# 7. Backtest a window after you have data
npm run bt -- run \
  --strategy flat_mid \
  --from 2026-05-11T00:00:00Z \
  --to   2026-05-12T00:00:00Z \
  --capital 1000 \
  --spread-bps 200 \
  --size-usd 10

# Or with inventory skew
npm run bt -- run \
  --strategy inventory_skew \
  --from 2026-05-11T00:00:00Z \
  --to   2026-05-12T00:00:00Z \
  --max-inventory-usd 100 \
  --skew-bps-per-pct 2

# Inspect past runs
npm run bt -- list --limit 20
```

## Diagnostic probes

If discovery looks empty or the WebSocket is silent, run:

```bash
npx tsx scripts/probe_discovery.ts   # prints currently-open 15-min markets
npx tsx scripts/probe_ws.ts          # opens one market WS for 30s and counts events
```

Both probes only need a stubbed `PG_URL` (they don't touch Postgres).

## Decision gate (after the 14-day run)

Look at `npm run bt -- list` and the `backtest_market_summary` table:

- Is `net_pnl_usd / capital_usd` annualized worth pursuing after a ~30% haircut for queue-model optimism?
- Is `gross_rebate_usd` a meaningful fraction of `total_fee_eq × 0.20` for the days you backtested? (If our share of pool is implausibly large — say >50% on illiquid slots — the result is noise.)
- Is `inventory_pnl_usd` close to zero or comfortably positive? Negative-and-large means inventory is eating the rebate.

If the answer is yes, plan Phase 2: live trading with order signing, heartbeat, inventory caps, real risk management. The plan file is at `/home/saji/.claude/plans/soft-riding-wand.md`.

## Caveats baked into the fill model

- Zero quote latency assumed. Real orders take ~50–200ms to reach the book.
- No adverse selection model. Reality: when our quote gets hit, the book has often moved against us.
- Self-trade prevention not modeled.
- Multiple resting quotes at the same (token, side) split a taker print only approximately.

The `report.ts` summary prints a reminder of these. Treat the headline number as an upper bound, not a forecast.
