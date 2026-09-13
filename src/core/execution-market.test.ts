import { describe, expect, it } from "vitest";
import type { Bar, Snapshot } from "../providers/types";
import { DEFAULT_CONFIG } from "../strategy/default/config";
import { freshEntryMarket } from "./execution-market";
import type { MarketContext } from "./types";

const now = Date.parse("2026-09-11T15:00:00Z");
const bar = (at: string, volume = 100_000): Bar => ({
  t: at,
  o: 100,
  h: 101,
  l: 99,
  c: 100,
  v: volume,
  n: 1000,
  vw: 100,
});
const snapshot: Snapshot = {
  feed: "iex",
  symbol: "AAPL",
  latest_trade: { price: 100, size: 100, timestamp: new Date(now - 2000).toISOString() },
  latest_quote: {
    symbol: "AAPL",
    bid_price: 99.98,
    ask_price: 100.02,
    bid_size: 10,
    ask_size: 10,
    timestamp: new Date(now - 1000).toISOString(),
  },
  minute_bar: bar(new Date(now - 60_000).toISOString(), 2000),
  daily_bar: bar("2026-09-11T04:00:00Z", 150_000),
  prev_daily_bar: bar("2026-09-10T04:00:00Z", 390_000),
};
const research: MarketContext = {
  price: 100,
  prev_close: 100,
  gap_pct: 0,
  extension_pct: 0,
  range_position: 0.7,
  rel_volume: 3,
  dollar_volume: 1_000_000_000,
  spread_bps: 1,
  atr_pct: 2,
  rsi_14: 58,
  sma_20: 99,
  sma_50: 97,
  trend: "above both",
  pct_of_52w_high: 90,
};
const config = {
  ...DEFAULT_CONFIG,
  entry_max_spread_bps: 30,
  entry_min_rel_volume: 0,
  entry_min_range_position: 0.5,
  entry_min_pct_of_52w_high: 75,
  stop_atr_multiple: 2.5,
};
const check = (s: Partial<Snapshot> = {}, r: Partial<MarketContext> = {}) =>
  freshEntryMarket({ ...snapshot, ...s }, { ...research, ...r }, config, now);

