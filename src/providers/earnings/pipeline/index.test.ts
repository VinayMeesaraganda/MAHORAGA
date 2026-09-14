import { afterEach, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../../research/test-db";
import { captureFinnhub, earningsBlocked } from ".";
const now = Date.parse("2026-09-14T12:00:00Z");
afterEach(() => vi.unstubAllGlobals());
describe("prospective Finnhub evidence", () => {
  it("authenticates by header, preserves snapshots and never certifies same-day estimates", async () => {
    const { db, close } = testDatabase();
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            earningsCalendar: [
              { symbol: "AAPL", date: "2026-09-15", epsEstimate: 1.2, epsActual: null },
              { symbol: "MSFT", date: "2026-09-14", epsEstimate: 2.3 },
            ],
          })
        )
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      const result = await captureFinnhub(db, "test-private-key", now);
      expect(result.status).toBe("ok");
      expect(result.prospective).toBe(1);
      const [url, init] = (fetcher.mock.calls as unknown as Array<[string, RequestInit]>)[0]!;
      expect(url).not.toContain("test-private-key");
      expect(init.headers).toEqual({ "X-Finnhub-Token": "test-private-key" });
      const rows = await db.execute<{ symbol: string; prospective: number }>(
        "SELECT symbol,prospective FROM consensus_snapshots ORDER BY symbol"
      );
      expect(rows).toEqual([
        { symbol: "AAPL", prospective: 1 },
        { symbol: "MSFT", prospective: 0 },
      ]);
      expect(await earningsBlocked(db, "AAPL", "2026-09-14", "2026-09-25", now)).toBe(
        "earnings_inside_holding_horizon"
      );
      expect(await earningsBlocked(db, "CAT", "2026-09-14", "2026-09-25", now)).toBeNull();
      // Identical provider content must retain its records in a new coverage observation.
      await captureFinnhub(db, "test-private-key", now + 3600000);
      expect(await earningsBlocked(db, "AAPL", "2026-09-14", "2026-09-25", now + 3600000)).toBe(
        "earnings_inside_holding_horizon"
      );
      expect(await earningsBlocked(db, "CAT", "2026-09-14", "2026-09-25", now + 90000001)).toBe(
        "earnings_calendar_unknown"
      );
    } finally {
      close();
    }
  });
  it("fails closed on 401 and never persists a provider token in an error", async () => {
    const { db, close } = testDatabase();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("secret body", { status: 401 }))
    );
    try {
      const result = await captureFinnhub(db, "private-key", now);
      expect(result.status).toBe("error");
      expect(result.reason).toBe("Source returned HTTP 401");
      expect(await earningsBlocked(db, "AAPL", "2026-09-14", "2026-09-25", now)).toBe("earnings_calendar_unknown");
    } finally {
      close();
    }
  });
});
