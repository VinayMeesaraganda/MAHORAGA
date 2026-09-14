import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarketNewsItem } from "../providers/types";
import { collectNews } from "./news";
import { testDatabase } from "./test-db";

const stores: ReturnType<typeof testDatabase>[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));
const setup = () => {
  const s = testDatabase();
  stores.push(s);
  return s;
};
const article = {
  id: 1,
  headline: "Release",
  summary: "EPS 2",
  source: "Benzinga",
  updated_at: "2026-09-10T20:00:00Z",
} as MarketNewsItem;
describe("news coverage and restart recovery", () => {
  it("retains contiguous history coverage when the next incremental cycle begins", async () => {
    const { db } = setup();
    const getNewsPage = vi.fn().mockResolvedValue({ news: [], next_page_token: null });
    const first = await collectNews(db, { getNewsPage }, ["AAPL"], 1800000000000);
    const next = await collectNews(db, { getNewsPage }, ["AAPL"], 1800000600000);
    expect(next.historyFrom).toBe(first.from);
    expect(next.from).not.toBe(first.from);
  });
  it("persists a page then resumes its cursor, without claiming coverage early", async () => {
    const { db } = setup();
    const getNewsPage = vi
      .fn()
      .mockResolvedValueOnce({ news: [article], next_page_token: "next" })
      .mockResolvedValueOnce({ news: [article], next_page_token: null });
    const first = await collectNews(db, { getNewsPage }, ["TEST"], 1_800_000_000_000);
    expect(first.complete).toBe(false);
    expect(first.through).toBeNull();
    const last = await collectNews(db, { getNewsPage }, ["TEST"], 1_800_000_001_000);
    expect(getNewsPage.mock.calls[1]![0].page_token).toBe("next");
    expect(last.complete).toBe(true);
    expect(last.through).toBe(first.end);
    expect(await db.executeOne("SELECT COUNT(*) AS count FROM research_news")).toEqual({ count: 1 });
  });
  it("records failures without advancing coverage and preserves source revisions", async () => {
    const { db } = setup();
    const getNewsPage = vi
      .fn()
      .mockRejectedValueOnce(new Error("outage"))
      .mockResolvedValueOnce({ news: [article, { ...article, summary: "correction" }], next_page_token: null });
    const failed = await collectNews(db, { getNewsPage }, [], 1_800_000_000_000);
    expect(failed.complete).toBe(false);
    expect(failed.error).toMatch(/outage/);
    const resumed = await collectNews(db, { getNewsPage }, [], 1_800_000_001_000);
    expect(resumed.complete).toBe(true);
    expect(await db.executeOne("SELECT COUNT(*) AS count FROM research_news")).toEqual({ count: 2 });
  });
  it("a repeated cursor stays incomplete, while an empty terminal page is a valid interval", async () => {
    const { db } = setup();
    const getNewsPage = vi.fn().mockResolvedValue({ news: [], next_page_token: "same" });
    await collectNews(db, { getNewsPage }, [], 1_800_000_000_000);
    expect((await collectNews(db, { getNewsPage }, [], 1_800_000_001_000)).error).toMatch(/Repeated/);
    getNewsPage.mockResolvedValue({ news: [], next_page_token: null });
    expect((await collectNews(db, { getNewsPage }, [], 1_800_000_002_000)).complete).toBe(true);
  });
});
