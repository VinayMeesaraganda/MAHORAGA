import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketNewsItem } from "../../../providers/types";
import type { StrategyContext } from "../../types";
import { DEFAULT_CONFIG } from "../config";
import { type CachedCatalyst, newsGatherer } from "./news";

const getNews = vi.hoisted(() => vi.fn());
vi.mock("../../../providers/alpaca", () => ({
  createAlpacaProviders: () => ({ marketData: { getNews } }),
}));

const NOW = Date.parse("2026-09-11T15:00:00Z");
function article(headline: string, symbols = ["ACME"], ageMinutes = 5): MarketNewsItem {
  const at = new Date(NOW - ageMinutes * 60_000).toISOString();
  return {
    id: ageMinutes,
    headline,
    symbols,
    summary: "",
    author: "News desk",
    source: "benzinga",
    url: "https://example.test/news",
    created_at: at,
    updated_at: at,
  };
}

function context(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  const ctx = {
    env: {},
    config: { ...DEFAULT_CONFIG, entry_max_catalyst_age_minutes: 1440 },
    state: {
      get: <T>(key: string) => data.get(key) as T | undefined,
      set: <T>(key: string, value: T) => {
        data.set(key, value);
      },
    },
    log: vi.fn(),
  } as unknown as StrategyContext;
  return {
    ctx,
    data,
    cache: () => ctx.state.get<Record<string, CachedCatalyst[]>>("catalystCache") ?? {},
  };
}

