import { describe, expect, it } from "vitest";
import type { Account, Position, PositionEntry } from "../../../core/types";
import type { StrategyContext } from "../../types";
import { DEFAULT_CONFIG } from "../config";
import { selectExits } from "./exits";

const HOUR = 3_600_000;
const account = { equity: 100_000, cash: 50_000, buying_power: 50_000 } as unknown as Account;

function position(overrides: Partial<Position> = {}): Position {
  // Cost basis is market_value - unrealized_pl, which is how the exit rules derive P&L.
  return {
    symbol: "AAPL",
    qty: 10,
    avg_entry_price: 100,
    current_price: 100,
    market_value: 1000,
    unrealized_pl: 0,
    asset_class: "us_equity",
    ...overrides,
  } as Position;
}

function entry(overrides: Partial<PositionEntry> = {}): PositionEntry {
  return {
    symbol: "AAPL",
    entry_time: Date.now() - HOUR,
    entry_price: 100,
    entry_sentiment: 0.6,
    entry_social_volume: 10,
    entry_sources: ["stocktwits"],
    entry_reason: "test",
    peak_price: 100,
    peak_sentiment: 0.6,
    ...overrides,
  };
}

function context(config: Partial<typeof DEFAULT_CONFIG>, entries: Record<string, PositionEntry>): StrategyContext {
  const store: Record<string, unknown> = { socialSnapshotCache: {}, stalenessAnalysis: {} };
  return {
    config: { ...DEFAULT_CONFIG, stale_position_enabled: false, ...config },
    positionEntries: entries,
    state: {
      get: <T>(key: string) => store[key] as T | undefined,
      set: <T>(key: string, value: T) => {
        store[key] = value;
      },
    },
  } as unknown as StrategyContext;
}

