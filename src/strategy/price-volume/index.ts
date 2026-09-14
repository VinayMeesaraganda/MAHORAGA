import { z } from "zod";
import { CandidateInputSchema, calendarRejection, localTime, type Decision } from "../guidance-continuation/rules";
import { GUIDANCE_PROFILE } from "../guidance-continuation/config";

export const PRICE_VOLUME_PROFILE = Object.freeze({
  ...GUIDANCE_PROFILE,
  name: "price-volume-v1",
  revision: "2026-09-13-1",
  mode: "shadow",
  breakoutSessions: 20,
  volumeMultiple: 1.5,
  trendSessions: 50,
  antiChaseAtr: 0.5,
  minimumCloseLocation: 0.75,
});
export const PriceVolumeInputSchema = CandidateInputSchema.omit({ event: true })
  .extend({
    symbol: z.string().regex(/^[A-Z][A-Z0-9.-]{0,14}$/),
    issuer_id: z.string().min(1),
    history_adjustment: z.literal("split"),
  })
  .strict();
export type PriceVolumeInput = z.infer<typeof PriceVolumeInputSchema>;

/** Completed-session breakout; no intraday/full-day volume comparison, no LLM. */
export function evaluatePriceVolume(raw: unknown): Decision {
  const x = PriceVolumeInputSchema.parse(raw),
    p = PRICE_VOLUME_PROFILE,
    at = Date.parse(x.at),
    t = localTime(at),
    reasons: string[] = [];
  const reject = (reason: string) => reasons.push(reason);
  const sessions = [...x.sessions].sort((a, b) => a.date.localeCompare(b.date));
  const current = sessions.find((s) => s.date === t.date),
    completed = sessions.filter((s) => Date.parse(s.close) < at).slice(-51);
  const bars = [...x.bars].sort((a, b) => a.date.localeCompare(b.date)).slice(-51),
    d0 = bars.at(-1);
  const eventKey = `${x.issuer_id}:breakout:${d0?.date ?? t.date}`;
  if (
    !current ||
    at < Date.parse(current.open) ||
    at >= Date.parse(current.close) ||
    t.minute < p.entryMinute ||
    t.minute >= p.entryEndMinute
  )
    reject("outside_entry_window");
  if (
    new Set(sessions.map((s) => s.date)).size !== sessions.length ||
    sessions.some((s) => Date.parse(s.open) >= Date.parse(s.close))
  )
    reject("invalid_sessions");
  if (completed.length !== 51 || bars.length !== 51 || bars.some((b, i) => b.date !== completed[i]?.date))
    reject("history_session_gap");
  if (
    bars.some(
      (b, i) =>
        Date.parse(b.available_at) > at ||
        b.date >= t.date ||
        b.high < Math.max(b.open, b.close, b.low) ||
        b.low > Math.min(b.open, b.close, b.high) ||
        (i > 0 && Math.abs(b.open / bars[i - 1]!.close - 1) > 0.25)
    )
  )
    reject("invalid_future_or_discontinuous_history");
  if (!x.asset.active || !x.asset.tradable || !["NYSE", "NASDAQ", "AMEX", "ARCA", "BATS"].includes(x.asset.exchange))
    reject("asset_not_eligible");
  const prior = bars.slice(-21, -1),
    priorVolume = prior.reduce((s, b) => s + b.volume, 0) / 20;
  const volumeRatio = priorVolume > 0 ? (d0?.volume ?? 0) / priorVolume : 0;
  const breakout = Math.max(...prior.map((b) => b.high)),
    sma50 = bars.slice(-50).reduce((s, b) => s + b.close, 0) / 50;
  if (!d0 || d0.close <= breakout || d0.close <= sma50) reject("breakout_or_trend_failed");
  if (!d0 || d0.high <= d0.low || (d0.close - d0.low) / (d0.high - d0.low) < p.minimumCloseLocation)
    reject("weak_close");
  if (prior.length !== 20 || volumeRatio < p.volumeMultiple) reject("volume_confirmation_failed");
  const adv20 = prior.reduce((n, b) => n + b.dollars, 0) / 20;
  if (adv20 < p.minAdv20) reject("insufficient_liquidity");
  const atr =
    bars
      .slice(1)
      .map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - bars[i]!.close), Math.abs(b.low - bars[i]!.close)))
      .slice(-14)
      .reduce((a, b) => a + b, 0) / 14;
  const q = x.quote,
    qAt = Date.parse(q.at);
  if (qAt > at || at - qAt > p.quoteAgeMs || q.ask < q.bid) reject("quote_unusable");
  if (q.ask < p.minPrice) reject("price_too_low");
  if (((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 10000 > p.maxSpreadBps) reject("spread_too_wide");
  if (q.bid < breakout) reject("breakout_failed_at_entry");
  const antiChase = (d0?.close ?? 0) + p.antiChaseAtr * atr;
  if (q.ask > antiChase) reject("entry_chasing");
  const distance = Math.max(atr * p.atrMultiple, q.ask * p.minStopFraction);
  const limit = Math.floor(Math.min(q.ask * 1.0005, antiChase) * 100 + 1e-8) / 100,
    stop = Math.floor((q.ask - distance) * 100 + 1e-8) / 100;
  if (!(atr > 0) || stop <= 0 || limit < q.ask || stop >= limit || (limit - stop) / limit > p.maxStopFraction)
    reject("stop_distance_unusable");
  const macro = calendarRejection(x.calendar, at);
  if (macro) reject(macro);
  if (
    !x.news.complete ||
    Date.parse(x.news.from) > Date.parse(completed.at(-1)?.open ?? x.at) ||
    Date.parse(x.news.through) > at ||
    at - Date.parse(x.news.through) > p.newsAgeMs
  )
    reject("news_coverage_unknown");
  return {
    eventKey,
    eventVersion: p.revision,
    at: x.at,
    reasons: [...new Set(reasons)],
    plan: reasons.length
      ? null
      : {
          symbol: x.symbol,
          issuer: x.issuer_id,
          sector: x.asset.sector,
          eventKey,
          eventVersion: p.revision,
          limit,
          stop,
          rank: volumeRatio,
          adv20,
          decisionAt: at,
          expiresAt: Math.min(at + 60000, Date.parse(current!.close)),
        },
  };
}
