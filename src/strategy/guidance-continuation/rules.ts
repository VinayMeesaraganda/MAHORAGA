import { z } from "zod";
import { EarningsEventSchema, eventRejections, Timestamp } from "../../schemas/earnings-event";
import { GUIDANCE_PROFILE as P } from "./config";

export const SessionSchema = z
  .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), open: Timestamp, close: Timestamp })
  .strict();
const positive = z.number().finite().positive();
export const CalendarSchema = z
  .object({
    checked_at: Timestamp,
    through: Timestamp,
    from: Timestamp,
    complete: z.boolean(),
    sources: z.array(z.string().url()).min(2),
    events: z.array(
      z.object({ at: Timestamp, kind: z.enum(["cpi", "employment", "fomc", "fed_press_conference"]) }).strict()
    ),
  })
  .strict();
export const CandidateInputSchema = z
  .object({
    event: EarningsEventSchema,
    at: Timestamp,
    sessions: z.array(SessionSchema).min(3),
    asset: z
      .object({
        type: z.literal("common_stock"),
        active: z.boolean(),
        tradable: z.boolean(),
        exchange: z.string(),
        sector: z.string().min(1),
      })
      .strict(),
    // Regular-session consolidated bars only; source adapter must certify these boundaries.
    bars: z
      .array(
        z
          .object({
            date: z.string(),
            open: positive,
            high: positive,
            low: positive,
            close: positive,
            volume: z.number().finite().nonnegative(),
            dollars: z.number().finite().nonnegative(),
            feed: z.literal("sip"),
            session: z.literal("regular"),
            available_at: Timestamp,
          })
          .strict()
      )
      .min(21),
    quote: z
      .object({
        bid: positive,
        ask: positive,
        bid_size: positive,
        ask_size: positive,
        at: Timestamp,
        feed: z.enum(["iex", "sip"]),
      })
      .strict(),
    calendar: CalendarSchema,
    news: z.object({ complete: z.boolean(), from: Timestamp, through: Timestamp }).strict(),
    optional_features: z.record(z.union([z.number().finite(), z.string(), z.null()])).default({}),
  })
  .strict();
