import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlpacaClient } from "./client";
import { AlpacaMarketDataProvider, createAlpacaMarketDataProvider } from "./market-data";

describe("Alpaca Market Data Provider", () => {
  let mockClient: {
    tradingRequest: ReturnType<typeof vi.fn>;
    dataRequest: ReturnType<typeof vi.fn>;
  };
  let provider: AlpacaMarketDataProvider;

  const mockBar = {
    t: "2024-01-15T10:00:00Z",
    o: 150.0,
    h: 152.0,
    l: 149.5,
    c: 151.5,
    v: 1000000,
    n: 5000,
    vw: 151.0,
  };

  const mockQuote = {
    ap: 151.55,
    as: 100,
    bp: 151.5,
    bs: 200,
    t: "2024-01-15T10:00:00Z",
  };

  beforeEach(() => {
    mockClient = {
      tradingRequest: vi.fn(),
      dataRequest: vi.fn(),
    };
    provider = createAlpacaMarketDataProvider(mockClient as unknown as AlpacaClient);
  });

  describe("createAlpacaMarketDataProvider", () => {
    it("creates provider with client", () => {
      expect(provider).toBeInstanceOf(AlpacaMarketDataProvider);
    });
  });

  describe("getBars", () => {
    it("fetches and parses bars for symbol", async () => {
      mockClient.dataRequest.mockResolvedValueOnce({
        bars: { AAPL: [mockBar] },
      });

      const bars = await provider.getBars("AAPL", "1Day");

      expect(mockClient.dataRequest).toHaveBeenCalledWith(
        "GET",
        "/v2/stocks/AAPL/bars",
        expect.objectContaining({ timeframe: "1Day" })
      );
      expect(bars).toHaveLength(1);
      expect(bars[0]!.o).toBe(150.0);
      expect(bars[0]!.h).toBe(152.0);
      expect(bars[0]!.l).toBe(149.5);
      expect(bars[0]!.c).toBe(151.5);
      expect(bars[0]!.v).toBe(1000000);
    });

    it("handles array response format", async () => {
      mockClient.dataRequest.mockResolvedValueOnce({
        bars: [mockBar],
      });

      const bars = await provider.getBars("AAPL", "1Day");

      expect(bars).toHaveLength(1);
      expect(bars[0]!.c).toBe(151.5);
    });

    it("returns empty array when no bars", async () => {
      mockClient.dataRequest.mockResolvedValueOnce({
        bars: {},
      });

      const bars = await provider.getBars("AAPL", "1Day");

      expect(bars).toEqual([]);
    });

    it("returns empty array when response is null", async () => {
      mockClient.dataRequest.mockResolvedValueOnce(null);

      const bars = await provider.getBars("AAPL", "1Day");

      expect(bars).toEqual([]);
    });

    it("passes optional params", async () => {
      mockClient.dataRequest.mockResolvedValueOnce({ bars: {} });

      await provider.getBars("AAPL", "1Hour", {
        start: "2024-01-01",
        end: "2024-01-15",
        limit: 100,
        adjustment: "all",
        feed: "iex",
      });

      expect(mockClient.dataRequest).toHaveBeenCalledWith("GET", "/v2/stocks/AAPL/bars", {
        timeframe: "1Hour",
        start: "2024-01-01",
        end: "2024-01-15",
        limit: 100,
        adjustment: "all",
        feed: "iex",
      });
    });

    it("encodes symbol in URL", async () => {
      mockClient.dataRequest.mockResolvedValueOnce({ bars: {} });

      await provider.getBars("BTC/USD", "1Day");

      expect(mockClient.dataRequest).toHaveBeenCalledWith("GET", "/v2/stocks/BTC%2FUSD/bars", expect.any(Object));
    });
  });

  describe("getLatestBar", () => {
    it("fetches latest bar for symbol", async () => {
      mockClient.dataRequest.mockResolvedValueOnce({
        bars: { AAPL: mockBar },
      });

      const bar = await provider.getLatestBar("AAPL");

      expect(mockClient.dataRequest).toHaveBeenCalledWith("GET", "/v2/stocks/AAPL/bars/latest");
      expect(bar.c).toBe(151.5);
    });

    it("throws when no bar data available", async () => {
      mockClient.dataRequest.mockResolvedValueOnce({
        bars: {},
      });

      await expect(provider.getLatestBar("AAPL")).rejects.toThrow("No bar data for AAPL");
    });
  });

  describe("getLatestBars", () => {
    it("fetches latest bars for multiple symbols", async () => {
      mockClient.dataRequest.mockResolvedValueOnce({
        bars: {
          AAPL: mockBar,
          GOOGL: { ...mockBar, c: 140.0 },
        },
      });

      const bars = await provider.getLatestBars(["AAPL", "GOOGL"]);

      expect(mockClient.dataRequest).toHaveBeenCalledWith("GET", "/v2/stocks/bars/latest", { symbols: "AAPL,GOOGL" });
      expect(bars.AAPL!.c).toBe(151.5);
      expect(bars.GOOGL!.c).toBe(140.0);
    });
  });

  describe("getQuote", () => {
    it("fetches latest quote for symbol", async () => {
      mockClient.dataRequest.mockResolvedValueOnce({
        quotes: { AAPL: mockQuote },
      });

      const quote = await provider.getQuote("AAPL");

      expect(mockClient.dataRequest).toHaveBeenCalledWith("GET", "/v2/stocks/AAPL/quotes/latest");
      expect(quote.symbol).toBe("AAPL");
      expect(quote.bid_price).toBe(151.5);
      expect(quote.ask_price).toBe(151.55);
      expect(quote.bid_size).toBe(200);
      expect(quote.ask_size).toBe(100);
    });

    it("throws when no quote data available", async () => {
      mockClient.dataRequest.mockResolvedValueOnce({
        quotes: {},
      });

      await expect(provider.getQuote("AAPL")).rejects.toThrow("No quote data for AAPL");
    });
  });

  describe("getQuotes", () => {
    it("fetches latest quotes for multiple symbols", async () => {
      mockClient.dataRequest.mockResolvedValueOnce({
        quotes: {
          AAPL: mockQuote,
          GOOGL: { ...mockQuote, bp: 140.0 },
        },
      });

      const quotes = await provider.getQuotes(["AAPL", "GOOGL"]);

      expect(mockClient.dataRequest).toHaveBeenCalledWith("GET", "/v2/stocks/quotes/latest", { symbols: "AAPL,GOOGL" });
      expect(quotes.AAPL!.bid_price).toBe(151.5);
      expect(quotes.GOOGL!.bid_price).toBe(140.0);
    });
  });

  describe("getSnapshot", () => {
    const mockSnapshot = {
      latestTrade: { p: 151.5, s: 100, t: "2024-01-15T10:00:00Z" },
      latestQuote: mockQuote,
      minuteBar: mockBar,
      dailyBar: mockBar,
      prevDailyBar: { ...mockBar, c: 150.0 },
    };

    it("fetches snapshot for symbol (direct response format)", async () => {
      mockClient.dataRequest.mockResolvedValueOnce(mockSnapshot);

      const snapshot = await provider.getSnapshot("AAPL");

      expect(mockClient.dataRequest).toHaveBeenCalledWith("GET", "/v2/stocks/AAPL/snapshot", undefined);
      expect(snapshot.symbol).toBe("AAPL");
      expect(snapshot.latest_trade.price).toBe(151.5);
      expect(snapshot.latest_quote.bid_price).toBe(151.5);
      expect(snapshot.minute_bar.c).toBe(151.5);
      expect(snapshot.daily_bar.c).toBe(151.5);
      expect(snapshot.prev_daily_bar.c).toBe(150.0);
    });

    it("fetches snapshot for symbol (keyed response format)", async () => {
      mockClient.dataRequest.mockResolvedValueOnce({
        AAPL: mockSnapshot,
      });

      const snapshot = await provider.getSnapshot("AAPL");

      expect(snapshot.symbol).toBe("AAPL");
      expect(snapshot.latest_trade.price).toBe(151.5);
    });

    it("requests and identifies an explicit snapshot feed", async () => {
      mockClient.dataRequest.mockResolvedValueOnce(mockSnapshot);
      const snapshot = await provider.getSnapshot("AAPL", { feed: "iex" });
      expect(mockClient.dataRequest).toHaveBeenCalledWith("GET", "/v2/stocks/AAPL/snapshot", { feed: "iex" });
      expect(snapshot.feed).toBe("iex");
    });

    it("does not label the default snapshot as a known feed", async () => {
      mockClient.dataRequest.mockResolvedValueOnce(mockSnapshot);
      expect((await provider.getSnapshot("AAPL")).feed).toBeUndefined();
    });

    it("throws when response is null", async () => {
      mockClient.dataRequest.mockResolvedValueOnce(null);

      await expect(provider.getSnapshot("AAPL")).rejects.toThrow("No snapshot data for AAPL");
    });

    it("throws when symbol not in keyed response", async () => {
      mockClient.dataRequest.mockResolvedValueOnce({
        GOOGL: mockSnapshot,
      });

      await expect(provider.getSnapshot("AAPL")).rejects.toThrow("No snapshot data for AAPL");
    });
  });

  describe("getCryptoSnapshot", () => {
    const mockCryptoSnapshot = {
      latestTrade: { p: 45000.0, s: 0.5, t: "2024-01-15T10:00:00Z" },
      latestQuote: { ...mockQuote, bp: 44999, ap: 45001 },
      minuteBar: { ...mockBar, c: 45000 },
      dailyBar: { ...mockBar, c: 45000 },
      prevDailyBar: { ...mockBar, c: 44500 },
    };

    it("fetches crypto snapshot", async () => {
      mockClient.dataRequest.mockResolvedValueOnce({
        snapshots: { "BTC/USD": mockCryptoSnapshot },
      });

      const snapshot = await provider.getCryptoSnapshot("BTC/USD");

      expect(mockClient.dataRequest).toHaveBeenCalledWith("GET", "/v1beta3/crypto/us/snapshots", {
        symbols: "BTC/USD",
      });
      expect(snapshot.symbol).toBe("BTC/USD");
      expect(snapshot.latest_trade.price).toBe(45000.0);
    });

    it("throws when no crypto snapshot data", async () => {
      mockClient.dataRequest.mockResolvedValueOnce({
        snapshots: {},
      });

      await expect(provider.getCryptoSnapshot("BTC/USD")).rejects.toThrow("No crypto snapshot data for BTC/USD");
    });
  });

  describe("getSnapshots", () => {
    const mockSnapshot = {
      latestTrade: { p: 151.5, s: 100, t: "2024-01-15T10:00:00Z" },
      latestQuote: mockQuote,
      minuteBar: mockBar,
      dailyBar: mockBar,
      prevDailyBar: mockBar,
    };

    it("fetches snapshots for multiple symbols", async () => {
      mockClient.dataRequest.mockResolvedValueOnce({
        AAPL: mockSnapshot,
        GOOGL: { ...mockSnapshot, latestTrade: { p: 140.0, s: 50, t: "2024-01-15T10:00:00Z" } },
      });

      const snapshots = await provider.getSnapshots(["AAPL", "GOOGL"]);

      expect(mockClient.dataRequest).toHaveBeenCalledWith("GET", "/v2/stocks/snapshots", { symbols: "AAPL,GOOGL" });
      expect(snapshots.AAPL!.latest_trade.price).toBe(151.5);
      expect(snapshots.GOOGL!.latest_trade.price).toBe(140.0);
    });
  });
});