describe("issuer-specific news evidence", () => {
  it("keeps a material overnight item for an existing holding even after entry-catalyst expiry", async () => {
    const { ctx, data } = context();
    ctx.positionEntries = {
      ACME: {
        symbol: "ACME",
        entry_time: NOW - 4 * 86_400_000,
        entry_price: 100,
        entry_sentiment: 0,
        entry_social_volume: 0,
        entry_sources: [],
        entry_reason: "test",
        peak_price: 100,
        peak_sentiment: 0,
      },
    };
    getNews.mockResolvedValue([article("Acme withdraws its revenue guidance", ["ACME"], 2 * 24 * 60)]);
    await newsGatherer.gather(ctx);
    expect(data.get("catalystInvalidatedAt")).toMatchObject({ ACME: NOW - 2 * 86_400_000 });
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    getNews.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("retains the confirmed single-issuer event with its publication timestamp", async () => {
    const { ctx, cache } = context();
    getNews.mockResolvedValue([article("Acme raises guidance; bullish breakout", ["acme", "ACME"])]);
    const signals = await newsGatherer.gather(ctx);
    expect(cache().ACME).toMatchObject([
      {
        symbol: "ACME",
        type: "guidance",
        quality: "high",
        at: NOW - 5 * 60_000,
      },
    ]);
    expect(signals.map((signal) => signal.symbol)).toEqual(["ACME"]);
  });

  it("does not transfer a target's event or market-wrap sentiment to tagged peers", async () => {
    const { ctx, cache } = context();
    getNews.mockResolvedValue([
      article("Acme agrees to acquire Beta; bullish breakout", ["ACME", "BETA"]),
      article("Acme wins contract while Peer stock rallies", ["ACME", "PEER"]),
      article("Fed signals rate cut; bullish AI stocks rally", ["ACME", "PEER"]),
    ]);
    expect(await newsGatherer.gather(ctx)).toEqual([]);
    expect(cache()).toEqual({});
    expect(ctx.state.get("newsCache")).toEqual({});
    expect(ctx.state.get<unknown[]>("macroHeadlines")).toHaveLength(1);
  });

  it("invalidates only the named issuer, irrespective of article ordering", async () => {
    for (const newestFirst of [true, false]) {
      const { ctx, cache } = context();
      const articles = [
        article("FDA approval denied for Acme therapy", ["ACME"], 1),
        article("Acme phase 3 trial met primary endpoint", ["ACME"], 10),
        article("Peer raises guidance", ["PEER"], 20),
      ];
      getNews.mockResolvedValue(newestFirst ? articles : articles.reverse());
      const signals = await newsGatherer.gather(ctx);
      expect(cache().ACME).toBeUndefined();
      expect(cache().PEER).toHaveLength(1);
      expect(signals.find((signal) => signal.symbol === "ACME")?.raw_sentiment).toBeLessThan(0);
    }
  });

  it("persists adverse evidence across restart and rejects an older positive replay", async () => {
    const first = context();
    const positive = article("Acme raises guidance", ["ACME"], 30);
    getNews.mockResolvedValue([positive]);
    await newsGatherer.gather(first.ctx);
    expect(first.cache().ACME).toHaveLength(1);

    getNews.mockResolvedValue([article("Acme withdraws guidance", ["ACME"], 1)]);
    await newsGatherer.gather(first.ctx);
    expect(first.cache().ACME).toBeUndefined();

    const restarted = context(Object.fromEntries(first.data));
    vi.setSystemTime(NOW + 4 * 60 * 60_000);
    getNews.mockResolvedValue([positive]);
    await newsGatherer.gather(restarted.ctx);
    expect(restarted.cache().ACME).toBeUndefined();
  });

  it("uses a correction's update time to invalidate a later cached story", async () => {
    const { ctx, cache } = context();
    getNews.mockResolvedValue([article("Acme raises guidance", ["ACME"], 10)]);
    await newsGatherer.gather(ctx);
    getNews.mockResolvedValue([
      {
        ...article("Acme FDA approval denied after correction", ["ACME"], 30),
        updated_at: new Date(NOW - 60_000).toISOString(),
      },
    ]);
    await newsGatherer.gather(ctx);
    expect(cache().ACME).toBeUndefined();
  });

  it("does not invalidate unrelated issuers based on ambiguous multi-ticker adverse news", async () => {
    const { ctx, cache } = context();
    getNews.mockResolvedValue([article("Acme raises guidance", ["ACME"], 10)]);
    await newsGatherer.gather(ctx);
    getNews.mockResolvedValue([article("Peer FDA approval denied", ["ACME", "PEER"], 1)]);
    await newsGatherer.gather(ctx);
    expect(cache().ACME).toHaveLength(1);
    expect(ctx.state.get("catalystInvalidatedAt")).toEqual({});
  });

  it("cannot qualify from summary boilerplate or hide an adverse qualification after 400 characters", async () => {
    const { ctx, cache } = context();
    getNews.mockResolvedValue([
      { ...article("Acme shares trade higher"), summary: "Acme raises guidance" },
      {
        ...article("Acme raises guidance", ["BETA"]),
        summary: `${"Background information. ".repeat(30)} FDA approval denied.`,
      },
      { ...article("FDA approves Peer therapy", ["PEER"]), summary: "The report is a rumor and remains unconfirmed." },
    ]);
    await newsGatherer.gather(ctx);
    expect(cache()).toEqual({});
  });

  it("rejects future or expired evidence and retains the newest five regardless of feed ordering", async () => {
    const { ctx, cache } = context();
    getNews.mockResolvedValue([
      ...[1, 2, 3, 4, 5, 6].map((age) => article(`Acme raises guidance for quarter ${age}`, ["ACME"], age)),
      article("Peer raises guidance", ["PEER"], -1),
      article("Beta raises guidance", ["BETA"], 1441),
    ]);
    await newsGatherer.gather(ctx);
    expect(Object.keys(cache())).toEqual(["ACME"]);
    expect(cache().ACME?.map((hit) => hit.at)).toEqual([5, 4, 3, 2, 1].map((age) => NOW - age * 60_000));
  });

  it("discards permissive pre-fix caches even when the feed fails", async () => {
    const { ctx, cache } = context({
      catalystCache: { ACME: [{ type: "regulatory", quality: "high", matched: "FDA approval", at: NOW - 60_000 }] },
    });
    getNews.mockRejectedValue(new Error("news unavailable"));
    expect(await newsGatherer.gather(ctx)).toEqual([]);
    expect(cache()).toEqual({});
    expect(ctx.log).toHaveBeenCalledWith("News", "fetch_failed", expect.any(Object));
  });
});
