import { describe, expect, it } from "vitest";
import type { MarketContext, ResearchResult, Signal } from "../../../core/types";
import { DEFAULT_CONFIG } from "../config";
import {
  blockingRedFlags,
  entryRejection,
  marketQualityRejection,
  riskSizedNotional,
  volatilitySizedTrade,
} from "./entry-quality";

const now = Date.now();
const signal: Signal = {
  symbol: "AAPL",
  source: "stocktwits",
  source_detail: "trending",
  sentiment: 0.6,
  raw_sentiment: 0.7,
  volume: 10,
  freshness: 0.8,
  source_weight: 0.85,
  reason: "Positive sentiment",
  timestamp: now,
};
const market: MarketContext = {
  price: 190,
  prev_close: 186,
  gap_pct: 1.1,
  extension_pct: 2.2,
  range_position: 0.6,
  rel_volume: 1.8,
  dollar_volume: 4_000_000_000,
  spread_bps: 3,
  atr_pct: 2.1,
  rsi_14: 58,
  sma_20: 185,
  sma_50: 180,
  trend: "above both",
  pct_of_52w_high: 94,
};
const research: ResearchResult = {
  symbol: "AAPL",
  verdict: "BUY",
  confidence: 0.8,
  entry_quality: "good",
  reasoning: "Fresh positive signal",
  red_flags: [],
  catalysts: [],
  timestamp: now,
  market,
};
function reject(r: Partial<ResearchResult> = {}, s: Partial<Signal> = {}, exits: Record<string, number> = {}) {
  return entryRejection("AAPL", [{ ...signal, ...s }], { ...research, ...r }, DEFAULT_CONFIG, now, exits);
}
describe("shared entry quality gate", () => {
  it("accepts fresh evidence and qualifying research", () => expect(reject()).toBeNull());
  it("blocks expired and future research", () => {
    expect(reject({ timestamp: now - 16 * 60_000 })).toBeTruthy();
    expect(reject({ timestamp: now + 1 })).toBeTruthy();
  });
  it("blocks stale, decayed or negative signals", () => {
    for (const s of [{ timestamp: now - 11 * 60_000 }, { freshness: 0.1 }, { raw_sentiment: -0.2 }])
      expect(reject({}, s)).toBeTruthy();
  });
  it("blocks missing evidence and mismatched symbols", () => {
    expect(entryRejection("AAPL", [], research, DEFAULT_CONFIG, now)).toBeTruthy();
    expect(reject({ symbol: "MSFT" })).toBeTruthy();
  });
  it("rejects invalid confidence, verdict and quality", () => {
    for (const r of [
      { confidence: NaN },
      { confidence: 1.1 },
      { confidence: 0.1 },
      { verdict: "WAIT" as const },
      { entry_quality: "poor" as const },
    ])
      expect(reject(r)).toBeTruthy();
  });
  it("enforces blacklist case-insensitively", () => {
    expect(
      entryRejection("AAPL", [signal], research, { ...DEFAULT_CONFIG, ticker_blacklist: ["aapl"] }, now)
    ).toBeTruthy();
  });
  it("caps notional by equity risk and widens stops by reducing size", () => {
    expect(riskSizedNotional(100000, { ...DEFAULT_CONFIG, max_position_value: 5000 })).toBe(2500);
    expect(riskSizedNotional(100000, { ...DEFAULT_CONFIG, stop_loss_pct: 10 })).toBe(1250);
    expect(riskSizedNotional(50000, DEFAULT_CONFIG)).toBe(1250);
    expect(riskSizedNotional(NaN, DEFAULT_CONFIG)).toBe(0);
  });
});

