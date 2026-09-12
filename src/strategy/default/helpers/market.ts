/**
 * Market-context helpers.
 *
 * The signal-research path already fetches an Alpaca snapshot to read the last
 * price. That snapshot also carries today's bar, the previous daily bar, the
 * last minute bar and the NBBO quote, so liquidity and extension can be derived
 * with no additional API calls.
 *
 * Pure functions — no side effects, no state.
 */

import type { MarketContext } from "../../../core/types";
import { calculateATR, calculateRSI, calculateSMA } from "../../../providers/technicals";
import type { Bar, Snapshot } from "../../../providers/types";

const MINUTES_PER_SESSION = 390;

function finitePositive(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Derive tradability metrics from a snapshot.
 *
 * Every field is independently nullable: Alpaca omits bars for thin names and
 * returns zeroed quotes outside regular hours. A missing field stays null so
 * callers can distinguish "unknown" from "bad", which the gates treat
 * differently from a value that is present and out of range.
 */
export function deriveMarketContext(snapshot: Snapshot | null | undefined): MarketContext | null {
  if (!snapshot) return null;

  const price =
    finitePositive(snapshot.latest_trade?.price) ??
    finitePositive(snapshot.minute_bar?.c) ??
    finitePositive(snapshot.latest_quote?.ask_price);
  if (price === null) return null;

  const prevClose = finitePositive(snapshot.prev_daily_bar?.c);
  const prevVolume = finitePositive(snapshot.prev_daily_bar?.v);
  const prevVwap = finitePositive(snapshot.prev_daily_bar?.vw) ?? prevClose;

  const bid = finitePositive(snapshot.latest_quote?.bid_price);
  const ask = finitePositive(snapshot.latest_quote?.ask_price);
  const mid = bid !== null && ask !== null && ask >= bid ? (bid + ask) / 2 : null;

  const dayOpen = finitePositive(snapshot.daily_bar?.o);
  const dayHigh = finitePositive(snapshot.daily_bar?.h);
  const dayLow = finitePositive(snapshot.daily_bar?.l);
  const minuteVolume = snapshot.minute_bar?.v;

  return {
    price,
    prev_close: prevClose,
    /** Overnight gap: today's open against the previous close. */
    gap_pct: prevClose !== null && dayOpen !== null ? ((dayOpen - prevClose) / prevClose) * 100 : null,
    /** How far the current print already is beyond the previous close. */
    extension_pct: prevClose !== null ? ((price - prevClose) / prevClose) * 100 : null,
    /** 0 = at the session low, 1 = at the session high. */
    range_position:
      dayHigh !== null && dayLow !== null && dayHigh > dayLow
        ? Math.min(1, Math.max(0, (price - dayLow) / (dayHigh - dayLow)))
        : null,
    /** Current minute's volume against the previous session's per-minute average. */
    rel_volume:
      prevVolume !== null && typeof minuteVolume === "number" && Number.isFinite(minuteVolume) && minuteVolume >= 0
        ? minuteVolume / (prevVolume / MINUTES_PER_SESSION)
        : null,
    /** Previous session's traded dollars — the liquidity floor that matters for exits. */
    dollar_volume: prevVolume !== null && prevVwap !== null ? prevVolume * prevVwap : null,
    spread_bps: mid !== null && bid !== null && ask !== null ? ((ask - bid) / mid) * 10_000 : null,
    atr_pct: null,
    rsi_14: null,
    sma_20: null,
    sma_50: null,
    trend: null,
    pct_of_52w_high: null,
  };
}

/**
 * Fold daily-bar technicals into a context.
 *
 * ATR is expressed as a percentage of price so it is directly comparable with
 * the configured stop: a 5% stop on a name whose ATR is 8% is inside one day's
 * normal range, which is how a fixed percentage stop gets hit by noise rather
 * than by being wrong.
 */
export function withTechnicals(market: MarketContext | null, bars: Bar[]): MarketContext | null {
  if (!market) return null;
  if (!Array.isArray(bars) || bars.length < 15) return market;

  const closes = bars.map((b) => b.c).filter((c) => Number.isFinite(c) && c > 0);
  const atr = calculateATR(bars, 14);
  const sma20 = calculateSMA(closes, 20);
  const sma50 = calculateSMA(closes, 50);

  let trend: MarketContext["trend"] = null;
  if (sma20 !== null && sma50 !== null) {
    if (market.price > sma20 && market.price > sma50) trend = "above both";
    else if (market.price > sma20) trend = "above 20";
    else trend = "below both";
  }

  // Dollar volume must come from the bars, not the snapshot: snapshots are
  // IEX-only on this plan (SIP 403s there) while bars carry the full tape.
  // Twenty sessions rather than one, because a single day is noisy and ADV20 is
  // the figure liquidity rules are normally written against.
  const recent = bars.slice(-20).filter((b) => Number.isFinite(b.v) && b.v > 0);
  const adv20 =
    recent.length >= 5
      ? recent.reduce((sum, b) => sum + b.v * (Number.isFinite(b.vw) && b.vw > 0 ? b.vw : b.c), 0) / recent.length
      : null;

  // Needs most of a year of history to mean anything; a 60-bar window would
  // report a three-month high and call it a 52-week high.
  const highs = bars.map((b) => b.h).filter((h) => Number.isFinite(h) && h > 0);
  const high52 = bars.length >= 180 && highs.length ? Math.max(...highs) : null;

  return {
    ...market,
    dollar_volume: adv20 ?? market.dollar_volume,
    atr_pct: atr !== null && market.price > 0 ? (atr / market.price) * 100 : null,
    rsi_14: calculateRSI(closes, 14),
    sma_20: sma20,
    sma_50: sma50,
    trend,
    pct_of_52w_high: high52 !== null && high52 > 0 ? (market.price / high52) * 100 : null,
  };
}

/** Format the context for an LLM prompt. Unknown fields are stated as unknown, never guessed. */
export function describeMarketContext(market: MarketContext | null): string {
  if (!market) return "- Price and liquidity data: unknown (snapshot unavailable)";
  const pct = (v: number | null, unit = "%") => (v === null ? "unknown" : `${v.toFixed(1)}${unit}`);
  return [
    `- Price: $${market.price.toFixed(2)} (previous close: ${market.prev_close === null ? "unknown" : `$${market.prev_close.toFixed(2)}`})`,
    `- Move vs previous close: ${pct(market.extension_pct)} (overnight gap: ${pct(market.gap_pct)})`,
    `- Position in today's range: ${market.range_position === null ? "unknown" : `${(market.range_position * 100).toFixed(0)}% (100% = at the high)`}`,
    `- Relative volume right now: ${market.rel_volume === null ? "unknown" : `${market.rel_volume.toFixed(1)}x normal`}`,
    `- Average daily dollar volume: ${market.dollar_volume === null ? "unknown" : `$${(market.dollar_volume / 1_000_000).toFixed(1)}M`}`,
    `- Quoted spread: ${market.spread_bps === null ? "unknown" : `${market.spread_bps.toFixed(0)} bps`}`,
    `- Daily ATR: ${market.atr_pct === null ? "unknown" : `${market.atr_pct.toFixed(1)}% of price`}`,
    `- RSI(14): ${market.rsi_14 === null ? "unknown" : market.rsi_14.toFixed(0)}`,
    `- Trend: ${market.trend === null ? "unknown" : `price ${market.trend} moving average(s) (20d/50d)`}`,
    `- Distance from 52-week high: ${market.pct_of_52w_high === null ? "unknown" : `at ${market.pct_of_52w_high.toFixed(0)}% of it`}`,
  ].join("\n");
}
