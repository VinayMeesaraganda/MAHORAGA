import { describe, expect, it } from "vitest";
import { aggregateRegularBars, exchangeTime, type Session } from ".";
describe("exchange-session market adapter", () => {
  it("uses the correct Eastern offset through daylight-saving changes", () => {
    expect(exchangeTime("2026-03-06", "09:30")).toBe("2026-03-06T14:30:00.000Z");
    expect(exchangeTime("2026-03-09", "09:30")).toBe("2026-03-09T13:30:00.000Z");
    expect(() => exchangeTime("2026-03-08", "02:30")).toThrow();
  });
  const session: Session = { date: "2026-11-27", open: "2026-11-27T14:30:00Z", close: "2026-11-27T18:00:00Z" };
  const bars = () =>
    Array.from({ length: 7 }, (_, i) => ({
      t: new Date(Date.parse(session.open) + i * 1800000).toISOString(),
      o: 100,
      h: 102,
      l: 99,
      c: 101,
      v: 10,
      vw: 100,
    }));
  it("respects an early close and excludes after-hours/closing-boundary bars", () => {
    const raw = [...bars(), { ...bars()[0]!, t: session.close, v: 999999 }];
    const result = aggregateRegularBars(raw, [session], Date.parse(session.close));
    expect(result[0]!.volume).toBe(70);
    expect(result[0]!.dollars).toBe(7000);
  });
  it("rejects missing buckets, duplicate buckets and incomplete sessions", () => {
    expect(() => aggregateRegularBars(bars().slice(1), [session], Date.parse(session.close))).toThrow();
    expect(() => aggregateRegularBars([...bars(), bars()[0]!], [session], Date.parse(session.close))).toThrow();
    expect(() => aggregateRegularBars(bars(), [session], Date.parse(session.close) - 1)).toThrow();
  });
});
