import 'dotenv/config';
import { z } from 'zod';

const Env = z.object({
  PG_URL: z.string().min(1),
  LOG_LEVEL: z.string().default('info'),
  LOG_PRETTY: z.coerce.boolean().default(false),

  GAMMA_BASE_URL: z.string().url().default('https://gamma-api.polymarket.com'),
  CLOB_BASE_URL: z.string().url().default('https://clob.polymarket.com'),
  CLOB_WS_URL: z.string().url().default('wss://ws-subscriptions-clob.polymarket.com/ws/market'),
  LIVE_DATA_WS_URL: z.string().url().default('wss://ws-live-data.polymarket.com'),

  DISCOVERY_POLL_MS: z.coerce.number().int().positive().default(60_000),
  REWARDS_CACHE_MS: z.coerce.number().int().positive().default(300_000),
  WS_PING_MS: z.coerce.number().int().positive().default(10_000),
  WS_RECONNECT_MIN_MS: z.coerce.number().int().positive().default(1_000),
  WS_RECONNECT_MAX_MS: z.coerce.number().int().positive().default(30_000),
  PERIODIC_SNAPSHOT_MS: z.coerce.number().int().positive().default(300_000),
  BOOK_LEVEL: z.coerce.number().int().min(1).max(3).default(2),
  SUBSCRIPTION_SHARD_SIZE: z.coerce.number().int().positive().default(50),

  UNDERLYING_SYMBOLS: z
    .string()
    .default('btcusdt,ethusdt,solusdt,xrpusdt')
    .transform((s) => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)),
});

export const config = Env.parse(process.env);

// Crypto market constants. The fee curve is fee = size * rate * p * (1 - p) for crypto (exponent = 1).
// Maker rebate pool = 20% of taker fees in crypto markets.
export const CRYPTO_FEE_RATE = 0.07;
export const CRYPTO_FEE_EXPONENT = 1;
export const CRYPTO_REBATE_FRACTION = 0.20;
export const REBATE_MIN_USD = 1.0;

// 15-minute crypto market slot length (seconds).
export const SLOT_SECONDS = 15 * 60;
