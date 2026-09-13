/**
 * MahoragaHarness — Thin Orchestrator
 *
 * This Durable Object is the core scheduler: it targets a 30s heartbeat,
 * delegates data gathering, research, and trading decisions to the active
 * strategy (src/strategy/index.ts), and enforces policy/safety via PolicyBroker.
 *
 * Users customize their strategy in src/strategy/my-strategy/ and change ONE
 * import line in src/strategy/index.ts. This file does NOT need to be modified.
 */

import { DurableObject } from "cloudflare:workers";
import { freshEntryMarket } from "../core/execution-market";
import { gatherWithinDeadline } from "../core/gather-boundary";
import { createPolicyBroker } from "../core/policy-broker";
import { reserveRequest } from "../core/request-budget";
import {
  closedMarketDelayMs,
  HEARTBEAT_INTERVAL_MS,
  heartbeatDelayMs,
  leastRecentlyResearched,
  nextDueStage,
} from "../core/scheduling";
import type {
  AgentState,
  LogEntry,
  MarketContext,
  PositionEntry,
  ResearchResult,
  Signal,
  SocialHistoryEntry,
  SocialSnapshotCacheEntry,
} from "../core/types";
import type { Env } from "../env.d";
import { getDefaultPolicyConfig } from "../policy/config";
import { createAlpacaProviders } from "../providers/alpaca";
import { createLLMProvider } from "../providers/llm/factory";
import type {
  Account,
  Bar,
  CompletionParams,
  CompletionResult,
  LLMProvider,
  MarketClock,
  Position,
} from "../providers/types";
import type { AgentConfig } from "../schemas/agent-config";
import { safeValidateAgentConfig } from "../schemas/agent-config";
import { IngestedCatalystsSchema } from "../schemas/catalyst-ingest";
import {
  AnalystResponseSchema,
  PositionResearchResponseSchema,
  parseAnalystRecommendations,
  parseJsonObject,
  SignalResearchResponseSchema,
} from "../schemas/llm-responses";
import { createD1Client } from "../storage/d1/client";
import { handleResearch } from "../research/api";
import {
  closeJournalEntry,
  createJournalEntry,
  deleteOpenJournalEntry,
  recentJournalEntries,
} from "../storage/d1/queries/memory";
import { activeStrategy } from "../strategy";
import { DEFAULT_STATE } from "../strategy/default/config";
import {
  checkTwitterBreakingNews,
  gatherTwitterConfirmation,
  isTwitterEnabled,
} from "../strategy/default/gatherers/twitter";
import { type AdverseEvidence, adjudicateAdverse, adjudicationKey } from "../strategy/default/helpers/adjudicate";
import { adverseCatalystReason, bestCatalyst } from "../strategy/default/helpers/catalyst";
import { isCryptoSymbol, normalizeCryptoSymbol } from "../strategy/default/helpers/crypto";
import { summariseJournal } from "../strategy/default/helpers/learnings";
import { deriveMarketContext, withTechnicals } from "../strategy/default/helpers/market";
import { attributeExit, type ExitEvidence } from "../strategy/default/helpers/postmortem";
import { buildThesis, classifyOutcome, regimeTags, rMultiple } from "../strategy/default/helpers/thesis";
import { tickerCache } from "../strategy/default/helpers/ticker";
import { runCryptoTrading } from "../strategy/default/rules/crypto-trading";
import { entryRejection, volatilitySizedTrade } from "../strategy/default/rules/entry-quality";
import { findBestOptionsContract } from "../strategy/default/rules/options";
import type { StrategyContext } from "../strategy/types";

// ============================================================================
// DURABLE OBJECT CLASS
// ============================================================================

export class MahoragaHarness extends DurableObject<Env> {
  private state: AgentState = { ...DEFAULT_STATE };
  private _llm: LLMProvider | null = null;
  private _etDayFormatter: Intl.DateTimeFormat | null = null;
  private discordCooldowns: Map<string, number> = new Map();
  private readonly DISCORD_COOLDOWN_MS = 30 * 60 * 1000;
  private optionalStageLastRun = { premarket: 0, crypto: 0, twitter: 0 };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this._llm = createLLMProvider(env);
    if (this._llm) {
      console.log(`[MahoragaHarness] LLM Provider initialized: ${env.LLM_PROVIDER || "openai-raw"}`);
    } else {
      console.log("[MahoragaHarness] WARNING: No valid LLM provider configured - research disabled");
    }

    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<AgentState>("state");
      if (stored) {
        this.state = { ...DEFAULT_STATE, ...stored };
        this.state.config = { ...DEFAULT_STATE.config, ...this.state.config };
      }
      this.initializeLLM();

