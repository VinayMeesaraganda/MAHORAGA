import { describe, expect, it, vi } from "vitest";
import type { Env } from "../env.d";
import { getDefaultPolicyConfig } from "../policy/config";
import type { AlpacaProviders } from "../providers/alpaca";
import { createPolicyBroker } from "./policy-broker";
import type { PendingExecution } from "./types";

function setup(pendingExecutions: Record<string, PendingExecution> = {}) {
  const trading = {
    getAccount: vi.fn().mockResolvedValue({ equity: 100000, last_equity: 100000, cash: 100000, buying_power: 100000 }),
    getPositions: vi.fn().mockResolvedValue([]),
    getClock: vi.fn().mockResolvedValue({ is_open: true }),
    getAsset: vi.fn().mockResolvedValue({ exchange: "NASDAQ", tradable: true }),
    listOrders: vi.fn().mockResolvedValue([]),
    createOrder: vi.fn().mockResolvedValue({ id: "buy-1", status: "accepted" }),
    closePosition: vi.fn().mockResolvedValue({ id: "sell-1", status: "accepted" }),
    getOrder: vi.fn(),
    getOrderByClientId: vi.fn(),
  };
  const validateBuy = vi.fn((): string | null => null);
  const validateExecution = vi.fn(async (): Promise<string | null> => null);
  const canSubmit = vi.fn(() => true);
  const persist = vi.fn(async () => {});
  const onSell = vi.fn();
  const onBuyIntent = vi.fn();
  const onBuyAbandoned = vi.fn();
  const broker = createPolicyBroker({
    alpaca: { trading } as unknown as AlpacaProviders,
    policyConfig: getDefaultPolicyConfig({} as Env),
    db: null,
    log: vi.fn(),
    cryptoSymbols: [],
    allowedExchanges: ["NASDAQ"],
    validateBuy,
    validateExecution,
    canSubmit,
    pendingExecutions,
    persist,
    onSell,
    onBuyIntent,
    onBuyAbandoned,
    maxBuyNotional: () => 1250,
  });
  return {
    broker,
    trading,
    validateBuy,
    validateExecution,
    canSubmit,
    pendingExecutions,
    persist,
    onSell,
    onBuyIntent,
    onBuyAbandoned,
  };
}
describe("autonomous entry execution checks", () => {
  it("rejects a strategy-disallowed symbol before order submission", async () => {
    const s = setup();
    s.validateBuy.mockReturnValue("Expired research");
    expect(await s.broker.buy("AAPL", 2500, "test")).toBe(false);
    expect(s.trading.createOrder).not.toHaveBeenCalled();
  });
  it("limits order size using the risk allowance", async () => {
    const s = setup();
    expect(await s.broker.buy("AAPL", 2500, "test")).toBe(true);
    expect(s.trading.createOrder).toHaveBeenCalledWith(expect.objectContaining({ notional: 1250 }));
  });
  it("blocks entries while any broker order is pending", async () => {
    const s = setup();
    s.trading.listOrders.mockResolvedValue([{ symbol: "MSFT", side: "buy" }]);
    expect(await s.broker.buy("AAPL", 2500, "test")).toBe(false);
    expect(s.trading.createOrder).not.toHaveBeenCalled();
  });
  it("fails closed when pending orders cannot be read", async () => {
    const s = setup();
    s.trading.listOrders.mockRejectedValue(new Error("unavailable"));
    expect(await s.broker.buy("AAPL", 2500, "test")).toBe(false);
    expect(s.trading.createOrder).not.toHaveBeenCalled();
  });
  it("prevents adding to an existing position", async () => {
    const s = setup();
    s.trading.getPositions.mockResolvedValue([{ symbol: "AAPL" }]);
    expect(await s.broker.buy("AAPL", 2500, "test")).toBe(false);
    expect(s.trading.createOrder).not.toHaveBeenCalled();
  });
  it("allows at most one concurrent entry per cycle", async () => {
    const s = setup();
    expect(await Promise.all([s.broker.buy("AAPL", 2500, "test"), s.broker.buy("MSFT", 2500, "test")])).toEqual([
      true,
      false,
    ]);
    expect(await s.broker.buy("NVDA", 2500, "test")).toBe(false);
    expect(s.trading.createOrder).toHaveBeenCalledTimes(1);
  });
  it("keeps position-closing exits independent of entry rejection", async () => {
    const s = setup();
    s.validateBuy.mockReturnValue("No fresh evidence");
    s.trading.getPositions.mockResolvedValue([{ symbol: "AAPL", qty: 10, side: "long" }]);
    expect(await s.broker.sell("AAPL", "stop loss")).toBe(true);
    expect(s.trading.closePosition).toHaveBeenCalledWith("AAPL");
  });
});

