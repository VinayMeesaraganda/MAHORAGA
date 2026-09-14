import { describe, expect, it } from "vitest";
import { evaluatePriceVolume, type PriceVolumeInput } from ".";
import { exchangeTime } from "../shared-market";

export function breakoutFixture(): PriceVolumeInput {
  const at = "2026-09-14T14:06:00.000Z",
    dates: string[] = [];
  for (let day = Date.parse("2026-06-01T00:00:00Z"); day <= Date.parse("2026-10-02T00:00:00Z"); day += 86400000) {
    if (![0, 6].includes(new Date(day).getUTCDay())) dates.push(new Date(day).toISOString().slice(0, 10));
  }
  const sessions = dates.map((date) => ({
    date,
    open: exchangeTime(date, "09:30"),
    close: exchangeTime(date, "16:00"),
  }));
  const bars = sessions
    .filter((s) => s.date < "2026-09-14")
    .slice(-51)
    .map((s) => ({
      date: s.date,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1000000,
      dollars: 100000000,
      available_at: "2026-09-14T12:00:00.000Z",
      feed: "sip" as const,
      session: "regular" as const,
    }));
  Object.assign(bars.at(-1)!, { high: 104, low: 100, close: 103.8, volume: 2000000, dollars: 206000000 });
  return {
    symbol: "AAPL",
    issuer_id: "AAPL",
    history_adjustment: "split",
    at,
    sessions,
    bars,
    asset: { type: "common_stock", active: true, tradable: true, exchange: "NASDAQ", sector: "Technology" },
    quote: { bid: 103.8, ask: 103.85, bid_size: 10, ask_size: 10, at, feed: "iex" },
    calendar: {
      checked_at: at,
      from: "2026-09-01T00:00:00Z",
      through: "2026-10-01T00:00:00Z",
      complete: true,
      sources: ["https://www.bls.gov/schedule/", "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"],
      events: [],
    },
    news: { complete: true, from: "2026-09-01T00:00:00Z", through: at },
    optional_features: { fcf: null },
  };
}
describe("price/volume completed-session strategy", () => {
  it("qualifies a liquid breakout without an LLM, sentiment or invented fundamentals", () => {
    const decision = evaluatePriceVolume(breakoutFixture());
    expect(decision.reasons).toEqual([]);
    expect(decision.plan?.rank).toBe(2);
    expect(decision.plan!.stop).toBeLessThan(decision.plan!.limit);
  });
  const cases: Array<[string, (x: PriceVolumeInput) => void, string]> = [
    [
      "low volume",
      (x) => {
        x.bars.at(-1)!.volume = 1000000;
      },
      "volume_confirmation_failed",
    ],
    [
      "weak close",
      (x) => {
        x.bars.at(-1)!.close = 101.5;
      },
      "weak_close",
    ],
    [
      "lost breakout",
      (x) => {
        x.quote.bid = 100.9;
        x.quote.ask = 101;
      },
      "breakout_failed_at_entry",
    ],
    [
      "chasing",
      (x) => {
        x.quote.bid = 115;
        x.quote.ask = 115.1;
      },
      "entry_chasing",
    ],
    [
      "stale quote",
      (x) => {
        x.quote.at = "2026-09-14T14:04:00Z";
      },
      "quote_unusable",
    ],
    [
      "missing session",
      (x) => {
        x.bars.splice(30, 1);
      },
      "history_session_gap",
    ],
    [
      "future revision",
      (x) => {
        x.bars[0]!.available_at = "2026-09-15T00:00:00Z";
      },
      "invalid_future_or_discontinuous_history",
    ],
    [
      "split discontinuity",
      (x) => {
        x.bars[20]!.open = 50;
        x.bars[20]!.low = 49;
      },
      "invalid_future_or_discontinuous_history",
    ],
    [
      "calendar unknown",
      (x) => {
        x.calendar.complete = false;
      },
      "calendar_coverage_unknown",
    ],
    [
      "news outage",
      (x) => {
        x.news.complete = false;
      },
      "news_coverage_unknown",
    ],
    [
      "macro release",
      (x) => {
        x.calendar.events = [{ at: "2026-09-14T14:10:00Z", kind: "cpi" }];
      },
      "macro_blackout",
    ],
    [
      "entry cutoff",
      (x) => {
        x.at = "2026-09-14T14:10:00Z";
      },
      "outside_entry_window",
    ],
  ];
  it.each(cases)("rejects %s", (_label, change, reason) => {
    const x = breakoutFixture();
    change(x);
    const r = evaluatePriceVolume(x);
    expect(r.reasons).toContain(reason);
    expect(r.plan).toBeNull();
  });
});
