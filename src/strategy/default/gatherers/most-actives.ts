/**
 * Most-actives momentum gatherer.
 *
 * The candidate pool was 15 StockTwits trending tickers, which caps how many
 * entries can ever qualify. Alpaca's screener ranks the whole tradable universe
 * by traded volume, and one batched snapshot call turns that list into a
 * directional read.
 *
 * Deliberately uses most-actives rather than the movers screener: the top
 * gainers are dominated by sub-dollar names (observed: +124% at $0.1887), every
 * one of which the entry gates reject on price, spread or extension. Volume
 * leaders are where a $5,000 order can actually be filled and exited.
 */

import type { Signal } from "../../../core/types";
import { createAlpacaProviders } from "../../../providers/alpaca";
import type { Gatherer, StrategyContext } from "../../types";
import { SOURCE_CONFIG } from "../config";
import { deriveMarketContext } from "../helpers/market";

const TOP_N = 40;
/** Day change that maps to a full-strength reading; +2.5% scores 0.5. */
const FULL_STRENGTH_MOVE_PCT = 5;
/** Above this the move is already made — the entry gates would reject it anyway. */
const MAX_USEFUL_EXTENSION_PCT = 15;
const MINUTES_PER_SESSION = 390;

async function gatherMostActives(ctx: StrategyContext): Promise<Signal[]> {
  const now = Date.now();
  const alpaca = createAlpacaProviders(ctx.env);
  const sourceWeight = SOURCE_CONFIG.weights.alpaca_most_actives;

  let actives: Awaited<ReturnType<typeof alpaca.marketData.getMostActives>>;
  try {
    actives = await alpaca.marketData.getMostActives(TOP_N);
  } catch (error) {
    ctx.log("MostActives", "fetch_failed", { error: String(error) });
    return [];
  }
  if (!actives.length) return [];

  const symbols = actives.map((a) => a.symbol.toUpperCase());
  let snapshots: Record<string, Awaited<ReturnType<typeof alpaca.marketData.getSnapshot>>>;
  try {
    // One batched request rather than one per symbol.
    snapshots = await alpaca.marketData.getSnapshots(symbols);
  } catch (error) {
    ctx.log("MostActives", "snapshots_failed", { error: String(error) });
    return [];
  }

  const signals: Signal[] = [];
  const rejected: string[] = [];
  for (const active of actives) {
    const symbol = active.symbol.toUpperCase();
    const snap = snapshots[symbol];
    const price = snap?.latest_trade?.price;
    const prevClose = snap?.prev_daily_bar?.c;
    if (!price || !prevClose || price <= 0 || prevClose <= 0) continue;

    const changePct = ((price - prevClose) / prevClose) * 100;
    // Long-only strategy: a heavy-volume decline is not a candidate.
    if (changePct <= 0 || changePct > MAX_USEFUL_EXTENSION_PCT) continue;

    // The screener is full of sub-dollar names the entry gates reject anyway —
    // one observed at $0.17 with a 2859 bps spread. Screening them here costs
    // nothing (the snapshot is in hand) and stops them consuming paid research
    // calls later. Only price and previous-session liquidity are checked:
    // spreads and relative volume are meaningless while the market is closed,
    // which is exactly when the premarket plan builds its candidate list. The
    // live checks stay in the entry gate, where quotes are real.
    const context = deriveMarketContext(snap);
    if (!context || context.price < ctx.config.entry_min_price) {
      rejected.push(`${symbol}: price below $${ctx.config.entry_min_price}`);
      continue;
    }
    if (context.dollar_volume !== null && context.dollar_volume < ctx.config.entry_min_dollar_volume) {
      rejected.push(`${symbol}: ${(context.dollar_volume / 1e6).toFixed(1)}M dollar volume`);
      continue;
    }

    const rawSentiment = Math.min(1, changePct / FULL_STRENGTH_MOVE_PCT);

    const prevVolume = snap?.prev_daily_bar?.v;
    const minuteVolume = snap?.minute_bar?.v;
    const relVolume =
      prevVolume && prevVolume > 0 && typeof minuteVolume === "number"
        ? minuteVolume / (prevVolume / MINUTES_PER_SESSION)
        : 1;
    // Participation scales conviction but cannot manufacture it.
    const conviction = Math.max(0.5, Math.min(1.5, relVolume / 2));

    signals.push({
      symbol,
      source: "alpaca_most_actives",
      source_detail: "screener",
      sentiment: rawSentiment * sourceWeight * conviction,
      raw_sentiment: rawSentiment,
      volume: active.trade_count > 0 ? active.trade_count : 1,
      freshness: 1,
      source_weight: sourceWeight,
      reason: `Most active: +${changePct.toFixed(1)}% on ${(active.volume / 1e6).toFixed(1)}M shares, ${relVolume.toFixed(1)}x normal`,
      timestamp: now,
      price,
    });
  }

  ctx.log("MostActives", "gathered", {
    screened: actives.length,
    signals: signals.length,
    rejected_untradable: rejected.length,
    examples: rejected.slice(0, 3),
  });
  return signals;
}

export const mostActivesGatherer: Gatherer = {
  name: "alpaca_most_actives",
  gather: gatherMostActives,
};
