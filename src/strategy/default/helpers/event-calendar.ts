/**
 * Scheduled macro event blackout.
 *
 * A CPI or FOMC release repricing the whole tape in seconds is not something a
 * 30-second polling loop can trade. What it can do is decline to open new risk
 * immediately before one, so a position is not entered at 08:29 into a print
 * that gaps through a percentage stop at 08:30.
 *
 * Deliberately blocks entries only. Exits never consult this: being unable to
 * leave a position before a known event is strictly worse than entering one.
 *
 * Dates are configuration, not code — they change every year and an agent
 * should not be asserting them from memory.
 */

export interface ScheduledEvent {
  at: number;
  label: string;
}

/** Parse configured entries of the form "2026-09-16T14:00:00Z FOMC decision". */
export function parseScheduledEvents(entries: string[] | undefined): ScheduledEvent[] {
  if (!Array.isArray(entries)) return [];
  const parsed: ScheduledEvent[] = [];
  for (const raw of entries) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(" ");
    const stamp = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
    const label = spaceIdx === -1 ? "scheduled macro event" : trimmed.slice(spaceIdx + 1).trim();
    const at = Date.parse(stamp);
    if (!Number.isFinite(at)) continue;
    parsed.push({ at, label: label || "scheduled macro event" });
  }
  return parsed;
}

/**
 * The event whose blackout window currently contains `now`, or null.
 *
 * The window runs from `blackoutMinutes` before the event until the event
 * itself; once it has happened the regime read takes over and there is no
 * reason to keep blocking.
 */
export function activeBlackout(
  events: ScheduledEvent[],
  blackoutMinutes: number,
  now = Date.now()
): ScheduledEvent | null {
  if (!(blackoutMinutes > 0)) return null;
  const windowMs = blackoutMinutes * 60_000;
  for (const event of events) {
    if (now <= event.at && event.at - now <= windowMs) return event;
  }
  return null;
}
