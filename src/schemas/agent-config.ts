import { z } from "zod";

export const AgentConfigSchema = z
  .object({
    data_poll_interval_ms: z.number().min(5000).max(300000),
    analyst_interval_ms: z.number().min(30000).max(600000),

    premarket_plan_window_minutes: z.number().min(1).max(60),
    market_open_execute_window_minutes: z.number().min(0).max(10),

    max_position_value: z.number().positive().max(100000),
    max_positions: z.number().int().min(1).max(50),
    entry_max_signal_age_minutes: z.number().min(1).max(120).default(10),
    entry_max_research_age_minutes: z.number().min(1).max(120).default(15),
    entry_min_freshness: z.number().min(0).max(1).default(0.5),
    risk_per_trade_pct: z.number().positive().max(1).default(0.125),

    // Tradability gates measured from the Alpaca snapshot, not asserted by the model.
    entry_min_price: z.number().min(0).max(10000).default(3),
    entry_min_dollar_volume: z.number().min(0).default(5_000_000),
    entry_max_spread_bps: z.number().min(1).max(1000).default(50),
    entry_max_extension_pct: z.number().min(0).max(100).default(10),
    entry_min_rel_volume: z.number().min(0).max(50).default(0),
    /**
     * Minimum percentage of the 52-week high. Short-horizon returns reverse for
     * past winners, and the crossover to continuation depends on high turnover
     * together with a high price-to-52-week-high ratio (George & Hwang 2004).
     * Buying a heavy-volume pop in a name far below its high sits in the
     * reversal regime. 0 disables.
     */
    entry_min_pct_of_52w_high: z.number().min(0).max(100).default(0),
    /**
     * Minimum position in the session's range, 0 = at the low, 1 = at the high.
     * A strong catalyst that closes in the bottom of its range was sold into;
     * buying there is buying the fade. 0 disables.
     */
    entry_min_range_position: z.number().min(0).max(1).default(0),
    /**
     * Require a classified catalyst before entering. This is the strategy's
     * core claim: a trade needs a discrete event that changes what a company is
     * worth. Social sentiment and volume rank candidates; only a catalyst
     * qualifies one. Off by default so the behaviour is opt-in.
     */
    entry_require_catalyst: z.boolean().default(false),
    entry_min_catalyst_quality: z.enum(["low", "medium", "high"]).default("medium"),
    /** How long a catalyst stays valid. Post-event drift runs for days, not minutes. */
    entry_max_catalyst_age_minutes: z.number().min(5).max(20160).default(1440),
    /** Non-blocking concerns tolerated before an entry is skipped. 0 restores the reject-any behaviour. */
    entry_max_red_flags: z.number().int().min(0).max(10).default(2),
    /** Minutes to wait before re-entering a symbol we just exited. 0 disables. */
    reentry_cooldown_minutes: z.number().min(0).max(10080).default(120),
    /**
     * Scheduled macro releases, as "<ISO datetime> <label>" — for example
     * "2026-09-16T18:00:00Z FOMC decision". Entries are blocked inside the
     * blackout window before each; exits are never blocked.
     */
    macro_events: z.array(z.string()).default([]),
    macro_event_blackout_minutes: z.number().min(0).max(1440).default(60),
    min_sentiment_score: z.number().min(0).max(1),
    min_analyst_confidence: z.number().min(0).max(1),

    take_profit_pct: z.number().min(1).max(100),
    stop_loss_pct: z.number().min(1).max(50),
    /**
     * Stop distance as a multiple of daily ATR. A fixed percentage stop is a
     * different amount of risk on every name: measured live, ATR ranged from
     * 2.27% (T) to 30.70% (TNON) across one most-actives list, so a 5% stop was
     * 2.2x daily range on one and 0.16x on the other. 0 keeps the fixed stop.
     */
    stop_atr_multiple: z.number().min(0).max(10).default(0),
    /** Floor and ceiling on the derived stop, so an extreme ATR cannot produce an absurd one. */
    stop_min_pct: z.number().min(0.5).max(50).default(3),
    stop_max_pct: z.number().min(1).max(90).default(15),
    /** Profit target as a multiple of the stop distance; 2 keeps a 2:1 reward-to-risk. */
    target_r_multiple: z.number().min(0.5).max(10).default(2),
    position_size_pct_of_cash: z.number().min(1).max(100),
    /** Give back at most this much from the peak once the trail is armed. 0 disables. */
    trailing_stop_pct: z.number().min(0).max(50).default(0),
    /**
     * Peak gain required before the trail arms. 0 means "same as
     * trailing_stop_pct", which makes the trail a break-even protector and caps
     * average wins near the trail distance. Setting it above the trail distance
     * locks in a minimum gain while leaving room to reach the profit target.
     */
    trailing_arm_pct: z.number().min(0).max(100).default(0),
    /**
     * Trailing expressed in R — multiples of that position's own stop distance.
     * Preferred over the percentage form once stops are ATR-derived: a 6% arm
     * means a different thing on a name with a 5.7% stop than on one with a 15%
     * stop. Arming at 1.5R and trailing 1R exits no worse than +0.5R. Both must
     * be above 0 to take effect; otherwise the percentage fields are used.
     */
    trailing_arm_r: z.number().min(0).max(10).default(0),
    trailing_stop_r: z.number().min(0).max(10).default(0),
    /**
     * Take an overnight gain handed over by a gap, in R, at the first exit
     * check of the session. A gap is not a move the position earned intraday
     * and the trail cannot see it: extended-hours prices never reach
     * peak_price because exits only run while the market is open, and no exit
     * could be taken then anyway. Holding for the remainder of the target
     * risks giving the whole gap back at the open. 0 disables.
     */
    gap_capture_r: z.number().min(0).max(5).default(0),
    /** Deterministic time stop, independent of social-history availability. 0 disables. */
    max_hold_days: z.number().min(0).max(60).default(0),

    /**
     * Exit a held position when disqualifying news appears — dilution, an
     * offering, an investigation, a guidance cut. The thesis is dead rather
     * than slow, and that is the only evidence that justifies leaving before
     * the target. Discretionary early exits on sentiment destroy the R
     * multiple: taking +3% against a 7.5% stop is 0.40R, which raises the
     * break-even hit rate from 33% to 71%.
     */
    exit_on_adverse_news: z.boolean().default(true),
    /**
     * Who decides that a headline is adverse enough to close a position.
     * "off" trusts the pattern matcher alone. "shadow" asks the model and logs
     * the disagreement without acting. "enforce" lets a confident favourable or
     * neutral verdict withdraw the flag. Scoped to held symbols, so it can only
     * ever spare a position — never open one, never close one.
     */
    news_adjudication: z.enum(["off", "shadow", "enforce"]).default("enforce"),
    stale_position_enabled: z.boolean(),
    stale_min_hold_hours: z.number().min(0).max(168),
    stale_max_hold_days: z.number().min(1).max(30),
    stale_min_gain_pct: z.number().min(0).max(100),
    stale_mid_hold_days: z.number().min(1).max(30),
    stale_mid_min_gain_pct: z.number().min(0).max(100),
    stale_social_volume_decay: z.number().min(0).max(1),

    llm_provider: z.enum(["openai-raw", "ai-sdk", "cloudflare-gateway"]),
    llm_model: z.string().min(1),
    llm_analyst_model: z.string().min(1),
    llm_min_hold_minutes: z.number().min(0).max(1440),
    /**
     * Completion budgets. Reasoning models bill their thinking against max_tokens
     * and return it in a separate field, so a budget sized for the visible JSON
     * alone yields empty content. max_tokens is a cap, not a spend: a
     * non-reasoning model still emits only what it needs.
     */
    llm_research_max_tokens: z.number().int().min(128).max(32768).default(2048),
    llm_analyst_max_tokens: z.number().int().min(256).max(32768).default(4096),
    /** Per-position LLM risk commentary. No rule reads its output; off by default to save budget. */
    position_research_enabled: z.boolean().default(false),

    options_enabled: z.boolean(),
    options_min_confidence: z.number().min(0).max(1),
    options_max_pct_per_trade: z.number().min(0).max(0.25),
    options_min_dte: z.number().int().min(1).max(365),
    options_max_dte: z.number().int().min(1).max(365),
    options_target_delta: z.number().min(0.1).max(0.9),
    options_min_delta: z.number().min(0.1).max(0.9),
    options_max_delta: z.number().min(0.1).max(0.9),
    options_stop_loss_pct: z.number().min(1).max(100),
    options_take_profit_pct: z.number().min(1).max(500),

    crypto_enabled: z.boolean(),
    crypto_symbols: z.array(z.string()),
    crypto_momentum_threshold: z.number().min(0.1).max(20),
    crypto_max_position_value: z.number().positive().max(100000),
    crypto_take_profit_pct: z.number().min(1).max(100),
    crypto_stop_loss_pct: z.number().min(1).max(50),

    ticker_blacklist: z.array(z.string()),
    allowed_exchanges: z.array(z.string()),
  })
  .refine((data) => data.options_min_delta < data.options_max_delta, {
    message: "options_min_delta must be less than options_max_delta",
    path: ["options_min_delta"],
  })
  .refine((data) => data.options_min_dte < data.options_max_dte, {
    message: "options_min_dte must be less than options_max_dte",
    path: ["options_min_dte"],
  })
  .refine((data) => data.stale_mid_hold_days <= data.stale_max_hold_days, {
    message: "stale_mid_hold_days must be <= stale_max_hold_days",
    path: ["stale_mid_hold_days"],
  });

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export function validateAgentConfig(config: unknown): AgentConfig {
  return AgentConfigSchema.parse(config);
}

export function safeValidateAgentConfig(
  config: unknown
): { success: true; data: AgentConfig } | { success: false; error: z.ZodError } {
  const result = AgentConfigSchema.safeParse(config);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