describe("equity exits", () => {
  it("backfills entry price and peak from the broker position", () => {
    const entries = { AAPL: entry({ entry_price: 0, peak_price: 0 }) };
    const ctx = context({}, entries);
    selectExits(ctx, [position({ current_price: 105, market_value: 1050, unrealized_pl: 50 })], account);
    expect(entries.AAPL.entry_price).toBe(100);
    expect(entries.AAPL.peak_price).toBe(105);
  });

  it("still takes profit and stops out on the configured thresholds", () => {
    const ctx = context({}, { AAPL: entry() });
    const tp = selectExits(ctx, [position({ current_price: 111, market_value: 1110, unrealized_pl: 110 })], account);
    expect(tp[0]?.reason).toMatch(/Take profit/);
    const sl = selectExits(ctx, [position({ current_price: 94, market_value: 940, unrealized_pl: -60 })], account);
    expect(sl[0]?.reason).toMatch(/Stop loss/);
  });

  it("arms the trailing stop only after the gain exceeds the trail distance", () => {
    const armed = context({ trailing_stop_pct: 4 }, { AAPL: entry({ peak_price: 108 }) });
    // Peaked at +8%, now +3.5%: 7.4% off the peak, so the trail fires.
    const exits = selectExits(
      armed,
      [position({ current_price: 100, market_value: 1000, unrealized_pl: 35 })],
      account
    );
    expect(exits[0]?.reason).toMatch(/Trailing stop/);

    // Never got far enough above the entry for the trail to arm.
    const unarmed = context({ trailing_stop_pct: 4 }, { AAPL: entry({ peak_price: 102 }) });
    expect(
      selectExits(unarmed, [position({ current_price: 98, market_value: 980, unrealized_pl: -20 })], account)
    ).toEqual([]);
  });

  it("arms only above the separate arm threshold, not at the trail distance", () => {
    // Arm 6 / trail 3: a position that peaked at +4% has not armed, so a 3%
    // give-back is ordinary noise rather than an exit.
    const notArmed = context({ trailing_stop_pct: 3, trailing_arm_pct: 6 }, { AAPL: entry({ peak_price: 104 }) });
    expect(
      selectExits(notArmed, [position({ current_price: 100.5, market_value: 1005, unrealized_pl: 5 })], account)
    ).toEqual([]);

    // Peaked at +8%, now 3.7% off the peak -> armed and triggered, exiting at a
    // real gain rather than at break-even.
    const armed = context({ trailing_stop_pct: 3, trailing_arm_pct: 6 }, { AAPL: entry({ peak_price: 108 }) });
    const exits = selectExits(
      armed,
      [position({ current_price: 104, market_value: 1040, unrealized_pl: 40 })],
      account
    );
    expect(exits[0]?.reason).toMatch(/Trailing stop/);
    expect(exits[0]?.reason).toMatch(/peak was \+8\.0%/);
  });

  it("locks in a gain rather than exiting near break-even", () => {
    // The failure mode of arm == trail: peak +6%, give back 6%, out at ~0%.
    const breakeven = context({ trailing_stop_pct: 6, trailing_arm_pct: 0 }, { AAPL: entry({ peak_price: 106 }) });
    expect(
      selectExits(breakeven, [position({ current_price: 99.6, market_value: 996, unrealized_pl: -4 })], account)
    ).toHaveLength(1);

    // With the arm raised, the same position exits only after a 3% give-back,
    // which from a +6% peak is still roughly +2.8%.
    const locked = context({ trailing_stop_pct: 3, trailing_arm_pct: 6 }, { AAPL: entry({ peak_price: 106 }) });
    expect(
      selectExits(locked, [position({ current_price: 102.8, market_value: 1028, unrealized_pl: 28 })], account)
    ).toHaveLength(1);
  });

  it("leaves positions alone when the trailing stop is disabled", () => {
    const ctx = context({ trailing_stop_pct: 0 }, { AAPL: entry({ peak_price: 120 }) });
    expect(
      selectExits(ctx, [position({ current_price: 101, market_value: 1010, unrealized_pl: 10 })], account)
    ).toEqual([]);
  });

  it("applies the time stop without needing social history", () => {
    const ctx = context({ max_hold_days: 5 }, { AAPL: entry({ entry_time: Date.now() - 6 * 24 * HOUR }) });
    const exits = selectExits(ctx, [position({ current_price: 101, market_value: 1010, unrealized_pl: 10 })], account);
    expect(exits[0]?.reason).toMatch(/Time stop/);

    const young = context({ max_hold_days: 5 }, { AAPL: entry({ entry_time: Date.now() - 2 * 24 * HOUR }) });
    expect(
      selectExits(young, [position({ current_price: 101, market_value: 1010, unrealized_pl: 10 })], account)
    ).toEqual([]);
  });

  it("trails by initial dollar risk on a 15% stop rather than a percentage of the peak", () => {
    const entries = { AAPL: entry({ stop_pct: 15, target_pct: 30, peak_price: 122.5 }) };
    const ctx = context({ trailing_arm_r: 1.5, trailing_stop_r: 1, trailing_stop_pct: 3 }, entries);
    // Entry $100, initial R $15, peak $122.50: true 1R trailing floor is
    // $107.50 (+0.5R), not $104.125 as a 15%-of-peak trail would produce.
    expect(
      selectExits(ctx, [position({ current_price: 107.51, market_value: 1075.1, unrealized_pl: 75.1 })], account)
    ).toEqual([]);
    const exits = selectExits(
      ctx,
      [position({ current_price: 107.5, market_value: 1075, unrealized_pl: 75 })],
      account
    );
    expect(exits).toHaveLength(1);
    expect(exits[0]?.reason).toMatch(/Trailing stop/);
    expect(exits[0]?.reason).toMatch(/1\.5R/);
  });

  it("keeps R trailing unarmed below the configured risk multiple", () => {
    const ctx = context(
      { trailing_arm_r: 1.5, trailing_stop_r: 1 },
      { AAPL: entry({ stop_pct: 15, target_pct: 30, peak_price: 122 }) }
    );
    expect(
      selectExits(ctx, [position({ current_price: 106, market_value: 1060, unrealized_pl: 60 })], account)
    ).toEqual([]);
  });

  it("preserves the percent-of-peak trail when R mode is disabled", () => {
    const ctx = context(
      { trailing_arm_r: 0, trailing_stop_r: 0, trailing_arm_pct: 22.5, trailing_stop_pct: 15 },
      { AAPL: entry({ stop_pct: 15, target_pct: 30, peak_price: 122.5 }) }
    );
    expect(
      selectExits(ctx, [position({ current_price: 107.5, market_value: 1075, unrealized_pl: 75 })], account)
    ).toEqual([]);
    const exits = selectExits(
      ctx,
      [position({ current_price: 104.125, market_value: 1041.25, unrealized_pl: 41.25 })],
      account
    );
    expect(exits[0]?.reason).toMatch(/pct mode/);
  });

  it("prefers the hard stop over the trailing stop when both would fire", () => {
    const ctx = context({ trailing_stop_pct: 4 }, { AAPL: entry({ peak_price: 110 }) });
    const exits = selectExits(ctx, [position({ current_price: 94, market_value: 940, unrealized_pl: -60 })], account);
    expect(exits).toHaveLength(1);
    expect(exits[0]?.reason).toMatch(/Stop loss/);
  });
});