describe("red flag severity", () => {
  it("classifies disqualifying concerns without tripping on generic caveats", () => {
    expect(blockingRedFlags(["Pending shelf offering could dilute holders"])).toHaveLength(1);
    expect(blockingRedFlags(["Stock was halted twice last week"])).toHaveLength(1);
    expect(blockingRedFlags(["Earnings tomorrow before the open"])).toHaveLength(1);
    expect(blockingRedFlags(["SEC investigation disclosed in the 8-K"])).toHaveLength(1);
    expect(blockingRedFlags(["No fundamentals supplied", "Thesis is sentiment-driven", "Volatile name"])).toEqual([]);
  });
  it("blocks a disqualifying flag but admits tolerated caveats", () => {
    expect(reject({ red_flags: ["Dilution risk from the pending offering"] })).toMatch(/Disqualifying red flag/);
    expect(reject({ red_flags: ["No fundamentals supplied"] })).toBeNull();
    expect(reject({ red_flags: ["No fundamentals", "Unknown news", "Sentiment only"] })).toMatch(/exceed limit/);
  });
  it("still rejects malformed red flag payloads", () => {
    expect(reject({ red_flags: [42 as unknown as string] })).toBeTruthy();
    expect(reject({ red_flags: undefined as unknown as string[] })).toBeTruthy();
  });
});

describe("market quality gate", () => {
  const check = (m: Partial<MarketContext>) => marketQualityRejection({ ...market, ...m }, DEFAULT_CONFIG);
  it("passes a liquid, un-extended name", () => expect(check({})).toBeNull());
  it("rejects sub-threshold price and thin liquidity", () => {
    expect(check({ price: 1.2 })).toMatch(/below minimum/);
    expect(check({ dollar_volume: 200_000 })).toMatch(/Dollar volume/);
  });
  it("rejects wide spreads and extended entries", () => {
    expect(check({ spread_bps: 250 })).toMatch(/Spread/);
    expect(check({ extension_pct: 34 })).toMatch(/above previous close/);
  });
  it("rejects sentiment without participation", () => {
    expect(check({ rel_volume: 0.3 })).toMatch(/Relative volume/);
  });
  it("fails closed when liquidity is unknown but tolerates unknown extension", () => {
    expect(marketQualityRejection(null, DEFAULT_CONFIG)).toMatch(/No market snapshot/);
    expect(check({ dollar_volume: null })).toMatch(/unknown/);
    expect(check({ spread_bps: null })).toMatch(/unknown/);
    expect(check({ extension_pct: null, gap_pct: null, range_position: null })).toBeNull();
    expect(check({ rel_volume: null })).toMatch(/Required relative volume unknown/);
  });
  it("blocks entries whose research carries no snapshot", () => {
    expect(reject({ market: null })).toMatch(/No market snapshot/);
  });

  it("rejects nonfinite price and metrics instead of passing NaN comparisons", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(check({ price: value })).toMatch(/invalid/i);
    for (const field of [
      "prev_close",
      "dollar_volume",
      "spread_bps",
      "extension_pct",
      "gap_pct",
      "rel_volume",
      "range_position",
      "atr_pct",
      "rsi_14",
      "sma_20",
      "sma_50",
      "pct_of_52w_high",
    ] as const) {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
        expect(check({ [field]: value })).toBe(`Invalid market metric: ${field}`);
      }
    }
  });

  it("rejects impossible metric ranges", () => {
    for (const m of [
      { prev_close: 0 },
      { spread_bps: -1 },
      { rel_volume: -1 },
      { dollar_volume: -1 },
      { atr_pct: 0 },
      { range_position: 1.1 },
      { range_position: -0.1 },
      { rsi_14: 101 },
      { sma_20: 0 },
      { sma_50: -1 },
      { pct_of_52w_high: 0 },
    ]) {
      expect(check(m)).toMatch(/Invalid market metric/);
    }
  });

  it("requires history and measurements only when the corresponding rule is enabled", () => {
    const cfg = { ...DEFAULT_CONFIG, stop_atr_multiple: 2.5, entry_min_range_position: 0.5 };
    expect(marketQualityRejection({ ...market, atr_pct: null }, cfg)).toMatch(/Required daily ATR history unknown/);
    expect(marketQualityRejection({ ...market, range_position: null }, cfg)).toMatch(/Required range position unknown/);
    expect(
      marketQualityRejection(
        { ...market, atr_pct: null, pct_of_52w_high: null, rel_volume: null, range_position: null },
        {
          ...DEFAULT_CONFIG,
          stop_atr_multiple: 0,
          entry_min_pct_of_52w_high: 0,
          entry_min_rel_volume: 0,
          entry_min_range_position: 0,
        }
      )
    ).toBeNull();
  });
});

