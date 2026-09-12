import type { AgentConfig, MarketContext, ResearchResult, Signal } from "../../../core/types";
import { bestCatalyst, type CatalystHit, meetsQuality } from "../helpers/catalyst";
import { activeBlackout, parseScheduledEvents } from "../helpers/event-calendar";

/**
 * Concerns that disqualify a social-momentum long outright.
 *
 * The research prompt asks the model to name concerns, and a competent model
 * always names some ("no fundamentals supplied", "sentiment-driven"). Treating
 * every string as disqualifying blocks every entry, so severity is classified
 * here — deterministically, rather than trusting the model to self-rate.
 */
const BLOCKING_RED_FLAG_PATTERNS: RegExp[] = [
  // Supply/structure events that cap upside regardless of sentiment.
  /\bdilut/i,
  /\b(secondary|shelf|atm)\s+offering\b/i,
  /\breverse\s+split\b/i,
  // Solvency and listing status.
  /\bgoing\s+concern\b/i,
  /\bbankrupt/i,
  /\bchapter\s*11\b/i,
  /\bdelist/i,
  // Integrity and regulatory action.
  /\bfraud\b/i,
  /\b(sec|doj|ftc)\s+(investigation|probe|inquiry|charges)\b/i,
  /\bclass\s+action\b/i,
  /\bshort\s+(seller\s+)?report\b/i,
  /\b(trading\s+)?halt(ed)?\b/i,
  /\bmanipulat/i,
  /\bpump\s*(and|&)\s*dump\b/i,
  // Binary event inside a multi-day hold with a percentage stop.
  /\b(earnings|report)\s+(tomorrow|today|tonight|this\s+week|next\s+(day|week))\b/i,
  /\b(upcoming|ahead\s+of|before|pending|imminent)\s+earnings\b/i,
  /\bearnings\s+(call|release|announcement)\s+(is\s+)?(due|scheduled|imminent)\b/i,
];

/** Red flags that disqualify the entry on their own. */
export function blockingRedFlags(redFlags: string[]): string[] {
  return redFlags.filter((flag) => BLOCKING_RED_FLAG_PATTERNS.some((pattern) => pattern.test(flag)));
}

/**
 * Liquidity and extension checks against data we measured ourselves.
 *
 * A null field is unknown, not bad: Alpaca omits bars for thin names and zeroes
 * quotes outside regular hours. Unknown liquidity is rejected because these are
 * the constraints that decide whether the exit can actually be filled; unknown
 * extension is allowed through to the model.
 */
