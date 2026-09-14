import { z } from "zod";
import type { AlpacaClient } from "../../providers/alpaca/client";
import { CandidateInputSchema, localTime, type CandidateInput } from "../guidance-continuation/rules";

// Registered forward universe, not a survivor-selected historical universe.
export const UNIVERSE_REVISION = "liquid-us-common-2026-09-13";
export const UNIVERSE: Readonly<Record<string, string>> = Object.freeze({
  AAPL: "Technology",
  MSFT: "Technology",
  NVDA: "Technology",
  AMD: "Technology",
  GOOGL: "Communication Services",
  META: "Communication Services",
  NFLX: "Communication Services",
  AMZN: "Consumer Discretionary",
  TSLA: "Consumer Discretionary",
  HD: "Consumer Discretionary",
  JPM: "Financials",
  BAC: "Financials",
  GS: "Financials",
  V: "Financials",
  XOM: "Energy",
  CVX: "Energy",
  UNH: "Health Care",
  JNJ: "Health Care",
  LLY: "Health Care",
  WMT: "Consumer Staples",
  COST: "Consumer Staples",
  CAT: "Industrials",
  GE: "Industrials",
  NEE: "Utilities",
});
export type Client = Pick<AlpacaClient, "tradingRequest" | "dataRequest">;
export type Session = CandidateInput["sessions"][number];
export type History = {
  symbol: string;
  asof: string;
  adjustment: "split";
  bars: CandidateInput["bars"];
  observedAt: string;
};
export type MarketPacket = Omit<CandidateInput, "event" | "at">;
export const nyDate = (at: number) => localTime(at).date;

/** Convert a broker exchange-local wall time using the date's actual NY offset. */
export function exchangeTime(date: string, time: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}(:\d{2})?$/.test(time)) throw Error("Invalid exchange time");
  const hour = Number(time.slice(0, 2)),
    minute = Number(time.slice(3, 5));
  if (hour > 23 || minute > 59) throw Error("Invalid exchange time");
  for (const offset of [4, 5]) {
    const at = Date.parse(`${date}T${time.length === 5 ? `${time}:00` : time}Z`) + offset * 3_600_000;
    const t = localTime(at);
    if (t.date === date && t.minute === hour * 60 + minute) return new Date(at).toISOString();
  }
  throw Error("Unresolvable exchange time");
}

export async function readExchangeSessions(client: Client, now: number): Promise<Session[]> {
  const start = new Date(now - 130 * 86_400_000).toISOString().slice(0, 10);
  const end = new Date(now + 35 * 86_400_000).toISOString().slice(0, 10);
  const rows = z
    .array(z.object({ date: z.string(), open: z.string(), close: z.string() }))
    .min(60)
    .parse(await client.tradingRequest("GET", `/v2/calendar?start=${start}&end=${end}`));
  const sessions = rows.map((r) => ({
    date: r.date,
    open: exchangeTime(r.date, r.open),
    close: exchangeTime(r.date, r.close),
  }));
  if (
    new Set(sessions.map((s) => s.date)).size !== sessions.length ||
    sessions.some((s, i) => Date.parse(s.open) >= Date.parse(s.close) || (i > 0 && s.date <= sessions[i - 1]!.date))
  )
    throw Error("Invalid exchange calendar");
  return sessions;
}

const RawBar = z.object({
  t: z.string().datetime({ offset: true }),
  o: z.number().positive(),
  h: z.number().positive(),
  l: z.number().positive(),
  c: z.number().positive(),
  v: z.number().nonnegative(),
  vw: z.number().positive(),
});
type RawBar = z.infer<typeof RawBar>;
/** Consistent 30-minute RTH buckets; excludes the bucket beginning at the close.
 * This is a regular-window bar, not a claim of the exchange official auction close.
 */
