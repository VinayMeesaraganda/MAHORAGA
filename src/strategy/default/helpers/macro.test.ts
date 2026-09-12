import { describe, expect, it } from "vitest";
import type { Snapshot } from "../../../providers/types";
import { deriveMacroRegime, describeMacroRegime, MACRO_BASKET, SECTOR_ETFS } from "./macro";

const bar = (c: number) => ({ t: "", o: c, h: c, l: c, c, v: 1_000_000, n: 10, vw: c });
function snap(price: number, prevClose: number): Snapshot {
  return {
    symbol: "X",
    latest_trade: { price, size: 1, timestamp: "" },
    latest_quote: { symbol: "X", bid_price: price, bid_size: 1, ask_price: price, ask_size: 1, timestamp: "" },
    minute_bar: bar(price),
    daily_bar: bar(price),
    prev_daily_bar: bar(prevClose),
  };
}
/** Build a snapshot map from symbol -> percentage change. */
function tape(moves: Record<string, number>): Record<string, Snapshot> {
  const out: Record<string, Snapshot> = {};
  for (const [sym, pct] of Object.entries(moves)) out[sym] = snap(100 * (1 + pct / 100), 100);
  return out;
}

describe("deriveMacroRegime", () => {
  it("covers rates, commodities, breadth and every sector in one basket", () => {
    expect(MACRO_BASKET).toContain("TLT");
    expect(MACRO_BASKET).toContain("USO");
    expect(MACRO_BASKET).toContain("VIXY");
    for (const sector of Object.keys(SECTOR_ETFS)) expect(MACRO_BASKET).toContain(sector);
  });

  it("reads risk-on when equities rise and volatility falls", () => {
    const r = deriveMacroRegime(tape({ SPY: 0.9, VIXY: -4.6, TLT: 0.1 }));
    expect(r.risk).toBe("risk-on");
  });

  it("reads risk-off when equities fall and volatility rises", () => {
    expect(deriveMacroRegime(tape({ SPY: -1.4, VIXY: 6 })).risk).toBe("risk-off");
  });

  it("refuses to call a regime when equities and volatility disagree", () => {
    // Both up is the classic warning tape; "mixed" is the honest answer.
    expect(deriveMacroRegime(tape({ SPY: 0.8, VIXY: 3 })).risk).toBe("mixed");
  });

  it("inverts bond prices into yield direction", () => {
    // Long-duration bonds rallying means yields FELL.
    expect(deriveMacroRegime(tape({ TLT: 1.2 })).yields).toBe("falling");
    expect(deriveMacroRegime(tape({ TLT: -1.2 })).yields).toBe("rising");
    expect(deriveMacroRegime(tape({ TLT: 0.05 })).yields).toBe("flat");
  });

  it("falls back down the curve when long duration is missing", () => {
    expect(deriveMacroRegime(tape({ IEF: -0.9 })).yields).toBe("rising");
  });

  it("ranks sector leaders and laggards", () => {
    const r = deriveMacroRegime(tape({ XLE: 2.4, XLK: 1.3, XLF: 0.6, XLU: -1.1, XLP: -0.4, XLV: -0.9 }));
    expect(r.leaders[0]?.symbol).toBe("XLE");
    expect(r.leaders[0]?.name).toBe("Energy");
    expect(r.laggards[0]?.symbol).toBe("XLU");
  });

  it("reports unknown rather than guessing on an empty tape", () => {
    const r = deriveMacroRegime({});
    expect(r.risk).toBe("unknown");
    expect(r.yields).toBe("unknown");
    expect(r.oil_pct).toBeNull();
    expect(r.leaders).toEqual([]);
  });
});

describe("describeMacroRegime", () => {
  it("states unknowns explicitly and labels the yield inversion", () => {
    expect(describeMacroRegime(null)).toMatch(/unknown/);
    const text = describeMacroRegime(deriveMacroRegime(tape({ SPY: 0.9, VIXY: -4.6, TLT: 1.2, USO: -2.2, XLE: 2.4 })));
    expect(text).toMatch(/Risk appetite: risk-on/);
    expect(text).toMatch(/Yields: falling \(from long-duration bond prices, inverted\)/);
    expect(text).toMatch(/Oil -2\.20%/);
    expect(text).toMatch(/Strongest sectors: Energy \+2\.40%/);
  });
});
