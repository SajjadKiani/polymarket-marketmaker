// Throwaway probe: open the CLOB market WebSocket against a real 15-minute crypto
// token and print events for 30 seconds. Confirms the subscription shape works.
import {
  listRewardMarkets,
  parseSlotStart,
  pickUpDownTokens,
} from '../src/polymarket/gamma.js';
import { MarketWsClient } from '../src/polymarket/ws_market.js';
import { getBook } from '../src/polymarket/clob.js';

async function main() {
  const now = Date.now();
  const all = await listRewardMarkets('15m');
  const open = all
    .map((rm) => {
      const start = parseSlotStart(rm.market_slug);
      const tokens = pickUpDownTokens(rm.tokens);
      if (!start || !tokens) return null;
      const end = new Date(start.getTime() + 15 * 60_000);
      if (end.getTime() < now || start.getTime() > now + 5 * 60_000) return null;
      return { slug: rm.market_slug, end, yes: tokens.yes, no: tokens.no };
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .slice(0, 2);

  if (open.length === 0) {
    console.error('no currently-open 15m markets');
    process.exit(1);
  }

  const sample = open[0]!;
  console.log('probe market:', sample.slug, 'yes=', sample.yes.slice(0, 20) + '…');

  // First, a REST /book to validate orderbook is reachable.
  try {
    const b = await getBook(sample.yes);
    console.log('REST /book: bids=', b.bids?.length, 'asks=', b.asks?.length, 'last=', b.last_trade_price);
  } catch (e) {
    console.error('REST /book failed:', (e as Error).message);
  }

  let events = 0;
  let snapshots = 0;
  let deltas = 0;
  let trades = 0;
  const client = new MarketWsClient(
    (e) => {
      events++;
      if (e.kind === 'snapshot') snapshots++;
      else if (e.kind === 'delta') deltas++;
      else if (e.kind === 'trade') trades++;
      if (events <= 5) {
        console.log(' event:', e.kind, 'token=' + e.tokenId.slice(0, 20) + '…', 'ts=' + e.ts);
      }
    },
    (state, detail) => console.log(' ws state:', state, detail ?? ''),
  );
  client.start([sample.yes, sample.no]);

  await new Promise((r) => setTimeout(r, 30_000));
  client.stop();
  console.log(`done: events=${events} snapshots=${snapshots} deltas=${deltas} trades=${trades}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
