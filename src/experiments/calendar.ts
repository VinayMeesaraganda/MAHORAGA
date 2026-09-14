import { z } from "zod";
import { CalendarSchema } from "../strategy/guidance-continuation/rules";
import { exchangeTime } from "../strategy/shared-market";
import { hash } from "../research/ledger";
import type { D1Client } from "../storage/d1/client";
import { fetchText } from "./http";

export const BLS_URL = "https://www.bls.gov/schedule/news_release/bls.ics";
export const FED_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
export type MacroCalendar = z.infer<typeof CalendarSchema>;

export function parseBls(content: string): MacroCalendar["events"] {
  if (!content.includes("BEGIN:VCALENDAR") || !content.includes("END:VCALENDAR")) throw Error("Invalid BLS calendar");
  const unfolded = content.replace(/\r?\n[ \t]/g, "");
  const events: MacroCalendar["events"] = [];
  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const summary = block.match(/(?:^|\n)SUMMARY:(.*)/)?.[1] ?? "";
    const kind = /Consumer Price Index/i.test(summary)
      ? "cpi"
      : /Employment Situation/i.test(summary)
        ? "employment"
        : null;
    if (!kind) continue;
    const date = block.match(
      /(?:^|\n)DTSTART(;TZID=America\/New_York)?:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?\r?\n/
    );
    if (!date || (date[1] && date[8]) || date[7] !== "00") throw Error("Unsupported BLS event timestamp");
    const day = `${date[2]}-${date[3]}-${date[4]}`;
    // BLS documents unzoned calendar times as Eastern time.
    const at = date[8]
      ? new Date(`${day}T${date[5]}:${date[6]}:00Z`).toISOString()
      : exchangeTime(day, `${date[5]}:${date[6]}`);
    events.push({ at, kind });
  }
  if (!events.some((e) => e.kind === "cpi") || !events.some((e) => e.kind === "employment"))
    throw Error("BLS required releases missing");
  return events;
}

export function parseFed(content: string, year: number): MacroCalendar["events"] {
  // Exact annual heading, rather than mixing meetings from several years.
  const heading = content.indexOf(`${year} FOMC Meetings`);
  if (heading < 0) throw Error("FOMC year unavailable");
  const rest = content.slice(heading);
  const next = rest.slice(30).search(/\d{4} FOMC Meetings/);
  const section = next < 0 ? rest : rest.slice(0, next + 30);
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const events: MacroCalendar["events"] = [];
  const pattern =
    /fomc-meeting__month[^>]*>\s*<strong>([A-Za-z]+)<\/strong>\s*<\/div>[\s\S]*?fomc-meeting__date[^>]*>\s*(\d{1,2})(?:-(\d{1,2}))?/g;
  for (const match of section.matchAll(pattern)) {
    const month = months.indexOf(match[1]!);
    if (month < 0) throw Error("Unsupported FOMC month");
    const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(match[3] ?? match[2]).padStart(2, "0")}`;
    events.push(
      { at: exchangeTime(date, "14:00"), kind: "fomc" },
      { at: exchangeTime(date, "14:30"), kind: "fed_press_conference" }
    );
  }
  if (events.length !== 16 || new Set(events.map((e) => e.at)).size !== 16)
    throw Error("FOMC scheduled meeting coverage changed; review required");
  return events;
}

export async function collectMacro(db: D1Client, now: number): Promise<MacroCalendar> {
  const [bls, fed] = await Promise.all([fetchText(BLS_URL), fetchText(FED_URL)]);
  const year = new Date(now).getUTCFullYear(),
    events = [...parseBls(bls), ...parseFed(fed, year)];
  const through = Math.min(now + 21 * 86400000, Date.parse(`${year + 1}-01-01T00:00:00Z`));
  for (const kind of ["cpi", "employment"])
    if (!events.some((e) => e.kind === kind && Date.parse(e.at) >= through))
      throw Error("BLS forward coverage incomplete");
  const observed = new Date(now).toISOString();
  for (const [url, content] of [
    [BLS_URL, bls],
    [FED_URL, fed],
  ]) {
    const digest = await hash(content!);
    await db.run(
      "INSERT OR IGNORE INTO research_evidence (id,source_url,content_hash,content,published_at,observed_at) VALUES (?,?,?,?,?,?)",
      [await hash(`${url}\n${digest}`), url, digest, content, observed, observed]
    );
  }
  return CalendarSchema.parse({
    checked_at: observed,
    from: new Date(now - 86400000).toISOString(),
    through: new Date(through).toISOString(),
    complete: true,
    sources: [BLS_URL, FED_URL],
    events,
  });
}

/** Manual fallback requires an explicit review, original documents and immutable provenance.
 * It is an operator assertion of completeness, not automated verification of an arbitrary document.
 */
export const CalendarReview = z
  .object({
    calendar: CalendarSchema.omit({ checked_at: true }),
    reviewer: z.string().min(3).max(100),
    completeness_attested: z.literal(true),
    evidence: z
      .array(z.object({ source_url: z.string().url(), content: z.string().min(100).max(250000) }).strict())
      .length(2),
  })
  .strict();
export async function saveCalendarReview(db: D1Client, raw: unknown, now: number): Promise<MacroCalendar> {
  const review = CalendarReview.parse(raw),
    observed = new Date(now).toISOString();
  const hosts = review.evidence.map((e) => new URL(e.source_url).hostname);
  if (
    !hosts.includes("www.bls.gov") ||
    !hosts.includes("www.federalreserve.gov") ||
    review.calendar.sources.some((u) => !review.evidence.some((e) => e.source_url === u))
  )
    throw Error("Official macro evidence required");
  if (
    Date.parse(review.calendar.from) >= Date.parse(review.calendar.through) ||
    Date.parse(review.calendar.through) < now ||
    Date.parse(review.calendar.from) > now
  )
    throw Error("Calendar does not cover now");
  const calendar = CalendarSchema.parse({ ...review.calendar, checked_at: observed });
  await db.run("INSERT INTO experiment_audit (id,experiment,kind,payload,observed_at) VALUES (?,?,?,?,?)", [
    crypto.randomUUID(),
    "macro",
    "operator_calendar_review",
    JSON.stringify({ ...review, calendar }),
    observed,
  ]);
  return calendar;
}
