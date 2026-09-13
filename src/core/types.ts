/**
 * Core types shared between the harness orchestrator and strategies.
 *
 * These types are the stable contract — changes here affect all strategies.
 */

// Re-export provider types that strategies need
export type { Account, LLMProvider, MarketClock, Position } from "../providers/types";

// Re-export config types
export type { AgentConfig } from "../schemas/agent-config";

// ---------------------------------------------------------------------------
// Signal — produced by data gatherers, consumed by the research & trading loop
// ---------------------------------------------------------------------------

export interface Signal {
  symbol: string;
  source: string;
  source_detail: string;
  sentiment: number;
  raw_sentiment: number;
  volume: number;
  freshness: number;
  source_weight: number;
  reason: string;
  timestamp: number;
  // Optional enrichment fields (gatherers add what they need)
  upvotes?: number;
  comments?: number;
  quality_score?: number;
  subreddits?: string[];
  best_flair?: string | null;
  bullish?: number;
  bearish?: number;
  /** Share of sampled messages that carried an explicit sentiment tag. */
  tagged_ratio?: number;
  isCrypto?: boolean;
  momentum?: number;
  price?: number;
}

// ---------------------------------------------------------------------------
// Position tracking — entry metadata persisted across alarm cycles
// ---------------------------------------------------------------------------

export interface PendingExecution {
  symbol: string;
  side: "buy" | "sell";
  reason: string;
  submitted_at: number;
  client_order_id?: string;
  order_id?: string;
  status: string;
  expected_qty?: number;
  entry_basis?: number;
  protected_entry?: {
    stop: number;
    limit: number;
    expires_at: number;
    protective_order_id?: string;
    protective_order_ids?: string[];
    protective_client_id?: string;
    closing_reason?: string;
  };
}

export interface PositionEntry {
  symbol: string;
  entry_time: number;
  entry_price: number;
  entry_sentiment: number;
  entry_social_volume: number;
  entry_sources: string[];
  entry_reason: string;
  peak_price: number;
  peak_sentiment: number;
  /** Levels fixed at entry from that name's volatility; config values are the fallback. */
  stop_pct?: number;
  target_pct?: number;
  /** Daily ATR at entry, so an exit can ask whether the adverse move was ordinary. */
  atr_pct?: number;
  /** ET day of the last gap check, so it runs once per session rather than every alarm. */
  last_gap_check_day?: string;
}

// ---------------------------------------------------------------------------
// Social history — rolling time-series for staleness detection
// ---------------------------------------------------------------------------

export interface SocialHistoryEntry {
  timestamp: number;
  volume: number;
  sentiment: number;
}

export interface SocialSnapshotCacheEntry {
  volume: number;
  sentiment: number;
  sources: string[];
}

// ---------------------------------------------------------------------------
// Logging & cost tracking
// ---------------------------------------------------------------------------

export interface LogEntry {
  timestamp: string;
  agent: string;
  action: string;
  [key: string]: unknown;
}

export interface CostTracker {
  total_usd: number;
  calls: number;
  tokens_in: number;
  tokens_out: number;
}

// ---------------------------------------------------------------------------
// Research results — output of LLM analysis
// ---------------------------------------------------------------------------

/**
 * Tradability metrics derived from the Alpaca snapshot taken at research time.
 *
 * Every field is nullable on purpose: a missing bar or a zeroed quote means
 * "unknown", which the entry gates treat differently from a value that is
 * present and out of range.
 */
export interface MarketContext {
  price: number;
  prev_close: number | null;
  gap_pct: number | null;
  extension_pct: number | null;
  range_position: number | null;
  rel_volume: number | null;
  dollar_volume: number | null;
  spread_bps: number | null;
  /** Daily-bar technicals. Null when insufficient history was returned. */
  atr_pct: number | null;
  rsi_14: number | null;
  sma_20: number | null;
  sma_50: number | null;
  trend: "above both" | "above 20" | "below both" | null;
  /** Last price as a percentage of the 52-week high. */
  pct_of_52w_high: number | null;
}