      if (this.state.enabled) {
        const existingAlarm = await this.ctx.storage.getAlarm();
        const now = Date.now();
        if (!existingAlarm || existingAlarm < now) {
          await this.ctx.storage.setAlarm(now + 5_000);
        }
      }
    });
  }

  private initializeLLM() {
    const provider = this.state.config.llm_provider || this.env.LLM_PROVIDER || "openai-raw";
    const model = this.state.config.llm_model || this.env.LLM_MODEL || "gpt-4o-mini";

    const effectiveEnv: Env = {
      ...this.env,
      LLM_PROVIDER: provider as Env["LLM_PROVIDER"],
      LLM_MODEL: model,
    };

    this._llm = createLLMProvider(effectiveEnv);
    if (this._llm) {
      console.log(`[MahoragaHarness] LLM Provider initialized: ${provider} (${model})`);
    } else {
      console.log("[MahoragaHarness] WARNING: No valid LLM provider configured");
    }
  }

  private async completeWithBudget(params: CompletionParams): Promise<CompletionResult> {
    if (!this._llm) throw new Error("LLM provider is not configured");
    const limit = Number(this.env.MAX_LLM_REQUESTS_PER_DAY ?? "300");
    this.state.llmDailyBudget = reserveRequest(this.state.llmDailyBudget, this.getEtDayString(Date.now()), limit);
    await this.persist();
    return this._llm.complete(params);
  }

  private getEtDayString(epochMs: number): string {
    if (!this._etDayFormatter) {
      try {
        this._etDayFormatter = new Intl.DateTimeFormat("en-US", {
          timeZone: "America/New_York",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        });
      } catch {
        this._etDayFormatter = null;
      }
    }

    if (!this._etDayFormatter) {
      return new Date(epochMs).toISOString().slice(0, 10);
    }

    try {
      const parts = this._etDayFormatter.formatToParts(new Date(epochMs));
      const year = parts.find((p) => p.type === "year")?.value;
      const month = parts.find((p) => p.type === "month")?.value;
      const day = parts.find((p) => p.type === "day")?.value;
      if (year && month && day) return `${year}-${month}-${day}`;
    } catch {
      // fall through
    }
    return new Date(epochMs).toISOString().slice(0, 10);
  }

  get llm(): LLMProvider | null {
    return this._llm;
  }

  // ============================================================================
  // STRATEGY CONTEXT BUILDER
  // ============================================================================

  private buildStrategyContext(): StrategyContext {
    const self = this;
    const db = createD1Client(this.env.DB);
    const alpaca = createAlpacaProviders(this.env);
    const policyConfig = getDefaultPolicyConfig(this.env);
    policyConfig.max_open_positions = Math.min(policyConfig.max_open_positions, this.state.config.max_positions);

    const broker = createPolicyBroker({
      alpaca,
      policyConfig,
      db,
      log: (agent, action, details) => self.log(agent, action, details),
      cryptoSymbols: self.state.config.crypto_symbols || [],
      allowedExchanges: self.state.config.allowed_exchanges ?? ["NYSE", "NASDAQ", "ARCA", "AMEX", "BATS"],
      canSubmit: () => self.state.enabled,
      pendingExecutions: (self.state.pendingExecutions ??= {}),
      persist: () => self.persist(),
      validateBuy: (symbol) => activeStrategy.validateEntry?.(context, symbol) ?? null,
      validateExecution: async (symbol) => {
        const snapshot = await alpaca.marketData.getSnapshot(symbol, { feed: "iex" });
        if (snapshot.symbol !== symbol) return "Execution snapshot symbol mismatch";
        const check = freshEntryMarket(snapshot, self.state.signalResearch[symbol]?.market, self.state.config);
        if (check.rejection) return check.rejection;
        // Refresh session status after the quote read; a cached open clock must
        // not permit an order to queue overnight after the closing bell.
        const clock = await alpaca.trading.getClock();
        const now = Date.now();
        const quoteTime = Date.parse(snapshot.latest_quote.timestamp);
        if (
          !clock.is_open ||
          !Number.isFinite(Date.parse(clock.next_close)) ||
          Date.parse(clock.next_close) - now < 30_000 ||
          now - quoteTime > 30_000
        ) {
          return "Market closed, near close, or execution quote expired";
        }
        return null;
      },
      maxBuyNotional: (account, symbol) => self.sizedTradeFor(symbol, account.equity).notional,
      onBuyIntent: (symbol, _notional, reason, account) => {
        const signal = self.state.signalCache.find((s) => s.symbol === symbol);
        const social = self.state.socialSnapshotCache[symbol];
        const sentiment = social?.sentiment ?? signal?.sentiment ?? 0;
        self.state.positionEntries[symbol] = {
          symbol,
          entry_time: Date.now(),
          entry_price: 0,
          entry_sentiment: sentiment,
          entry_social_volume: social?.volume ?? signal?.volume ?? 0,
          entry_sources: social?.sources ?? [signal?.source ?? "research"],
          entry_reason: reason,
          peak_price: 0,
          peak_sentiment: sentiment,
          ...self.sizedTradeFor(symbol, account.equity),
          atr_pct: self.state.signalResearch?.[symbol]?.market?.atr_pct ?? undefined,
        };
        void self.journalEntry(symbol, account.equity);
      },
      onBuyAbandoned: (symbol) => {
        delete self.state.positionEntries[symbol];
        // The thesis was written at intent, because it cannot be reconstructed
        // later. An abandoned order never became a trade, so that row would
        // enter a fabricated scratch into every R statistic.
        void self.discardJournalEntry(symbol);
      },
      onSell: (symbol) => {
        // Snapshot before deleting: journalExit reads stop_pct off this object
        // to compute the R multiple, and deleting first silently fell back to
        // the config default. Every R in the record would have been measured
        // against a stop the trade never used.
        const closing = self.state.positionEntries[symbol];
        delete self.state.positionEntries[symbol];
        delete self.state.socialHistory[symbol];
        delete self.state.stalenessAnalysis[symbol];
        // The research that justified the entry is still inside its freshness
        // window when a stop fills, so record the exit and let the entry gate
        // enforce a cooldown instead of re-buying the same name minutes later.
        self.recordExit(symbol);
        void self.journalExit(symbol, closing);
      },
    });

    const context: StrategyContext = {
      env: this.env,
      config: this.state.config,
      llm: this._llm ? { complete: (params) => this.completeWithBudget(params) } : null,
      log: (agent, action, details) => self.log(agent, action, details),
      trackLLMCost: (model, tokensIn, tokensOut) => self.trackLLMCost(model, tokensIn, tokensOut),
      sleep: (ms) => self.sleep(ms),
      broker,
      state: {
        get<T>(key: string): T | undefined {
          return (self.state as unknown as Record<string, unknown>)[key] as T | undefined;
        },
        set<T>(key: string, value: T): void {
          (self.state as unknown as Record<string, unknown>)[key] = value;
        },
      },
      get signals() {
        return self.state.signalCache;
      },
      positionEntries: this.state.positionEntries,
    };
    return context;
  }

  // ============================================================================
  // ALARM HANDLER — Main 30-second heartbeat
  // ============================================================================

  async alarm(): Promise<void> {
    if (!this.state.enabled) {
      this.log("System", "alarm_skipped", { reason: "Agent not enabled" });
      return;
    }

    const now = Date.now();
    // Distribute the former five-name batch across separate alarms.
    const RESEARCH_INTERVAL_MS = Math.max(30_000, Math.max(120_000, this.state.config.analyst_interval_ms) / 5);
    const POSITION_RESEARCH_INTERVAL_MS = 300_000;
    const premarketPlanWindowMinutes = Math.max(1, this.state.config.premarket_plan_window_minutes ?? 5);
    const marketOpenExecuteWindowMinutes = Math.max(0, this.state.config.market_open_execute_window_minutes ?? 2);

    const ctx = this.buildStrategyContext();

    try {
      // Settle broker intents even when expensive equity work is asleep.
      await ctx.broker.reconcile?.();
      if (!this.state.enabled) return;
      const clock = await ctx.broker.getClock();
      const clockNowMs = Number.isFinite(new Date(clock.timestamp).getTime())
        ? new Date(clock.timestamp).getTime()
        : now;
      const etDay = this.getEtDayString(clockNowMs);
      const nextOpenMs = new Date(clock.next_open).getTime();
      const nextOpenValid = Number.isFinite(nextOpenMs);

      if (!clock.is_open && nextOpenValid) {
        this.state.lastKnownNextOpenMs = nextOpenMs;
      }

      const idleDelay = closedMarketDelayMs(
        clock,
        this.state.config.crypto_enabled,
        premarketPlanWindowMinutes,
        clockNowMs
      );
      if (idleDelay !== null) {
        this.state.lastClockIsOpen = false;
        await this.persist();
        await this.scheduleNextAlarm(idleDelay);
        return;
      }

      // Always use fresh broker state before optional work. Account and holdings
      // share one bounded read window instead of two serial requests.
      const [positions, account] = await Promise.all([ctx.broker.getPositions(), ctx.broker.getAccount()]);
      if (!this.state.enabled) return;
      if (clock.is_open) {
        const exits = activeStrategy.selectExits(
          ctx,
          positions.filter(
            (p) => p.asset_class === "us_equity" || (p.asset_class === "us_option" && this.state.config.options_enabled)
          ),
          account
        );
        exits.sort(
          (a, b) =>
            Number(a.reason.startsWith("Adverse issuer news")) - Number(b.reason.startsWith("Adverse issuer news"))
        );
        for (const exit of exits) {
          if (!this.state.enabled) break;
          // A pattern matcher must not be the last word before a position is
          // closed. This runs here rather than in the news gatherer because
          // gatherers are given `llm: null` by design — the adjudicator placed
          // there could never have fired, and silently fell through to the regex.
          if (exit.reason.startsWith("Adverse issuer news") && (await this.adverseExitOverturned(ctx, exit.symbol))) {
            continue;
          }
          // Capture the marks before submitting: once the fill is confirmed the
          // position no longer exists and its P&L cannot be recovered.
          const held = positions.find((p) => p.symbol === exit.symbol);
          const basis = held ? held.market_value - held.unrealized_pl : 0;
          if (held && basis > 0) {
            this.state.pendingExitMarks[exit.symbol] = {
              price: held.current_price,
              pnl_usd: held.unrealized_pl,
              pnl_pct: (held.unrealized_pl / basis) * 100,
              reason: exit.reason,
            };
          }
          await ctx.broker.sell(exit.symbol, exit.reason);
        }
      }

      if (
        this.state.premarketPlan &&
        this.state.lastPremarketPlanDayEt &&
        this.state.lastPremarketPlanDayEt !== etDay
      ) {
        this.log("System", "clearing_stale_premarket_plan", {
          stale_day: this.state.lastPremarketPlanDayEt,
          current_day: etDay,
        });
        this.state.premarketPlan = null;
        this.state.lastPremarketPlanDayEt = null;
      }

      const minutesToOpen = nextOpenValid ? (nextOpenMs - clockNowMs) / 60_000 : Number.POSITIVE_INFINITY;
      const shouldPlan =
        !clock.is_open &&
        !this.state.premarketPlan &&
        minutesToOpen > 0 &&
        minutesToOpen <= premarketPlanWindowMinutes &&
        this.state.lastPremarketPlanDayEt !== etDay;
      const lastKnownOpenMs = this.state.lastKnownNextOpenMs;
      const hasOpenMs = typeof lastKnownOpenMs === "number" && Number.isFinite(lastKnownOpenMs);
      const withinOpenWindow =
        hasOpenMs &&
        clockNowMs >= lastKnownOpenMs &&
        clockNowMs - lastKnownOpenMs <= marketOpenExecuteWindowMinutes * 60_000;
      const marketJustOpened = this.state.lastClockIsOpen === false && clock.is_open;
      const shouldExecutePlan =
        clock.is_open &&
        !!this.state.premarketPlan &&
        (withinOpenWindow || marketJustOpened || (!hasOpenMs && this.state.lastClockIsOpen == null));

      // Exactly one optional stage per alarm. An order-capable stage is always
      // awaited: racing it would allow financial mutations after timeout.
      const stage = shouldExecutePlan
        ? "execute-plan"
        : nextDueStage(
            [
              {
                name: "gather",
                lastRun: this.state.lastDataGatherRun,
                intervalMs: this.state.config.data_poll_interval_ms,
                eligible: true,
              },
              {
                name: "research",
                lastRun: this.state.lastResearchRun,
                intervalMs: RESEARCH_INTERVAL_MS,
                eligible: this.state.signalCache.length > 0 && !!this._llm,
              },
              {
                name: "analyst",
                lastRun: this.state.lastAnalystRun,
                intervalMs: this.state.config.analyst_interval_ms,
                eligible: clock.is_open,
              },
              {
                name: "premarket",
                lastRun: this.optionalStageLastRun.premarket,
                intervalMs: 60_000,
                eligible: shouldPlan && this.state.signalCache.length > 0 && !!this._llm,
              },
              {
                name: "position-research",
                lastRun: this.state.lastPositionResearchRun,
                intervalMs: POSITION_RESEARCH_INTERVAL_MS / Math.max(1, positions.length),
                eligible: clock.is_open && this.state.config.position_research_enabled && positions.length > 0,
              },
              {
                name: "crypto",
                lastRun: this.optionalStageLastRun.crypto,
                intervalMs: HEARTBEAT_INTERVAL_MS,
                eligible: this.state.config.crypto_enabled,
              },
              {
                name: "twitter",
                lastRun: this.optionalStageLastRun.twitter,
                intervalMs: 120_000,
                eligible: clock.is_open && isTwitterEnabled(ctx),
              },
            ],
            now
          );

      // If broker protection already consumed a heartbeat, return promptly to
      // protection instead of appending more work to an overdue cycle.
      if (this.state.enabled && Date.now() - now < HEARTBEAT_INTERVAL_MS && stage) {
        this.log("System", "scheduled_stage", { stage });
        switch (stage) {
          case "gather":
            this.state.lastDataGatherRun = now;
            await this.runDataGatherers(ctx);
            break;
          case "research":
            this.state.lastResearchRun = now;
            await this.researchTopSignals(ctx, 5);
            break;
          case "analyst":
            this.state.lastAnalystRun = now;
            await this.runAnalyst(ctx);
            break;
          case "premarket":
            this.optionalStageLastRun.premarket = now;
            await this.runPreMarketAnalysis(ctx);
            if (this.state.premarketPlan) this.state.lastPremarketPlanDayEt = etDay;
            break;
          case "execute-plan":
            await this.executePremarketPlan(ctx);
            break;
          case "position-research": {
            this.state.lastPositionResearchRun = now;
            const leastRecent = positions
              .filter((p) => p.asset_class !== "us_option")
              .sort(
                (a, b) =>
                  ((this.state.positionResearch[a.symbol] as { timestamp?: number } | undefined)?.timestamp ?? 0) -
                  ((this.state.positionResearch[b.symbol] as { timestamp?: number } | undefined)?.timestamp ?? 0)
              )[0];
            if (leastRecent) await this.callPositionResearch(ctx, leastRecent);
            break;
          }
          case "crypto":
            this.optionalStageLastRun.crypto = now;
            await runCryptoTrading(ctx, positions);
            break;
          case "twitter": {
            this.optionalStageLastRun.twitter = now;
            const news = await checkTwitterBreakingNews(
              ctx,
              positions.map((p) => p.symbol)
            );
            for (const item of news)
              if (item.is_breaking) {
                this.log("System", "twitter_breaking_news", {
                  symbol: item.symbol,
                  headline: item.headline.slice(0, 100),
                });
              }
            break;
          }
        }
      }

      this.state.lastClockIsOpen = clock.is_open;
      await this.persist();
    } catch (error) {
      this.log("System", "alarm_error", { error: String(error) });
    }

    await this.scheduleNextAlarm(heartbeatDelayMs(now, Date.now()));
  }

  private async scheduleNextAlarm(delayMs = 30_000): Promise<void> {
    if (!this.state.enabled) return;
    const nextRun = Date.now() + delayMs;
    await this.ctx.storage.setAlarm(nextRun);
  }

  // ============================================================================
  // DATA GATHERING — delegates to strategy gatherers
  // ============================================================================

  private async runDataGatherers(ctx: StrategyContext): Promise<void> {
    this.log("System", "gathering_data", {});

    // The SEC ticker refresh is independent and must not serially delay feeds.
    const [, results] = await Promise.all([
      tickerCache.refreshSecTickersIfNeeded(),
      Promise.allSettled(activeStrategy.gatherers.map((g) => gatherWithinDeadline(g, ctx, () => this.state.enabled))),
    ]);
    if (!this.state.enabled) return;

    const allSignals: Signal[] = [];
    const counts: Record<string, number> = {};
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const name = activeStrategy.gatherers[i]?.name ?? `gatherer_${i}`;
      if (result?.status === "fulfilled") {
        allSignals.push(...result.value);
        counts[name] = result.value.length;
      } else if (result) {
        counts[name] = 0;
        this.log("System", "gatherer_failed", { source: name, error: String(result.reason) });
      }
    }

    const MAX_SIGNALS = 200;
    const MAX_AGE_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();

    const eligibleSignals = allSignals.filter((s) => now - s.timestamp < MAX_AGE_MS);

    const socialSnapshot = this.buildSocialSnapshot(eligibleSignals);
    this.updateSocialHistoryFromSnapshot(socialSnapshot, now);
    this.state.socialSnapshotCache = {};
    for (const [symbol, s] of socialSnapshot) {
      this.state.socialSnapshotCache[symbol] = {
        volume: s.volume,
        sentiment: s.sentiment,
        sources: Array.from(s.sources),
      };
    }
    this.state.socialSnapshotCacheUpdatedAt = now;

    const freshSignals = eligibleSignals
      .slice()
      .sort((a, b) => Math.abs(b.sentiment) - Math.abs(a.sentiment))
      .slice(0, MAX_SIGNALS);

    this.state.signalCache = freshSignals;
    this.state.lastDataGatherRun = now;

    this.log("System", "data_gathered", { ...counts, total: this.state.signalCache.length });
  }

  private buildSocialSnapshot(
    signals: Signal[]
  ): Map<string, { volume: number; sentiment: number; sources: Set<string> }> {
    const aggregated = new Map<string, { volume: number; sentimentNumerator: number; sources: Set<string> }>();

    for (const sig of signals) {
      if (!sig.symbol) continue;
      const volume = Number.isFinite(sig.volume) && sig.volume > 0 ? sig.volume : 1;

      let entry = aggregated.get(sig.symbol);
      if (!entry) {
        entry = { volume: 0, sentimentNumerator: 0, sources: new Set() };
        aggregated.set(sig.symbol, entry);
      }
      entry.volume += volume;
      entry.sentimentNumerator += (Number.isFinite(sig.sentiment) ? sig.sentiment : 0) * volume;
      entry.sources.add(sig.source_detail || sig.source);
    }

    const out = new Map<string, { volume: number; sentiment: number; sources: Set<string> }>();
    for (const [symbol, entry] of aggregated) {
      out.set(symbol, {
        volume: entry.volume,
        sentiment: entry.volume > 0 ? entry.sentimentNumerator / entry.volume : 0,
        sources: entry.sources,
      });
    }
    return out;
  }

  private pruneSocialHistoryInPlace(history: SocialHistoryEntry[], cutoffMs: number): void {
    if (history.length === 0) return;
    const pruned = history.filter((entry) => entry.timestamp >= cutoffMs);
    pruned.sort((a, b) => a.timestamp - b.timestamp);
    history.splice(0, history.length, ...pruned);
  }

  private updateSocialHistoryFromSnapshot(
    snapshot: Map<string, { volume: number; sentiment: number; sources: Set<string> }>,
    nowMs: number
  ): void {
    const SOCIAL_HISTORY_BUCKET_MS = 5 * 60 * 1000;
    const SOCIAL_HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
    const cutoff = nowMs - SOCIAL_HISTORY_MAX_AGE_MS;

    const touchedSymbols = new Set<string>();
    for (const [symbol, s] of snapshot) {
      touchedSymbols.add(symbol);
      const history = this.state.socialHistory[symbol] ?? [];
      if (history.length > 1) history.sort((a, b) => a.timestamp - b.timestamp);
      const last = history[history.length - 1];

      if (last && nowMs - last.timestamp < SOCIAL_HISTORY_BUCKET_MS) {
        last.timestamp = nowMs;
        last.volume = s.volume;
        last.sentiment = s.sentiment;
      } else {
        history.push({ timestamp: nowMs, volume: s.volume, sentiment: s.sentiment });
      }

      this.pruneSocialHistoryInPlace(history, cutoff);
      if (history.length === 0) {
        delete this.state.socialHistory[symbol];
      } else {
        this.state.socialHistory[symbol] = history;
      }
    }

    for (const symbol of Object.keys(this.state.socialHistory)) {
      if (touchedSymbols.has(symbol)) continue;
      const history = this.state.socialHistory[symbol];
      if (!history || history.length === 0) {
        delete this.state.socialHistory[symbol];
        continue;
      }
      this.pruneSocialHistoryInPlace(history, cutoff);
      if (history.length === 0) {
        delete this.state.socialHistory[symbol];
      }
    }
  }

  private getSocialSnapshotCache(): Record<string, SocialSnapshotCacheEntry> {
    if (this.state.socialSnapshotCacheUpdatedAt > 0) {
      return this.state.socialSnapshotCache;
    }

    const fallback = this.buildSocialSnapshot(this.state.signalCache);
    const out: Record<string, SocialSnapshotCacheEntry> = {};
    for (const [symbol, s] of fallback) {
      out[symbol] = { volume: s.volume, sentiment: s.sentiment, sources: Array.from(s.sources) };
    }
    return out;
  }

  // ============================================================================
  // LLM RESEARCH — uses strategy prompt builders
  // ============================================================================

  private async researchTopSignals(ctx: StrategyContext, limit = 5): Promise<ResearchResult[]> {
    const positions = await ctx.broker.getPositions();
    const heldSymbols = new Set(positions.map((p) => p.symbol));

    const allSignals = this.state.signalCache;
    const notHeld = allSignals.filter((s) => !heldSymbols.has(s.symbol));
    const aboveThreshold = notHeld.filter((s) => s.raw_sentiment >= this.state.config.min_sentiment_score);
    const candidates = aboveThreshold.sort((a, b) => b.sentiment - a.sentiment);

    if (candidates.length === 0) {
      this.log("SignalResearch", "no_candidates", {
        total_signals: allSignals.length,
        not_held: notHeld.length,
        above_threshold: aboveThreshold.length,
        min_sentiment: this.state.config.min_sentiment_score,
      });
      return [];
    }

    this.log("SignalResearch", "researching_signals", { count: candidates.length });

    const aggregated = new Map<string, { symbol: string; sentiment: number; sources: string[] }>();
    for (const sig of candidates) {
      if (!aggregated.has(sig.symbol)) {
        if (aggregated.size >= limit) continue;
        aggregated.set(sig.symbol, { symbol: sig.symbol, sentiment: sig.sentiment, sources: [sig.source] });
      } else {
        aggregated.get(sig.symbol)!.sources.push(sig.source);
      }
    }

    // Record attempts independently of successes: a provider failure for the
    // strongest symbol must not monopolize every research stage.
    const attempts = ctx.state.get<Record<string, number>>("signalResearchAttempts") ?? {};
    const symbol = leastRecentlyResearched([...aggregated.keys()], this.state.signalResearch, attempts);
    if (!symbol || !this.state.enabled) return [];
    const data = aggregated.get(symbol)!;
    const cutoff = Date.now() - 86_400_000;
    for (const [key, timestamp] of Object.entries(attempts)) if (timestamp < cutoff) delete attempts[key];
    attempts[symbol] = Date.now();
    ctx.state.set("signalResearchAttempts", attempts);
    const analysis = await this.callSignalResearch(ctx, symbol, data.sentiment, data.sources);
    return analysis ? [analysis] : [];
  }

  private async callSignalResearch(
    ctx: StrategyContext,
    symbol: string,
    sentiment: number,
    sources: string[]
  ): Promise<ResearchResult | null> {
    if (!this._llm || !activeStrategy.prompts.researchSignal) return null;

    const cached = this.state.signalResearch[symbol];
    const CACHE_TTL_MS = 180_000;
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached;

    try {
      const alpaca = createAlpacaProviders(this.env);
      const crypto = isCryptoSymbol(symbol, this.state.config.crypto_symbols || []);
      let price = 0;
      // The snapshot already carries today's bar, the previous daily bar, the
      // last minute bar and the quote. Deriving liquidity and extension from it
      // costs no additional requests.
      let market: MarketContext | null = null;
      if (crypto) {
        const snapshot = await alpaca.marketData.getCryptoSnapshot(normalizeCryptoSymbol(symbol)).catch(() => null);
        price = snapshot?.latest_trade?.price || snapshot?.latest_quote?.ask_price || 0;
      } else {
        // Snapshot and daily bars in parallel: the snapshot gives liquidity and
        // extension, the bars give ATR, RSI, trend and the 52-week high. A full
        // year is needed for the last of those to mean what it says.
        const [snapshot, bars] = await Promise.all([
          alpaca.marketData.getSnapshot(symbol, { feed: "iex" }).catch(() => null),
          alpaca.marketData.getBars(symbol, "1Day", { limit: 252 }).catch(() => [] as Bar[]),
        ]);
        price = snapshot?.latest_trade?.price || snapshot?.latest_quote?.ask_price || 0;
        market = withTechnicals(deriveMarketContext(snapshot), bars);
      }

      const headlines = (this.state.newsCache ?? {})[symbol] ?? [];
      const prompt = activeStrategy.prompts.researchSignal(symbol, sentiment, sources, price, ctx, market, headlines);

      const response = await this.completeWithBudget({
        model: prompt.model || this.state.config.llm_model,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        max_tokens: prompt.maxTokens || 250,
        temperature: 0.3,
        response_format: { type: "json_object" },
      });

      if (response.usage) {
        this.trackLLMCost(
          prompt.model || this.state.config.llm_model,
          response.usage.prompt_tokens,
          response.usage.completion_tokens
        );
      }

      // JSON mode guarantees syntax, not shape. Validate before this becomes an
      // order: an unvalidated empty object yields an undefined verdict, and the
      // gates would be comparing against undefined rather than refusing.
      const parsed = SignalResearchResponseSchema.safeParse(parseJsonObject(response.content || "{}"));
      if (!parsed.success) {
        this.log("SignalResearch", "invalid_response", {
          symbol,
          issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
        });
        return null;
      }
      const analysis = parsed.data;

      const result: ResearchResult = {
        symbol,
        verdict: analysis.verdict,
        confidence: analysis.confidence,
        entry_quality: analysis.entry_quality,
        reasoning: analysis.reasoning,
        red_flags: analysis.red_flags,
        catalysts: analysis.catalysts,
        timestamp: Date.now(),
        market,
      };

      this.state.signalResearch[symbol] = result;
      this.log("SignalResearch", "signal_researched", {
        symbol,
        verdict: result.verdict,
        confidence: result.confidence,
        quality: result.entry_quality,
        rejection: entryRejection(
          symbol,
          this.state.signalCache,
          result,
          this.state.config,
          Date.now(),
          this.state.recentExits ?? {},
          (this.state.catalystCache ?? {}) as never
        ),
      });

      if (result.verdict === "BUY") {
        await this.sendDiscordNotification("research", {
          symbol: result.symbol,
          verdict: result.verdict,
          confidence: result.confidence,
          quality: result.entry_quality,
          sentiment,
          sources,
          reasoning: result.reasoning,
          catalysts: result.catalysts,
          red_flags: result.red_flags,
        });
      }

      return result;
    } catch (error) {
      this.log("SignalResearch", "error", { symbol, message: String(error) });
      return null;
    }
  }

  private async callPositionResearch(ctx: StrategyContext, position: Position): Promise<void> {
    if (!this._llm || !activeStrategy.prompts.researchPosition) return;

    const plPct = (position.unrealized_pl / (position.market_value - position.unrealized_pl)) * 100;
    const prompt = activeStrategy.prompts.researchPosition(position.symbol, position, plPct, ctx);

    try {
      const response = await this.completeWithBudget({
        model: prompt.model || this.state.config.llm_model,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        max_tokens: prompt.maxTokens || 200,
        temperature: 0.3,
        response_format: { type: "json_object" },
      });

      if (response.usage) {
        this.trackLLMCost(
          prompt.model || this.state.config.llm_model,
          response.usage.prompt_tokens,
          response.usage.completion_tokens
        );
      }

      const parsed = PositionResearchResponseSchema.safeParse(parseJsonObject(response.content || "{}"));
      if (!parsed.success) {
        this.log("PositionResearch", "invalid_response", {
          symbol: position.symbol,
          issues: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
        });
        return;
      }
      this.state.positionResearch[position.symbol] = { ...parsed.data, timestamp: Date.now() };
      this.log("PositionResearch", "position_analyzed", {
        symbol: position.symbol,
        recommendation: parsed.data.recommendation,
        risk: parsed.data.risk_level,
      });
    } catch (error) {
      this.log("PositionResearch", "error", { symbol: position.symbol, message: String(error) });
    }
  }

  private async callAnalystLLM(
    ctx: StrategyContext,
    signals: Signal[],
    positions: Position[],
    account: Account
  ): Promise<{
    recommendations: Array<{
      action: "BUY" | "SELL" | "HOLD";
      symbol: string;
      confidence: number;
      reasoning: string;
      suggested_size_pct?: number;
    }>;
    market_summary: string;
    high_conviction: string[];
  }> {
    if (!this._llm || !activeStrategy.prompts.analyzeSignals || signals.length === 0) {
      return { recommendations: [], market_summary: "No signals to analyze", high_conviction: [] };
    }

    const prompt = activeStrategy.prompts.analyzeSignals(signals, positions, account, ctx);

    try {
      const response = await this.completeWithBudget({
        model: prompt.model || this.state.config.llm_analyst_model,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        max_tokens: prompt.maxTokens || 800,
        temperature: 0.4,
        response_format: { type: "json_object" },
      });

      if (response.usage) {
        this.trackLLMCost(
          prompt.model || this.state.config.llm_analyst_model,
          response.usage.prompt_tokens,
          response.usage.completion_tokens
        );
      }

      const envelope = AnalystResponseSchema.safeParse(parseJsonObject(response.content || "{}"));
      if (!envelope.success) {
        this.log("Analyst", "invalid_response", {
          issues: envelope.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
        });
        return { recommendations: [], market_summary: "", high_conviction: [] };
      }

      // Drop malformed recommendations individually; a single bad entry should
      // not discard the rest of an otherwise usable batch.
      const { valid, rejected } = parseAnalystRecommendations(envelope.data.recommendations);

      this.log("Analyst", "analysis_complete", {
        recommendations: valid.length,
        rejected,
      });

      return {
        recommendations: valid,
        market_summary: envelope.data.market_summary,
        high_conviction: envelope.data.high_conviction_plays,
      };
    } catch (error) {
      this.log("Analyst", "error", { message: String(error) });
      return { recommendations: [], market_summary: `Analysis failed: ${error}`, high_conviction: [] };
    }
  }

  // ============================================================================
  // ANALYST & TRADING — uses strategy selectEntries/selectExits + PolicyBroker
  // ============================================================================

  private async runAnalyst(ctx: StrategyContext): Promise<void> {
    const [account, positions, clock] = await Promise.all([
      ctx.broker.getAccount(),
      ctx.broker.getPositions(),
      ctx.broker.getClock(),
    ]);

    if (!account || !clock.is_open) {
      this.log("System", "analyst_skipped", { reason: "Account unavailable or market closed" });
      return;
    }

    const heldSymbols = new Set(positions.map((p) => p.symbol));
    const socialSnapshot = this.getSocialSnapshotCache();

    if (positions.length >= this.state.config.max_positions || this.state.signalCache.length === 0) return;

    // Strategy entry decisions from cached research
    const research = Object.values(this.state.signalResearch);
    const entries = activeStrategy.selectEntries(ctx, research, positions, account);

    for (const entry of entries) {
      if (heldSymbols.has(entry.symbol)) continue;
      if (positions.length >= this.state.config.max_positions) break;

      let finalConfidence = entry.confidence;

      // Twitter confirmation
      if (isTwitterEnabled(ctx)) {
        const originalSignal = this.state.signalCache.find((s) => s.symbol === entry.symbol);
        if (originalSignal) {
          const twitterConfirm = await gatherTwitterConfirmation(ctx, entry.symbol, originalSignal.sentiment);
          if (twitterConfirm) {
            this.state.twitterConfirmations[entry.symbol] = twitterConfirm;
            if (twitterConfirm.confirms_existing) {
              finalConfidence = Math.min(1.0, finalConfidence * 1.15);
              this.log("System", "twitter_boost", { symbol: entry.symbol, new_confidence: finalConfidence });
            } else if (twitterConfirm.sentiment !== 0) {
              finalConfidence *= 0.85;
            }
          }
        }
      }

      if (finalConfidence < this.state.config.min_analyst_confidence) continue;

      // Options routing. Whatever happens here, the equity path below must not
      // also run: on success that would double the exposure for one signal, and
      // on refusal it silently substitutes a different instrument for the one
      // the trade was sized and reasoned for.
      if (entry.useOptions) {
        const contract = await findBestOptionsContract(ctx, entry.symbol, "bullish", account.equity);
        const placed = contract ? await this.executeOptionsOrder(contract, 1, account.equity) : false;
        this.log("Options", placed ? "options_route_taken" : "options_route_failed", {
          symbol: entry.symbol,
          contract: contract?.symbol ?? null,
          equity_fallback: false,
        });
        continue;
      }

      // Execute buy via policy broker
      const result = await ctx.broker.buy(entry.symbol, entry.notional, entry.reason);
      if (result) {
        heldSymbols.add(entry.symbol);
        const originalSignal = this.state.signalCache.find((s) => s.symbol === entry.symbol);
        const aggregatedSocial = socialSnapshot[entry.symbol];
        this.state.positionEntries[entry.symbol] ??= {
          symbol: entry.symbol,
          entry_time: Date.now(),
          entry_price: 0,
          entry_sentiment: aggregatedSocial?.sentiment ?? originalSignal?.sentiment ?? finalConfidence,
          entry_social_volume: aggregatedSocial?.volume ?? originalSignal?.volume ?? 0,
          entry_sources: aggregatedSocial
            ? aggregatedSocial.sources
            : originalSignal?.subreddits || [originalSignal?.source || "research"],
          entry_reason: entry.reason,
          peak_price: 0,
          peak_sentiment: aggregatedSocial?.sentiment ?? originalSignal?.sentiment ?? finalConfidence,
          ...this.sizedTradeFor(entry.symbol, account.equity),
        };
      }
    }

    // LLM analyst for additional recommendations
    const analysis = await this.callAnalystLLM(ctx, this.state.signalCache, positions, account);
    const entrySymbols = new Set(entries.map((e) => e.symbol));

    for (const rec of analysis.recommendations) {
      if (rec.confidence < this.state.config.min_analyst_confidence) continue;

      if (rec.action === "SELL" && heldSymbols.has(rec.symbol)) {
        const posEntry = this.state.positionEntries[rec.symbol];
        const holdMinutes = posEntry ? (Date.now() - posEntry.entry_time) / (1000 * 60) : 0;
        const minHold = this.state.config.llm_min_hold_minutes ?? 30;

        if (holdMinutes < minHold) {
          this.log("Analyst", "llm_sell_blocked", {
            symbol: rec.symbol,
            holdMinutes: Math.round(holdMinutes),
            minRequired: minHold,
            reason: "Position held less than minimum hold time",
          });
          continue;
        }

        const result = await ctx.broker.sell(rec.symbol, `LLM recommendation: ${rec.reasoning}`);
        if (result) {
          heldSymbols.delete(rec.symbol);
          this.log("Analyst", "llm_sell_executed", {
            symbol: rec.symbol,
            confidence: rec.confidence,
            reasoning: rec.reasoning,
          });
        }
        continue;
      }

      if (rec.action === "BUY") {
        if (positions.length >= this.state.config.max_positions) continue;
        if (heldSymbols.has(rec.symbol)) continue;
        if (entrySymbols.has(rec.symbol)) continue;

        const sizePct = Math.min(20, this.state.config.position_size_pct_of_cash);
        const sized = this.sizedTradeFor(rec.symbol, account.equity);
        const notional = Math.min(account.cash * (sizePct / 100) * rec.confidence, sized.notional);
        if (notional < 100) continue;

        const result = await ctx.broker.buy(rec.symbol, notional, rec.reasoning);
        if (result) {
          const originalSignal = this.state.signalCache.find((s) => s.symbol === rec.symbol);
          const aggregatedSocial = socialSnapshot[rec.symbol];
          heldSymbols.add(rec.symbol);
          this.state.positionEntries[rec.symbol] ??= {
            symbol: rec.symbol,
            entry_time: Date.now(),
            entry_price: 0,
            entry_sentiment: aggregatedSocial?.sentiment ?? originalSignal?.sentiment ?? rec.confidence,
            entry_social_volume: aggregatedSocial?.volume ?? originalSignal?.volume ?? 0,
            entry_sources: aggregatedSocial
              ? aggregatedSocial.sources
              : originalSignal?.subreddits || [originalSignal?.source || "analyst"],
            entry_reason: rec.reasoning,
            peak_price: 0,
            peak_sentiment: aggregatedSocial?.sentiment ?? originalSignal?.sentiment ?? rec.confidence,
            stop_pct: sized.stop_pct,
            target_pct: sized.target_pct,
          };
        }
      }
    }
  }

  /**
   * Options entry — refused until it is routed through the policy broker.
   *
   * This path called `alpaca.trading.createOrder` directly, so it never reached
   * PolicyEngine and skipped every rule the engine defines for options:
   * `options_min_dte` (the rule that refuses 0DTE), `options_max_dte`, delta
   * bounds, `options_max_position_size`, `options_total_exposure`,
   * `options_max_positions` and `options_no_averaging_down` — plus the
   * account-wide `kill_switch`, `loss_cooldown` and `daily_loss_limit` that gate
   * every equity order.
   *
   * Rules that are written but routed around are more dangerous than rules that
   * were never written, because the configuration reads as protection while the
   * order path ignores it. The order-placing body is deleted rather than left
   * unreachable: whoever does the routing work will call `executeWithPolicy`,
   * not revive this, and unreachable order code invites someone to simply drop
   * the guard. Git history holds the original.
   */
  private async executeOptionsOrder(
    contract: { symbol: string; mid_price: number },
    _quantity: number,
    _equity: number
  ): Promise<boolean> {
    if (!this.state.config.options_enabled) return false;

    this.log("Options", "blocked_policy_bypass", {
      contract: contract.symbol,
      reason: "options execution bypasses PolicyEngine; route through the policy broker before enabling",
    });
    return false;
  }

  // ============================================================================
  // PRE-MARKET ANALYSIS — uses strategy prompts
  // ============================================================================

  private async runPreMarketAnalysis(ctx: StrategyContext): Promise<void> {
    const [account, positions] = await Promise.all([ctx.broker.getAccount(), ctx.broker.getPositions()]);

    if (!account || this.state.signalCache.length === 0) return;

    this.log("System", "premarket_analysis_starting", {
      signals: this.state.signalCache.length,
      researched: Object.keys(this.state.signalResearch).length,
    });

    // Research is its own one-symbol stage; planning only consumes its cache.
    const signalResearch = Object.values(this.state.signalResearch);
    const analysis = await this.callAnalystLLM(ctx, this.state.signalCache, positions, account);

    this.state.premarketPlan = {
      timestamp: Date.now(),
      recommendations: analysis.recommendations.map((r) => ({
        action: r.action,
        symbol: r.symbol,
        confidence: r.confidence,
        reasoning: r.reasoning,
        suggested_size_pct: r.suggested_size_pct,
      })),
      market_summary: analysis.market_summary,
      high_conviction: analysis.high_conviction,
      researched_buys: signalResearch.filter((r) => r.verdict === "BUY"),
    };

    const buyRecs = this.state.premarketPlan.recommendations.filter((r) => r.action === "BUY").length;
    const sellRecs = this.state.premarketPlan.recommendations.filter((r) => r.action === "SELL").length;

    this.log("System", "premarket_analysis_complete", {
      buy_recommendations: buyRecs,
      sell_recommendations: sellRecs,
      high_conviction: this.state.premarketPlan.high_conviction,
    });
  }

  private async executePremarketPlan(ctx: StrategyContext): Promise<void> {
    const PLAN_STALE_MS = 600_000;

    if (!this.state.premarketPlan) {
      this.log("System", "no_premarket_plan", { reason: "Plan missing" });
      return;
    }
    if (Date.now() - this.state.premarketPlan.timestamp > PLAN_STALE_MS) {
      this.log("System", "no_premarket_plan", { reason: "Plan stale" });
      this.state.premarketPlan = null;
      return;
    }

    const [account, positions] = await Promise.all([ctx.broker.getAccount(), ctx.broker.getPositions()]);
    if (!account) return;

    const heldSymbols = new Set(positions.map((p) => p.symbol));
    const socialSnapshot = this.getSocialSnapshotCache();

    this.log("System", "executing_premarket_plan", {
      recommendations: this.state.premarketPlan.recommendations.length,
    });

    // Sells first
    for (const rec of this.state.premarketPlan.recommendations) {
      if (
        rec.action === "SELL" &&
        rec.confidence >= this.state.config.min_analyst_confidence &&
        heldSymbols.has(rec.symbol)
      ) {
        await ctx.broker.sell(rec.symbol, `Pre-market plan: ${rec.reasoning}`);
        heldSymbols.delete(rec.symbol);
      }
    }

    // Then buys
    for (const rec of this.state.premarketPlan.recommendations) {
      if (rec.action === "BUY" && rec.confidence >= this.state.config.min_analyst_confidence) {
        if (heldSymbols.has(rec.symbol)) continue;
        if (positions.length >= this.state.config.max_positions) break;

        const sizePct = Math.min(20, this.state.config.position_size_pct_of_cash);
        const sized = this.sizedTradeFor(rec.symbol, account.equity);
        const notional = Math.min(account.cash * (sizePct / 100) * rec.confidence, sized.notional);
        if (notional < 100) continue;

        const result = await ctx.broker.buy(rec.symbol, notional, `Pre-market plan: ${rec.reasoning}`);
        if (result) {
          heldSymbols.add(rec.symbol);
          const originalSignal = this.state.signalCache.find((s) => s.symbol === rec.symbol);
          const aggregatedSocial = socialSnapshot[rec.symbol];
          this.state.positionEntries[rec.symbol] ??= {
            symbol: rec.symbol,
            entry_time: Date.now(),
            entry_price: 0,
            entry_sentiment: aggregatedSocial?.sentiment ?? originalSignal?.sentiment ?? 0,
            entry_social_volume: aggregatedSocial?.volume ?? originalSignal?.volume ?? 0,
            entry_sources: aggregatedSocial
              ? aggregatedSocial.sources
              : originalSignal?.subreddits || [originalSignal?.source || "premarket"],
            entry_reason: rec.reasoning,
            peak_price: 0,
            peak_sentiment: aggregatedSocial?.sentiment ?? originalSignal?.sentiment ?? 0,
            stop_pct: sized.stop_pct,
            target_pct: sized.target_pct,
          };
        }
      }
    }

    this.state.premarketPlan = null;
  }

  // ============================================================================
  // HTTP HANDLER
  // ============================================================================

  private constantTimeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
      mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return mismatch === 0;
  }

  private isAuthorized(request: Request): boolean {
    const token = this.env.MAHORAGA_API_TOKEN;
    if (!token) {
      console.warn("[MahoragaHarness] MAHORAGA_API_TOKEN not set - denying request");
      return false;
    }
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return false;
    return this.constantTimeCompare(authHeader.slice(7), token);
  }

  private isKillSwitchAuthorized(request: Request): boolean {
    const secret = this.env.KILL_SWITCH_SECRET;
    if (!secret) return false;
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return false;
    return this.constantTimeCompare(authHeader.slice(7), secret);
  }

  private unauthorizedResponse(): Response {
    return new Response(
      JSON.stringify({ error: "Unauthorized. Requires: Authorization: Bearer <MAHORAGA_API_TOKEN>" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.slice(1);

    const protectedActions = [
      "enable",
      "disable",
      "config",
      "trigger",
      "status",
      "logs",
      "costs",
      "signals",
      "history",
      "setup/status",
      "catalysts",
      "journal",
      "learnings",
    ];
    if (protectedActions.includes(action) || action.startsWith("research/")) {
      if (!this.isAuthorized(request)) return this.unauthorizedResponse();
    }

    try {
      if (action.startsWith("research/")) return handleResearch(request, this.env);
      switch (action) {
        case "catalysts":
          return this.handleCatalysts(request);
        case "journal":
          return this.handleJournal(url);
        case "learnings":
          return this.handleLearnings();
        case "status":
          return this.handleStatus();
        case "setup/status":
          return this.jsonResponse({ ok: true, data: { configured: true } });
        case "config":
          if (request.method === "POST") return this.handleUpdateConfig(request);
          return this.jsonResponse({ ok: true, data: this.state.config });
        case "enable":
          return this.handleEnable();
        case "disable":
          return this.handleDisable();
        case "logs":
          return this.handleGetLogs(url);
        case "costs":
          return this.jsonResponse({ costs: this.state.costTracker });
        case "signals":
          return this.jsonResponse({ signals: this.state.signalCache });
        case "history":
          return this.handleGetHistory(url);
        case "trigger":
          await this.alarm();
          return this.jsonResponse({ ok: true, message: "Alarm triggered" });
        case "kill":
          if (!this.isKillSwitchAuthorized(request)) {
            return new Response(
              JSON.stringify({ error: "Forbidden. Requires: Authorization: Bearer <KILL_SWITCH_SECRET>" }),
              { status: 403, headers: { "Content-Type": "application/json" } }
            );
          }
          return this.handleKillSwitch();
        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (error) {
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleStatus(): Promise<Response> {
    const alpaca = createAlpacaProviders(this.env);

    let account: Account | null = null;
    let positions: Position[] = [];
    let clock: MarketClock | null = null;

    try {
      [account, positions, clock] = await Promise.all([
        alpaca.trading.getAccount(),
        alpaca.trading.getPositions(),
        alpaca.trading.getClock(),
      ]);

      for (const pos of positions || []) {
        const entry = this.state.positionEntries[pos.symbol];
        if (entry && entry.entry_price === 0 && pos.avg_entry_price) {
          entry.entry_price = pos.avg_entry_price;
          entry.peak_price = Math.max(entry.peak_price, pos.current_price);
        }
      }
    } catch (_e) {
      // Ignore - will return null
    }

    return this.jsonResponse({
      ok: true,
      data: {
        enabled: this.state.enabled,
        strategy: activeStrategy.name,
        account,
        positions,
        clock,
        config: this.state.config,
        signals: this.state.signalCache,
        logs: this.state.logs.slice(-100),
        costs: this.state.costTracker,
        llmDailyBudget: this.state.llmDailyBudget ?? null,
        pendingExecutions: this.state.pendingExecutions ?? {},
        lastAnalystRun: this.state.lastAnalystRun,
        lastResearchRun: this.state.lastResearchRun,
        lastPositionResearchRun: this.state.lastPositionResearchRun,
        signalResearch: this.state.signalResearch,
        positionResearch: this.state.positionResearch,
        positionEntries: this.state.positionEntries,
        twitterConfirmations: this.state.twitterConfirmations,
        premarketPlan: this.state.premarketPlan,
        stalenessAnalysis: this.state.stalenessAnalysis,
      },
    });
  }

  /**
   * Read or ingest catalysts.
   *
   * The strongest catalyst source available is an earnings calendar with actual
   * versus estimated EPS, and no free endpoint reachable from a Worker supplies
   * it. This lets an outside process push what it has — a scheduled job, a
   * broker connector, a paid calendar — into the same cache the news gatherer
   * fills, so the entry gate treats every source identically.
   *
   * Ingested entries are merged rather than replacing the cache, deduplicated by
   * symbol and headline, and pruned by the configured age window on the next
   * gather pass like any other catalyst.
   */
  private async handleCatalysts(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return this.jsonResponse({ ok: true, catalysts: this.state.catalystCache ?? {} });
    }

    const body = (await request.json().catch(() => null)) as { catalysts?: unknown } | null;
    const parsed = IngestedCatalystsSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "Invalid catalyst payload",
          issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const now = Date.now();
    const maxAgeMs = Math.max(1, this.state.config.entry_max_catalyst_age_minutes) * 60_000;
    const cache = (this.state.catalystCache ?? {}) as Record<string, Array<Record<string, unknown>>>;
    let accepted = 0;
    let expired = 0;

    for (const entry of parsed.data.catalysts) {
      const at = Date.parse(entry.at);
      // A stale catalyst is not evidence; reject rather than silently backdate.
      if (!Number.isFinite(at) || at > now || now - at > maxAgeMs) {
        expired++;
        continue;
      }
      const symbol = entry.symbol.toUpperCase();
      const list = (cache[symbol] ??= []);
      if (list.some((h) => h.headline === entry.headline)) continue;
      list.push({
        type: entry.type,
        quality: entry.quality,
        matched: entry.type,
        headline: entry.headline,
        symbol,
        at,
      });
      if (list.length > 5) list.shift();
      accepted++;
    }

    this.state.catalystCache = cache;
    await this.persist();
    this.log("System", "catalysts_ingested", { accepted, expired, symbols: Object.keys(cache).length });
    return this.jsonResponse({ ok: true, accepted, expired, symbols: Object.keys(cache).length });
  }

  private async handleUpdateConfig(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<AgentConfig>;
    const merged = { ...this.state.config, ...body };

    const validation = safeValidateAgentConfig(merged);
    if (!validation.success) {
      return new Response(
        JSON.stringify({ ok: false, error: "Invalid configuration", issues: validation.error.issues }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    this.state.config = validation.data;
    this.initializeLLM();
    await this.persist();
    return this.jsonResponse({ ok: true, config: this.state.config });
  }

  private async handleEnable(): Promise<Response> {
    this.initializeLLM();
    if (!this._llm || !this.env.ALPACA_API_KEY?.trim() || !this.env.ALPACA_API_SECRET?.trim()) {
      return new Response(
        JSON.stringify({ ok: false, error: "Configure Alpaca and the selected LLM provider before enabling." }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
    this.state.enabled = true;
    // A restart must not lose the record: reload it before the first decision.
    await this.refreshLearnings();
    await this.persist();
    await this.scheduleNextAlarm();
    this.log("System", "agent_enabled", {});
    return this.jsonResponse({ ok: true, enabled: true });
  }

  private async handleDisable(): Promise<Response> {
    this.state.enabled = false;
    await this.ctx.storage.deleteAlarm();
    await this.persist();
    this.log("System", "agent_disabled", {});
    return this.jsonResponse({ ok: true, enabled: false });
  }

  private handleGetLogs(url: URL): Response {
    const limit = parseInt(url.searchParams.get("limit") || "100", 10);
    const logs = this.state.logs.slice(-limit);
    return this.jsonResponse({ logs });
  }

  private async handleGetHistory(url: URL): Promise<Response> {
    const alpaca = createAlpacaProviders(this.env);
    const period = url.searchParams.get("period") || "1M";
    const timeframe = url.searchParams.get("timeframe") || "1D";
    const intradayReporting = url.searchParams.get("intraday_reporting") as
      | "market_hours"
      | "extended_hours"
      | "continuous"
      | null;

    try {
      const history = await alpaca.trading.getPortfolioHistory({
        period,
        timeframe,
        intraday_reporting: intradayReporting || "extended_hours",
      });

      const snapshots = history.timestamp.map((ts, i) => ({
        timestamp: ts * 1000,
        equity: history.equity[i],
        pl: history.profit_loss[i],
        pl_pct: history.profit_loss_pct[i],
      }));

      return this.jsonResponse({
        ok: true,
        data: { snapshots, base_value: history.base_value, timeframe: history.timeframe },
      });
    } catch (error) {
      this.log("System", "history_error", { error: String(error) });
      return new Response(JSON.stringify({ ok: false, error: String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  private async handleKillSwitch(): Promise<Response> {
    this.state.enabled = false;
    await this.ctx.storage.deleteAlarm();
    this.state.signalCache = [];
    this.state.signalResearch = {};
    this.state.premarketPlan = null;
    await this.persist();
    this.log("System", "kill_switch_activated", { timestamp: new Date().toISOString() });
    return this.jsonResponse({
      ok: true,
      message: "KILL SWITCH ACTIVATED. Agent disabled, alarms cancelled, signal cache cleared.",
      note: "Existing positions are NOT automatically closed. Review and close manually if needed.",
    });
  }

  // ============================================================================
  // UTILITIES
  // ============================================================================

  private log(agent: string, action: string, details: Record<string, unknown>): void {
    const entry: LogEntry = { timestamp: new Date().toISOString(), agent, action, ...details };
    this.state.logs.push(entry);
    if (this.state.logs.length > 500) {
      this.state.logs = this.state.logs.slice(-500);
    }
    console.log(`[${entry.timestamp}] [${agent}] ${action}`, JSON.stringify(details));
  }

  public trackLLMCost(model: string, tokensIn: number, tokensOut: number): number {
    const pricing: Record<string, { input: number; output: number }> = {
      "gpt-4o": { input: 2.5, output: 10 },
      "gpt-4o-mini": { input: 0.15, output: 0.6 },
    };
    const rates = pricing[model] ?? pricing["gpt-4o"]!;
    const cost = (tokensIn * rates.input + tokensOut * rates.output) / 1_000_000;

    this.state.costTracker.total_usd += cost;
    this.state.costTracker.calls++;
    this.state.costTracker.tokens_in += tokensIn;
    this.state.costTracker.tokens_out += tokensOut;
    return cost;
  }

  /**
   * Size a trade for one symbol using the ATR captured with its research.
   * Every entry path routes through here so stop, target and size stay
   * consistent no matter which one originated the order.
   */
  private sizedTradeFor(symbol: string, equity: number) {
    const atrPct = this.state.signalResearch?.[symbol]?.market?.atr_pct ?? null;
    return volatilitySizedTrade(equity, this.state.config, atrPct);
  }

  /** The aggregate the prompts read. Recomputed on demand so it is never stale here. */
  private async handleLearnings(): Promise<Response> {
    await this.refreshLearnings();
    return this.jsonResponse({ ok: true, learnings: this.state.learnings ?? null });
  }

  /** Read the trade journal. The record of why, not just what. */
  private async handleJournal(url: URL): Promise<Response> {
    const db = createD1Client(this.env.DB);
    if (!db) return this.jsonResponse({ ok: false, error: "No database bound" });
    const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));
    try {
      return this.jsonResponse({ ok: true, entries: await recentJournalEntries(db, limit) });
    } catch (error) {
      return this.jsonResponse({ ok: false, error: String(error) });
    }
  }

  /**
   * Recompute the journal aggregate that prompts read.
   *
   * Deliberately does not touch configuration. At roughly three trades a week a
   * month yields twelve observations and a hit rate accurate to plus or minus
   * twenty-eight points; retuning thresholds on that fits noise, and an agent
   * that can widen its own risk limits has none. The record goes into the
   * prompt as evidence and the limits stay where a human put them.
   */
  private async refreshLearnings(): Promise<void> {
    const db = createD1Client(this.env.DB);
    if (!db) return;
    try {
      const entries = await recentJournalEntries(db, 200);
      const learnings = summariseJournal(entries);
      this.state.learnings = learnings;
      this.log("Journal", "learnings_refreshed", {
        closed: learnings.total_closed,
        wins: learnings.overall.wins,
        avg_r: learnings.overall.avg_r?.toFixed(2) ?? "insufficient sample",
      });
    } catch (error) {
      this.log("Journal", "learnings_failed", { error: String(error) });
    }
  }

  /** Exit marks captured at decision time, keyed by symbol, consumed on fill confirmation. */

  /**
   * Journal why a trade was taken, at the moment it was taken.
   *
   * None of this survives to the exit: research expires from the cache, the
   * macro regime moves, the catalyst ages out. A journal written at exit can
   * only record outcomes, which teaches nothing about selection.
   */
  private async journalEntry(symbol: string, equity: number): Promise<void> {
    const db = createD1Client(this.env.DB);
    if (!db) return;
    try {
      const research = this.state.signalResearch?.[symbol];
      const catalysts = (this.state.catalystCache ?? {})[symbol.toUpperCase()] ?? [];
      const catalyst = bestCatalyst(catalysts as never) as never;
      const sized = this.sizedTradeFor(symbol, equity);
      const regime = this.state.macroRegime as never;
      const thesis = buildThesis({
        symbol,
        catalyst,
        research,
        market: research?.market,
        regime,
        stopPct: sized.stop_pct,
        targetPct: sized.target_pct,
        notional: sized.notional,
      });

      await createJournalEntry(db, {
        symbol,
        side: "buy",
        qty: 0,
        entry_at: new Date().toISOString(),
        signals: { catalyst: thesis.catalyst, research: thesis.research, plan: thesis.plan },
        technicals: thesis.gates,
        regime_tags: regimeTags(regime),
        notes: thesis.summary,
      });
      this.log("Journal", "entry_recorded", { symbol, thesis: thesis.summary.slice(0, 120) });
    } catch (error) {
      // Journalling must never block or fail a trade.
      this.log("Journal", "entry_failed", { symbol, error: String(error) });
    }
  }

  /**
   * Collect what is needed to attribute an exit.
   *
   * Each lookup is independent and failure-tolerant: an attribution made on
   * partial evidence is still worth more than none, and the attributor reports
   * "unknown" rather than guessing when a field is missing. Recovery after the
   * exit is deliberately absent — it is a future measurement.
   */
  private async gatherExitEvidence(
    symbol: string,
    marks: { pnl_pct: number; reason: string },
    stopPct: number
  ): Promise<ExitEvidence> {
    const entry = this.state.positionEntries?.[symbol];
    const entryTime = entry?.entry_time ?? Date.now();
    const alpaca = createAlpacaProviders(this.env);

    // What the tape did over the same window, so beta is not mistaken for a bad pick.
    let marketPct: number | null = null;
    try {
      const start = new Date(entryTime - 86_400_000).toISOString().slice(0, 10);
      const spy = await alpaca.marketData.getBars("SPY", "1Day", { limit: 30, start });
      if (spy.length >= 2) {
        const first = spy[0]?.c;
        const last = spy[spy.length - 1]?.c;
        if (first && last && first > 0) marketPct = ((last - first) / first) * 100;
      }
    } catch {
      // Leave null; the attributor handles missing evidence.
    }

    // Did the facts change after we bought it?
    let adverseNews: string[] = [];
    try {
      const news = await alpaca.marketData.getNews({
        symbols: [symbol],
        start: new Date(entryTime).toISOString(),
        limit: 30,
      });
      adverseNews = news
        .filter((n) => adverseCatalystReason(`${n.headline} ${n.summary}`))
        .map((n) => n.headline)
        .slice(0, 3);
    } catch {
      // Leave empty.
    }

    return {
      pnl_pct: marks.pnl_pct,
      stop_pct: stopPct,
      target_pct: entry?.target_pct ?? null,
      exit_reason: marks.reason,
      market_pct: marketPct,
      // Sector attribution needs a symbol-to-sector map the Worker does not have.
      sector_pct: null,
      adverse_news: adverseNews,
      recovered_to_pct: null,
      atr_pct_at_entry: entry?.atr_pct ?? null,
    };
  }

  /** Close the journal entry with the outcome, in R so trades with different stops compare. */
  private async journalExit(symbol: string, closing?: PositionEntry): Promise<void> {
    const db = createD1Client(this.env.DB);
    const marks = this.state.pendingExitMarks?.[symbol];
    if (this.state.pendingExitMarks) delete this.state.pendingExitMarks[symbol];
    if (!db || !marks) return;
    try {
      const entry = closing ?? this.state.positionEntries?.[symbol];
      const stopPct = entry?.stop_pct ?? this.state.config.stop_loss_pct;
      if (!closing) {
        this.log("Journal", "exit_without_entry_snapshot", { symbol, fallback_stop_pct: stopPct });
      }
      const r = rMultiple(marks.pnl_pct, stopPct);
      const evidence = await this.gatherExitEvidence(symbol, marks, stopPct);
      const attribution = attributeExit(evidence);

      await closeJournalEntry(db, {
        symbol,
        exit_price: marks.price,
        pnl_usd: marks.pnl_usd,
        pnl_pct: marks.pnl_pct,
        outcome: classifyOutcome(marks.pnl_pct),
        lessons_learned: [
          `cause=${attribution.cause}`,
          `selection_valid=${attribution.selection_still_valid}`,
          attribution.explanation,
          `${marks.reason} | ${r === null ? "R unknown" : `${r.toFixed(2)}R`} on a ${stopPct.toFixed(1)}% stop`,
          "P&L marked at decision, not fill",
        ].join(" | "),
      });
      this.log("Journal", "exit_recorded", {
        symbol,
        pnl_pct: marks.pnl_pct.toFixed(2),
        r: r?.toFixed(2),
        cause: attribution.cause,
        selection_valid: attribution.selection_still_valid,
      });
      // A closed trade is the only event that changes the record, so this is
      // the only moment the aggregate needs recomputing.
      await this.refreshLearnings();
    } catch (error) {
      this.log("Journal", "exit_failed", { symbol, error: String(error) });
    }
  }

  /**
   * Second opinion before an adverse-news exit fires.
   *
   * Returns true only when the model says, with confidence, that the flagged
   * story is not adverse — the single path that spares a position. Every other
   * outcome, including every failure, returns false and lets the exit proceed,
   * because the conservative action for capital is the one already in flight.
   */
  private async adverseExitOverturned(ctx: StrategyContext, symbol: string): Promise<boolean> {
    const mode = this.state.config.news_adjudication;
    if (mode === "off") return false;

    const evidence = ctx.state.get<Record<string, AdverseEvidence>>("adverseEvidence")?.[symbol];
    if (!evidence) return false;

    const cache = ctx.state.get<Record<string, { upheld: boolean; at: number }>>("adjudications") ?? {};
    const key = adjudicationKey(symbol, evidence);
    let entry = cache[key];
    let note = "cached";

    if (!entry) {
      const outcome = await adjudicateAdverse(ctx.llm, {
        symbol,
        headline: evidence.headline,
        summary: evidence.summary,
        matched: evidence.reason,
      });
      entry = { upheld: outcome.upheld, at: Date.now() };
      note = outcome.note;
      const maxAge = Math.max(1, this.state.config.entry_max_catalyst_age_minutes) * 60_000;
      for (const [k, v] of Object.entries(cache)) if (Date.now() - v.at > maxAge) delete cache[k];
      cache[key] = entry;
      ctx.state.set("adjudications", cache);
      this.log("News", "adjudicated", {
        symbol,
        mode,
        matched: evidence.reason,
        upheld: outcome.upheld,
        note,
        headline: evidence.headline.slice(0, 120),
        event: outcome.verdict?.event ?? null,
        quote: outcome.verdict?.quote?.slice(0, 120) ?? null,
        reasoning: outcome.verdict?.reasoning?.slice(0, 200) ?? null,
      });
    }

    if (entry.upheld) return false;
    if (mode === "shadow") {
      this.log("News", "adjudication_shadowed", { symbol, note, would_have_spared: true });
      return false;
    }

    // Clear the flag as well as skipping the sell, or the exit rule proposes the
    // same close again on the very next pass.
    const invalidated = ctx.state.get<Record<string, number>>("catalystInvalidatedAt") ?? {};
    delete invalidated[symbol];
    delete invalidated[symbol.toUpperCase()];
    ctx.state.set("catalystInvalidatedAt", invalidated);
    const all = ctx.state.get<Record<string, AdverseEvidence>>("adverseEvidence") ?? {};
    delete all[symbol];
    ctx.state.set("adverseEvidence", all);
    this.log("News", "adverse_exit_overturned", { symbol, matched: evidence.reason, note });
    return true;
  }

  /** Remove the open journal row for an order that never became a position. */
  private async discardJournalEntry(symbol: string): Promise<void> {
    const db = createD1Client(this.env.DB);
    if (!db) return;
    try {
      const removed = await deleteOpenJournalEntry(db, symbol);
      if (removed) this.log("Journal", "entry_discarded", { symbol, reason: "order abandoned before fill" });
    } catch (error) {
      this.log("Journal", "discard_failed", { symbol, error: String(error) });
    }
  }

  /** Record an exit for the re-entry cooldown, pruning entries past the window. */
  private recordExit(symbol: string, now = Date.now()): void {
    if (!this.state.recentExits) this.state.recentExits = {};
    this.state.recentExits[symbol.toUpperCase()] = now;

    const keepMs = Math.max(this.state.config.reentry_cooldown_minutes, 1) * 60_000;
    for (const [key, exitedAt] of Object.entries(this.state.recentExits)) {
      if (!Number.isFinite(exitedAt) || now - exitedAt > keepMs) delete this.state.recentExits[key];
    }
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put("state", this.state);
  }

  private jsonResponse(data: unknown): Response {
    return new Response(JSON.stringify(data, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async sendDiscordNotification(
    type: "signal" | "research",
    data: {
      symbol: string;
      sentiment?: number;
      sources?: string[];
      verdict?: string;
      confidence?: number;
      quality?: string;
      reasoning?: string;
      catalysts?: string[];
      red_flags?: string[];
    }
  ): Promise<void> {
    if (!this.env.DISCORD_WEBHOOK_URL) return;

    const cacheKey = data.symbol;
    const lastNotification = this.discordCooldowns.get(cacheKey);
    if (lastNotification && Date.now() - lastNotification < this.DISCORD_COOLDOWN_MS) return;

    try {
      let embed: {
        title: string;
        color: number;
        fields: Array<{ name: string; value: string; inline: boolean }>;
        description?: string;
        timestamp: string;
        footer: { text: string };
      };

      if (type === "signal") {
        embed = {
          title: `🔔 SIGNAL: $${data.symbol}`,
          color: 0xfbbf24,
          fields: [
            { name: "Sentiment", value: `${((data.sentiment || 0) * 100).toFixed(0)}% bullish`, inline: true },
            { name: "Sources", value: data.sources?.join(", ") || "StockTwits", inline: true },
          ],
          description: "High sentiment detected, researching...",
          timestamp: new Date().toISOString(),
          footer: { text: "MAHORAGA • Not financial advice • DYOR" },
        };
      } else {
        const verdictEmoji = data.verdict === "BUY" ? "✅" : data.verdict === "SKIP" ? "⏭️" : "⏸️";
        const color = data.verdict === "BUY" ? 0x22c55e : data.verdict === "SKIP" ? 0x6b7280 : 0xfbbf24;

        embed = {
          title: `${verdictEmoji} $${data.symbol} → ${data.verdict}`,
          color,
          fields: [
            { name: "Confidence", value: `${((data.confidence || 0) * 100).toFixed(0)}%`, inline: true },
            { name: "Quality", value: data.quality || "N/A", inline: true },
            { name: "Sentiment", value: `${((data.sentiment || 0) * 100).toFixed(0)}%`, inline: true },
          ],
          timestamp: new Date().toISOString(),
          footer: { text: "MAHORAGA • Not financial advice • DYOR" },
        };

        if (data.reasoning) {
          embed.description = data.reasoning.substring(0, 300) + (data.reasoning.length > 300 ? "..." : "");
        }
        if (data.catalysts && data.catalysts.length > 0) {
          embed.fields.push({ name: "Catalysts", value: data.catalysts.slice(0, 3).join(", "), inline: false });
        }
        if (data.red_flags && data.red_flags.length > 0) {
          embed.fields.push({
            name: "⚠️ Red Flags",
            value: data.red_flags.slice(0, 3).join(", "),
            inline: false,
          });
        }
      }

      await fetch(this.env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      });

      this.discordCooldowns.set(cacheKey, Date.now());
      this.log("Discord", "notification_sent", { type, symbol: data.symbol });
    } catch (err) {
      this.log("Discord", "notification_failed", { error: String(err) });
    }
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export function getHarnessStub(env: Env): DurableObjectStub {
  if (!env.MAHORAGA_HARNESS) {
    throw new Error("MAHORAGA_HARNESS binding not configured - check wrangler.toml");
  }
  const id = env.MAHORAGA_HARNESS.idFromName("main");
  return env.MAHORAGA_HARNESS.get(id);
}

export async function getHarnessStatus(env: Env): Promise<unknown> {
  const stub = getHarnessStub(env);
  const response = await stub.fetch(new Request("http://harness/status"));
  return response.json();
}

export async function enableHarness(env: Env): Promise<void> {
  const stub = getHarnessStub(env);
  await stub.fetch(new Request("http://harness/enable"));
}

export async function disableHarness(env: Env): Promise<void> {
  const stub = getHarnessStub(env);
  await stub.fetch(new Request("http://harness/disable"));
}
