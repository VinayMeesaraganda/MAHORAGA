import { describe, expect, it } from "vitest";
import { trailingCashFlow } from "./fundamentals";
import { relativeVolume } from "./volume";

describe("point-in-time optional research features", () => {
  const rows = [1, 2, 3, 4].map((quarter) => ({
    year: 2025,
    quarter,
    currency: "USD",
    unit: "millions",
    cfo: 100 * quarter,
    capex: 30 * quarter,
    availableAt: quarter * 1000,
  }));
  it("converts YTD to discrete quarters before summing", () => {
    expect(trailingCashFlow(rows, 5000)).toEqual({ cfo: 400, capex: 120, fcf: 280 });
  });
  it("does not borrow future filings or fill a missing quarter", () => {
    expect(trailingCashFlow(rows, 3500)).toBeNull();
    expect(
      trailingCashFlow(
        rows.filter((r) => r.quarter !== 2),
        5000
      )
    ).toBeNull();
  });
  it("rejects duplicate unresolved revisions and mismatched units", () => {
    expect(trailingCashFlow([...rows, rows[0]!], 5000)).toBeNull();
    expect(
      trailingCashFlow(
        rows.map((r, i) => (i === 1 ? { ...r, unit: "units" } : r)),
        5000
      )
    ).toBeNull();
  });
  const volume = { date: "2026-09-30", cutoff: "10:05", feed: "sip" as const, volume: 2000, complete: true };
  const history = Array.from({ length: 20 }, (_, i) => ({
    ...volume,
    date: `2026-09-${String(i + 1).padStart(2, "0")}`,
    volume: 1000,
  }));
  it("uses the same cutoff and feed, with current session excluded", () => {
    expect(relativeVolume(volume, [...history, volume])).toBe(2);
  });
  it("keeps incomplete or incomparable volume unknown", () => {
    expect(relativeVolume(volume, history.slice(1))).toBeNull();
    expect(relativeVolume({ ...volume, feed: "iex" }, history)).toBeNull();
    expect(relativeVolume({ ...volume, cutoff: "13:00" }, history)).toBeNull();
  });
});