const holding = { symbol: "AAPL", qty: 10, side: "long" };
function pending(side: "buy" | "sell", status = "accepted"): Record<string, PendingExecution> {
  return { AAPL: { symbol: "AAPL", side, reason: "risk test", submitted_at: Date.now(), order_id: "order-1", status } };
}
function order(side: "buy" | "sell", status: string, filledQty = "0") {
  return { id: "order-1", symbol: "AAPL", side, status, filled_qty: filledQty };
}

describe("persistent execution reconciliation", () => {
  it("persists a recoverable client ID and entry risk before a buy reaches the broker", async () => {
    const s = setup();
    s.trading.createOrder.mockImplementation(async (request) => {
      expect(s.persist).toHaveBeenCalled();
      expect(s.onBuyIntent).toHaveBeenCalled();
      expect(s.pendingExecutions.AAPL?.client_order_id).toBe(request.client_order_id);
      return { id: "buy-1", status: "accepted" };
    });
    expect(await s.broker.buy("AAPL", 2500, "test")).toBe(true);
    expect(s.pendingExecutions.AAPL?.status).toBe("accepted");
  });

  it("never submits when persistence fails", async () => {
    const s = setup();
    s.persist.mockRejectedValue(new Error("storage unavailable"));
    expect(await s.broker.buy("AAPL", 2500, "test")).toBe(false);
    expect(s.trading.createOrder).not.toHaveBeenCalled();
  });

  it("preserves an ambiguous buy across a new broker instance and resolves by client ID", async () => {
    const s = setup();
    s.trading.createOrder.mockRejectedValue(new Error("timeout"));
    expect(await s.broker.buy("AAPL", 2500, "test")).toBe(false);
    const resumed = setup(s.pendingExecutions);
    expect(await resumed.broker.buy("MSFT", 2500, "test")).toBe(false);
    resumed.trading.getOrderByClientId.mockResolvedValue(order("buy", "filled", "10"));
    resumed.trading.getPositions.mockResolvedValue([holding]);
    await resumed.broker.reconcile!();
    expect(resumed.pendingExecutions).toEqual({});
    expect(resumed.onBuyAbandoned).not.toHaveBeenCalled();
  });

  it.each(["filled", "canceled"])("retains a %s buy with fills until position propagation", async (status) => {
    const s = setup(pending("buy"));
    s.trading.getOrder.mockResolvedValue(order("buy", status, "5"));
    await s.broker.reconcile!();
    expect(s.pendingExecutions.AAPL).toBeDefined();
    expect(s.onBuyAbandoned).not.toHaveBeenCalled();
    s.trading.getPositions.mockResolvedValue([holding]);
    await s.broker.reconcile!();
    expect(s.pendingExecutions).toEqual({});
  });

  it("clears unfilled rejected buy metadata only with broker confirmation", async () => {
    const s = setup(pending("buy"));
    s.trading.getOrder.mockResolvedValue(order("buy", "rejected"));
    await s.broker.reconcile!();
    expect(s.onBuyAbandoned).toHaveBeenCalledWith("AAPL");
    expect(s.pendingExecutions).toEqual({});
  });

  it("does not call onSell or submit twice after a close acknowledgement", async () => {
    const s = setup();
    s.trading.getPositions.mockResolvedValue([holding]);
    expect(await s.broker.sell("AAPL", "stop")).toBe(true);
    expect(await s.broker.sell("AAPL", "stop")).toBe(false);
    expect(s.onSell).not.toHaveBeenCalled();
    expect(s.trading.closePosition).toHaveBeenCalledTimes(1);
  });

  it("keeps residual metadata for partial and canceled closes", async () => {
    const s = setup(pending("sell"));
    s.trading.getPositions.mockResolvedValue([holding]);
    s.trading.getOrder.mockResolvedValue(order("sell", "partially_filled", "5"));
    await s.broker.reconcile!();
    expect(s.pendingExecutions.AAPL).toBeDefined();
    s.trading.getOrder.mockResolvedValue(order("sell", "canceled", "5"));
    await s.broker.reconcile!();
    expect(s.pendingExecutions).toEqual({});
    expect(s.onSell).not.toHaveBeenCalled();
  });

  it("waits for a filled close and holdings to agree, then records the exit once", async () => {
    const s = setup(pending("sell"));
    s.trading.getOrder.mockResolvedValue(order("sell", "filled", "10"));
    s.trading.getPositions.mockResolvedValue([holding]);
    await s.broker.reconcile!();
    expect(s.onSell).not.toHaveBeenCalled();
    s.trading.getPositions.mockResolvedValue([]);
    await s.broker.reconcile!();
    await s.broker.reconcile!();
    expect(s.onSell).toHaveBeenCalledTimes(1);
    expect(s.pendingExecutions).toEqual({});
  });

  it("does not interpret malformed holdings as flat", async () => {
    const s = setup(pending("sell"));
    s.trading.getOrder.mockResolvedValue(order("sell", "filled", "10"));
    s.trading.getPositions.mockResolvedValue([{ ...holding, qty: NaN }]);
    await s.broker.reconcile!();
    expect(s.pendingExecutions.AAPL).toBeDefined();
    expect(s.onSell).not.toHaveBeenCalled();
  });

  it("preserves an ambiguous close but permits retry after a definitive rejection", async () => {
    const s = setup();
    s.trading.getPositions.mockResolvedValue([holding]);
    s.trading.closePosition.mockRejectedValueOnce({ code: "INVALID_INPUT" });
    expect(await s.broker.sell("AAPL", "stop")).toBe(false);
    expect(s.pendingExecutions).toEqual({});
    s.trading.closePosition.mockRejectedValueOnce(new Error("network timeout"));
    expect(await s.broker.sell("AAPL", "stop")).toBe(false);
    expect(s.pendingExecutions.AAPL).toBeDefined();
    expect(await s.broker.sell("AAPL", "stop")).toBe(false);
    expect(s.trading.closePosition).toHaveBeenCalledTimes(2);
  });

  it("does not adopt unrelated later sells when recovering an unknown close", async () => {
    const s = setup();
    s.trading.getPositions.mockResolvedValue([holding]);
    s.trading.closePosition.mockRejectedValueOnce(new Error("timeout"));
    await s.broker.sell("AAPL", "stop");
    s.trading.listOrders.mockResolvedValue([
      { ...order("sell", "filled", "10"), qty: "10", submitted_at: new Date(Date.now() + 60_000).toISOString() },
    ]);
    s.trading.getPositions.mockResolvedValue([]);
    await s.broker.reconcile!();
    expect(s.pendingExecutions.AAPL?.order_id).toBeUndefined();
    expect(s.onSell).not.toHaveBeenCalled();
  });

  it("serializes entries across two adapters sharing persisted state", async () => {
    const state: Record<string, PendingExecution> = {};
    const a = setup(state),
      b = setup(state);
    const results = await Promise.all([a.broker.buy("AAPL", 2500, "test"), b.broker.buy("MSFT", 2500, "test")]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe("final submission boundary", () => {
  it("rejects stale execution quotes without sending an order", async () => {
    const s = setup();
    s.validateExecution.mockResolvedValue("Stale execution quote");
    expect(await s.broker.buy("AAPL", 2500, "test")).toBe(false);
    expect(s.trading.createOrder).not.toHaveBeenCalled();
  });
  it("honors disable while awaiting fresh market data", async () => {
    const s = setup();
    s.validateExecution.mockImplementation(async () => {
      s.canSubmit.mockReturnValue(false);
      return null;
    });
    expect(await s.broker.buy("AAPL", 2500, "test")).toBe(false);
    expect(s.trading.createOrder).not.toHaveBeenCalled();
  });
  it("honors disable while persisting an intent before HTTP", async () => {
    const s = setup();
    s.persist.mockImplementation(async () => {
      s.canSubmit.mockReturnValue(false);
    });
    expect(await s.broker.buy("AAPL", 2500, "test")).toBe(false);
    expect(s.trading.createOrder).not.toHaveBeenCalled();
    expect(s.pendingExecutions).toEqual({});
  });
  it("rejects assets the broker marks untradable", async () => {
    const s = setup();
    s.trading.getAsset.mockResolvedValue({ exchange: "NASDAQ", tradable: false });
    expect(await s.broker.buy("AAPL", 2500, "test")).toBe(false);
  });
});