export function marketQualityRejection(market: MarketContext | null | undefined, config: AgentConfig): string | null {
  if (!market) return "No market snapshot for entry";

  if (!Number.isFinite(market.price) || market.price <= 0) return "Entry price is invalid";
  const numericFields = [
    "prev_close",
    "gap_pct",
    "extension_pct",
    "range_position",
    "rel_volume",
    "dollar_volume",
    "spread_bps",
    "atr_pct",
    "rsi_14",
    "sma_20",
    "sma_50",
    "pct_of_52w_high",
  ] as const;
  for (const field of numericFields) {
    if (market[field] !== null && !Number.isFinite(market[field])) return `Invalid market metric: ${field}`;
  }
  for (const field of ["prev_close", "atr_pct", "sma_20", "sma_50", "pct_of_52w_high"] as const) {
    if (market[field] !== null && market[field] <= 0) return `Invalid market metric: ${field}`;
  }
  for (const field of ["dollar_volume", "spread_bps", "rel_volume"] as const) {
    if (market[field] !== null && market[field] < 0) return `Invalid market metric: ${field}`;
  }
  if (market.range_position !== null && (market.range_position < 0 || market.range_position > 1)) {
    return "Invalid market metric: range_position";
  }
  if (market.rsi_14 !== null && (market.rsi_14 < 0 || market.rsi_14 > 100)) return "Invalid market metric: rsi_14";
  if (config.stop_atr_multiple > 0 && market.atr_pct === null) return "Required daily ATR history unknown";
  if (config.entry_min_pct_of_52w_high > 0 && market.pct_of_52w_high === null) {
    return "Required 52-week high history unknown";
  }
  if (config.entry_min_rel_volume > 0 && market.rel_volume === null) return "Required relative volume unknown";
  if (config.entry_min_range_position > 0 && market.range_position === null) return "Required range position unknown";

  if (market.price < config.entry_min_price) {
    return `Price $${market.price.toFixed(2)} below minimum $${config.entry_min_price}`;
  }

  if (market.dollar_volume === null) return "Previous-session dollar volume unknown";
  if (market.dollar_volume < config.entry_min_dollar_volume) {
    return `Dollar volume $${(market.dollar_volume / 1_000_000).toFixed(1)}M below minimum $${(config.entry_min_dollar_volume / 1_000_000).toFixed(1)}M`;
  }

  if (market.spread_bps === null) return "Quoted spread unknown";
  if (market.spread_bps > config.entry_max_spread_bps) {
    return `Spread ${market.spread_bps.toFixed(0)} bps exceeds ${config.entry_max_spread_bps} bps`;
  }

  // Chasing a name that has already run is where a fixed percentage stop gets hit by noise.
  if (market.extension_pct !== null && market.extension_pct > config.entry_max_extension_pct) {
    return `Already ${market.extension_pct.toFixed(1)}% above previous close (limit ${config.entry_max_extension_pct}%)`;
  }

  // Sentiment without participation is a chat room, not a move.
  if (
    config.entry_min_rel_volume > 0 &&
    market.rel_volume !== null &&
    market.rel_volume < config.entry_min_rel_volume
  ) {
    return `Relative volume ${market.rel_volume.toFixed(1)}x below minimum ${config.entry_min_rel_volume}x`;
  }

  // A heavy-volume pop in a name far below its 52-week high is the regime where
  // short-horizon returns reverse rather than continue: the crossover from
  // reversal to continuation needs high turnover AND a high price-to-52-week-high
  // ratio, not turnover alone. When enabled, missing history blocks the entry.
  if (
    config.entry_min_pct_of_52w_high > 0 &&
    market.pct_of_52w_high !== null &&
    market.pct_of_52w_high < config.entry_min_pct_of_52w_high
  ) {
    return `At ${market.pct_of_52w_high.toFixed(0)}% of the 52-week high, below the ${config.entry_min_pct_of_52w_high}% minimum`;
  }

  // Closing in the lower part of the day's range means the move was sold into.
  if (
    config.entry_min_range_position > 0 &&
    market.range_position !== null &&
    market.range_position < config.entry_min_range_position
  ) {
    return `At ${(market.range_position * 100).toFixed(0)}% of the day's range, below the ${(config.entry_min_range_position * 100).toFixed(0)}% minimum`;
  }

  return null;
}

