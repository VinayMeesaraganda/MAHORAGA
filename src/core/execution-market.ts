import type { Bar, Snapshot } from "../providers/types";
import { deriveMarketContext } from "../strategy/default/helpers/market";
import { marketQualityRejection } from "../strategy/default/rules/entry-quality";
import type { AgentConfig, MarketContext } from "./types";

const nyDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
const nonnegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function fresh(timestamp: string | undefined, maxAgeMs: number, now: number): boolean {
  const at = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(at) && at <= now && now - at <= maxAgeMs;
}

function validBar(bar: Bar | undefined, zeroVolumeAllowed = false): bar is Bar {
  if (!bar || ![bar.o, bar.h, bar.l, bar.c, bar.vw].every(positive)) return false;
  if (!(zeroVolumeAllowed ? nonnegative(bar.v) : positive(bar.v)) || !nonnegative(bar.n)) return false;
  return bar.h >= Math.max(bar.o, bar.c, bar.l) && bar.l <= Math.min(bar.o, bar.c, bar.h);
}

export interface FreshEntryMarket {
  rejection: string | null;
  market: MarketContext | null;
}

/**
 * Recheck a long immediately before submission using explicitly requested IEX
 * data. IEX is one venue, not a consolidated NBBO. History-derived metrics must
 * come from the validated completed SIP bars in the research path; never replace
 * their ADV20 with the smaller IEX snapshot volume.
 *
 * This is a point-in-time check, not a bound on a market-order fill. Market
 * orders can still slip after this validation; no execution price is promised.
 */
export function freshEntryMarket(
  snapshot: Snapshot | null | undefined,
  researchMarket: MarketContext | null | undefined,
  config: AgentConfig,
  now = Date.now()
): FreshEntryMarket {
  const reject = (rejection: string): FreshEntryMarket => ({ rejection, market: null });
  if (!Number.isFinite(now)) return reject("Invalid execution check time");
  if (!snapshot || snapshot.feed !== "iex") return reject("Execution requires an explicitly identified IEX snapshot");
  if (!snapshot.symbol?.trim() || snapshot.latest_quote?.symbol !== snapshot.symbol) {
    return reject("Execution snapshot symbol mismatch");
  }
  if (!researchMarket || !positive(researchMarket.price)) return reject("Missing or invalid research price");

  const quote = snapshot.latest_quote;
  const trade = snapshot.latest_trade;
  if (!fresh(quote?.timestamp, 30_000, now)) return reject("Execution quote is stale, future-dated or missing");
  if (!fresh(trade?.timestamp, 60_000, now)) return reject("Execution trade is stale, future-dated or missing");
  if (!fresh(snapshot.minute_bar?.t, 120_000, now))
    return reject("Execution minute bar is stale, future-dated or missing");
  if (![quote.bid_price, quote.ask_price, quote.bid_size, quote.ask_size].every(positive)) {
    return reject("Execution quote has invalid price or size");
  }
  if (quote.ask_price < quote.bid_price) return reject("Execution quote is crossed");
  if (!positive(trade.price) || !positive(trade.size)) return reject("Execution trade has invalid price or size");
  if (!validBar(snapshot.minute_bar, true)) return reject("Execution minute bar is invalid");
  if (!validBar(snapshot.daily_bar)) return reject("Execution daily bar is invalid");
  if (!validBar(snapshot.prev_daily_bar)) return reject("Execution previous daily bar is invalid");

  const today = nyDate.format(new Date(now));
  if (!fresh(snapshot.daily_bar.t, 26 * 3600_000, now) || nyDate.format(new Date(snapshot.daily_bar.t)) !== today) {
    return reject("Execution daily bar is not from the current New York date");
  }
  if (
    !fresh(snapshot.prev_daily_bar.t, Number.MAX_SAFE_INTEGER, now) ||
    nyDate.format(new Date(snapshot.prev_daily_bar.t)) >= today
  ) {
    return reject("Execution previous daily bar date is invalid");
  }

  for (const [label, price] of [
    ["ask", quote.ask_price],
    ["trade", trade.price],
  ] as const) {
    const drift = Math.abs(price / researchMarket.price - 1);
    if (drift > 0.01 + Number.EPSILON * 4) return reject(`Execution ${label} drift exceeds 1% from research`);
  }

  const measured = deriveMarketContext(snapshot)!;
  // Validate at the higher of the ask and latest trade for a long. This avoids
  // passing the extension/price gates using a cheaper, already obsolete print.
  const price = Math.max(quote.ask_price, trade.price);
  const researchRatio = price / researchMarket.price;
  const market: MarketContext = {
    ...measured,
    price,
    extension_pct: (price / snapshot.prev_daily_bar.c - 1) * 100,
    // Participation is based on actual traded prices, not an unfilled ask.
    range_position: measured.range_position,
    dollar_volume: researchMarket.dollar_volume,
    atr_pct: researchMarket.atr_pct === null ? null : researchMarket.atr_pct / researchRatio,
    rsi_14: researchMarket.rsi_14,
    sma_20: researchMarket.sma_20,
    sma_50: researchMarket.sma_50,
    trend:
      positive(researchMarket.sma_20) && positive(researchMarket.sma_50)
        ? price > researchMarket.sma_20 && price > researchMarket.sma_50
          ? "above both"
          : price > researchMarket.sma_20
            ? "above 20"
            : "below both"
        : null,
    pct_of_52w_high: researchMarket.pct_of_52w_high === null ? null : researchMarket.pct_of_52w_high * researchRatio,
  };
  const rejection = marketQualityRejection(market, config);
  return { rejection, market };
}
