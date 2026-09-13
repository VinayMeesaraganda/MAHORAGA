import { describe, expect, it, vi } from "vitest";
import type { Env } from "../env.d";
import { getDefaultPolicyConfig } from "../policy/config";
import type { AlpacaProviders } from "../providers/alpaca";
import { createPolicyBroker, type ProtectedBuy } from "./policy-broker";
import type { PendingExecution } from "./types";

function setup(pending: Record<string, PendingExecution> = {}, allow = true) {
  const trading = {
    getAccount: vi.fn().mockResolvedValue({ equity: 100000, last_equity: 100000, cash: 100000, buying_power: 100000 }),
    getPositions: vi.fn().mockResolvedValue([]),
    getClock: vi.fn().mockResolvedValue({ is_open: true }),
    getAsset: vi.fn().mockResolvedValue({ exchange: "NASDAQ", tradable: true }),
    listOrders: vi.fn().mockResolvedValue([]),
    createOrder: vi.fn().mockResolvedValue({ id: "parent", status: "accepted" }),
    getOrder: vi.fn(),
    getOrderByClientId: vi.fn(),
    cancelOrder: vi.fn(),
    closePosition: vi.fn().mockResolvedValue({ id: "close", status: "accepted" }),
  };
  const persist = vi.fn(async () => {}),
    validate = vi.fn(async (): Promise<string | null> => null);
  const broker = createPolicyBroker({
    alpaca: { trading } as unknown as AlpacaProviders,
    policyConfig: getDefaultPolicyConfig({} as Env),
    db: null,
    log: vi.fn(),
    cryptoSymbols: [],
    allowedExchanges: ["NASDAQ"],
    pendingExecutions: pending,
    persist,
    validateBuy: () => "Legacy LLM BUY verdict absent",
    validateExecution: async () => "Legacy research absent",
    validateProtectedEntry: allow ? validate : undefined,
  });
  const intent: ProtectedBuy = {
    symbol: "TEST",
    quantity: 25,
    limit: 100,
    stop: 95,
    expiresAt: Date.now() + 60_000,
    reason: "verified event",
  };
  return { broker, trading, pending, persist, validate, intent };
}
const holding = { symbol: "TEST", qty: 25, side: "long", avg_entry_price: 100 };
const parent = (status = "filled", qty = "25") => ({
  id: "parent",
  symbol: "TEST",
  side: "buy",
  status,
  filled_qty: qty,
  filled_avg_price: "100",
});
const stop = (status = "new") => ({
  id: "stop",
  symbol: "TEST",
  side: "sell",
  type: "stop",
  time_in_force: "gtc",
  qty: "25",
  filled_qty: "0",
  stop_price: "95",
  status,
});
const pending = (): Record<string, PendingExecution> => ({
  TEST: {
    symbol: "TEST",
    side: "buy",
    submitted_at: Date.now(),
    reason: "event",
    status: "accepted",
    order_id: "parent",
    protected_entry: { stop: 95, limit: 100, expires_at: Date.now() + 60_000 },
  },
});

describe("protected entry policy contract", () => {
  it("is unavailable without separate pilot validation", async () => {
    const s = setup({}, false);
    expect(await s.broker.buyProtected!(s.intent)).toBe(false);
    expect(s.trading.createOrder).not.toHaveBeenCalled();
  });
  it("uses whole shares and a native stop through policy without fabricating legacy research", async () => {
    const s = setup();
    expect(await s.broker.buyProtected!(s.intent)).toBe(true);
    expect(s.trading.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        qty: 25,
        type: "limit",
        limit_price: 100,
        order_class: "oto",
        stop_loss: { stop_price: 95 },
      })
    );
    expect(s.pending.TEST?.protected_entry?.stop).toBe(95);
    expect(s.persist).toHaveBeenCalled();
  });
  it("still enforces account-wide policy and specialized validation", async () => {
    const s = setup();
    s.trading.getAccount.mockResolvedValue({ equity: 95000, last_equity: 100000, cash: 100000, buying_power: 100000 });
    expect(await s.broker.buyProtected!(s.intent)).toBe(false);
    const v = setup();
    v.validate.mockResolvedValue("Sector capacity exhausted");
    expect(await v.broker.buyProtected!(v.intent)).toBe(false);
  });
  it("rejects malformed risk, fractional shares, expired caps and non-tick prices", async () => {
    for (const patch of [{ quantity: 1.5 }, { stop: 101 }, { limit: 100.001 }, { expiresAt: 0 }, { quantity: 0 }]) {
      const s = setup();
      expect(await s.broker.buyProtected!({ ...s.intent, ...patch })).toBe(false);
      expect(s.trading.createOrder).not.toHaveBeenCalled();
    }
  });
  it("retains a submission timeout and will not duplicate it after restart", async () => {
    const s = setup();
    s.trading.createOrder.mockRejectedValue(new Error("timeout"));
    expect(await s.broker.buyProtected!(s.intent)).toBe(false);
    const resumed = setup(s.pending);
    expect(await resumed.broker.buyProtected!(resumed.intent)).toBe(false);
  });
});

