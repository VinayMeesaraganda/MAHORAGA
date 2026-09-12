import { describe, expect, it } from "vitest";
import type { Snapshot } from "../../../providers/types";
import { deriveMarketContext, describeMarketContext, withTechnicals } from "./market";

const bar = (o: number, h: number, l: number, c: number, v: number, vw = c) => ({
  t: "2026-09-11T13:30:00Z",
  o,
  h,
  l,
  c,
  v,
  n: 100,
  vw,
});

const snapshot: Snapshot = {
  symbol: "AAPL",
  latest_trade: { price: 102, size: 100, timestamp: "2026-09-11T15:00:00Z" },
  latest_quote: {
    symbol: "AAPL",
    bid_price: 101.95,
    bid_size: 5,
    ask_price: 102.05,
    ask_size: 5,
    timestamp: "2026-09-11T15:00:00Z",
  },
  minute_bar: bar(101.9, 102.1, 101.8, 102, 3900),
  daily_bar: bar(101, 103, 100.5, 102, 500_000),
  prev_daily_bar: bar(99, 100.5, 98, 100, 780_000, 99.5),
};

describe("deriveMarketContext", () => {
  it("derives gap, extension, range position, relative volume, liquidity and spread", () => {
    const m = deriveMarketContext(snapshot)!;
    expect(m.price).toBe(102);
    expect(m.gap_pct).toBeCloseTo(1, 5); // 101 open vs 100 previous close
    expect(m.extension_pct).toBeCloseTo(2, 5); // 102 now vs 100 previous close
    expect(m.range_position).toBeCloseTo(0.6, 5); // (102-100.5)/(103-100.5)
    expect(m.rel_volume).toBeCloseTo(1.95, 2); // 3900 vs 780000/390
    expect(m.dollar_volume).toBeCloseTo(780_000 * 99.5, 5);
    expect(m.spread_bps).toBeCloseTo(9.8, 1);
  });

  it("reports unknown rather than guessing when bars or quotes are missing", () => {
    const partial = deriveMarketContext({
      ...snapshot,
      latest_quote: { ...snapshot.latest_quote, bid_price: 0, ask_price: 0 },
      prev_daily_bar: bar(0, 0, 0, 0, 0, 0),
    })!;
    expect(partial.price).toBe(102);
    expect(partial.spread_bps).toBeNull();
    expect(partial.dollar_volume).toBeNull();
    expect(partial.extension_pct).toBeNull();
    expect(partial.rel_volume).toBeNull();
  });

  it("returns null when no usable price exists", () => {
    expect(deriveMarketContext(null)).toBeNull();
    expect(
      deriveMarketContext({
        ...snapshot,
        latest_trade: { price: 0, size: 0, timestamp: "" },
        minute_bar: bar(0, 0, 0, 0, 0, 0),
        latest_quote: { ...snapshot.latest_quote, bid_price: 0, ask_price: 0 },
      })
    ).toBeNull();
  });

  it("describes missing context as unknown for the prompt", () => {
    expect(describeMarketContext(null)).toMatch(/unknown/);
    expect(describeMarketContext(deriveMarketContext(snapshot))).toMatch(/Relative volume right now: 1\.9x normal/);
  });
});

describe("withTechnicals", () => {
  // A rising series: each close 1 higher, 60 sessions, so SMAs sit below price.
  const rising = [...Array(60)].map((_, i) => bar(100 + i, 101 + i, 99 + i, 100.5 + i, 1_000_000));
  const base = deriveMarketContext(snapshot)!;

  it("expresses ATR as a percentage of price, comparable with the configured stop", () => {
    const m = withTechnicals({ ...base, price: 100 }, rising)!;
    // Each bar spans 99..101 around a 100 price, so true range is ~2% of price.
    expect(m.atr_pct).not.toBeNull();
    expect(m.atr_pct!).toBeGreaterThan(1);
    expect(m.atr_pct!).toBeLessThan(4);
  });

  it("classifies trend against the 20 and 50 day averages", () => {
    const above = withTechnicals({ ...base, price: 1000 }, rising)!;
    expect(above.trend).toBe("above both");
    const below = withTechnicals({ ...base, price: 1 }, rising)!;
    expect(below.trend).toBe("below both");
  });

  it("computes RSI and leaves the price-derived snapshot fields untouched", () => {
    const m = withTechnicals(base, rising)!;
    expect(m.rsi_14).not.toBeNull();
    expect(m.rsi_14!).toBeGreaterThan(50); // monotonically rising series
    expect(m.spread_bps).toBe(base.spread_bps);
    expect(m.extension_pct).toBe(base.extension_pct);
    // dollar_volume is deliberately replaced: see "dollar volume source" below.
  });

  it("reports unknown rather than guessing when history is too short", () => {
    const m = withTechnicals(base, rising.slice(0, 10))!;
    expect(m.atr_pct).toBeNull();
    expect(m.rsi_14).toBeNull();
    expect(m.trend).toBeNull();
  });

  it("passes a null context through untouched", () => {
    expect(withTechnicals(null, rising)).toBeNull();
  });

  it("surfaces the technicals in the prompt description", () => {
    const text = describeMarketContext(withTechnicals({ ...base, price: 1000 }, rising));
    expect(text).toMatch(/Daily ATR: \d+\.\d% of price/);
    expect(text).toMatch(/RSI\(14\): \d+/);
    expect(text).toMatch(/Trend: price above both moving average\(s\)/);
  });
});

describe("dollar volume source", () => {
  const base = deriveMarketContext(snapshot)!;

  it("replaces the snapshot figure with ADV20 from the bars", () => {
    // Snapshots are IEX-only on this plan (SIP 403s there) while bars carry the
    // full tape, so liquidity must be measured from the bars.
    const bars = [...Array(30)].map(() => bar(100, 101, 99, 100, 5_000_000, 100));
    const m = withTechnicals(base, bars)!;
    expect(m.dollar_volume).toBeCloseTo(5_000_000 * 100, 0);
    expect(m.dollar_volume).not.toBe(base.dollar_volume);
  });

  it("keeps the snapshot figure when there are too few bars to average", () => {
    const m = withTechnicals(
      base,
      [...Array(20)].map(() => bar(100, 101, 99, 100, 0, 100))
    )!;
    expect(m.dollar_volume).toBe(base.dollar_volume);
  });
});
