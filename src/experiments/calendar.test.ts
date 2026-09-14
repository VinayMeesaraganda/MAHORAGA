import { describe, expect, it } from "vitest";
import { parseBls, parseFed } from "./calendar";
describe("official macro parsers", () => {
  it("keeps Eastern event time and rejects missing mandatory releases", () => {
    const event = (title: string) =>
      `BEGIN:VEVENT\nDTSTART;TZID=America/New_York:20260915T083000\nSUMMARY:${title}\nEND:VEVENT\n`;
    const data = `BEGIN:VCALENDAR\n${event("Consumer Price Index")}${event("Employment Situation")}END:VCALENDAR`;
    expect(parseBls(data)[0]).toEqual({ at: "2026-09-15T12:30:00.000Z", kind: "cpi" });
    expect(() => parseBls("BEGIN:VCALENDAR\nEND:VCALENDAR")).toThrow("missing");
    expect(() => parseBls("Access denied")).toThrow("Invalid");
  });
  it("isolates a single FOMC year and fails closed when markup or meeting count changes", () => {
    const rows = ["January", "March", "April", "June", "July", "September", "October", "December"]
      .map(
        (m) => `<div class="fomc-meeting__month"><strong>${m}</strong></div><div class="fomc-meeting__date">15-16</div>`
      )
      .join("");
    const html = `2026 FOMC Meetings${rows}2025 FOMC Meetings${rows}`;
    expect(parseFed(html, 2026)).toHaveLength(16);
    expect(parseFed(html, 2026).every((e) => e.at.startsWith("2026"))).toBe(true);
    expect(() => parseFed(html, 2027)).toThrow();
    expect(() => parseFed("2026 FOMC Meetings", 2026)).toThrow("coverage");
  });
});