describe("gap capture", () => {
  // From a live example: entered before earnings, the stock ran 15% after
  // hours, the target was never reached, and the whole gain was given back the
  // next morning. At that name's real 13.4% ATR-derived stop, +15% is 1.12R —
  // below the 1.5R the trail arms at, and the trail could not have seen an
  // after-hours price anyway.
  const cfg = { trailing_stop_pct: 0, gap_capture_r: 1.0, max_hold_days: 0 };
  const entry13 = () => entry({ entry_price: 100, peak_price: 100, stop_pct: 13.4, target_pct: 26.8 });

  it("takes a gapped gain at the first check of the session", () => {
    const ctx = context(cfg, { AAPL: entry13() });
    const exits = selectExits(ctx, [position({ current_price: 115, market_value: 1150, unrealized_pl: 150 })], account);
    expect(exits[0]?.reason).toMatch(/Gap capture/);
    expect(exits[0]?.reason).toMatch(/1\.12R/);
  });

  it("runs once per session, not on every alarm", () => {
    const entries = { AAPL: entry13() };
    const ctx = context(cfg, entries);
    const pos = [position({ current_price: 115, market_value: 1150, unrealized_pl: 150 })];
    expect(selectExits(ctx, pos, account)).toHaveLength(1);
    // Second alarm the same day: already checked, so it must not fire again.
    expect(selectExits(ctx, pos, account)).toHaveLength(0);
  });

  it("leaves a gain below the threshold alone", () => {
    const ctx = context(cfg, { AAPL: entry13() });
    // +10% on a 13.4% stop is 0.75R — not enough to abandon the target.
    expect(
      selectExits(ctx, [position({ current_price: 110, market_value: 1100, unrealized_pl: 100 })], account)
    ).toEqual([]);
  });

  it("is disabled at zero and never fires on a loss", () => {
    const off = context({ ...cfg, gap_capture_r: 0 }, { AAPL: entry13() });
    expect(
      selectExits(off, [position({ current_price: 115, market_value: 1150, unrealized_pl: 150 })], account)
    ).toEqual([]);
    const losing = context(cfg, { AAPL: entry13() });
    expect(
      selectExits(losing, [position({ current_price: 96, market_value: 960, unrealized_pl: -40 })], account)
    ).toEqual([]);
  });

  it("does not pre-empt a genuine target hit", () => {
    // At +27% the target is reached; that path should win, not gap capture.
    const ctx = context(cfg, { AAPL: entry13() });
    const exits = selectExits(ctx, [position({ current_price: 127, market_value: 1270, unrealized_pl: 270 })], account);
    expect(exits[0]?.reason).toMatch(/Take profit/);
  });
});
