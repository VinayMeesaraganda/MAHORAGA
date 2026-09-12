import { describe, expect, it } from "vitest";
import { activeBlackout, parseScheduledEvents } from "./event-calendar";

const now = Date.parse("2026-09-16T17:30:00Z");

describe("parseScheduledEvents", () => {
  it("parses an ISO stamp with a trailing label", () => {
    const [e] = parseScheduledEvents(["2026-09-16T18:00:00Z FOMC decision"]);
    expect(e?.at).toBe(Date.parse("2026-09-16T18:00:00Z"));
    expect(e?.label).toBe("FOMC decision");
  });

  it("defaults the label and skips unusable entries", () => {
    expect(parseScheduledEvents(["2026-09-16T18:00:00Z"])[0]?.label).toBe("scheduled macro event");
    expect(parseScheduledEvents(["not a date", "", "   ", 42 as unknown as string])).toEqual([]);
    expect(parseScheduledEvents(undefined)).toEqual([]);
  });
});

describe("activeBlackout", () => {
  const events = parseScheduledEvents(["2026-09-16T18:00:00Z FOMC decision", "2026-10-14T12:30:00Z CPI release"]);

  it("blocks inside the window before an event", () => {
    expect(activeBlackout(events, 60, now)?.label).toBe("FOMC decision");
  });

  it("allows entries outside the window", () => {
    expect(activeBlackout(events, 15, now)).toBeNull();
    expect(activeBlackout(events, 60, Date.parse("2026-09-16T16:00:00Z"))).toBeNull();
  });

  it("stops blocking once the event has passed", () => {
    // The regime read takes over afterwards; there is nothing left to protect against.
    expect(activeBlackout(events, 60, Date.parse("2026-09-16T18:00:01Z"))).toBeNull();
  });

  it("is disabled by a zero or negative window", () => {
    expect(activeBlackout(events, 0, now)).toBeNull();
    expect(activeBlackout(events, -5, now)).toBeNull();
  });
});