export function entryRejection(
  symbol: string,
  signals: Signal[],
  research: ResearchResult | undefined,
  config: AgentConfig,
  now = Date.now(),
  recentExits: Record<string, number> = {},
  catalysts: Record<string, Array<CatalystHit & { at: number }>> = {}
): string | null {
  if (config.ticker_blacklist.some((s) => s.toUpperCase() === symbol.toUpperCase())) return "Blacklisted symbol";

  // Do not re-buy a name we just exited: the research that triggered the first
  // entry is still inside its freshness window when the stop fills.
  const lastExit = recentExits[symbol.toUpperCase()] ?? recentExits[symbol] ?? Number.NaN;
  if (config.reentry_cooldown_minutes > 0 && Number.isFinite(lastExit) && lastExit <= now) {
    const minutesSince = (now - lastExit) / 60_000;
    if (minutesSince < config.reentry_cooldown_minutes) {
      return `Re-entry cooldown: exited ${minutesSince.toFixed(0)}m ago (${config.reentry_cooldown_minutes}m required)`;
    }
  }

  // Do not open new risk immediately before a scheduled release that can gap
  // straight through a percentage stop. Exits do not pass through this gate.
  const blackout = activeBlackout(parseScheduledEvents(config.macro_events), config.macro_event_blackout_minutes, now);
  if (blackout) {
    const minutes = Math.max(0, Math.round((blackout.at - now) / 60_000));
    return `Macro event blackout: ${blackout.label} in ${minutes}m`;
  }

  const fresh = (timestamp: number, minutes: number) =>
    Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= minutes * 60_000;
  const supporting = signals.filter(
    (s) =>
      s.symbol === symbol &&
      fresh(s.timestamp, config.entry_max_signal_age_minutes) &&
      Number.isFinite(s.raw_sentiment) &&
      s.raw_sentiment >= config.min_sentiment_score &&
      s.raw_sentiment <= 1 &&
      Number.isFinite(s.freshness) &&
      s.freshness >= config.entry_min_freshness &&
      s.freshness <= 1 &&
      Number.isFinite(s.volume) &&
      s.volume > 0 &&
      s.source?.trim()
  );
  if (!supporting.length) return "No fresh supporting signal";
  if (!research || research.symbol !== symbol || !fresh(research.timestamp, config.entry_max_research_age_minutes)) {
    return "Missing or expired research";
  }
  if (
    research.verdict !== "BUY" ||
    !Number.isFinite(research.confidence) ||
    research.confidence < config.min_analyst_confidence ||
    research.confidence > 1
  )
    return "Research does not qualify for BUY";
  if (!["good", "excellent"].includes(research.entry_quality)) return "Entry quality is not good or excellent";
  if (!Array.isArray(research.red_flags) || research.red_flags.some((flag) => typeof flag !== "string")) {
    return "Research red flags are malformed";
  }
  const namedFlags = research.red_flags.filter((flag) => flag.trim());
  const blocking = blockingRedFlags(namedFlags);
  if (blocking.length) return `Disqualifying red flag: ${blocking[0]}`;
  if (namedFlags.length > config.entry_max_red_flags) {
    return `${namedFlags.length} red flags exceed limit of ${config.entry_max_red_flags}`;
  }
  if (typeof research.reasoning !== "string" || !research.reasoning.trim()) return "Missing research rationale";

  // The core claim: a trade needs a discrete event that changes what the
  // company is worth. Sentiment and volume rank candidates; only a catalyst
  // qualifies one.
  if (config.entry_require_catalyst) {
    const fresh = (catalysts[symbol.toUpperCase()] ?? catalysts[symbol] ?? []).filter(
      (c) => Number.isFinite(c.at) && c.at <= now && now - c.at <= config.entry_max_catalyst_age_minutes * 60_000
    );
    const best = bestCatalyst(fresh);
    if (!best) return "No qualifying catalyst";
    if (!meetsQuality(best.quality, config.entry_min_catalyst_quality)) {
      return `Catalyst quality ${best.quality} (${best.type}) below required ${config.entry_min_catalyst_quality}`;
    }
  }

  return marketQualityRejection(research.market, config);
}

export interface SizedTrade {
  /** Stop distance below entry, in percent. */
  stop_pct: number;
  /** Profit target above entry, in percent. */
  target_pct: number;
  /** Dollar size that puts the configured risk at that stop. */
  notional: number;
}

/**
 * Volatility-normalised trade sizing.
 *
 * A fixed percentage stop risks a different amount on every name: at 2.5x ATR,
 * a 5% stop is 2.2 daily ranges on a utility and 0.16 on a 30%-ATR small cap,
 * so one is never hit and the other is hit by ordinary noise. Deriving the stop
 * from ATR and then solving size from the stop keeps the dollar risk constant
 * and shrinks exposure in volatile names, which is where drawdown comes from.
 *
 * Falls back to the fixed percentages when ATR is unavailable or the feature is
 * off, so a missing indicator can never size a position larger than before.
 */
export function volatilitySizedTrade(equity: number, config: AgentConfig, atrPct?: number | null): SizedTrade {
  const fallback = {
    stop_pct: config.stop_loss_pct,
    target_pct: config.take_profit_pct,
    notional: 0,
  };
  if (!Number.isFinite(equity) || equity <= 0) return { ...fallback, notional: 0 };

  const riskDollars = (equity * config.risk_per_trade_pct) / 100;

  let stopPct = config.stop_loss_pct;
  let targetPct = config.take_profit_pct;
  if (config.stop_atr_multiple > 0 && typeof atrPct === "number" && Number.isFinite(atrPct) && atrPct > 0) {
    stopPct = Math.min(config.stop_max_pct, Math.max(config.stop_min_pct, config.stop_atr_multiple * atrPct));
    targetPct = stopPct * config.target_r_multiple;
  }

  return {
    stop_pct: stopPct,
    target_pct: targetPct,
    notional: Math.min(config.max_position_value, riskDollars / (stopPct / 100)),
  };
}

/** Planned loss at the configured stop, not a guaranteed maximum fill loss. */
export function riskSizedNotional(equity: number, config: AgentConfig, atrPct?: number | null): number {
  if (!Number.isFinite(equity) || equity <= 0) return 0;
  return volatilitySizedTrade(equity, config, atrPct).notional;
}
