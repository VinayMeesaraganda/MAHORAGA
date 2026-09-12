import { withRequestDeadline } from "../lib/request-deadline";
import type { Gatherer, StrategyContext } from "../strategy/types";

export const GATHER_DEADLINE_MS = 15_000;

/**
 * A slow source cannot block the alarm or publish a partial/late cache. The
 * gatherer gets isolated state and no model/order capabilities. Individual
 * source transports still need their own abort deadline: this bounds waiting,
 * not arbitrary fetches created internally by a third-party strategy.
 */
export async function gatherWithinDeadline(
  gatherer: Gatherer,
  ctx: StrategyContext,
  isEnabled: () => boolean,
  timeoutMs = GATHER_DEADLINE_MS
) {
  let active = true;
  const values = new Map<string, unknown>();
  const writes = new Set<string>();
  const assertActive = () => {
    if (!active || !isEnabled()) throw new Error(`${gatherer.name} gathering expired or agent stopped`);
  };
  const isolated: StrategyContext = {
    ...ctx,
    config: structuredClone(ctx.config),
    signals: structuredClone(ctx.signals),
    positionEntries: structuredClone(ctx.positionEntries),
    llm: null,
    broker: {
      getAccount: () => {
        assertActive();
        return ctx.broker.getAccount();
      },
      getPositions: () => {
        assertActive();
        return ctx.broker.getPositions();
      },
      getClock: () => {
        assertActive();
        return ctx.broker.getClock();
      },
      buy: async () => {
        throw new Error("Gatherers cannot submit orders");
      },
      sell: async () => {
        throw new Error("Gatherers cannot submit orders");
      },
    },
    log: (agent, action, details) => {
      if (active && isEnabled()) ctx.log(agent, action, details);
    },
    trackLLMCost: () => {
      throw new Error("Gatherers cannot run model requests");
    },
    sleep: async (ms) => {
      assertActive();
      await ctx.sleep(ms);
      assertActive();
    },
    state: {
      get: <T>(key: string): T | undefined => {
        assertActive();
        if (!values.has(key)) values.set(key, structuredClone(ctx.state.get(key)));
        return values.get(key) as T | undefined;
      },
      set: <T>(key: string, value: T) => {
        assertActive();
        values.set(key, value);
        writes.add(key);
      },
    },
  };

  try {
    assertActive();
    const signals = await withRequestDeadline(
      timeoutMs,
      new Error(`${gatherer.name} exceeded ${timeoutMs}ms gathering deadline`),
      () => gatherer.gather(isolated)
    );
    assertActive();
    // Commit only a completed source; cloned values also prevent references
    // retained by the gatherer from mutating committed state after completion.
    for (const key of writes) ctx.state.set(key, structuredClone(values.get(key)));
    return structuredClone(signals);
  } finally {
    active = false;
  }
}