export type CandidateInput = z.infer<typeof CandidateInputSchema>;
export interface Plan {
  symbol: string;
  issuer: string;
  sector: string;
  eventKey: string;
  eventVersion: string;
  limit: number;
  stop: number;
  rank: number;
  adv20: number;
  expiresAt: number;
  decisionAt: number;
}
export interface Decision {
  eventKey: string;
  eventVersion: string;
  at: string;
  reasons: string[];
  plan: Plan | null;
}
const ny = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export function localTime(at: number) {
  const p = Object.fromEntries(ny.formatToParts(at).map((v) => [v.type, v.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}
export function calendarRejection(c: z.infer<typeof CalendarSchema>, at: number): string | null {
  const hosts = c.sources.map((s) => new URL(s).hostname);
  if (!hosts.includes("www.bls.gov") || !hosts.includes("www.federalreserve.gov")) return "calendar_sources_unverified";
  if (
    !c.complete ||
    Date.parse(c.from) > at - P.blackoutMs ||
    Date.parse(c.through) < at + P.blackoutMs ||
    Date.parse(c.checked_at) > at ||
    at - Date.parse(c.checked_at) > P.calendarAgeMs
  )
    return "calendar_coverage_unknown";
  const { minute } = localTime(at);
  const start = at - (minute - P.entryMinute) * 60_000;
  const end = start + (P.entryEndMinute - P.entryMinute) * 60_000;
  return c.events.some((e) => Date.parse(e.at) + P.blackoutMs >= start && Date.parse(e.at) - P.blackoutMs <= end)
    ? "macro_blackout"
    : null;
}
export function evaluateCandidate(raw: unknown): Decision {
  const x = CandidateInputSchema.parse(raw),
    at = Date.parse(x.at),
    event = x.event;
  const reasons = eventRejections(event, at);
  const reject = (s: string) => {
    reasons.push(s);
  };
  const t = localTime(at);
  if (t.minute < P.entryMinute || t.minute >= P.entryEndMinute) reject("outside_entry_window");
  const sessions = [...x.sessions].sort((a, b) => Date.parse(a.open) - Date.parse(b.open));
  if (
    new Set(sessions.map((s) => s.date)).size !== sessions.length ||
    sessions.some((s) => Date.parse(s.open) >= Date.parse(s.close) || localTime(Date.parse(s.open)).date !== s.date)
  )
    reject("invalid_sessions");
  const released = Date.parse(event.released_at);
  if (sessions.some((s) => released >= Date.parse(s.open) && released < Date.parse(s.close)))
    reject("intraday_release");
  const d0Index = sessions.findIndex((s) => Date.parse(s.open) > released);
  const d0 = sessions[d0Index],
    d1 = sessions[d0Index + 1];
  if (d0Index <= 0 || !d0 || !d1 || d1.date !== t.date || at < Date.parse(d1.open) || at >= Date.parse(d1.close))
    reject("not_D1_or_calendar_gap");
  if (!x.asset.active || !x.asset.tradable || !["NYSE", "NASDAQ", "AMEX", "ARCA", "BATS"].includes(x.asset.exchange))
    reject("asset_not_eligible");
  const bars = [...x.bars].sort((a, b) => a.date.localeCompare(b.date));
  if (
    new Set(bars.map((b) => b.date)).size !== bars.length ||
    bars.some(
      (b) =>
        b.high < Math.max(b.open, b.close, b.low) ||
        b.low > Math.min(b.open, b.close, b.high) ||
        Date.parse(b.available_at) > at ||
        b.date >= t.date
    )
  )
    reject("invalid_or_future_bars");
  const reaction = bars.find((b) => b.date === d0?.date);
  const previous = bars.find((b) => b.date === sessions[d0Index - 1]?.date);
  if (
    !reaction ||
    !previous ||
    reaction.high <= reaction.low ||
    reaction.close <= previous.close ||
    reaction.close < (reaction.high + reaction.low) / 2
  )
    reject("D0_response_failed");
  // Require the last 21 completed sessions, not merely 21 arbitrarily spaced observations.
  const completed = sessions.filter((s) => Date.parse(s.close) < at).slice(-21);
  const recent = bars.slice(-21);
  if (completed.length !== 21 || recent.some((b, i) => b.date !== completed[i]?.date)) reject("history_session_gap");
  const adv20 = recent.slice(-20).reduce((n, b) => n + b.dollars, 0) / 20;
  if (adv20 < P.minAdv20) reject("insufficient_liquidity");
  const ranges = recent
    .slice(1)
    .map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - recent[i]!.close), Math.abs(b.low - recent[i]!.close)));
  // Explicit simple 14-session ATR; do not silently substitute Wilder smoothing.
  const atr = ranges.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const q = x.quote,
    qAt = Date.parse(q.at);
  if (qAt > at || at - qAt > P.quoteAgeMs || q.ask < q.bid) reject("quote_unusable");
  if (((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 10_000 > P.maxSpreadBps) reject("spread_too_wide");
  if (q.ask < P.minPrice) reject("price_too_low");
  const calendar = calendarRejection(x.calendar, at);
  if (calendar) reject(calendar);
  if (
    !x.news.complete ||
    Date.parse(x.news.from) > released ||
    Date.parse(x.news.through) > at ||
    at - Date.parse(x.news.through) > P.newsAgeMs
  )
    reject("news_coverage_unknown");
  const distance = Math.max(P.atrMultiple * atr, P.minStopFraction * q.ask);
  if (!(atr > 0) || distance / q.ask > P.maxStopFraction) reject("stop_distance_unusable");
  const antiChase = (reaction?.close ?? 0) + atr;
  if (q.ask > antiChase) reject("entry_chasing");
  // Round the buy cap down so tick conversion never exceeds the approved price.
  const limit = Math.floor(Math.min(q.ask * 1.0005, antiChase) * 100 + 1e-8) / 100;
  const stop = Math.floor((q.ask - distance) * 100 + 1e-8) / 100;
  if (limit < q.ask || stop <= 0 || stop >= limit || (limit - stop) / limit > P.maxStopFraction)
    reject("rounded_prices_unusable");
  const old = event.previous_guidance,
    next = event.new_guidance;
  const rank = old && next && old.low + old.high > 0 ? (next.low + next.high) / (old.low + old.high) - 1 : 0;
  return {
    eventKey: event.event_key,
    eventVersion: event.version,
    at: x.at,
    reasons: [...new Set(reasons)],
    plan: reasons.length
      ? null
      : {
          symbol: event.symbol,
          issuer: event.issuer_id,
          sector: x.asset.sector,
          eventKey: event.event_key,
          eventVersion: event.version,
          limit,
          stop,
          rank,
          adv20,
          decisionAt: at,
          expiresAt: Math.min(at + P.entryTimeoutMs, at + (P.entryEndMinute - t.minute) * 60_000 - (at % 60_000)),
        },
  };
}

export interface Allocation {
  issuer: string;
  sector: string;
  value: number;
  initialRisk: number;
}
export interface Portfolio {
  equity: number;
  cash: number;
  peakEquity: number;
  paused: boolean;
  allocations: Allocation[];
  attemptedEvents: string[];
}
/** Includes held positions AND opening reservations. No mutations or broker access. */
export function allocate(
  plans: Plan[],
  portfolio: Portfolio
): Array<{ plan: Plan; quantity: number; reason: string | null }> {
  if (
    plans.some(
      (p) =>
        ![p.limit, p.stop, p.rank, p.adv20, p.expiresAt, p.decisionAt].every(Number.isFinite) ||
        p.limit <= p.stop ||
        p.stop <= 0 ||
        p.adv20 < 0
    )
  )
    throw new Error("Invalid trade plan");
  if (
    ![portfolio.equity, portfolio.cash, portfolio.peakEquity].every(Number.isFinite) ||
    portfolio.equity <= 0 ||
    portfolio.cash < 0 ||
    portfolio.peakEquity < portfolio.equity ||
    portfolio.allocations.some(
      (a) => !Number.isFinite(a.value) || !Number.isFinite(a.initialRisk) || a.value < 0 || a.initialRisk < 0
    )
  )
    throw new Error("Invalid portfolio");
  const allocations = [...portfolio.allocations],
    attempted = new Set(portfolio.attemptedEvents);
  let cash = portfolio.cash;
  return [...plans]
    .sort((a, b) => b.rank - a.rank || b.adv20 - a.adv20 || a.issuer.localeCompare(b.issuer))
    .map((plan) => {
      let reason: string | null = null;
      if (portfolio.paused || 1 - portfolio.equity / portfolio.peakEquity >= P.drawdownPause)
        reason = "experiment_paused";
      else if (attempted.has(plan.eventKey) || allocations.some((a) => a.issuer === plan.issuer))
        reason = "duplicate_event_or_issuer";
      else if (allocations.length >= P.maxPositions) reason = "position_capacity";
      const sector = allocations.filter((a) => a.sector === plan.sector);
      if (!reason && sector.length >= P.maxSectorPositions) reason = "sector_capacity";
      const sum = (xs: Allocation[], field: "value" | "initialRisk") => xs.reduce((n, a) => n + a[field], 0);
      const risk = plan.limit - plan.stop,
        equity = portfolio.equity;
      let quantity = reason
        ? 0
        : Math.floor(
            Math.min(
              (equity * P.riskFraction) / risk,
              (equity * P.nameFraction) / plan.limit,
              (equity * P.grossFraction - sum(allocations, "value")) / plan.limit,
              (equity * P.sectorFraction - sum(sector, "value")) / plan.limit,
              (equity * P.portfolioRiskFraction - sum(allocations, "initialRisk")) / risk,
              cash / plan.limit
            )
          );
      if (!Number.isFinite(quantity) || quantity <= 0 || !(risk > 0) || !(plan.stop > 0)) {
        quantity = 0;
        reason ??= "risk_or_cash_capacity";
      }
      if (quantity > 0) {
        allocations.push({
          issuer: plan.issuer,
          sector: plan.sector,
          value: quantity * plan.limit,
          initialRisk: quantity * risk,
        });
        cash -= quantity * plan.limit;
        attempted.add(plan.eventKey);
      }
      return { plan, quantity, reason };
    });
}

export function exitReason(
  position: { stop: number; price: number; enteredSession: string; invalidation: "verified" | "pending" | "none" },
  sessions: z.infer<typeof SessionSchema>[],
  at: number
): string | null {
  const current = sessions.find((s) => at >= Date.parse(s.open) && at <= Date.parse(s.close));
  if (!current) return null;
  if (Number.isFinite(position.price) && position.price > 0 && position.price <= position.stop) return "initial_stop";
  const held = sessions.filter((s) => s.date >= position.enteredSession && s.date <= current.date);
  if (held.length > P.holdSessions || (held.length === P.holdSessions && at >= Date.parse(current.close) - 300_000))
    return "session_horizon";
  return position.invalidation === "verified" ? "verified_thesis_invalidation" : null;
}