export function aggregateRegularBars(raw: RawBar[], sessions: Session[], observed: number): CandidateInput["bars"] {
  return sessions.map((s) => {
    const open = Date.parse(s.open),
      close = Date.parse(s.close);
    const bars = raw
      .filter((b) => Date.parse(b.t) >= open && Date.parse(b.t) + 1_800_000 <= close)
      .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    const slots = (close - open) / 1_800_000;
    if (
      close > observed ||
      !Number.isInteger(slots) ||
      bars.length !== slots ||
      bars.some(
        (b, i) =>
          Date.parse(b.t) !== open + i * 1_800_000 || b.h < Math.max(b.o, b.c, b.l) || b.l > Math.min(b.o, b.c, b.h)
      )
    )
      throw Error(`Incomplete regular-session bars: ${s.date}`);
    return {
      date: s.date,
      open: bars[0]!.o,
      high: Math.max(...bars.map((b) => b.h)),
      low: Math.min(...bars.map((b) => b.l)),
      close: bars.at(-1)!.c,
      volume: bars.reduce((n, b) => n + b.v, 0),
      dollars: bars.reduce((n, b) => n + b.v * b.vw, 0),
      feed: "sip" as const,
      session: "regular" as const,
      available_at: new Date(observed).toISOString(),
    };
  });
}

export async function readHistory(client: Client, symbol: string, sessions: Session[], now: number): Promise<History> {
  if (!UNIVERSE[symbol]) throw Error("Symbol outside registered universe");
  const completed = sessions.filter((s) => Date.parse(s.close) + 900_000 < now).slice(-51);
  if (completed.length !== 51) throw Error("Insufficient calendar history");
  const raw = new Map<string, RawBar>(),
    seen = new Set<string>();
  let token: string | undefined;
  for (let page = 0; page < 12; page++) {
    const data = z
      .object({ bars: z.array(RawBar), next_page_token: z.string().nullable().optional() })
      .parse(
        await client.dataRequest("GET", `/v2/stocks/${encodeURIComponent(symbol)}/bars`, {
          timeframe: "30Min",
          start: completed[0]!.open,
          end: completed.at(-1)!.close,
          adjustment: "split",
          feed: "sip",
          sort: "asc",
          limit: 10000,
          page_token: token,
        })
      );
    for (const b of data.bars) {
      if (raw.has(b.t) && JSON.stringify(raw.get(b.t)) !== JSON.stringify(b))
        throw Error("Conflicting historical bar revision");
      raw.set(b.t, b);
    }
    if (!data.next_page_token)
      return {
        symbol,
        asof: completed.at(-1)!.date,
        adjustment: "split",
        bars: aggregateRegularBars([...raw.values()], completed, now),
        observedAt: new Date(now).toISOString(),
      };
    if (seen.has(data.next_page_token)) throw Error("Repeated market page cursor");
    seen.add(data.next_page_token);
    token = data.next_page_token;
  }
  throw Error("Historical bar pagination incomplete");
}

export async function readMarketPacket(
  client: Client,
  history: History,
  sessions: Session[],
  calendar: MarketPacket["calendar"],
  news: MarketPacket["news"],
  now: number
): Promise<MarketPacket> {
  const symbol = history.symbol;
  if (history.asof !== sessions.filter((s) => Date.parse(s.close) < now).at(-1)?.date || history.adjustment !== "split")
    throw Error("History is stale");
  const [asset, quotes] = await Promise.all([
    client.tradingRequest<{ class: string; status: string; tradable: boolean; exchange: string }>(
      "GET",
      `/v2/assets/${encodeURIComponent(symbol)}`
    ),
    client.dataRequest<{ quote: { bp: number; ap: number; bs: number; as: number; t: string } }>(
      "GET",
      `/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`,
      { feed: "iex" }
    ),
  ]);
  if (asset.class !== "us_equity" || !UNIVERSE[symbol]) throw Error("Unregistered security");
  const q = quotes.quote;
  return CandidateInputSchema.omit({ event: true, at: true }).parse({
    sessions,
    bars: history.bars,
    asset: {
      type: "common_stock",
      active: asset.status === "active",
      tradable: asset.tradable,
      exchange: asset.exchange,
      sector: UNIVERSE[symbol],
    },
    quote: { bid: q.bp, ask: q.ap, bid_size: q.bs, ask_size: q.as, at: q.t, feed: "iex" },
    calendar,
    news,
    optional_features: { relative_volume: null, fcf: null },
  });
}
