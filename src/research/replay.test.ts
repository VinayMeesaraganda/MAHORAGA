import { describe, expect, it } from "vitest";
import { candidate } from "../strategy/guidance-continuation/fixtures.test-helper";
import { evaluateCandidate } from "../strategy/guidance-continuation/rules";
import { pairedBlockInterval, replayExit, replayPortfolio, type ReplayTrade } from "./replay";

const trade = (): ReplayTrade => ({
  plan: { ...evaluateCandidate(candidate()).plan!, limit: 100, stop: 95 },
  entryAt: 1000,
  entryPrice: 100,
  exitDueAt: 3000,
  bars: [
    { at: 2000, open: 100, high: 104, low: 99, close: 103 },
    { at: 3000, open: 103, high: 105, low: 102, close: 104 },
  ],
});
describe("cost-aware replay with explicit hypothetical fills", () => {
  it("does not cap a profitable continuation at an invented target", () => {
    expect(replayExit(trade(), 0)).toMatchObject({ price: 104, cause: "time", grossR: 0.8 });
  });
  it("models gaps beyond stops and does not promise minus one R", () => {
    const t = trade();
    t.bars[0] = { at: 2000, open: 90, high: 92, low: 89, close: 91 };
    expect(replayExit(t, 0)?.grossR).toBe(-2);
  });
  it("leaves missing horizon data open and ignores pre-entry extremes", () => {
    const t = trade();
    t.bars = [{ at: 500, open: 80, high: 100, low: 70, close: 90 }];
    expect(replayExit(t, 10)).toBeNull();
  });
  it("does not use a later bar's price to fill an earlier horizon", () => {
    const t = trade();
    t.bars[1]!.at = 4000;
    expect(replayExit(t, 0)).toBeNull();
  });
  it("charges a stated cost scenario exactly once", () => {
    const t = trade();
    expect(replayExit(t, 50)?.netR).toBeCloseTo((4 - 204 * 0.0025) / 5);
  });
  it("simulates shared portfolio capacity instead of summing trade R", () => {
    const trades = [0, 1, 2].map((i) => ({
      ...trade(),
      plan: { ...trade().plan, issuer: String(i), eventKey: String(i), rank: i },
    }));
    const report = replayPortfolio(trades, 100000, 0);
    expect(report.results.map((r) => r.quantity)).toEqual([25, 25, 0]);
    expect(report.curve.at(-1)?.equity).toBe(100200);
  });
  it("requires enough independent blocks and returns a reproducible paired diagnostic", () => {
    expect(pairedBlockInterval([[1, 2]])).toBeNull();
    const blocks = Array.from({ length: 20 }, () => [0.001, 0.001]);
    expect(pairedBlockInterval(blocks, 100)).toMatchObject({
      mean: expect.closeTo(0.001),
      low: expect.closeTo(0.001),
      high: expect.closeTo(0.001),
      blocks: 20,
    });
  });
});
