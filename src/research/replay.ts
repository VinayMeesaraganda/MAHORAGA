import { allocate, type Plan, type Portfolio } from "../strategy/guidance-continuation/rules";

export interface ReplayBar {
  at: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
export interface ReplayTrade {
  plan: Plan;
  entryAt: number;
  entryPrice: number;
  exitDueAt: number;
  bars: ReplayBar[];
  invalidatedAt?: number;
}
export interface ReplayExit {
  at: number;
  price: number;
  cause: "stop" | "time" | "invalidation";
  grossR: number;
  netR: number;
}
/** Assumed entry fills are explicit inputs. Stop gaps fill at the worse opening price.
 * Bars must end before the horizon; price ordering within a bar is unknowable.
 * Missing horizon bars leave the trade OPEN rather than inventing an exit.
 */
export function replayExit(trade: ReplayTrade, roundTripBps: number): ReplayExit | null {
  if (
    ![trade.entryPrice, trade.plan.stop, trade.entryAt, trade.exitDueAt, roundTripBps].every(Number.isFinite) ||
    trade.entryPrice <= trade.plan.stop ||
    trade.entryAt >= trade.exitDueAt ||
    roundTripBps < 0
  )
    throw new Error("Invalid replay trade");
  if (trade.entryPrice > trade.plan.limit) throw new Error("Assumed fill exceeds entry cap");
  const bars = [...trade.bars].sort((a, b) => a.at - b.at);
  if (
    new Set(bars.map((b) => b.at)).size !== bars.length ||
    bars.some(
      (b) =>
        ![b.at, b.open, b.high, b.low, b.close].every(Number.isFinite) ||
        Math.min(b.open, b.high, b.low, b.close) <= 0 ||
        b.high < Math.max(b.open, b.close, b.low) ||
        b.low > Math.min(b.open, b.close, b.high)
    )
  )
    throw new Error("Invalid replay bars");
  for (const bar of bars) {
    if (bar.at <= trade.entryAt) continue; // no use of pre-fill extremes
    let cause: ReplayExit["cause"] | null = null,
      price = bar.close;
    if (bar.low <= trade.plan.stop) {
      cause = "stop";
      price = Math.min(bar.open, trade.plan.stop);
    } else if (bar.at === trade.exitDueAt) cause = "time";
    else if (trade.invalidatedAt !== undefined && bar.at >= trade.invalidatedAt && trade.invalidatedAt > trade.entryAt)
      cause = "invalidation";
    if (bar.at > trade.exitDueAt) return null; // cannot fill an earlier time exit at a later bar
    if (cause) {
      const risk = trade.entryPrice - trade.plan.stop,
        costs = ((trade.entryPrice + price) * roundTripBps) / 20_000;
      return {
        at: bar.at,
        price,
        cause,
        grossR: (price - trade.entryPrice) / risk,
        netR: (price - trade.entryPrice - costs) / risk,
      };
    }
  }
  return null;
}

/** Chronological capital-constrained simulation. Marks use only past supplied bars.
 * This view has its own cash/holdings; it never sums independent trade R as account returns.
 */
export function replayPortfolio(trades: ReplayTrade[], initialEquity: number, costBps: number) {
  if (!(initialEquity > 0) || !Number.isFinite(initialEquity) || !Number.isFinite(costBps) || costBps < 0)
    throw new Error("Invalid replay account");
  const open: Array<{ trade: ReplayTrade; quantity: number; exit: ReplayExit | null }> = [];
  const results: Array<{ event: string; quantity: number; reason: string | null }> = [];
  const curve: Array<{ at: number; equity: number; cash: number }> = [];
  const attempted: string[] = [];
  let cash = initialEquity,
    peak = initialEquity,
    paused = false;
  const times = [
    ...new Set(trades.flatMap((t) => [t.entryAt, ...t.bars.filter((b) => b.at > t.entryAt).map((b) => b.at)])),
  ].sort((a, b) => a - b);
  const mark = (t: ReplayTrade, at: number) =>
    [...t.bars].filter((b) => b.at > t.entryAt && b.at <= at).sort((a, b) => b.at - a.at)[0]?.close ?? t.entryPrice;
  for (const at of times) {
    for (let i = open.length - 1; i >= 0; i--) {
      const position = open[i]!;
      if (position.exit && position.exit.at <= at) {
        cash += position.quantity * position.exit.price * (1 - costBps / 20_000);
        open.splice(i, 1);
      }
    }
    const equity = cash + open.reduce((n, p) => n + p.quantity * mark(p.trade, at), 0);
    peak = Math.max(peak, equity);
    paused ||= 1 - equity / peak >= 0.03;
    const arriving = trades.filter((t) => t.entryAt === at);
    const portfolio: Portfolio = {
      equity,
      cash,
      peakEquity: peak,
      paused,
      attemptedEvents: attempted,
      allocations: open.map((p) => ({
        issuer: p.trade.plan.issuer,
        sector: p.trade.plan.sector,
        value: p.quantity * mark(p.trade, at),
        initialRisk: p.quantity * (p.trade.entryPrice - p.trade.plan.stop),
      })),
    };
    // Reserve entry costs in available cash before whole-share sizing.
    portfolio.cash /= 1 + costBps / 20_000;
    for (const allocation of allocate(
      arriving.map((t) => t.plan),
      portfolio
    )) {
      const trade = arriving.find((t) => t.plan.eventKey === allocation.plan.eventKey)!;
      results.push({ event: trade.plan.eventKey, quantity: allocation.quantity, reason: allocation.reason });
      if (allocation.quantity > 0) {
        const exit = replayExit(trade, costBps);
        cash -= allocation.quantity * trade.entryPrice * (1 + costBps / 20_000);
        open.push({ trade, quantity: allocation.quantity, exit });
        attempted.push(trade.plan.eventKey);
      }
    }
    curve.push({ at, equity: cash + open.reduce((n, p) => n + p.quantity * mark(p.trade, at), 0), cash });
  }
  return { mode: "simulated", costBps, results, curve, openEvents: open.map((p) => p.trade.plan.eventKey), paused };
}

/** Paired calendar-block bootstrap: caller supplies NON-overlapping blocks longer
 * than the holding horizon, including zero-trade days. This is a diagnostic CI,
 * never an automatic promotion verdict or a correction for repeated peeking.
 */
export function pairedBlockInterval(
  blocks: number[][],
  iterations = 2000,
  seed = 12345
): { mean: number; low: number; high: number; blocks: number } | null {
  if (blocks.length < 20) return null;
  if (
    !Number.isInteger(iterations) ||
    iterations < 100 ||
    iterations > 100_000 ||
    blocks.some((b) => !b.length || b.some((x) => !Number.isFinite(x)))
  )
    throw new Error("Invalid resampling inputs");
  const values = blocks.flat(),
    mean = values.reduce((n, x) => n + x, 0) / values.length;
  const sampled: number[] = [];
  const random = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < iterations; i++) {
    let sum = 0,
      count = 0;
    for (let j = 0; j < blocks.length; j++) {
      const block = blocks[Math.floor(random() * blocks.length)]!;
      sum += block.reduce((n, x) => n + x, 0);
      count += block.length;
    }
    sampled.push(sum / count);
  }
  sampled.sort((a, b) => a - b);
  return {
    mean,
    low: sampled[Math.floor(iterations * 0.025)]!,
    high: sampled[Math.floor(iterations * 0.975)]!,
    blocks: blocks.length,
  };
}
