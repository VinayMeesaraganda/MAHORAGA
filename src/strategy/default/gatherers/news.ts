/**
 * Alpaca news gatherer.
 *
 * The research prompt tells the model that missing news must stay unknown, and
 * until now it always was — nothing fed it catalysts. Alpaca's feed is
 * Benzinga-sourced and symbol-tagged. Tags express relevance, not event ownership:
 * only articles with one unique symbol can supply issuer evidence. Multi-company
 * stories remain eligible for macro context, never for a per-symbol catalyst.
 *
 * Headlines are also cached in strategy state so the research prompt can quote
 * them for the symbol under evaluation.
 */

import type { Signal } from "../../../core/types";
import { createAlpacaProviders } from "../../../providers/alpaca";
import type { MarketNewsItem } from "../../../providers/types";
import type { Gatherer, StrategyContext } from "../../types";
import { SOURCE_CONFIG } from "../config";
import { adjudicateAdverse, adjudicationKey, MAX_ADJUDICATIONS_PER_PASS } from "../helpers/adjudicate";
import { adverseCatalystReason, type CatalystHit, classifyCatalyst } from "../helpers/catalyst";
import { detectSentiment } from "../helpers/sentiment";

/**
 * Headlines older than this contribute no entry signal. Three hours rather
 * than one: freshness decays linearly across the window, so the entry gate's
 * 0.5 minimum still rejects anything past the halfway point.
 */
const LOOKBACK_MINUTES = 180;
/** A single passing mention in a market-wrap piece is not a catalyst. */
const MIN_ARTICLES = 1;
/** Discard catalysts cached before conservative classification/issuer attribution. */
const CATALYST_EVIDENCE_VERSION = 2;

/**
 * Topics that move whole sectors rather than one issuer. Captured for context
 * only: the model is told what was published, and separately what the tape did
 * with it, rather than being asked to infer one from the other.
 */
const MACRO_PATTERNS: RegExp[] = [
  /\b(fed|fomc|powell|rate (cut|hike|decision)|basis points?)\b/i,
  /\b(cpi|inflation|ppi|pce|core inflation)\b/i,
  /\b(jobs report|nonfarm|payrolls?|unemployment rate|jobless claims)\b/i,
  /\b(gdp|recession|soft landing|yield curve|treasury yields?)\b/i,
  /\b(tariffs?|trade war|sanctions?|embargo|export controls?)\b/i,
  /\b(war|invasion|missile|airstrike|ceasefire|military strike)\b/i,
  /\b(opec|crude|oil prices?|barrel|pipeline|refinery)\b/i,
  /\b(government shutdown|debt ceiling|stimulus|budget deal)\b/i,
];

export function isMacroHeadline(text: string): boolean {
  return MACRO_PATTERNS.some((p) => p.test(text));
}

export interface CachedHeadline {
  headline: string;
  source: string;
  created_at: string;
}

export interface CachedCatalyst extends CatalystHit {
  symbol: string;
  headline: string;
  /** Epoch ms of publication, used for the entry gate's age check. */
  at: number;
}

function freshnessOf(createdAt: string, now: number): number {
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return 0;
  const ageMinutes = (now - t) / 60_000;
  if (ageMinutes < 0 || ageMinutes > LOOKBACK_MINUTES) return 0;
  // Linear decay across the window, floored so a 89-minute-old item is not zero.
  return Math.max(0.2, 1 - ageMinutes / LOOKBACK_MINUTES);
}

function singleIssuer(article: MarketNewsItem): string | null {
  const symbols = [...new Set(article.symbols.map((symbol) => symbol.trim().toUpperCase()))];
  const symbol = symbols[0];
  return symbols.length === 1 && symbol && /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) ? symbol : null;
}

