import { describe, expect, it, vi } from "vitest";
import type { AlpacaClient } from "./client";
import { AlpacaMarketDataProvider } from "./market-data";

describe("Alpaca news pagination", () => {
  it("follows the interval to its terminal page and deduplicates overlapping versions", async () => {
    const article = {
      id: 1,
      headline: "Release",
      created_at: "2026-09-11T20:00:00Z",
      updated_at: "2026-09-11T20:00:00Z",
    };
    const dataRequest = vi
      .fn()
      .mockResolvedValueOnce({ news: [article], next_page_token: "next" })
      .mockResolvedValueOnce({ news: [article, { ...article, id: 2 }], next_page_token: null });
    const provider = new AlpacaMarketDataProvider({ dataRequest } as unknown as AlpacaClient);
    const articles = await provider.getNews({ start: "2026-09-10", end: "2026-09-12", limit: 50 });
    expect(articles).toHaveLength(2);
    expect(dataRequest.mock.calls[1]![2]).toMatchObject({ page_token: "next", start: "2026-09-10", end: "2026-09-12" });
  });
  it("does not return partial successes on a source error or repeated cursor", async () => {
    const dataRequest = vi.fn().mockResolvedValue({ news: [], next_page_token: "same" });
    const provider = new AlpacaMarketDataProvider({ dataRequest } as unknown as AlpacaClient);
    await expect(provider.getNews()).rejects.toThrow(/repeated/);
    dataRequest.mockResolvedValueOnce({ news: [], next_page_token: "next" }).mockRejectedValueOnce(new Error("outage"));
    await expect(provider.getNews()).rejects.toThrow(/outage/);
  });
  it("distinguishes a malformed response from a valid empty interval", async () => {
    const dataRequest = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ news: [] });
    const provider = new AlpacaMarketDataProvider({ dataRequest } as unknown as AlpacaClient);
    await expect(provider.getNews()).rejects.toThrow(/Malformed/);
    expect(await provider.getNews()).toEqual([]);
  });
});
