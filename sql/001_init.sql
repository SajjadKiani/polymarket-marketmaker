-- Polymarket maker-rebate measurement pipeline schema.
-- All timestamps are TIMESTAMPTZ; producer always supplies UTC.

CREATE TABLE IF NOT EXISTS markets (
  condition_id     TEXT PRIMARY KEY,
  yes_token_id     TEXT NOT NULL,
  no_token_id      TEXT NOT NULL,
  question         TEXT NOT NULL,
  underlying       TEXT,
  slot_start       TIMESTAMPTZ NOT NULL,
  slot_end         TIMESTAMPTZ NOT NULL,
  fee_rate_bps     INTEGER,
  rebate_eligible  BOOLEAN NOT NULL DEFAULT FALSE,
  raw              JSONB NOT NULL,
  discovered_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS markets_slot_start_idx ON markets (slot_start);
CREATE INDEX IF NOT EXISTS markets_yes_token_idx ON markets (yes_token_id);
CREATE INDEX IF NOT EXISTS markets_no_token_idx  ON markets (no_token_id);

CREATE TABLE IF NOT EXISTS book_snapshots (
  token_id  TEXT        NOT NULL,
  ts        TIMESTAMPTZ NOT NULL,
  seq       BIGINT      NOT NULL,
  bids      JSONB       NOT NULL,
  asks      JSONB       NOT NULL,
  reason    TEXT        NOT NULL,
  PRIMARY KEY (token_id, ts, seq)
);
CREATE INDEX IF NOT EXISTS book_snapshots_token_ts_idx ON book_snapshots (token_id, ts);
CREATE INDEX IF NOT EXISTS book_snapshots_ts_brin     ON book_snapshots USING BRIN (ts);

CREATE TABLE IF NOT EXISTS book_deltas (
  token_id TEXT        NOT NULL,
  ts       TIMESTAMPTZ NOT NULL,
  seq      BIGINT      NOT NULL,
  side     SMALLINT    NOT NULL,
  price    NUMERIC(10,4) NOT NULL,
  size     NUMERIC(20,4) NOT NULL,
  PRIMARY KEY (token_id, ts, seq, side, price)
);
CREATE INDEX IF NOT EXISTS book_deltas_token_ts_idx ON book_deltas (token_id, ts);
CREATE INDEX IF NOT EXISTS book_deltas_ts_brin     ON book_deltas USING BRIN (ts);

CREATE TABLE IF NOT EXISTS trades (
  token_id TEXT        NOT NULL,
  ts       TIMESTAMPTZ NOT NULL,
  seq      BIGINT      NOT NULL,
  price    NUMERIC(10,4) NOT NULL,
  size     NUMERIC(20,4) NOT NULL,
  side     SMALLINT    NOT NULL,
  trade_id TEXT,
  PRIMARY KEY (token_id, ts, seq)
);
CREATE INDEX IF NOT EXISTS trades_token_ts_idx ON trades (token_id, ts);
CREATE INDEX IF NOT EXISTS trades_ts_brin      ON trades USING BRIN (ts);

CREATE TABLE IF NOT EXISTS underlying_prices (
  symbol TEXT        NOT NULL,
  source TEXT        NOT NULL,
  ts     TIMESTAMPTZ NOT NULL,
  price  NUMERIC(20,8) NOT NULL,
  PRIMARY KEY (symbol, source, ts)
);
CREATE INDEX IF NOT EXISTS underlying_prices_ts_brin ON underlying_prices USING BRIN (ts);

CREATE TABLE IF NOT EXISTS ws_sessions (
  id         BIGSERIAL PRIMARY KEY,
  channel    TEXT        NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at   TIMESTAMPTZ,
  reason     TEXT
);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id                BIGSERIAL PRIMARY KEY,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  strategy          TEXT NOT NULL,
  params            JSONB NOT NULL,
  data_from         TIMESTAMPTZ NOT NULL,
  data_to           TIMESTAMPTZ NOT NULL,
  capital_usd       NUMERIC(20,4) NOT NULL,
  net_pnl_usd       NUMERIC(20,4),
  gross_rebate_usd  NUMERIC(20,4),
  inventory_pnl_usd NUMERIC(20,4),
  fills             INTEGER,
  notes             TEXT
);

CREATE TABLE IF NOT EXISTS backtest_market_summary (
  run_id               BIGINT REFERENCES backtest_runs(id) ON DELETE CASCADE,
  condition_id         TEXT REFERENCES markets(condition_id),
  fills                INTEGER,
  my_fee_eq            NUMERIC(20,6),
  total_fee_eq         NUMERIC(20,6),
  rebate_usd           NUMERIC(20,4),
  inv_pnl_usd          NUMERIC(20,4),
  quote_dollar_seconds NUMERIC(20,4),
  PRIMARY KEY (run_id, condition_id)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