async function gatherNews(ctx: StrategyContext): Promise<Signal[]> {
  const now = Date.now();
  const alpaca = createAlpacaProviders(ctx.env);
  const sourceWeight = SOURCE_CONFIG.weights.alpaca_news;
  const maxAgeMs = Math.max(1, ctx.config.entry_max_catalyst_age_minutes) * 60_000;
  const isCurrent = (at: number) => Number.isFinite(at) && at <= now && now - at <= maxAgeMs;
  const evidenceCurrent = ctx.state.get<number>("catalystEvidenceVersion") === CATALYST_EVIDENCE_VERSION;
  const existing = evidenceCurrent ? (ctx.state.get<Record<string, CachedCatalyst[]>>("catalystCache") ?? {}) : {};
  const invalidatedAt: Record<string, number> = {};
  for (const [symbol, at] of Object.entries(ctx.state.get<Record<string, number>>("catalystInvalidatedAt") ?? {})) {
    if (isCurrent(at)) invalidatedAt[symbol] = at;
  }
  const catalystCache: Record<string, CachedCatalyst[]> = {};
  for (const [symbol, hits] of Object.entries(existing)) {
    const kept = (hits ?? []).filter((h) => isCurrent(h.at) && h.at > (invalidatedAt[symbol] ?? 0));
    if (kept.length) catalystCache[symbol] = kept;
  }
  // Prune and migrate even if today's feed fails; a failure must not preserve
  // evidence admitted by the old permissive classifier.
  ctx.state.set("catalystCache", catalystCache);
  ctx.state.set("catalystInvalidatedAt", invalidatedAt);
  ctx.state.set("catalystEvidenceVersion", CATALYST_EVIDENCE_VERSION);

  let articles: MarketNewsItem[];
  try {
    articles = await alpaca.marketData.getNews({
      start: new Date(now - LOOKBACK_MINUTES * 60_000).toISOString(),
      limit: 50,
    });
  } catch (error) {
    ctx.log("News", "fetch_failed", { error: String(error) });
    return [];
  }

  const bySymbol = new Map<
    string,
    { articles: number; weightedSentiment: number; freshest: number; headlines: CachedHeadline[] }
  >();
  const macroHeadlines: CachedHeadline[] = [];

  for (const article of articles) {
    // Macro stories are captured whatever their symbol tagging: a tariff or
    // OPEC headline is often tagged with a long list of names, or none.
    if (macroHeadlines.length < 8 && isMacroHeadline(`${article.headline} ${article.summary}`.slice(0, 300))) {
      if (freshnessOf(article.created_at, now) > 0) {
        macroHeadlines.push({
          headline: article.headline,
          source: article.source,
          created_at: article.created_at,
        });
      }
    }

    const symbol = singleIssuer(article);
    if (!symbol) continue;
    const freshness = freshnessOf(article.created_at, now);
    if (freshness <= 0) continue;

    // Headline carries the signal; the summary mostly repeats it with boilerplate.
    const text = `${article.headline} ${article.summary}`;
    const rawSentiment = detectSentiment(text.slice(0, 400));
    const sentiment = adverseCatalystReason(text) ? -Math.max(Math.abs(rawSentiment), 0.5) : rawSentiment;

    let entry = bySymbol.get(symbol);
    if (!entry) {
      entry = { articles: 0, weightedSentiment: 0, freshest: 0, headlines: [] };
      bySymbol.set(symbol, entry);
    }
    entry.articles++;
    entry.weightedSentiment += sentiment * freshness;
    entry.freshest = Math.max(entry.freshest, freshness);
    if (entry.headlines.length < 5) {
      entry.headlines.push({ headline: article.headline, source: article.source, created_at: article.created_at });
    }
  }

  // Catalysts accumulate across passes and are pruned by age, because the
  // article window is three hours while post-event drift runs for days. A
  // catalyst published this morning should still qualify an entry this
  // afternoon.
  // First collect adverse evidence, independently of API ordering. Remember its
  // publication watermark across passes so an old positive cannot reappear when
  // the adverse story drops out of the feed's shorter three-hour window.
  const flagged: Array<{ symbol: string; at: number; reason: string; article: MarketNewsItem }> = [];
  for (const article of articles) {
    const symbol = singleIssuer(article);
    const createdAt = Date.parse(article.created_at);
    const updatedAt = Date.parse(article.updated_at);
    const at = Number.isFinite(updatedAt) && updatedAt <= now ? Math.max(createdAt, updatedAt) : createdAt;
    if (!symbol || !isCurrent(at)) continue;
    const reason = adverseCatalystReason(`${article.headline} ${article.summary}`);
    if (!reason || at <= (invalidatedAt[symbol] ?? 0)) continue;
    flagged.push({ symbol, at, reason, article });
  }

  // The pattern matcher reads vocabulary, and vocabulary is unbounded: three
  // defects in one week were all a negative word describing a negative being
  // removed. A model reads the event. It is consulted only for symbols actually
  // held, because that is the only case where a false flag costs money — for a
  // symbol not held, the flag merely blocks an entry, which costs opportunity,
  // and an entry is protected by every gate downstream anyway. Held symbols are
  // also already excluded from entry selection, so overturning a flag here can
  // only spare a position. There is no path from a model reply to an order.
  const mode = ctx.config.news_adjudication;
  const judged = ctx.state.get<Record<string, { upheld: boolean; at: number }>>("adjudications") ?? {};
  for (const [k, v] of Object.entries(judged)) if (now - v.at > maxAgeMs) delete judged[k];

  if (mode !== "off" && flagged.length > 0) {
    let held: Set<string>;
    try {
      held = new Set((await ctx.broker.getPositions()).map((p) => p.symbol.toUpperCase()));
    } catch {
      held = new Set();
    }
    const pending = flagged
      .filter((f) => held.has(f.symbol) && judged[adjudicationKey(f.symbol, f.article.headline)] === undefined)
      .slice(0, MAX_ADJUDICATIONS_PER_PASS);

    // Concurrently, so the worst case for the pass is one request deadline
    // rather than the sum of them.
    const outcomes = await Promise.all(
      pending.map((f) =>
        adjudicateAdverse(ctx.llm, {
          symbol: f.symbol,
          headline: f.article.headline,
          summary: f.article.summary,
          matched: f.reason,
        })
      )
    );
    pending.forEach((f, i) => {
      const outcome = outcomes[i]!;
      judged[adjudicationKey(f.symbol, f.article.headline)] = { upheld: outcome.upheld, at: now };
      ctx.log("News", "adjudicated", {
        symbol: f.symbol,
        matched: f.reason,
        upheld: outcome.upheld,
        note: outcome.note,
        mode,
        headline: f.article.headline.slice(0, 120),
        quote: outcome.verdict?.quote?.slice(0, 120) ?? null,
        event: outcome.verdict?.event ?? null,
        reasoning: outcome.verdict?.reasoning?.slice(0, 200) ?? null,
        // Shadow records what would have changed without changing it.
        would_have_changed: !outcome.upheld,
      });
    });
  }
  ctx.state.set("adjudications", judged);

  for (const f of flagged) {
    const decided = judged[adjudicationKey(f.symbol, f.article.headline)];
    if (mode === "enforce" && decided && !decided.upheld) {
      ctx.log("News", "catalyst_invalidation_withdrawn", { symbol: f.symbol, reason: f.reason });
      continue;
    }
    invalidatedAt[f.symbol] = f.at;
    ctx.log("News", "catalyst_invalidated", { symbol: f.symbol, at: f.at, reason: f.reason });
  }
  for (const [symbol, hits] of Object.entries(catalystCache)) {
    const kept = hits.filter((hit) => hit.at > (invalidatedAt[symbol] ?? 0));
    if (kept.length) catalystCache[symbol] = kept;
    else delete catalystCache[symbol];
  }

  for (const article of articles) {
    const symbol = singleIssuer(article);
    const at = Date.parse(article.created_at);
    if (!symbol || !isCurrent(at) || at <= (invalidatedAt[symbol] ?? 0)) continue;
    // Qualifying language must be in the headline. The complete summary may
    // veto it; truncation must not hide a denial or other adverse qualification.
    if (!classifyCatalyst(`${article.headline} ${article.summary}`)) continue;
    const hit = classifyCatalyst(article.headline);
    if (!hit) continue;
    const list = (catalystCache[symbol] ??= []);
    if (list.some((h) => h.headline === article.headline && h.at === at)) continue;
    list.push({ ...hit, symbol, headline: article.headline, at });
    list.sort((a, b) => a.at - b.at);
    if (list.length > 5) list.splice(0, list.length - 5);
  }
  ctx.state.set("catalystCache", catalystCache);
  ctx.state.set("catalystInvalidatedAt", invalidatedAt);

  // Cache headlines for the research prompt regardless of whether they clear the
  // signal threshold: context is useful even when the sentiment read is neutral.
  const newsCache: Record<string, CachedHeadline[]> = {};
  for (const [symbol, data] of bySymbol) newsCache[symbol] = data.headlines;
  ctx.state.set("newsCache", newsCache);
  ctx.state.set("newsCacheUpdatedAt", now);
  ctx.state.set("macroHeadlines", macroHeadlines);

  const signals: Signal[] = [];
  for (const [symbol, data] of bySymbol) {
    if (data.articles < MIN_ARTICLES) continue;
    const rawSentiment = Math.max(-1, Math.min(1, data.weightedSentiment / data.articles));
    if (rawSentiment === 0) continue;

    signals.push({
      symbol,
      source: "alpaca_news",
      source_detail: "benzinga",
      sentiment: rawSentiment * sourceWeight * data.freshest,
      raw_sentiment: rawSentiment,
      volume: data.articles,
      freshness: data.freshest,
      source_weight: sourceWeight,
      reason: `News: ${data.articles} article(s), latest "${data.headlines[0]?.headline.slice(0, 80) ?? ""}"`,
      timestamp: now,
    });
  }

  ctx.log("News", "gathered", {
    articles: articles.length,
    symbols: bySymbol.size,
    signals: signals.length,
    macro_headlines: macroHeadlines.length,
    catalysts: Object.keys(catalystCache).length,
  });
  return signals;
}

export const newsGatherer: Gatherer = {
  name: "alpaca_news",
  gather: gatherNews,
};