describe("macro event blackout", () => {
  const soon = new Date(now + 30 * 60_000).toISOString();
  const later = new Date(now + 6 * 60 * 60_000).toISOString();
  const withEvents = (events: string[], blackout = 60) => ({
    ...DEFAULT_CONFIG,
    macro_events: events,
    macro_event_blackout_minutes: blackout,
  });

  it("blocks a new entry inside the window before a release", () => {
    const r = entryRejection("AAPL", [signal], research, withEvents([`${soon} CPI release`]), now);
    expect(r).toMatch(/Macro event blackout: CPI release in 30m/);
  });

  it("allows entries well before the event and when disabled", () => {
    expect(entryRejection("AAPL", [signal], research, withEvents([`${later} FOMC`]), now)).toBeNull();
    expect(entryRejection("AAPL", [signal], research, withEvents([`${soon} CPI`], 0), now)).toBeNull();
    expect(entryRejection("AAPL", [signal], research, withEvents([]), now)).toBeNull();
  });

  it("ignores malformed calendar entries rather than blocking everything", () => {
    expect(entryRejection("AAPL", [signal], research, withEvents(["not-a-date CPI"]), now)).toBeNull();
  });
});

describe("re-entry cooldown", () => {
  it("blocks a re-buy inside the window and allows it afterwards", () => {
    expect(reject({}, {}, { AAPL: now - 30 * 60_000 })).toMatch(/Re-entry cooldown/);
    expect(reject({}, {}, { AAPL: now - 121 * 60_000 })).toBeNull();
  });
  it("ignores the cooldown when disabled and ignores future timestamps", () => {
    expect(
      entryRejection("AAPL", [signal], research, { ...DEFAULT_CONFIG, reentry_cooldown_minutes: 0 }, now, {
        AAPL: now - 60_000,
      })
    ).toBeNull();
    expect(reject({}, {}, { AAPL: now + 60_000 })).toBeNull();
  });
});

describe("volatility-normalised sizing", () => {
  const cfg = {
    ...DEFAULT_CONFIG,
    max_position_value: 5000,
    risk_per_trade_pct: 0.25,
    stop_loss_pct: 5,
    take_profit_pct: 10,
    stop_atr_multiple: 2.5,
    stop_min_pct: 3,
    stop_max_pct: 15,
    target_r_multiple: 2,
  };
  const equity = 100_000;
  const riskDollars = 250;

  it("keeps dollar risk constant across wildly different volatilities", () => {
    // Measured live from one most-actives list: T at 2.27% ATR, TNON at 30.70%.
    for (const atr of [2.27, 2.95, 6.58, 30.7]) {
      const t = volatilitySizedTrade(equity, cfg, atr);
      const risked = t.notional * (t.stop_pct / 100);
      // Either the risk is exactly the budget, or max_position_value capped the
      // size, in which case the risk is smaller — never larger.
      expect(risked).toBeLessThanOrEqual(riskDollars + 0.01);
      if (t.notional < cfg.max_position_value) expect(risked).toBeCloseTo(riskDollars, 2);
    }
  });

  it("widens the stop and shrinks the position as volatility rises", () => {
    const calm = volatilitySizedTrade(equity, cfg, 2.95);
    const wild = volatilitySizedTrade(equity, cfg, 6.58);
    expect(wild.stop_pct).toBeGreaterThan(calm.stop_pct);
    expect(wild.notional).toBeLessThan(calm.notional);
  });

  it("clamps the derived stop at both ends", () => {
    // 2.5 x 0.93% (SPY) would be a 2.3% stop; the floor holds it at 3%.
    expect(volatilitySizedTrade(equity, cfg, 0.93).stop_pct).toBe(3);
    // 2.5 x 30.7% would be a 76% stop; the ceiling holds it at 15%.
    expect(volatilitySizedTrade(equity, cfg, 30.7).stop_pct).toBe(15);
  });

  it("preserves the reward-to-risk ratio in the target", () => {
    const t = volatilitySizedTrade(equity, cfg, 4);
    expect(t.target_pct).toBeCloseTo(t.stop_pct * 2, 6);
  });

  it("falls back to fixed percentages without ATR or when disabled", () => {
    for (const atr of [undefined, null, 0, Number.NaN]) {
      const t = volatilitySizedTrade(equity, cfg, atr as number);
      expect(t.stop_pct).toBe(5);
      expect(t.target_pct).toBe(10);
    }
    const off = volatilitySizedTrade(equity, { ...cfg, stop_atr_multiple: 0 }, 6.58);
    expect(off.stop_pct).toBe(5);
  });

  it("never sizes above max_position_value and handles invalid equity", () => {
    expect(volatilitySizedTrade(equity, cfg, 1).notional).toBe(5000);
    expect(volatilitySizedTrade(Number.NaN, cfg, 4).notional).toBe(0);
    expect(volatilitySizedTrade(-1, cfg, 4).notional).toBe(0);
  });
});

