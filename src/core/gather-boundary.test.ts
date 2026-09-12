import { afterEach, describe, expect, it, vi } from "vitest";
import type { StrategyContext } from "../strategy/types";
import { gatherWithinDeadline } from "./gather-boundary";
import type { Signal } from "./types";

function fixture() {
  const state: Record<string, unknown> = { cache: { value: "old" } };
  const buy = vi.fn();
  const ctx = {
    config: {},
    signals: [],
    positionEntries: {},
    llm: { complete: vi.fn() },
    log: vi.fn(),
    trackLLMCost: vi.fn(),
    sleep: async () => {},
    broker: { buy, sell: vi.fn() },
    state: {
      get: <T>(key: string) => state[key] as T,
      set: <T>(key: string, value: T) => {
        state[key] = value;
      },
    },
  } as unknown as StrategyContext;
  return { ctx, state, buy };
}

afterEach(() => vi.useRealTimers());

describe("gather stage boundary", () => {
  it("publishes completed source state without leaking mutable references", async () => {
    const { ctx, state } = fixture();
    let retained: { value: string } | undefined;
    const signals = await gatherWithinDeadline(
      {
        name: "fast",
        gather: async (isolated) => {
          retained = isolated.state.get<{ value: string }>("cache")!;
          retained.value = "new";
          expect(state.cache).toEqual({ value: "old" });
          isolated.state.set("cache", retained);
          return [{ symbol: "AAPL" } as Signal];
        },
      },
      ctx,
      () => true
    );
    expect(signals[0]?.symbol).toBe("AAPL");
    expect(state.cache).toEqual({ value: "new" });
    retained!.value = "late mutation";
    expect(state.cache).toEqual({ value: "new" });
  });

  it("expires a hung source and discards its partial and late writes", async () => {
    vi.useFakeTimers();
    const { ctx, state } = fixture();
    let release: () => void = () => {};
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lateWriteRejected = false;
    const result = gatherWithinDeadline(
      {
        name: "slow",
        gather: async (isolated) => {
          isolated.state.get<{ value: string }>("cache")!.value = "partial";
          isolated.state.set("other", "partial");
          await deferred;
          try {
            isolated.state.set("cache", { value: "late" });
          } catch {
            lateWriteRejected = true;
          }
          return [];
        },
      },
      ctx,
      () => true,
      100
    );
    const rejection = expect(result).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(state).toEqual({ cache: { value: "old" } });
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(lateWriteRejected).toBe(true);
    expect(state).toEqual({ cache: { value: "old" } });
  });

  it("refuses result publication when the agent stops during a gather", async () => {
    const { ctx, state } = fixture();
    let enabled = true;
    await expect(
      gatherWithinDeadline(
        {
          name: "stop",
          gather: async (isolated) => {
            isolated.state.set("cache", { value: "uncommitted" });
            enabled = false;
            return [];
          },
        },
        ctx,
        () => enabled
      )
    ).rejects.toThrow(/stopped/);
    expect(state.cache).toEqual({ value: "old" });
  });

  it("removes broker mutation and model capabilities from source gathering", async () => {
    const { ctx, buy } = fixture();
    await expect(
      gatherWithinDeadline(
        {
          name: "bad",
          gather: async (isolated) => {
            expect(isolated.llm).toBeNull();
            await isolated.broker.buy("AAPL", 100, "unexpected");
            return [];
          },
        },
        ctx,
        () => true
      )
    ).rejects.toThrow(/cannot submit/);
    expect(buy).not.toHaveBeenCalled();
  });
});