describe("fresh execution market", () => {
  it("rechecks current IEX measures while preserving completed SIP history", () => {
    const result = check();
    expect(result.rejection).toBeNull();
    expect(result.market).toEqual(
      expect.objectContaining({
        price: 100.02,
        dollar_volume: 1_000_000_000,
        rsi_14: 58,
        sma_20: 99,
        sma_50: 97,
        range_position: 0.5,
        rel_volume: null,
      })
    );
    expect(result.market?.spread_bps).toBeCloseTo(4, 5);
    expect(result.market?.extension_pct).toBeCloseTo(0.02, 5);
    expect(result.market?.atr_pct).toBeCloseTo(2 / 1.0002, 8);
    expect(result.market?.pct_of_52w_high).toBeCloseTo(90 * 1.0002, 8);
    expect(research.price).toBe(100); // helper does not mutate cached evidence
    expect(snapshot.latest_trade.price).toBe(100);
  });

  it("requires explicit IEX provenance and internally matching symbols", () => {
    expect(check({ feed: undefined }).rejection).toMatch(/explicitly identified IEX/);
    expect(check({ feed: "sip" }).rejection).toMatch(/explicitly identified IEX/);
    expect(check({ symbol: "MSFT" }).rejection).toMatch(/symbol mismatch/);
    expect(check({ symbol: "" }).rejection).toMatch(/symbol mismatch/);
    expect(freshEntryMarket(null, research, config, now).rejection).toBeTruthy();
  });

  it.each([
    ["quote", 30_000],
    ["trade", 60_000],
    ["minute bar", 120_000],
  ] as const)("rejects stale, missing and future %s timestamps", (kind, maxAge) => {
    for (const timestamp of [
      new Date(now - maxAge - 1).toISOString(),
      new Date(now + 1).toISOString(),
      "invalid",
      "",
    ]) {
      const s = structuredClone(snapshot);
      if (kind === "quote") s.latest_quote.timestamp = timestamp;
      else if (kind === "trade") s.latest_trade.timestamp = timestamp;
      else s.minute_bar.t = timestamp;
      expect(check(s).rejection).toMatch(/stale, future-dated or missing/);
    }
  });

  it("accepts the timestamp age boundaries", () => {
    const s = structuredClone(snapshot);
    s.latest_quote.timestamp = new Date(now - 30_000).toISOString();
    s.latest_trade.timestamp = new Date(now - 60_000).toISOString();
    s.minute_bar.t = new Date(now - 120_000).toISOString();
    expect(check(s).rejection).toBeNull();
  });

  it("requires today's New York daily bar and a valid prior daily bar date", () => {
    for (const t of ["2026-09-10T04:00:00Z", "2026-09-12T04:00:00Z", "bad"]) {
      expect(check({ daily_bar: { ...snapshot.daily_bar, t } }).rejection).toMatch(/current New York date/);
    }
    for (const t of ["2026-09-11T04:00:00Z", "2026-09-12T04:00:00Z", "bad"]) {
      expect(check({ prev_daily_bar: { ...snapshot.prev_daily_bar, t } }).rejection).toMatch(/previous daily bar date/);
    }
  });

  it.each(["bid_price", "ask_price", "bid_size", "ask_size"] as const)("rejects invalid quote %s", (field) => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(check({ latest_quote: { ...snapshot.latest_quote, [field]: value } }).rejection).toMatch(
        /invalid price or size/
      );
    }
  });

  it("rejects crossed quotes but allows a locked, positive quote", () => {
    expect(check({ latest_quote: { ...snapshot.latest_quote, bid_price: 100.03 } }).rejection).toMatch(/crossed/);
    expect(check({ latest_quote: { ...snapshot.latest_quote, bid_price: 100.02 } }).rejection).toBeNull();
  });

  it("rejects invalid trade price or size without falling back to an old bar", () => {
    for (const field of ["price", "size"]) {
      for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(check({ latest_trade: { ...snapshot.latest_trade, [field]: value } }).rejection).toMatch(
          /invalid price or size/
        );
      }
    }
  });

  it.each(["minute_bar", "daily_bar", "prev_daily_bar"] as const)("rejects malformed %s values", (field) => {
    for (const change of [
      { o: 0 },
      { h: Number.NaN },
      { l: Number.NEGATIVE_INFINITY },
      { c: -1 },
      { v: -1 },
      { n: Number.NaN },
      { vw: 0 },
      { h: 99 },
    ]) {
      expect(check({ [field]: { ...snapshot[field], ...change } }).rejection).toMatch(/bar is invalid/);
    }
  });

  it("leaves relative volume unknown without a matching denominator, including zero-volume minutes", () => {
    const s = { ...snapshot, minute_bar: { ...snapshot.minute_bar, v: 0, n: 0 } };
    expect(freshEntryMarket(s, research, { ...config, entry_min_rel_volume: 1.5 }, now).rejection).toMatch(/Required relative volume unknown/);
    expect(freshEntryMarket(s, research, { ...config, entry_min_rel_volume: 0 }, now).rejection).toBeNull();
  });

  it.each(["ask", "trade"] as const)("rejects over 1%% drift in either direction for the %s", (field) => {
    for (const price of [98.999, 101.001]) {
      const s = structuredClone(snapshot);
      if (field === "ask") {
        s.latest_quote.ask_price = price;
        s.latest_quote.bid_price = price - 0.02;
      } else s.latest_trade.price = price;
      expect(check(s).rejection).toBe(`Execution ${field} drift exceeds 1% from research`);
    }
  });

  it("allows exactly 1% drift subject to all the quality gates", () => {
    const s = structuredClone(snapshot);
    s.latest_quote.ask_price = 101;
    s.latest_quote.bid_price = 100.99;
    s.latest_trade.price = 101;
    expect(check(s).rejection).toBeNull();
  });

  it("rejects a newly wide spread and newly extended executable price", () => {
    expect(check({ latest_quote: { ...snapshot.latest_quote, bid_price: 99.5 } }).rejection).toMatch(/Spread/);
    expect(freshEntryMarket(snapshot, research, { ...config, entry_max_extension_pct: 0.01 }, now).rejection).toMatch(
      /above previous close/
    );
  });

  it("recomputes the 52-week high ratio and traded range instead of accepting research", () => {
    const s = structuredClone(snapshot);
    s.latest_trade.price = 99.8;
    s.latest_quote.ask_price = 99.9;
    s.latest_quote.bid_price = 99.88;
    expect(check(s, { pct_of_52w_high: 75 }).rejection).toMatch(/52-week high/);
    expect(check(s).rejection).toMatch(/day's range/);
  });

  it("rejects missing required history and nonfinite cached technicals", () => {
    expect(check({}, { atr_pct: null }).rejection).toMatch(/Required daily ATR history unknown/);
    expect(check({}, { pct_of_52w_high: null }).rejection).toMatch(/Required 52-week high history unknown/);
    expect(check({}, { dollar_volume: Number.NaN }).rejection).toMatch(/Invalid market metric/);
    expect(check({}, { sma_20: Number.POSITIVE_INFINITY }).rejection).toMatch(/Invalid market metric/);
    expect(check({}, { price: Number.NaN }).rejection).toMatch(/research price/);
    expect(freshEntryMarket(snapshot, research, config, Number.NaN).rejection).toMatch(/check time/);
  });
});