describe("completed daily history", () => {
  const bar = (date: string, close = 100) => ({
    t: `${date}T04:00:00Z`,
    o: close,
    h: close + 1,
    l: close - 1,
    c: close,
    v: 100_000,
    n: 100,
    vw: close,
  });
  let client: { tradingRequest: ReturnType<typeof vi.fn>; dataRequest: ReturnType<typeof vi.fn> };
  let provider: AlpacaMarketDataProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T15:00:00Z"));
    client = {
      tradingRequest: vi.fn().mockResolvedValue([{ date: "2026-09-09" }, { date: "2026-09-10" }]),
      dataRequest: vi.fn().mockResolvedValue({ bars: [bar("2026-09-10")] }),
    };
    provider = createAlpacaMarketDataProvider(client as unknown as AlpacaClient);
  });

  afterEach(() => vi.useRealTimers());

  it("requests newest split-adjusted SIP bars and returns chronological history", async () => {
    client.dataRequest.mockResolvedValueOnce({
      bars: [bar("2026-09-10", 103), bar("2026-09-09", 102), bar("2026-09-08", 101)],
      next_page_token: "older-sessions",
    });
    const bars = await provider.getBars("AAPL", "1Day", { limit: 3 });
    expect(bars.map((b) => b.c)).toEqual([101, 102, 103]);
    expect(bars.every((b) => b.feed === "sip")).toBe(true);
    expect(client.dataRequest).toHaveBeenCalledWith("GET", "/v2/stocks/AAPL/bars", {
      timeframe: "1Day",
      start: "2026-08-26",
      end: "2026-09-10T23:59:59.999Z",
      limit: 3,
      sort: "desc",
      adjustment: "split",
      feed: "sip",
      page_token: undefined,
    });
    expect(client.dataRequest).toHaveBeenCalledTimes(1);
  });

  it("follows short pages, deduplicates, and trims to the latest requested count", async () => {
    client.dataRequest
      .mockResolvedValueOnce({ bars: { AAPL: [bar("2026-09-10"), bar("2026-09-09")] }, next_page_token: "page-2" })
      .mockResolvedValueOnce({
        bars: [bar("2026-09-09"), bar("2026-09-08"), bar("2026-09-04")],
        next_page_token: "page-3",
      });
    const bars = await provider.getBars("AAPL", "1Day", { limit: 3 });
    expect(bars.map((b) => b.t.slice(0, 10))).toEqual(["2026-09-08", "2026-09-09", "2026-09-10"]);
    expect(client.dataRequest).toHaveBeenCalledTimes(2);
    expect(client.dataRequest.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ page_token: "page-2", sort: "desc" })
    );
  });

  it("does not accept a stale first page as the latest history", async () => {
    client.dataRequest.mockResolvedValueOnce({ bars: [bar("2026-08-25"), bar("2026-08-24")] });
    await expect(provider.getBars("AAPL", "1Day", { limit: 2 })).rejects.toThrow("expected session 2026-09-10");
  });

  it("excludes the current incomplete bar even if the response contains it", async () => {
    client.dataRequest
      .mockResolvedValueOnce({ bars: [bar("2026-09-11")], next_page_token: "previous" })
      .mockResolvedValueOnce({ bars: [bar("2026-09-10")] });
    expect((await provider.getBars("AAPL", "1D", { limit: 1 })).map((b) => b.t.slice(0, 10))).toEqual(["2026-09-10"]);
    expect(client.dataRequest.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ start: "2026-08-29" }));
  });

  it("uses calendar truth across weekends and market holidays", async () => {
    vi.setSystemTime(new Date("2026-09-08T13:00:00Z")); // Tuesday after Labor Day
    client.tradingRequest.mockResolvedValueOnce([{ date: "2026-09-03" }, { date: "2026-09-04" }]);
    client.dataRequest.mockResolvedValueOnce({ bars: [bar("2026-09-04")] });
    const bars = await provider.getBars("AAPL", "1Day", { limit: 1 });
    expect(bars[0]?.t.slice(0, 10)).toBe("2026-09-04");
    expect(client.tradingRequest).toHaveBeenCalledWith("GET", "/v2/calendar?start=2026-08-04&end=2026-09-07");
  });

  it("uses the New York date across UTC midnight and daylight saving time", async () => {
    vi.setSystemTime(new Date("2026-01-13T01:00:00Z")); // Monday evening in New York
    client.tradingRequest.mockResolvedValueOnce([{ date: "2026-01-09" }]);
    client.dataRequest.mockResolvedValueOnce({ bars: [{ ...bar("2026-01-09"), t: "2026-01-09T05:00:00Z" }] });
    expect((await provider.getBars("AAPL", "1Day", { limit: 1 }))[0]?.t).toBe("2026-01-09T05:00:00Z");
    expect(client.tradingRequest.mock.calls[0]?.[1]).toContain("end=2026-01-11");
  });

  it("caches the calendar by New York date, refreshing on the next date", async () => {
    await Promise.all([provider.getBars("AAPL", "1Day", { limit: 1 }), provider.getBars("MSFT", "1Day", { limit: 1 })]);
    expect(client.tradingRequest).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-09-12T05:00:00Z"));
    client.tradingRequest.mockResolvedValueOnce([{ date: "2026-09-11" }]);
    client.dataRequest.mockResolvedValueOnce({ bars: [bar("2026-09-11")] });
    await provider.getBars("AAPL", "1Day", { limit: 1 });
    expect(client.tradingRequest).toHaveBeenCalledTimes(2);
  });

  it("retries the calendar after failure without caching a fabricated session", async () => {
    client.tradingRequest.mockRejectedValueOnce(new Error("calendar unavailable"));
    await expect(provider.getBars("AAPL", "1Day", { limit: 1 })).rejects.toThrow("calendar unavailable");
    expect(client.dataRequest).not.toHaveBeenCalled();
    await expect(provider.getBars("AAPL", "1Day", { limit: 1 })).resolves.toHaveLength(1);
    expect(client.tradingRequest).toHaveBeenCalledTimes(2);
  });

  it("fails on missing history instead of presenting stale technicals", async () => {
    client.dataRequest.mockResolvedValueOnce({ bars: [] });
    await expect(provider.getBars("AAPL", "1Day", { limit: 252 })).rejects.toThrow("Stale or missing daily history");
  });

  it("rejects repeated page tokens and malformed timestamps", async () => {
    client.dataRequest.mockResolvedValue({ bars: [bar("2026-09-10")], next_page_token: "same" });
    await expect(provider.getBars("AAPL", "1Day", { limit: 3 })).rejects.toThrow("Repeated daily bar page token");
    expect(client.dataRequest).toHaveBeenCalledTimes(2);
    client.dataRequest.mockResolvedValueOnce({ bars: [{ ...bar("2026-09-10"), t: "invalid" }] });
    await expect(provider.getBars("AAPL", "1Day", { limit: 3 })).rejects.toThrow("Invalid daily bar timestamp");
  });

  it("fails on SIP errors without silently substituting single-venue volume", async () => {
    client.dataRequest.mockRejectedValueOnce(new Error("subscription does not permit SIP"));
    await expect(provider.getBars("AAPL", "1Day", { limit: 252 })).rejects.toThrow("subscription does not permit SIP");
    expect(client.dataRequest).toHaveBeenCalledTimes(1);
  });

  it("preserves explicitly requested feed and adjustment", async () => {
    const bars = await provider.getBars("AAPL", "1Day", { limit: 1, feed: "iex", adjustment: "raw" });
    expect(bars[0]?.feed).toBe("iex");
    expect(client.dataRequest.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ feed: "iex", adjustment: "raw" }));
  });

  it("does not change explicit windows or intraday semantics", async () => {
    await provider.getBars("AAPL", "1Day", { start: "2026-01-01", end: "2026-01-31", limit: 10 });
    expect(client.dataRequest.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        start: "2026-01-01",
        end: "2026-01-31",
        limit: 10,
        adjustment: undefined,
      })
    );
    expect(client.dataRequest.mock.calls[0]?.[2]).not.toHaveProperty("sort");
    await provider.getBars("AAPL", "5Min", { limit: 60 });
    expect(client.dataRequest.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({
        start: undefined,
        end: undefined,
        timeframe: "5Min",
        limit: 60,
      })
    );
    expect(client.tradingRequest).not.toHaveBeenCalled();
  });

  it("still widens weekly lookbacks without applying daily completion rules", async () => {
    await provider.getBars("AAPL", "1Week", { limit: 20 });
    const start = client.dataRequest.mock.calls[0]?.[2]?.start;
    expect((Date.now() - Date.parse(`${start}T00:00:00Z`)) / 86_400_000).toBeGreaterThan(140);
    expect(client.tradingRequest).not.toHaveBeenCalled();
  });
});