describe("one owner for parent, protection and liquidation", () => {
  it("reconciles the combined fills of replaced protective orders before retiring the position", async () => {
    const p = pending();
    p.TEST!.protected_entry!.protective_order_id = "second-stop";
    p.TEST!.protected_entry!.protective_order_ids = ["stop", "second-stop"];
    const s = setup(p);
    s.trading.getOrder.mockImplementation(async (id) =>
      id === "parent"
        ? parent()
        : id === "stop"
          ? { ...stop("canceled"), filled_qty: "10" }
          : { ...stop("filled"), id: "second-stop", qty: "15", filled_qty: "15" }
    );
    await s.broker.reconcile!();
    expect(s.pending.TEST).toBeUndefined();
    expect(s.trading.createOrder).not.toHaveBeenCalled();
  });
  it.each(["", "NaN", "0"])("keeps a supposedly filled parent with malformed quantity %s unresolved", async (qty) => {
    const s = setup(pending());
    s.trading.getOrder.mockResolvedValue(parent("filled", qty));
    await s.broker.reconcile!();
    expect(s.pending.TEST).toBeDefined();
    expect(s.trading.createOrder).not.toHaveBeenCalled();
  });
  it("cancels a partial parent and waits for terminal confirmation before placing residual protection", async () => {
    const s = setup(pending());
    s.trading.getOrder.mockResolvedValue(parent("partially_filled", "5"));
    s.trading.getPositions.mockResolvedValue([{ ...holding, qty: 5 }]);
    await s.broker.reconcile!();
    expect(s.trading.cancelOrder).toHaveBeenCalledWith("parent");
    expect(s.trading.createOrder).not.toHaveBeenCalled();
    s.trading.getOrder.mockResolvedValue(parent("canceled", "5"));
    s.trading.createOrder.mockResolvedValue({ id: "stop", status: "accepted" });
    await s.broker.reconcile!();
    expect(s.trading.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: "sell", qty: 5, type: "stop", time_in_force: "gtc" })
    );
    expect(s.pending.TEST?.status).toBe("protecting");
  });
  it("recognizes only confirmed quantity-matching GTC protection", async () => {
    const s = setup(pending());
    s.trading.getOrder.mockResolvedValue(parent());
    s.trading.getPositions.mockResolvedValue([holding]);
    s.trading.listOrders.mockResolvedValue([{ ...parent(), legs: [stop()] }]);
    await s.broker.reconcile!();
    expect(s.pending.TEST?.status).toBe("protected");
    expect(s.trading.createOrder).not.toHaveBeenCalled();
  });
  it("does not interpret a DAY stop as overnight protection", async () => {
    const s = setup(pending());
    s.trading.getOrder.mockResolvedValue(parent());
    s.trading.getPositions.mockResolvedValue([holding]);
    s.trading.listOrders.mockResolvedValue([{ ...parent(), legs: [{ ...stop(), time_in_force: "day" }] }]);
    await s.broker.reconcile!();
    expect(s.trading.cancelOrder).toHaveBeenCalledWith("stop");
    expect(s.pending.TEST?.status).not.toBe("protected");
  });
  it("cancels protection before a time exit and never races the two sells", async () => {
    const p = pending();
    p.TEST!.protected_entry!.protective_order_id = "stop";
    p.TEST!.status = "protected";
    const s = setup(p);
    s.trading.getPositions.mockResolvedValue([holding]);
    s.trading.getOrder.mockImplementation(async (id) => (id === "parent" ? parent() : stop()));
    s.trading.listOrders.mockResolvedValue([stop()]);
    expect(await s.broker.sell("TEST", "session horizon")).toBe(false);
    await s.broker.reconcile!();
    expect(s.trading.cancelOrder).toHaveBeenCalledWith("stop");
    expect(s.trading.closePosition).not.toHaveBeenCalled();
    s.trading.getOrder.mockImplementation(async (id) => (id === "parent" ? parent() : stop("canceled")));
    s.trading.listOrders.mockResolvedValue([]);
    await s.broker.reconcile!();
    expect(s.trading.closePosition).toHaveBeenCalledTimes(1);
    expect(s.pending.TEST?.side).toBe("sell");
  });
  it("an unknown stop submission blocks further entries and never submits a second stop", async () => {
    const s = setup(pending());
    s.trading.getOrder.mockResolvedValue(parent());
    s.trading.getPositions.mockResolvedValue([holding]);
    s.trading.createOrder.mockRejectedValue(new Error("timeout"));
    await s.broker.reconcile!();
    const resumed = setup(s.pending);
    resumed.trading.getOrder.mockResolvedValue(parent());
    resumed.trading.getPositions.mockResolvedValue([holding]);
    resumed.trading.getOrderByClientId.mockRejectedValue(new Error("not yet visible"));
    await resumed.broker.reconcile!();
    expect(resumed.trading.createOrder).not.toHaveBeenCalled();
    expect(await resumed.broker.buyProtected!(resumed.intent)).toBe(false);
  });
});
