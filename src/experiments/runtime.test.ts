import { afterEach, describe, expect, it, vi } from "vitest";
import { ExperimentRuntime, type ExperimentEnv, type Store } from "./runtime";
import { testDatabase } from "../research/test-db";
import type { AlpacaProviders } from "../providers/alpaca";
import type { Client } from "../strategy/shared-market";
import type { Plan } from "../strategy/guidance-continuation/rules";

const stores: Array<ReturnType<typeof testDatabase>> = [];
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  vi.useRealTimers();
});
async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime("2026-09-14T13:00:00Z");
  const database = testDatabase();
  stores.push(database);
  const saved = new Map<string, unknown>();
  const store: Store = {
    get: async <T>(key: string) => structuredClone(saved.get(key)) as T | undefined,
    put: async (key, value) => {
      saved.set(key, structuredClone(value));
    },
    setAlarm: vi.fn(async () => {}),
    deleteAlarm: vi.fn(async () => {}),
  };
  const trading = {
    getAccount: vi.fn().mockResolvedValue({
      id: "dedicated-account",
      status: "ACTIVE",
      currency: "USD",
      equity: 100000,
      cash: 100000,
      last_equity: 100000,
    }),
    getPositions: vi.fn().mockResolvedValue([]),
    listOrders: vi.fn().mockResolvedValue([]),
    getClock: vi.fn().mockImplementation(async () => ({
      is_open: false,
      timestamp: new Date().toISOString(),
      next_open: "2026-09-14T13:30:00Z",
      next_close: "2026-09-14T20:00:00Z",
    })),
    createOrder: vi.fn(),
    cancelOrder: vi.fn(),
    closePosition: vi.fn(),
    getAsset: vi.fn().mockResolvedValue({ tradable: true, exchange: "NASDAQ" }),
  };
  const env = {
    DB: database.raw,
    ALPACA_PAPER: "true",
    STRATEGY_ID: "price-volume",
    EXPECTED_ACCOUNT_ID: "dedicated-account",
  } as ExperimentEnv;
  const deps = {
    alpaca: { trading } as unknown as AlpacaProviders,
    client: { tradingRequest: vi.fn(), dataRequest: vi.fn() } as Client,
    db: database.db,
  };
  const runtime = new ExperimentRuntime(store, env, deps);
  await runtime.init();
  return { runtime, store, env, deps, trading };
}
describe("isolated paper experiment execution", () => {
  it("enables an explicitly authorized paper pilot without claiming broker fill acceptance", async () => {
    const { runtime, env } = await setup();
    env.PAPER_PILOT_AUTHORIZATION = runtime.state.profileHash;
    await runtime.configure(true, "paper");
    expect(runtime.canExecute()).toBe(true);
    const status = await runtime.status();
    expect(status.executionAuthorized).toBe(true);
    expect(status.executionAccepted).toBe(false);
    expect(status.brokerFillValidation).toBe("pending");
  });
  it("rejects a pilot authorization for another profile", async () => {
    const { runtime, env } = await setup();
    env.PAPER_PILOT_AUTHORIZATION = "another-profile";
    await expect(runtime.configure(true, "paper")).rejects.toThrow("authorization");
    expect(runtime.canExecute()).toBe(false);
  });
  it.each([
    { stop: 94, quantity: 5 },
    { stop: 93, quantity: 4 },
  ])("accepts a better price within frozen risk, persists before submission and never duplicates a timeout ($stop)", async ({
    stop,
    quantity,
  }) => {
    const { runtime, env, trading, store, deps } = await setup();
    vi.setSystemTime("2026-09-14T14:06:00Z");
    await runtime.account();
    runtime.state.enabled = true;
    runtime.state.mode = "paper";
    env.EXECUTION_ACCEPTANCE = runtime.state.profileHash;
    trading.getClock.mockResolvedValue({ is_open: true });
    const plan: Plan = {
      symbol: "AAPL",
      issuer: "AAPL",
      sector: "Technology",
      eventKey: "AAPL:breakout:2026-09-11",
      eventVersion: "v1",
      limit: 100,
      stop: 95,
      rank: 2,
      adv20: 100000000,
      decisionAt: Date.now(),
      expiresAt: Date.now() + 60000,
    };
    runtime.state.batch = {
      date: "2026-09-14",
      rows: [],
      allocations: [{ plan, quantity: 5, reason: null }],
      attempted: [],
      complete: true,
    };
    vi.spyOn(runtime, "evaluate").mockResolvedValue({
      input: { quote: { bid: 98.98, ask: 99 } } as never,
      result: {
        plan: { ...plan, limit: 99, stop },
        eventKey: plan.eventKey,
        eventVersion: plan.eventVersion,
        at: new Date().toISOString(),
        reasons: [],
      },
    });
    trading.createOrder.mockImplementation(async () => {
      const persisted = await store.get<typeof runtime.state>("runtime");
      expect(persisted!.pending.AAPL!.client_order_id).toBeTruthy();
      expect(persisted!.entries.AAPL!.quantity).toBe(quantity);
      throw Error("response timeout; broker outcome unknown");
    });
    await runtime.enter(Date.now());
    expect(trading.createOrder).toHaveBeenCalledTimes(1);
    expect(trading.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: "AAPL",
        qty: quantity,
        limit_price: 99,
        order_class: "oto",
        stop_loss: { stop_price: stop },
      })
    );
    const restarted = new ExperimentRuntime(store, env, deps);
    await restarted.init();
    await restarted.enter(Date.now());
    expect(trading.createOrder).toHaveBeenCalledTimes(1);
    expect(restarted.state.pending.AAPL).toBeDefined();
  });
  it("replays an immutable daily batch instead of choosing winners again after restart", async () => {
    const { runtime, env, store, deps } = await setup();
    const evaluate = vi.spyOn(runtime, "evaluate").mockImplementation(async (symbol) => ({
      input: {} as never,
      result: {
        eventKey: symbol,
        eventVersion: "v1",
        at: new Date().toISOString(),
        reasons: ["no_breakout"],
        plan: null,
      },
    }));
    await runtime.scan(Date.now(), true);
    expect(evaluate).toHaveBeenCalledTimes(24);
    const restarted = new ExperimentRuntime(store, env, deps);
    await restarted.init();
    const reevaluate = vi.spyOn(restarted, "evaluate");
    const batch = await restarted.scan(Date.now(), true);
    expect(batch.rows).toHaveLength(24);
    expect(reevaluate).not.toHaveBeenCalled();
  });
  it("rejects non-paper environments at construction", async () => {
    const x = await setup();
    expect(() => new ExperimentRuntime(x.store, { ...x.env, ALPACA_PAPER: "false" }, x.deps)).toThrow("paper");
  });
  it("a disabled alarm does nothing, and a manual preparation cannot trade", async () => {
    const { runtime, trading } = await setup();
    const exits = vi.spyOn(runtime, "exits").mockResolvedValue(),
      prepare = vi.spyOn(runtime, "prepare").mockResolvedValue();
    await runtime.tick();
    expect(trading.getAccount).not.toHaveBeenCalled();
    await runtime.tick(true);
    expect(prepare).toHaveBeenCalled();
    expect(exits).not.toHaveBeenCalled();
    expect(trading.createOrder).not.toHaveBeenCalled();
    expect(runtime.state.enabled).toBe(false);
  });
  it("pins the account before reconciliation or any order mutation", async () => {
    const { runtime, env, trading } = await setup();
    runtime.state.enabled = true;
    runtime.state.mode = "paper";
    env.EXECUTION_ACCEPTANCE = runtime.state.profileHash;
    trading.getAccount.mockResolvedValue({ id: "wrong-account" });
    const exits = vi.spyOn(runtime, "exits");
    await runtime.tick();
    expect(runtime.state.error).toBe("broker_account_identity_mismatch");
    expect(exits).not.toHaveBeenCalled();
    expect(trading.createOrder).not.toHaveBeenCalled();
  });
  it("executes exits before optional source work; source failure leaves recovery scheduled", async () => {
    const { runtime, env, store } = await setup();
    runtime.state.enabled = true;
    runtime.state.mode = "paper";
    env.EXECUTION_ACCEPTANCE = runtime.state.profileHash;
    const order: string[] = [];
    vi.spyOn(runtime, "exits").mockImplementation(async () => {
      order.push("exits");
    });
    vi.spyOn(runtime, "prepare").mockImplementation(async () => {
      order.push("research");
      throw Error("outage");
    });
    await runtime.tick();
    expect(order).toEqual(["exits", "research"]);
    expect(store.setAlarm).toHaveBeenCalled();
  });
  it("does not turn an enabled shadow collector into an order executor", async () => {
    const { runtime } = await setup();
    const audit = vi.spyOn(runtime, "audit");
    await runtime.configure(true, "shadow");
    expect(audit).toHaveBeenCalledWith("configuration", expect.objectContaining({ authorizationBasis: "none" }));
    const exits = vi.spyOn(runtime, "exits").mockResolvedValue();
    vi.spyOn(runtime, "prepare").mockResolvedValue();
    await runtime.tick();
    expect(exits).not.toHaveBeenCalled();
    await expect(runtime.configure(true, "paper")).rejects.toThrow("authorization");
  });
  it("will not switch modes while an account has open orders", async () => {
    const { runtime, env, trading } = await setup();
    env.EXECUTION_ACCEPTANCE = runtime.state.profileHash;
    trading.listOrders.mockResolvedValue([{ id: "external-order" }]);
    await expect(runtime.configure(true, "paper")).rejects.toThrow("exposure");
  });
  it("latches drawdown across restart and does not reset the high-water mark", async () => {
    const { runtime, store, env, deps, trading } = await setup();
    await runtime.account();
    trading.getAccount.mockResolvedValue({
      id: "dedicated-account",
      status: "ACTIVE",
      currency: "USD",
      equity: 96000,
      cash: 96000,
    });
    await runtime.account();
    await runtime.persist();
    const restarted = new ExperimentRuntime(store, env, deps);
    await restarted.init();
    expect(restarted.state.paused).toBe(true);
    expect(restarted.state.peakEquity).toBe(100000);
  });
  it("rejects unknown holdings instead of treating them as free capacity", async () => {
    const { runtime } = await setup();
    const account = await runtime.account();
    expect(() => runtime.portfolio(account, [{ symbol: "EXTERNAL" }] as never)).toThrow("unreconciled");
  });
  it("keeps risk-reducing exits available with negative cash or exhausted equity", async () => {
    for (const finances of [
      { equity: 100000, cash: -1 },
      { equity: 0, cash: 0 },
    ]) {
      const { runtime, env, trading } = await setup();
      runtime.state.enabled = true;
      runtime.state.mode = "paper";
      env.EXECUTION_ACCEPTANCE = runtime.state.profileHash;
      trading.getAccount.mockResolvedValue({ id: "dedicated-account", status: "ACTIVE", currency: "USD", ...finances });
      const exits = vi.spyOn(runtime, "exits").mockResolvedValue();
      vi.spyOn(runtime, "prepare").mockResolvedValue();
      await runtime.tick();
      expect(exits).toHaveBeenCalled();
      if (finances.equity === 0) expect(runtime.state.paused).toBe(true);
    }
  });
  it("stopping during a configuration read wins over the pending enable", async () => {
    const { runtime, trading } = await setup();
    trading.getPositions.mockImplementationOnce(async () => {
      await runtime.stop();
      return [];
    });
    await expect(runtime.configure(true, "shadow")).rejects.toThrow("interrupted_by_stop");
    expect(runtime.state.enabled).toBe(false);
  });
  it("retains a disabled state when a manual cycle finishes after shutdown", async () => {
    const { runtime, store } = await setup();
    runtime.state.enabled = true;
    vi.spyOn(runtime, "prepare").mockImplementation(async () => {
      await runtime.stop();
    });
    await runtime.tick();
    expect(runtime.state.enabled).toBe(false);
    expect(store.setAlarm).not.toHaveBeenCalled();
  });
});
