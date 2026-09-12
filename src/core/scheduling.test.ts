import { describe, expect, it } from "vitest";
import type { MarketClock } from "../providers/types";
import { closedMarketDelayMs, heartbeatDelayMs, leastRecentlyResearched, nextDueStage } from "./scheduling";

const now = Date.parse("2026-09-11T23:00:00Z");
const clock = { is_open: false, next_open: "2026-09-14T13:30:00Z" } as MarketClock;
describe("equity idle scheduling", () => {
  it("sleeps over weekends but rechecks within an hour", () => {
    expect(closedMarketDelayMs(clock, false, 5, now)).toBe(3_600_000);
  });
  it("wakes at the start of premarket preparation", () => {
    const beforeOpen = Date.parse(clock.next_open) - 6 * 60_000;
    expect(closedMarketDelayMs(clock, false, 5, beforeOpen)).toBe(60_000);
    expect(closedMarketDelayMs(clock, false, 5, beforeOpen + 60_000)).toBeNull();
  });
  it("keeps crypto and open-market loops active", () => {
    expect(closedMarketDelayMs(clock, true, 5, now)).toBeNull();
    expect(closedMarketDelayMs({ ...clock, is_open: true }, false, 5, now)).toBeNull();
  });
  it("backs off on an invalid or past next-open time instead of researching", () => {
    expect(closedMarketDelayMs({ ...clock, next_open: "invalid" }, false, 5, now)).toBe(60_000);
    expect(closedMarketDelayMs(clock, false, 5, Date.parse(clock.next_open) + 1)).toBe(60_000);
  });
});

describe("one-stage heartbeat scheduling", () => {
  it("rotates research after both success and failure instead of repeating the strongest name", () => {
    const symbols = ["AAPL", "MSFT", "AMZN"];
    expect(leastRecentlyResearched(symbols, {}, {})).toBe("AAPL");
    expect(leastRecentlyResearched(symbols, {}, { AAPL: now })).toBe("MSFT");
    expect(leastRecentlyResearched(symbols, { MSFT: { timestamp: now } }, { AAPL: now })).toBe("AMZN");
  });
  it("charges completed work against the heartbeat instead of adding another 30 seconds", () => {
    expect(heartbeatDelayMs(now, now + 15_000)).toBe(15_000);
    expect(heartbeatDelayMs(now, now + 45_000)).toBe(1_000);
  });

  it("chooses exactly one due stage and skips ineligible work", () => {
    expect(
      nextDueStage(
        [
          { name: "analyst", lastRun: 0, intervalMs: 300_000, eligible: false },
          { name: "research", lastRun: now, intervalMs: 60_000, eligible: true },
          { name: "gather", lastRun: now - 120_000, intervalMs: 120_000, eligible: true },
        ],
        now
      )
    ).toBe("gather");
    expect(nextDueStage([{ name: "research", lastRun: now, intervalMs: 60_000, eligible: true }], now)).toBeNull();
  });

  it("serves overdue research and analysis even when slow gathering becomes due again", () => {
    const stages = [
      { name: "gather", lastRun: 0, intervalMs: 120_000, eligible: true },
      { name: "research", lastRun: 0, intervalMs: 60_000, eligible: true },
      { name: "analyst", lastRun: 0, intervalMs: 300_000, eligible: true },
    ];
    const selected = [];
    // Simulate severe overruns: each stage consumes more than a gather period.
    for (let i = 0; i < 3; i++) {
      const time = now + i * 130_000;
      const name = nextDueStage(stages, time);
      selected.push(name);
      stages.find((stage) => stage.name === name)!.lastRun = time;
    }
    expect(selected).toEqual(["gather", "research", "analyst"]);
  });
});
