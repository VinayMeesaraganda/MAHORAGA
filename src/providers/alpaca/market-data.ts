import type {
  Bar,
  BarsParams,
  MarketDataProvider,
  MarketNewsItem,
  MostActive,
  Mover,
  NewsParams,
  Quote,
  Snapshot,
} from "../types";
import type { AlpacaClient } from "./client";

interface AlpacaBarsResponse {
  bars: Record<string, AlpacaBar[]> | AlpacaBar[];
  next_page_token?: string | null;
}

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  n: number;
  vw: number;
}

interface AlpacaLatestBarsResponse {
  bars: Record<string, AlpacaBar>;
}

interface AlpacaQuotesResponse {
  quotes: Record<string, AlpacaQuote>;
}

interface AlpacaQuote {
  ap: number;
  as: number;
  bp: number;
  bs: number;
  t: string;
}

interface AlpacaSnapshotsResponse {
  [symbol: string]: AlpacaSnapshot;
}

interface AlpacaSnapshot {
  latestTrade: {
    p: number;
    s: number;
    t: string;
  };
  latestQuote: AlpacaQuote;
  minuteBar: AlpacaBar;
  dailyBar: AlpacaBar;
  prevDailyBar: AlpacaBar;
}

function parseBar(raw: AlpacaBar): Bar {
  return {
    t: raw.t,
    o: raw.o,
    h: raw.h,
    l: raw.l,
    c: raw.c,
    v: raw.v,
    n: raw.n,
    vw: raw.vw,
  };
}

function parseQuote(symbol: string, raw: AlpacaQuote): Quote {
  return {
    symbol,
    bid_price: raw.bp,
    bid_size: raw.bs,
    ask_price: raw.ap,
    ask_size: raw.as,
    timestamp: raw.t,
  };
}

function parseSnapshot(symbol: string, raw: AlpacaSnapshot): Snapshot {
  return {
    symbol,
    latest_trade: {
      price: raw.latestTrade.p,
      size: raw.latestTrade.s,
      timestamp: raw.latestTrade.t,
    },
    latest_quote: parseQuote(symbol, raw.latestQuote),
    minute_bar: parseBar(raw.minuteBar),
    daily_bar: parseBar(raw.dailyBar),
    prev_daily_bar: parseBar(raw.prevDailyBar),
  };
}

/**
 * Alpaca defaults the bar range to the current day. A `limit` caps how many
 * bars come back but does not widen that range, so `{ limit: 60 }` on a daily
 * timeframe returns exactly one bar and every downstream indicator reports
 * unknown. Derive a start far enough back to actually contain `limit` sessions.
 */
function defaultStartFor(timeframe: string, limit?: number): string | undefined {
  if (!limit || limit <= 1) return undefined;
  const unit = timeframe.replace(/^\d+/, "").toLowerCase();

  let calendarDays: number;
  if (unit.startsWith("day")) {
    calendarDays = Math.ceil(limit * 1.5) + 10; // weekends and holidays
  } else if (unit.startsWith("week")) {
    calendarDays = limit * 7 + 14;
  } else if (unit.startsWith("month")) {
    calendarDays = limit * 31 + 31;
  } else {
    return undefined; // intraday ranges are already satisfied by the default window
  }

  return new Date(Date.now() - calendarDays * 86_400_000).toISOString().slice(0, 10);
}

const newYorkDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function daysBefore(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

export class AlpacaMarketDataProvider implements MarketDataProvider {
  private completedSession?: { date: string; promise: Promise<string> };

  constructor(private client: AlpacaClient) {}

  async getBars(symbol: string, timeframe: string, params?: BarsParams): Promise<Bar[]> {
    // A limit with no caller-defined range means a lookback, not the earliest
    // page in a widened range. Only this daily-history mode changes semantics;
    // explicit windows and intraday requests retain their existing behavior.
    if (/^1(day|d)$/i.test(timeframe) && params?.limit && !params.start && !params.end) {
      return this.getCompletedDailyBars(symbol, timeframe, params);
    }

    const request = (feed: string | undefined) =>
      this.client.dataRequest<AlpacaBarsResponse>("GET", `/v2/stocks/${encodeURIComponent(symbol)}/bars`, {
        timeframe,
        start: params?.start ?? defaultStartFor(timeframe, params?.limit),
        end: params?.end,
        limit: params?.limit,
        adjustment: params?.adjustment,
        feed,
      });

    // Alpaca defaults to the IEX feed, which is one venue and reports a small
    // fraction of consolidated volume — measured 7x to 60x understated against
    // the tape (NVDA 2.6M vs 157.8M shares). Any liquidity test built on it is
    // wrong by orders of magnitude. SIP carries the full tape; where the plan
    // does not include it the request 403s and IEX is used instead.
    let response: AlpacaBarsResponse;
    try {
      response = await request(params?.feed ?? "sip");
    } catch {
      response = await request(params?.feed === "sip" ? undefined : params?.feed);
    }

    if (!response || !response.bars) {
      return [];
    }

    if (Array.isArray(response.bars)) {
      return response.bars.map(parseBar);
    }

    const bars = response.bars[symbol];
    return bars ? bars.map(parseBar) : [];
  }

  private async latestCompletedDailySession(): Promise<string> {
    const today = newYorkDate.format(new Date());
    if (this.completedSession?.date === today) return this.completedSession.promise;

    // Alpaca's daily bar is a New York calendar-day aggregate and can change
    // after the regular close. Exclude today's bar even after 16:00 ET; during
    // the trading loop this is exactly the latest completed session. Calendar
    // truth handles weekends, holidays and unexpected closures.
    const promise = this.client
      .tradingRequest<Array<{ date: string }>>(
        "GET",
        `/v2/calendar?start=${daysBefore(today, 35)}&end=${daysBefore(today, 1)}`
      )
      .then((calendar) => {
        const latest = calendar
          .map((day) => day.date)
          .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date < today)
          .sort()
          .at(-1);
        if (!latest) throw new Error("Cannot determine latest completed daily session from Alpaca calendar");
        return latest;
      });
    const cached = { date: today, promise };
    this.completedSession = cached;
    try {
      return await promise;
    } catch (error) {
      if (this.completedSession === cached) this.completedSession = undefined;
      throw error;
    }
  }

  private async getCompletedDailyBars(symbol: string, timeframe: string, params: BarsParams): Promise<Bar[]> {
    const limit = params.limit!;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error("Daily bar lookback limit must be an integer between 1 and 10000");
    }
    const latestSession = await this.latestCompletedDailySession();
    const start = daysBefore(latestSession, Math.ceil(limit * 1.5) + 10);
    const feed = params.feed ?? "sip";
    const bars = new Map<number, Bar>();
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;

    // The API can return fewer rows than limit while still advertising another
    // page. Cap requests and fail if the service makes no bounded progress.
    for (let page = 0; page < 20; page++) {
      const response = await this.client.dataRequest<AlpacaBarsResponse>(
        "GET",
        `/v2/stocks/${encodeURIComponent(symbol)}/bars`,
        {
          timeframe,
          start,
          end: `${latestSession}T23:59:59.999Z`,
          limit: Math.min(limit, 10_000),
          sort: "desc",
          adjustment: params.adjustment ?? "split",
          feed,
          page_token: pageToken,
        }
      );
      const rawBars = Array.isArray(response?.bars) ? response.bars : (response?.bars?.[symbol] ?? []);
      for (const raw of rawBars) {
        const timestamp = Date.parse(raw.t);
        if (!Number.isFinite(timestamp)) throw new Error(`Invalid daily bar timestamp for ${symbol}`);
        if (newYorkDate.format(new Date(timestamp)) > latestSession) continue;
        bars.set(timestamp, { ...parseBar(raw), feed });
      }

      const nextToken = response?.next_page_token;
      if (bars.size >= limit || !nextToken) {
        const chronological = [...bars.entries()]
          .sort(([a], [b]) => a - b)
          .slice(-limit)
          .map(([, bar]) => bar);
        const newest = chronological.at(-1);
        if (!newest || newYorkDate.format(new Date(newest.t)) !== latestSession) {
          throw new Error(`Stale or missing daily history for ${symbol}: expected session ${latestSession}`);
        }
        return chronological;
      }
      if (seenTokens.has(nextToken)) throw new Error(`Repeated daily bar page token for ${symbol}`);
      seenTokens.add(nextToken);
      pageToken = nextToken;
    }
    throw new Error(`Daily bar pagination limit exceeded for ${symbol}`);
  }

  async getLatestBar(symbol: string): Promise<Bar> {
    const response = await this.client.dataRequest<AlpacaLatestBarsResponse>(
      "GET",
      `/v2/stocks/${encodeURIComponent(symbol)}/bars/latest`
    );

    const bar = response.bars[symbol];
    if (!bar) {
      throw new Error(`No bar data for ${symbol}`);
    }
    return parseBar(bar);
  }

  async getLatestBars(symbols: string[]): Promise<Record<string, Bar>> {
    const response = await this.client.dataRequest<AlpacaLatestBarsResponse>("GET", "/v2/stocks/bars/latest", {
      symbols: symbols.join(","),
    });

    const result: Record<string, Bar> = {};
    for (const [symbol, bar] of Object.entries(response.bars)) {
      result[symbol] = parseBar(bar);
    }
    return result;
  }

  async getQuote(symbol: string): Promise<Quote> {
    const response = await this.client.dataRequest<AlpacaQuotesResponse>(
      "GET",
      `/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`
    );

    const quote = response.quotes[symbol];
    if (!quote) {
      throw new Error(`No quote data for ${symbol}`);
    }
    return parseQuote(symbol, quote);
  }

  async getQuotes(symbols: string[]): Promise<Record<string, Quote>> {
    const response = await this.client.dataRequest<AlpacaQuotesResponse>("GET", "/v2/stocks/quotes/latest", {
      symbols: symbols.join(","),
    });

    const result: Record<string, Quote> = {};
    for (const [symbol, quote] of Object.entries(response.quotes)) {
      result[symbol] = parseQuote(symbol, quote);
    }
    return result;
  }

  async getSnapshot(symbol: string, params?: { feed?: "iex" | "sip" }): Promise<Snapshot> {
    const response = await this.client.dataRequest<AlpacaSnapshotsResponse | AlpacaSnapshot>(
      "GET",
      `/v2/stocks/${encodeURIComponent(symbol)}/snapshot`,
      params?.feed ? { feed: params.feed } : undefined
    );

    if (!response) {
      throw new Error(`No snapshot data for ${symbol} (market may be closed)`);
    }

    if ("latestTrade" in response) {
      return { ...parseSnapshot(symbol, response as AlpacaSnapshot), ...(params?.feed ? { feed: params.feed } : {}) };
    }

    const snapshot = (response as AlpacaSnapshotsResponse)[symbol];
    if (!snapshot) {
      throw new Error(`No snapshot data for ${symbol} (market may be closed)`);
    }
    return { ...parseSnapshot(symbol, snapshot), ...(params?.feed ? { feed: params.feed } : {}) };
  }

  async getCryptoSnapshot(symbol: string): Promise<Snapshot> {
    const response = await this.client.dataRequest<{ snapshots: AlpacaSnapshotsResponse }>(
      "GET",
      "/v1beta3/crypto/us/snapshots",
      { symbols: symbol }
    );

    const snapshot = response.snapshots?.[symbol as keyof typeof response.snapshots];
    if (!snapshot) {
      throw new Error(`No crypto snapshot data for ${symbol}`);
    }
    return parseSnapshot(symbol, snapshot);
  }

  async getSnapshots(symbols: string[]): Promise<Record<string, Snapshot>> {
    const response = await this.client.dataRequest<AlpacaSnapshotsResponse>("GET", "/v2/stocks/snapshots", {
      symbols: symbols.join(","),
    });

    const result: Record<string, Snapshot> = {};
    for (const [symbol, snapshot] of Object.entries(response)) {
      result[symbol] = parseSnapshot(symbol, snapshot);
    }
    return result;
  }

  /**
   * Symbol-tagged news. Alpaca supplies the symbol list, so headlines do not
   * have to be regex-matched back to tickers the way a generic feed would.
   */
  async getNews(params: NewsParams = {}): Promise<MarketNewsItem[]> {
    const articles = new Map<string, MarketNewsItem>();
    let pageToken = params.page_token;
    const seen = new Set<string>();
    // Bounded work, explicit failure rather than a silently incomplete success.
    for (let page = 0; page < 20; page++) {
      const result = await this.getNewsPage({ ...params, page_token: pageToken });
      for (const article of result.news) articles.set(`${article.id}:${article.updated_at}`, article);
      if (!result.next_page_token) return [...articles.values()];
      if (seen.has(result.next_page_token)) throw new Error("News pagination token repeated; coverage incomplete");
      seen.add(result.next_page_token);
      pageToken = result.next_page_token;
    }
    throw new Error("News pagination budget exceeded; coverage incomplete");
  }

  async getNewsPage(params: NewsParams = {}): Promise<{ news: MarketNewsItem[]; next_page_token: string | null }> {
    const response = await this.client.dataRequest<{ news?: RawNews[]; next_page_token?: string | null }>(
      "GET",
      "/v1beta1/news",
      {
        symbols: params.symbols?.length ? params.symbols.join(",") : undefined,
        start: params.start,
        end: params.end,
        limit: params.limit ?? 50,
        sort: params.sort ?? "desc",
        page_token: params.page_token,
      }
    );
    if (!Array.isArray(response.news)) throw new Error("Malformed news response; coverage unknown");
    return {
      next_page_token: response.next_page_token ?? null,
      news: response.news.map((n) => ({
        id: n.id,
        headline: n.headline ?? "",
        summary: n.summary ?? "",
        author: n.author ?? "",
        source: n.source ?? "",
        url: n.url ?? "",
        symbols: Array.isArray(n.symbols) ? n.symbols : [],
        created_at: n.created_at ?? "",
        updated_at: n.updated_at ?? "",
      })),
    };
  }

  /** Volume-ranked universe — the liquid names actually trading today. */
  async getMostActives(top = 50): Promise<MostActive[]> {
    const response = await this.client.dataRequest<{ most_actives?: MostActive[] }>(
      "GET",
      "/v1beta1/screener/stocks/most-actives",
      { top, by: "volume" }
    );
    return (response.most_actives ?? []).filter((m) => m.symbol && Number.isFinite(m.volume));
  }

  /** Day gainers and losers. Heavily populated by sub-dollar names; filter before use. */
  async getMovers(top = 20): Promise<{ gainers: Mover[]; losers: Mover[] }> {
    const response = await this.client.dataRequest<{ gainers?: Mover[]; losers?: Mover[] }>(
      "GET",
      "/v1beta1/screener/stocks/movers",
      { top }
    );
    return { gainers: response.gainers ?? [], losers: response.losers ?? [] };
  }
}

interface RawNews {
  id: number;
  headline?: string;
  summary?: string;
  author?: string;
  source?: string;
  url?: string;
  symbols?: string[];
  created_at?: string;
  updated_at?: string;
}

export function createAlpacaMarketDataProvider(client: AlpacaClient): AlpacaMarketDataProvider {
  return new AlpacaMarketDataProvider(client);
}
