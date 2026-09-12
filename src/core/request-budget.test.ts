import { describe, expect, it } from "vitest";
import { reserveRequest } from "./request-budget";

describe("daily completion request allowance", () => {
  it("allows exactly the configured count", () => {
    const first = reserveRequest(undefined, "2026-09-11", 2);
    const second = reserveRequest(first, "2026-09-11", 2);
    expect(second.calls).toBe(2);
    expect(() => reserveRequest(second, "2026-09-11", 2)).toThrow();
  });
  it("resets on a new trading calendar date", () => {
    expect(reserveRequest({ day: "2026-09-11", calls: 300 }, "2026-09-14", 300).calls).toBe(1);
  });
  it("rejects corrupt counters and invalid limits", () => {
    expect(() => reserveRequest({ day: "today", calls: NaN }, "today", 3)).toThrow();
    for (const limit of [0, -1, NaN, 1.5]) expect(() => reserveRequest(undefined, "today", limit)).toThrow();
  });
});
