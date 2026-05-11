// Throwaway probe: confirm rewards endpoint discovery surfaces real 15-minute markets.
import {
  listRewardMarkets,
  parseSlotStart,
  parseUnderlying,
  pickUpDownTokens,
} from '../src/polymarket/gamma.js';

async function main() {
  const now = Date.now();
  const all = await listRewardMarkets('15m');
  console.log('total entries:', all.length);

  const open: Array<{ slug: string; start: Date; end: Date; underlying: string | null }> = [];
  for (const rm of all) {
    const start = parseSlotStart(rm.market_slug);
    if (!start) continue;
    const tokens = pickUpDownTokens(rm.tokens);
    if (!tokens) continue;
    const end = new Date(start.getTime() + 15 * 60_000);
    if (end.getTime() < now - 60_000) continue;
    if (start.getTime() > now + 30 * 60_000) continue;
    open.push({
      slug: rm.market_slug,
      start,
      end,
      underlying: parseUnderlying(rm.market_slug, rm.question),
    });
  }
  open.sort((a, b) => a.start.getTime() - b.start.getTime());
  console.log('open/imminent markets:', open.length);
  for (const m of open.slice(0, 20)) {
    console.log(
      `  ${m.underlying ?? '???'}  start=${m.start.toISOString()}  end=${m.end.toISOString()}  slug=${m.slug}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