describe("52-week high gate", () => {
  const cfg = { ...DEFAULT_CONFIG, entry_min_pct_of_52w_high: 75 };
  it("rejects a heavy-volume pop far below the 52-week high", () => {
    expect(marketQualityRejection({ ...market, pct_of_52w_high: 58 }, cfg)).toMatch(/52-week high/);
  });
  it("admits names near their high and blocks unknown history", () => {
    expect(marketQualityRejection({ ...market, pct_of_52w_high: 91 }, cfg)).toBeNull();
    expect(marketQualityRejection({ ...market, pct_of_52w_high: null }, cfg)).toMatch(
      /Required 52-week high history unknown/
    );
  });
  it("is disabled at zero", () => {
    expect(
      marketQualityRejection({ ...market, pct_of_52w_high: 12 }, { ...DEFAULT_CONFIG, entry_min_pct_of_52w_high: 0 })
    ).toBeNull();
  });
});

describe("catalyst requirement", () => {
  const cfg = { ...DEFAULT_CONFIG, entry_require_catalyst: true, entry_min_catalyst_quality: "medium" as const };
  const cat = (quality: "low" | "medium" | "high", at = now) => ({
    AAPL: [{ type: "guidance" as const, quality, matched: "raises guidance", at }],
  });

  it("refuses an entry with no classified catalyst", () => {
    expect(entryRejection("AAPL", [signal], research, cfg, now, {}, {})).toBe("No qualifying catalyst");
  });

  it("admits a catalyst at or above the required quality", () => {
    expect(entryRejection("AAPL", [signal], research, cfg, now, {}, cat("high"))).toBeNull();
    expect(entryRejection("AAPL", [signal], research, cfg, now, {}, cat("medium"))).toBeNull();
  });

  it("refuses one below it, naming the shortfall", () => {
    expect(entryRejection("AAPL", [signal], research, cfg, now, {}, cat("low"))).toMatch(
      /quality low.*below required medium/
    );
  });

  it("expires a catalyst past the age window but tolerates the drift horizon", () => {
    // Drift runs for days: a catalyst from this morning still qualifies.
    expect(entryRejection("AAPL", [signal], research, cfg, now, {}, cat("high", now - 8 * 3600_000))).toBeNull();
    expect(entryRejection("AAPL", [signal], research, cfg, now, {}, cat("high", now - 40 * 3600_000))).toBe(
      "No qualifying catalyst"
    );
    // A future timestamp is not evidence of anything.
    expect(entryRejection("AAPL", [signal], research, cfg, now, {}, cat("high", now + 60_000))).toBe(
      "No qualifying catalyst"
    );
  });

  it("is inert when the requirement is off", () => {
    expect(entryRejection("AAPL", [signal], research, DEFAULT_CONFIG, now, {}, {})).toBeNull();
  });
});
