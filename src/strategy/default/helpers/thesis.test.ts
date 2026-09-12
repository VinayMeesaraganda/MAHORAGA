import { describe, expect, it } from "vitest";
import type { MarketContext, ResearchResult } from "../../../core/types";
import type { MacroRegime } from "./macro";
import { buildThesis, classifyOutcome, regimeTags, rMultiple } from "./thesis";

const market: MarketContext = {
  price: 21.16,
  prev_close: 20.8,
  gap_pct: 0.9,
  extension_pct: 1.7,
  range_position: 0.61,
  rel_volume: 2.4,
  dollar_volume: 135_000_000,
  spread_bps: 6,
  atr_pct: 2.97,
  rsi_14: 70,
  sma_20: 20.1,
  sma_50: 19.4,
  trend: "above both",
  pct_of_52w_high: 75,
};
const research: ResearchResult = {
  symbol: "GME",
  verdict: "BUY",
  confidence: 0.78,
  entry_quality: "good",
  reasoning: "Earnings beat with volume confirmation.",
  red_flags: [],
  catalysts: ["EPS surprise"],
  timestamp: Date.now(),
  market,
};
const regime = {
  as_of: Date.now(),
  risk: "risk-on",
  yields: "flat",
  oil_pct: -2.19,
  gold_pct: 0.57,
  dollar_pct: 0.11,
  volatility_pct: -4.6,
  spy_pct: 0.84,
  qqq_pct: 0.88,
  iwm_pct: 0.47,
  leaders: [
    { symbol: "XLK", name: "Technology", change_pct: 1.31 },
    { symbol: "XLI", name: "Industrials", change_pct: 1.08 },
  ],
  laggards: [{ symbol: "XLU", name: "Utilities", change_pct: -0.35 }],
  breadth_pct: 0.05,
  credit_pct: 0.05,
  size_pct: -0.36,
} as MacroRegime;

describe("rMultiple", () => {
  it("is the only unit that compares trades with different stops", () => {
    // The same +15% is 1R on a 15% stop and 3R on a 5% stop.
    expect(rMultiple(15, 15)).toBeCloseTo(1, 6);
    expect(rMultiple(15, 5)).toBeCloseTo(3, 6);
    expect(rMultiple(-7.4, 7.4)).toBeCloseTo(-1, 6);
  });
  it("returns null rather than a misleading number on bad input", () => {
    expect(rMultiple(10, 0)).toBeNull();
    expect(rMultiple(Number.NaN, 5)).toBeNull();
    expect(rMultiple(10, -5)).toBeNull();
  });
});

describe("classifyOutcome", () => {
  it("treats near-zero as a scratch rather than a win or loss", () => {
    expect(classifyOutcome(4.2)).toBe("win");
    expect(classifyOutcome(-6.1)).toBe("loss");
    expect(classifyOutcome(0.2)).toBe("scratch");
    expect(classifyOutcome(-0.3)).toBe("scratch");
  });
});

describe("buildThesis", () => {
  const catalyst = {
    type: "earnings" as const,
    quality: "high" as const,
    matched: "tops estimates",
    headline: "Q2 EPS 0.27 vs 0.06 estimate",
    at: Date.now() - 36 * 3600_000,
  };

  it("captures the reason, the measurements and the plan", () => {
    const t = buildThesis({
      symbol: "GME",
      catalyst,
      research,
      market,
      regime,
      stopPct: 7.4,
      targetPct: 14.8,
      notional: 3371,
    });
    expect(t.summary).toContain("GME");
    expect(t.summary).toContain("earnings (high)");
    expect(t.summary).toContain("75% of 52w high");
    expect(t.catalyst?.age_hours).toBeCloseTo(36, 0);
    expect(t.research?.confidence).toBe(0.78);
    expect(t.gates.pct_of_52w_high).toBe(75);
    expect(t.gates.atr_pct).toBe(2.97);
    expect(t.gates.rsi_14).toBe(70);
    // Risk is the denominator for R, so it must be stored not recomputed later.
    expect(t.plan.risk_usd).toBeCloseTo(3371 * 0.074, 2);
  });

  it("records absence explicitly instead of omitting it", () => {
    const t = buildThesis({
      symbol: "XYZ",
      catalyst: null,
      research: undefined,
      market: null,
      regime: null,
      stopPct: 5,
      targetPct: 10,
      notional: 1000,
    });
    expect(t.catalyst).toBeNull();
    expect(t.research).toBeNull();
    expect(t.summary).toContain("no catalyst recorded");
    expect(t.gates.pct_of_52w_high).toBeNull();
  });
});

describe("regimeTags", () => {
  it("flattens the tape into groupable tags", () => {
    expect(regimeTags(regime)).toEqual(["risk:risk-on", "yields:flat", "leader:XLK", "leader:XLI", "laggard:XLU"]);
    expect(regimeTags(null)).toEqual([]);
  });
});
