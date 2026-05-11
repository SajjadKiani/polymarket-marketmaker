import { config } from '../config.js';
import { log } from '../util/log.js';

// Minimal Gamma + CLOB-rewards client for discovery. Read-only.

export interface RewardToken {
  token_id: string;
  outcome: string; // 'Up' | 'Down' for 15-minute markets, or 'Yes'/'No' for binary markets
  price?: number | string;
}

export interface RewardMarket {
  condition_id: string;
  market_slug: string;
  question: string;
  spread?: number | string;
  rewards_min_size?: number;
  rewards_max_spread?: number;
  tokens?: RewardToken[];
  end_date_iso?: string;
  start_date_iso?: string;
  [k: string]: unknown;
}

interface RewardsResponse {
  data?: RewardMarket[];
  next_cursor?: string;
}

const CLOB = config.CLOB_BASE_URL;
const GAMMA = config.GAMMA_BASE_URL;

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'polymarket-marketmaker/0.1',
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`GET ${url} → ${r.status} ${r.statusText}: ${body.slice(0, 256)}`);
  }
  return (await r.json()) as T;
}

// GET /rewards/markets/multi?tag_slug=15m  paginated. This is the authoritative
// discovery surface for 15-minute crypto markets: each entry already includes
// the tokens, the slot timestamp encoded in market_slug, and rewards config.
export async function listRewardMarkets(tagSlug = '15m'): Promise<RewardMarket[]> {
  const out: RewardMarket[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const params = new URLSearchParams();
    if (tagSlug) params.set('tag_slug', tagSlug);
    if (cursor && cursor !== 'LTE=') params.set('next_cursor', cursor);
    const url = `${CLOB}/rewards/markets/multi?${params.toString()}`;
    try {
      const r = await getJson<RewardsResponse>(url);
      const data = Array.isArray(r.data) ? r.data : [];
      out.push(...data);
      const nxt = r.next_cursor ?? 'LTE=';
      if (!nxt || nxt === 'LTE=' || data.length === 0) break;
      cursor = nxt;
    } catch (e) {
      log.warn({ err: e, url }, 'rewards/markets/multi failed');
      break;
    }
  }
  return out;
}

// Parse a 15-minute crypto market's slot start from its slug. Format:
//   "{asset}-updown-15m-{unix_seconds}"  →  slot_start UTC.
export function parseSlotStart(slug: string): Date | null {
  const m = slug.match(/-15m-(\d{10})$/);
  if (!m) return null;
  const sec = Number(m[1]);
  if (!Number.isFinite(sec)) return null;
  return new Date(sec * 1000);
}

// Coarse parse of the underlying asset from the slug or question.
//   btc-updown-15m-... → BTC
//   eth-updown-...     → ETH
export function parseUnderlying(slug: string, question: string): string | null {
  const s = `${slug} ${question}`.toLowerCase();
  if (s.startsWith('btc') || s.includes('bitcoin')) return 'BTC';
  if (s.startsWith('eth') || s.includes('ethereum')) return 'ETH';
  if (s.startsWith('sol') || s.includes('solana')) return 'SOL';
  if (s.startsWith('xrp')) return 'XRP';
  if (s.startsWith('doge') || s.includes('dogecoin')) return 'DOGE';
  if (s.startsWith('bnb')) return 'BNB';
  if (s.startsWith('hype')) return 'HYPE';
  if (s.startsWith('ada') || s.includes('cardano')) return 'ADA';
  if (s.startsWith('avax') || s.includes('avalanche')) return 'AVAX';
  if (s.startsWith('ltc') || s.includes('litecoin')) return 'LTC';
  return null;
}

// The rewards endpoint typically returns tokens as [Up, Down]. Map Up → YES, Down → NO
// so the rest of the system treats it like a standard binary market.
export function pickUpDownTokens(tokens: RewardToken[] | undefined): { yes: string; no: string } | null {
  if (!tokens || tokens.length !== 2) return null;
  const up = tokens.find((t) => /^up$/i.test(t.outcome) || /^yes$/i.test(t.outcome));
  const down = tokens.find((t) => /^down$/i.test(t.outcome) || /^no$/i.test(t.outcome));
  if (!up || !down) return null;
  return { yes: up.token_id, no: down.token_id };
}

// Optional: Gamma fallback if we ever need extra metadata for a specific market.
export async function getMarketByConditionId(conditionId: string): Promise<unknown | null> {
  const url = `${GAMMA}/markets?condition_ids=${encodeURIComponent(conditionId)}&limit=1`;
  try {
    const r = await getJson<unknown[]>(url);
    return Array.isArray(r) ? r[0] ?? null : null;
  } catch (e) {
    log.warn({ err: e, url }, 'gamma getMarketByConditionId failed');
    return null;
  }
}
