/**
 * StockTwits gatherer — trending symbols + sentiment from the StockTwits API.
 */

import type { Signal } from "../../../core/types";
import type { Gatherer, StrategyContext } from "../../types";
import { SOURCE_CONFIG } from "../config";
import { calculateTimeDecay } from "../helpers/sentiment";

async function fetchWithRetry(
  url: string,
  headers: Record<string, string>,
  log: StrategyContext["log"],
  sleep: StrategyContext["sleep"],
  maxRetries = 3
): Promise<Response | null> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (res.ok) return res;
      if (res.status === 403 || res.status === 429) {
        log("StockTwits", "source_unavailable", { status: res.status });
        return null;
      }
      return null;
    } catch (error) {
      log("StockTwits", "fetch_retry", { url, attempt: i + 1, error: String(error) });
      await sleep(1000 * 2 ** i);
    }
  }
  return null;
}

/** A net score over one or two tagged messages is noise, not sentiment. */
export const MIN_TAGGED_MESSAGES = 3;

export interface StockTwitsMessage {
  entities?: { sentiment?: { basic?: string } };
  created_at?: string;
}

export interface StockTwitsScore {
  /** Net bullish share of the messages that expressed a view, in [-1, 1]. */
  score: number;
  bullish: number;
  bearish: number;
  taggedCount: number;
  taggedRatio: number;
  avgFreshness: number;
  total: number;
  usable: boolean;
}

/**
 * Score a symbol's message stream.
 *
 * Most StockTwits messages carry no sentiment tag. Scoring the net of the
 * tagged ones over every message deflates the result by the untagged share, so
 * a unanimously bullish stream never reaches the configured threshold. Score
 * over the messages that actually expressed a view and keep the tagged share
 * separately as a confidence measure.
 */
export function scoreStockTwitsStream(messages: StockTwitsMessage[]): StockTwitsScore {
  let bullish = 0;
  let bearish = 0;
  let taggedTimeDecay = 0;
  let taggedCount = 0;
  let totalTimeDecay = 0;

  for (const msg of messages) {
    const sentiment = msg.entities?.sentiment?.basic;
    const msgTime = new Date(msg.created_at || Date.now()).getTime() / 1000;
    const timeDecay = calculateTimeDecay(msgTime);
    totalTimeDecay += timeDecay;

    if (sentiment === "Bullish" || sentiment === "Bearish") {
      taggedTimeDecay += timeDecay;
      taggedCount++;
      if (sentiment === "Bullish") bullish += timeDecay;
      else bearish += timeDecay;
    }
  }

  const total = messages.length;
  return {
    score: taggedTimeDecay > 0 ? (bullish - bearish) / taggedTimeDecay : 0,
    bullish,
    bearish,
    taggedCount,
    taggedRatio: total > 0 ? taggedCount / total : 0,
    avgFreshness: total > 0 ? totalTimeDecay / total : 0,
    total,
    usable: total >= 5 && taggedCount >= MIN_TAGGED_MESSAGES,
  };
}

async function gatherStockTwits(ctx: StrategyContext): Promise<Signal[]> {
  const signals: Signal[] = [];
  const sourceWeight = SOURCE_CONFIG.weights.stocktwits;

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
  };

  try {
    const trendingRes = await fetchWithRetry(
      "https://api.stocktwits.com/api/2/trending/symbols.json",
      headers,
      ctx.log,
      ctx.sleep
    );
    if (!trendingRes) {
      ctx.log("StockTwits", "cloudflare_blocked", {
        message: "StockTwits API blocked by Cloudflare - using Reddit only",
      });
      return [];
    }
    const trendingData = (await trendingRes.json()) as { symbols?: Array<{ symbol: string }> };
    const trending = trendingData.symbols || [];

    for (const sym of trending.slice(0, 15)) {
      try {
        const streamRes = await fetchWithRetry(
          `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(sym.symbol)}.json?limit=30`,
          headers,
          ctx.log,
          ctx.sleep
        );
        if (!streamRes) continue;
        const streamData = (await streamRes.json()) as {
          messages?: Array<{ entities?: { sentiment?: { basic?: string } }; created_at?: string }>;
        };
        const messages = streamData.messages || [];

        const { score, bullish, bearish, taggedCount, taggedRatio, avgFreshness, total, usable } =
          scoreStockTwitsStream(messages);

        if (usable) {
          const weightedSentiment = score * sourceWeight * avgFreshness;

          signals.push({
            symbol: sym.symbol,
            source: "stocktwits",
            source_detail: "stocktwits_trending",
            sentiment: weightedSentiment,
            raw_sentiment: score,
            volume: total,
            bullish: Math.round(bullish),
            bearish: Math.round(bearish),
            tagged_ratio: taggedRatio,
            freshness: avgFreshness,
            source_weight: sourceWeight,
            reason: `StockTwits: ${Math.round(bullish)}B/${Math.round(bearish)}b of ${taggedCount}/${total} tagged (${(score * 100).toFixed(0)}%) [fresh:${(avgFreshness * 100).toFixed(0)}%]`,
            timestamp: Date.now(),
          });
        }

        await ctx.sleep(200);
      } catch (error) {
        ctx.log("StockTwits", "symbol_error", { symbol: sym.symbol, error: String(error) });
      }
    }
  } catch (error) {
    ctx.log("StockTwits", "error", { message: String(error) });
  }

  return signals;
}

export const stocktwitsGatherer: Gatherer = {
  name: "stocktwits",
  gather: gatherStockTwits,
};
