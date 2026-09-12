/**
 * Trade thesis capture.
 *
 * The point of a journal is not a record of what happened — the broker already
 * has that. It is a record of *why the decision was made*, taken at the moment
 * it was made, so that later you can ask which reasons actually paid.
 *
 * Everything here is captured at entry because none of it can be reconstructed
 * afterwards: prices move, the macro regime changes, research expires from the
 * cache, and the catalyst ages out. A journal assembled at exit can only record
 * outcomes, which is the half that teaches you nothing about selection.
 *
 * The questions this is built to answer:
 *   - Do guidance catalysts pay better than earnings beats?
 *   - Is the 52-week gate at 70% selecting better trades than 75% would have?
 *   - Do entries in leading sectors outperform entries in lagging ones?
 *   - Is model confidence correlated with outcome at all?
 */

import type { MarketContext, ResearchResult } from "../../../core/types";
import type { CatalystHit } from "./catalyst";
import type { MacroRegime } from "./macro";

export interface TradeThesis {
  /** One line a human can read: why this, why now. */
  summary: string;
  /** The reason the trade was permitted at all. */
  catalyst: { type: string; quality: string; headline: string; age_hours: number } | null;
  /** What the model concluded, kept so confidence can be scored against outcomes. */
  research: {
    verdict: string;
    confidence: number;
    entry_quality: string;
    reasoning: string;
    red_flags: string[];
  } | null;
  /** The measured values every gate saw, so a threshold can be re-tested later. */
  gates: Record<string, number | string | null>;
  /** Planned risk at entry — the denominator for an R multiple. */
  plan: { stop_pct: number; target_pct: number; notional: number; risk_usd: number };
}

export function buildThesis(params: {
  symbol: string;
  catalyst: (CatalystHit & { headline?: string; at?: number }) | null;
  research: ResearchResult | undefined;
  market: MarketContext | null | undefined;
  regime: MacroRegime | null | undefined;
  stopPct: number;
  targetPct: number;
  notional: number;
  now?: number;
}): TradeThesis {
  const now = params.now ?? Date.now();
  const { catalyst, research, market, regime } = params;

  const catalystPart = catalyst ? `${catalyst.type} (${catalyst.quality})` : "no catalyst recorded";
  const contextPart = market?.pct_of_52w_high != null ? `${market.pct_of_52w_high.toFixed(0)}% of 52w high` : "";
  const regimePart = regime ? `tape ${regime.risk}` : "";
  const leaderPart = regime?.leaders?.length ? `leaders ${regime.leaders.map((l) => l.symbol).join("/")}` : "";

  return {
    summary: [params.symbol, catalystPart, contextPart, regimePart, leaderPart].filter(Boolean).join(" · "),
    catalyst: catalyst
      ? {
          type: catalyst.type,
          quality: catalyst.quality,
          headline: catalyst.headline ?? catalyst.matched,
          age_hours: Number.isFinite(catalyst.at) ? (now - (catalyst.at as number)) / 3_600_000 : Number.NaN,
        }
      : null,
    research: research
      ? {
          verdict: research.verdict,
          confidence: research.confidence,
          entry_quality: research.entry_quality,
          reasoning: research.reasoning,
          red_flags: research.red_flags ?? [],
        }
      : null,
    gates: {
      price: market?.price ?? null,
      pct_of_52w_high: market?.pct_of_52w_high ?? null,
      atr_pct: market?.atr_pct ?? null,
      rsi_14: market?.rsi_14 ?? null,
      trend: market?.trend ?? null,
      rel_volume: market?.rel_volume ?? null,
      spread_bps: market?.spread_bps ?? null,
      extension_pct: market?.extension_pct ?? null,
      range_position: market?.range_position ?? null,
      adv20_usd: market?.dollar_volume ?? null,
    },
    plan: {
      stop_pct: params.stopPct,
      target_pct: params.targetPct,
      notional: params.notional,
      risk_usd: (params.notional * params.stopPct) / 100,
    },
  };
}

/** Macro state as flat tags, so entries can be grouped by regime later. */
export function regimeTags(regime: MacroRegime | null | undefined): string[] {
  if (!regime) return [];
  return [
    `risk:${regime.risk}`,
    `yields:${regime.yields}`,
    ...regime.leaders.slice(0, 2).map((l) => `leader:${l.symbol}`),
    ...regime.laggards.slice(0, 1).map((l) => `laggard:${l.symbol}`),
  ];
}

/**
 * Outcome in R — the only unit that compares trades with different stops.
 * A +15% gain on a 15% stop is 1R; the same gain on a 5% stop is 3R.
 */
export function rMultiple(pnlPct: number, stopPct: number): number | null {
  if (!Number.isFinite(pnlPct) || !Number.isFinite(stopPct) || stopPct <= 0) return null;
  return pnlPct / stopPct;
}

export function classifyOutcome(pnlPct: number): "win" | "loss" | "scratch" {
  if (pnlPct > 0.5) return "win";
  if (pnlPct < -0.5) return "loss";
  return "scratch";
}