export interface ResearchResult {
  symbol: string;
  verdict: "BUY" | "SKIP" | "WAIT";
  confidence: number;
  entry_quality: "excellent" | "good" | "fair" | "poor";
  reasoning: string;
  red_flags: string[];
  catalysts: string[];
  timestamp: number;
  /** Snapshot-derived liquidity/extension context captured with the research call. */
  market?: MarketContext | null;
}

export interface TwitterConfirmation {
  symbol: string;
  tweet_count: number;
  sentiment: number;
  confirms_existing: boolean;
  highlights: Array<{ author: string; text: string; likes: number }>;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Pre-market plan
// ---------------------------------------------------------------------------

export interface PremarketPlan {
  timestamp: number;
  recommendations: Array<{
    action: "BUY" | "SELL" | "HOLD";
    symbol: string;
    confidence: number;
    reasoning: string;
    suggested_size_pct?: number;
  }>;
  market_summary: string;
  high_conviction: string[];
  researched_buys: ResearchResult[];
}

// ---------------------------------------------------------------------------
// Agent state — persisted in DO storage
// ---------------------------------------------------------------------------

export interface AgentState {
  config: import("../schemas/agent-config").AgentConfig;
  signalCache: Signal[];
  positionEntries: Record<string, PositionEntry>;
  socialHistory: Record<string, SocialHistoryEntry[]>;
  socialSnapshotCache: Record<string, SocialSnapshotCacheEntry>;
  socialSnapshotCacheUpdatedAt: number;
  /** Symbol -> recent headlines, for the research prompt. */
  newsCache: Record<string, Array<{ headline: string; source: string; created_at: string }>>;
  newsCacheUpdatedAt: number;
  /** Symbol -> classified catalysts, accumulated across passes and pruned by age. */
  catalystCache: Record<string, Array<Record<string, unknown>>>;
  /** Macro-topic headlines, for context in the analyst prompt. */
  macroHeadlines: Array<{ headline: string; source: string; created_at: string }>;
  /** Measured index/rate/sector regime; shape defined in strategy/default/helpers/macro. */
  macroRegime: unknown;
  logs: LogEntry[];
  costTracker: CostTracker;
  llmDailyBudget?: { day: string; calls: number };
  /** Persisted before broker mutations; unresolved outcomes block duplicate orders. */
  pendingExecutions?: Record<string, PendingExecution>;
  lastDataGatherRun: number;
  lastAnalystRun: number;
  lastResearchRun: number;
  lastPositionResearchRun: number;
  signalResearch: Record<string, ResearchResult>;
  positionResearch: Record<string, unknown>;
  stalenessAnalysis: Record<string, unknown>;
  /** Symbol -> epoch ms of the most recent exit, for the re-entry cooldown. */
  recentExits: Record<string, number>;
  /**
   * P&L captured at the moment an exit is decided, held until the journal
   * records it. Persisted rather than in-memory: a Durable Object can be
   * evicted between the sell and the journal write, and an in-memory mark
   * would take the only record of the trade's outcome with it.
   */
  pendingExitMarks: Record<string, { price: number; pnl_usd: number; pnl_pct: number; reason: string }>;
  /** Aggregated journal record, injected into prompts as evidence. Shape in helpers/learnings. */
  learnings: unknown;
  /** Rolling Form 4 open-market purchases; clusters form across filings and days. */
  insiderTransactions: unknown[];
  /** Accession index URLs already fetched, so filings are not re-downloaded. */
  processedForm4: Record<string, number>;
  twitterConfirmations: Record<string, TwitterConfirmation>;
  twitterDailyReads: number;
  twitterDailyReadReset: number;
  lastKnownNextOpenMs: number | null;
  premarketPlan: PremarketPlan | null;
  lastPremarketPlanDayEt: string | null;
  lastClockIsOpen: boolean | null;
  enabled: boolean;
}
