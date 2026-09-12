import { describe, expect, it } from "vitest";
import { type StockTwitsMessage, scoreStockTwitsStream } from "./stocktwits";

const nowIso = new Date().toISOString();
const msg = (basic?: string): StockTwitsMessage => ({
  created_at: nowIso,
  entities: basic ? { sentiment: { basic } } : undefined,
});

describe("scoreStockTwitsStream", () => {
  it("scores over the messages that expressed a view, not the whole stream", () => {
    // 5 bullish tags among 20 messages. Dividing by all 20 would report 25%
    // bullish and fall under a 0.3 threshold despite unanimous agreement.
    const messages = [...Array(5)].map(() => msg("Bullish")).concat([...Array(15)].map(() => msg()));
    const result = scoreStockTwitsStream(messages);
    expect(result.score).toBeCloseTo(1, 5);
    expect(result.taggedCount).toBe(5);
    expect(result.taggedRatio).toBeCloseTo(0.25, 5);
    expect(result.usable).toBe(true);
  });

  it("nets bullish against bearish tags", () => {
    const messages = [...Array(6)].map(() => msg("Bullish")).concat([...Array(2)].map(() => msg("Bearish")));
    expect(scoreStockTwitsStream(messages).score).toBeCloseTo(0.5, 5);
  });

  it("rejects streams with too few messages or too few opinions", () => {
    expect(scoreStockTwitsStream([...Array(4)].map(() => msg("Bullish"))).usable).toBe(false);
    const mostlyUntagged = [msg("Bullish"), msg("Bullish"), ...[...Array(18)].map(() => msg())];
    expect(scoreStockTwitsStream(mostlyUntagged).usable).toBe(false);
  });

  it("returns a neutral, unusable score for an empty stream", () => {
    const result = scoreStockTwitsStream([]);
    expect(result.score).toBe(0);
    expect(result.avgFreshness).toBe(0);
    expect(result.usable).toBe(false);
  });
});
