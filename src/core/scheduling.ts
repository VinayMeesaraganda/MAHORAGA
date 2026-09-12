import type { MarketClock } from "../providers/types";

export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Resume promptly after slow work instead of adding another full heartbeat. */
export function heartbeatDelayMs(startedAt: number, now: number): number {
  return Math.max(1_000, HEARTBEAT_INTERVAL_MS - Math.max(0, now - startedAt));
}

/** Oldest due stage wins; periodic gathering cannot starve research or analysis. */
export function nextDueStage<T extends string>(
  stages: Array<{ name: T; lastRun: number; intervalMs: number; eligible: boolean }>,
  now: number
): T | null {
  let selected: T | null = null;
  let earliestDue = Number.POSITIVE_INFINITY;
  for (const stage of stages) {
    if (!stage.eligible) continue;
    const due = stage.lastRun > 0 ? stage.lastRun + stage.intervalMs : 0;
    if (due <= now && due < earliestDue) {
      selected = stage.name;
      earliestDue = due;
    }
  }
  return selected;
}

/** Failed research attempts still rotate so one failing symbol cannot starve peers. */
export function leastRecentlyResearched(
  symbols: string[],
  completed: Record<string, { timestamp: number }>,
  attempted: Record<string, number>
): string | null {
  return (
    symbols
      .slice()
      .sort(
        (a, b) =>
          Math.max(completed[a]?.timestamp ?? 0, attempted[a] ?? 0) -
          Math.max(completed[b]?.timestamp ?? 0, attempted[b] ?? 0)
      )[0] ?? null
  );
}

/** Delay expensive equity work until the premarket window; recheck the clock hourly. */
export function closedMarketDelayMs(
  clock: MarketClock,
  cryptoEnabled: boolean,
  premarketMinutes: number,
  now: number
): number | null {
  if (clock.is_open || cryptoEnabled) return null;
  const nextOpen = Date.parse(clock.next_open);
  if (!Number.isFinite(nextOpen) || nextOpen <= now) return 60_000;
  const untilPreparation = nextOpen - now - premarketMinutes * 60_000;
  return untilPreparation > 0 ? Math.min(untilPreparation, 3_600_000) : null;
}
