import { afterEach, describe, expect, it, vi } from "vitest";
import type { Order } from "../../../providers/types";
import { testDatabase } from "../../../research/test-db";
import { recordOrderLoss } from "./fill-loss";
import { getRiskState, resetDailyLoss } from "./risk-state";

const stores: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  vi.useRealTimers();
});
const now = Date.parse("2026-09-14T19:00:00Z");
const fill = (qty: number, price: number): Order =>
  ({
    id: "sell-1",
    symbol: "TEST",
    side: "sell",
    filled_qty: String(qty),
    filled_avg_price: String(price),
    filled_at: null,
    updated_at: new Date(now).toISOString(),
  }) as Order;
const setup = () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const s = testDatabase();
  stores.push(s);
  return s;
};
describe("idempotent realized-loss increments from broker fills", () => {
  it("counts partial losses once, and derives subsequent deltas from cumulative proceeds", async () => {
    const { db } = setup();
    await recordOrderLoss(db, fill(5, 90), 100, 30, now);
    await recordOrderLoss(db, fill(5, 90), 100, 30, now);
    expect((await getRiskState(db)).daily_loss_usd).toBe(50);
    await recordOrderLoss(db, fill(10, 95), 100, 30, now); // second five filled at 100; no incremental loss
    expect((await getRiskState(db)).daily_loss_usd).toBe(50);
    expect((await getRiskState(db)).cooldown_until).toBe("2026-09-14T19:30:00.000Z");
  });
  it("does not offset losses with wins or recalculate a duplicate with a corrected price", async () => {
    const { db } = setup();
    await recordOrderLoss(db, fill(5, 90), 100, 30, now);
    await recordOrderLoss(db, fill(10, 110), 100, 30, now);
    expect((await getRiskState(db)).daily_loss_usd).toBe(50);
    await expect(recordOrderLoss(db, fill(10, 111), 100, 30, now)).rejects.toThrow(/correction/);
  });
  it("rolls the daily counter on New York date without clearing a continuing cooldown", async () => {
    const { db } = setup();
    const before = Date.parse("2026-09-15T03:55:00Z"),
      after = before + 10 * 60_000;
    await recordOrderLoss(db, { ...fill(5, 90), updated_at: new Date(before).toISOString() }, 100, 30, before);
    vi.setSystemTime(after);
    await resetDailyLoss(db);
    const state = await getRiskState(db);
    expect(state.daily_loss_usd).toBe(0);
    expect(state.cooldown_until).toBe("2026-09-15T04:25:00.000Z");
  });
  it("rejects missing cost basis and does not count a previous-day delayed fill as today's loss", async () => {
    const { db } = setup();
    await expect(recordOrderLoss(db, fill(5, 90), Number.NaN, 30, now)).rejects.toThrow();
    await recordOrderLoss(db, { ...fill(5, 90), updated_at: "2026-09-11T19:00:00Z" }, 100, 30, now);
    expect((await getRiskState(db)).daily_loss_usd).toBe(0);
  });
});
