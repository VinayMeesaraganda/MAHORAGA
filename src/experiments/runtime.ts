import type { PendingExecution } from "../core/types";
import { createPolicyBroker, type ProtectedBuy } from "../core/policy-broker";
import { entryReservationPending } from "../core/protection";
import { getDefaultOptionsPolicyConfig, type PolicyConfig } from "../policy/config";
import { createAlpacaClient, createAlpacaProviders, type AlpacaProviders } from "../providers/alpaca";
import type { Account, Position } from "../providers/types";
import { captureFinnhub, earningsBlocked, loadLatestGuidanceEvents } from "../providers/earnings/pipeline";
import { hash } from "../research/ledger";
import { collectNews, type Coverage } from "../research/news";
import { createD1Client, type D1Client } from "../storage/d1/client";
import { GUIDANCE_PROFILE } from "../strategy/guidance-continuation/config";
import {
  allocate,
  calendarRejection,
  evaluateCandidate,
  exitReason,
  localTime,
  type Decision,
  type Plan,
  type Portfolio,
} from "../strategy/guidance-continuation/rules";
import { evaluatePriceVolume, PRICE_VOLUME_PROFILE } from "../strategy/price-volume";
import {
  readExchangeSessions,
  readHistory,
  readMarketPacket,
  UNIVERSE,
  UNIVERSE_REVISION,
  type Client,
  type History,
  type Session,
} from "../strategy/shared-market";
import { collectMacro, type MacroCalendar } from "./calendar";
import { newsEntryVeto } from "./news-risk";
import { evidenceAvailable } from "../schemas/earnings-event";

export type StrategyId = "guidance-continuation" | "price-volume";
export interface ExperimentEnv
  extends Omit<
    ExperimentBindings,
    "STRATEGY_ID" | "FINNHUB_API_KEY" | "PAPER_PILOT_AUTHORIZATION" | "EXECUTION_ACCEPTANCE"
  > {
  STRATEGY_ID: StrategyId;
  EXPECTED_ACCOUNT_ID: string;
  FINNHUB_API_KEY?: string;
  /** Exact execution-profile hash after lifecycle acceptance, never a generic true flag. */
  EXECUTION_ACCEPTANCE?: string;
  /** Operator-authorized paper pilot; does not claim completed broker fill validation. */
  PAPER_PILOT_AUTHORIZATION?: string;
}
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
interface Entry {
  plan: Plan;
  quantity: number;
  enteredSession: string;
}
interface Batch {
  date: string;
  rows: Decision[];
  allocations: ReturnType<typeof allocate>;
  attempted: string[];
  complete: boolean;
}
export interface RuntimeState {
  version: 1;
  enabled: boolean;
  mode: "shadow" | "paper";
  profileHash: string;
  accountId: string | null;
  peakEquity: number;
  paused: boolean;
  pending: Record<string, PendingExecution>;
  entries: Record<string, Entry>;
  sessions: Session[];
  calendarAt: number;
  macro?: MacroCalendar;
  macroAt: number;
  macroError: string | null;
  finnhubAt: number;
  news?: Coverage;
  newsAt: number;
  historyCursor: number;
  batch?: Batch;
  lastTick: string | null;
  nextTick: string | null;
  error: string | null;
  lastMark: number;
  broker?: { equity: number; cash: number; positions: number; openOrders: number; at: string };
  controlEpoch?: number;
  auditOrderIds?: string[];
}
export const executionProfile = (id: StrategyId) => ({
  strategy: id === "guidance-continuation" ? GUIDANCE_PROFILE : PRICE_VOLUME_PROFILE,
  runtimeRevision: "2026-09-13-1",
  universe: UNIVERSE_REVISION,
  history: "split-adjusted SIP 30-minute buckets wholly inside regular session; excludes closing-auction bucket",
  quote: "IEX displayed quote; not a claim of NBBO",
  maxDailyLossFraction: 0.02,
  review: { firstOperationalSession: 1, firstPerformanceSessions: 20, adaptiveSizing: false },
});
const policy: PolicyConfig = {
  max_position_pct_equity: 0.05,
  max_open_positions: 5,
  max_notional_per_trade: 5000,
  allowed_order_types: ["limit", "market", "stop"],
  max_daily_loss_pct: 0.02,
  cooldown_minutes_after_loss: 120,
  allowed_symbols: Object.keys(UNIVERSE),
  deny_symbols: [],
  min_avg_volume: 100000,
  min_price: 10,
  trading_hours_only: true,
  extended_hours_allowed: false,
  approval_token_ttl_seconds: 300,
  allow_short_selling: false,
  use_cash_only: true,
  options: getDefaultOptionsPolicyConfig(),
};
export class ExperimentRuntime {
  state!: RuntimeState;
  readonly alpaca: AlpacaProviders;
  readonly client: Client;
  readonly db: D1Client;
  busy = false;
  constructor(
    readonly store: Store,
    readonly env: ExperimentEnv,
    deps?: { alpaca: AlpacaProviders; client: Client; db: D1Client }
  ) {
    if (!["guidance-continuation", "price-volume"].includes(env.STRATEGY_ID) || env.ALPACA_PAPER !== "true")
      throw Error("Explicit registered paper strategy required");
    this.alpaca = deps?.alpaca ?? createAlpacaProviders(env);
    this.client =
      deps?.client ?? createAlpacaClient({ apiKey: env.ALPACA_API_KEY, apiSecret: env.ALPACA_API_SECRET, paper: true });
    this.db = deps?.db ?? createD1Client(env.DB);
  }
  async init() {
    const profileHash = await hash(JSON.stringify(executionProfile(this.env.STRATEGY_ID)));
    this.state = (await this.store.get<RuntimeState>("runtime")) ?? {
      version: 1,
      enabled: false,
      mode: "shadow",
      profileHash,
      accountId: null,
      peakEquity: 0,
      paused: false,
      pending: {},
      entries: {},
      sessions: [],
      calendarAt: 0,
      macroAt: 0,
      macroError: null,
      finnhubAt: 0,
      newsAt: 0,
      historyCursor: 0,
      lastTick: null,
      nextTick: null,
      error: null,
      lastMark: 0,
    };
    // Preserve the old profile and exposures. A code revision cannot silently change a running trial.
    if (this.state.profileHash !== profileHash) {
      this.state.enabled = false;
      this.state.error = "profile_changed_review_required";
    }
  }
  persist() {
    return this.store.put("runtime", this.state);
  }
  async audit(kind: string, payload: unknown, now = Date.now(), id = crypto.randomUUID()) {
    await this.db.run(
      "INSERT OR IGNORE INTO experiment_audit (id,experiment,kind,payload,observed_at) VALUES (?,?,?,?,?)",
      [id, this.env.STRATEGY_ID, kind, JSON.stringify(payload), new Date(now).toISOString()]
    );
  }
  async account(): Promise<Account> {
    const account = await this.alpaca.trading.getAccount();
    if (
      !this.env.EXPECTED_ACCOUNT_ID ||
      account.id !== this.env.EXPECTED_ACCOUNT_ID ||
      (this.state.accountId && account.id !== this.state.accountId)
    )
      throw Error("broker_account_identity_mismatch");
    if (
      account.status !== "ACTIVE" ||
      account.currency !== "USD" ||
      !Number.isFinite(account.equity) ||
      !Number.isFinite(account.cash)
    )
      throw Error("broker_account_unusable");
    this.state.accountId = account.id;
    this.state.peakEquity = Math.max(this.state.peakEquity, account.equity);
    if (account.equity <= 0 || 1 - account.equity / this.state.peakEquity >= GUIDANCE_PROFILE.drawdownPause)
      this.state.paused = true;
    return account;
  }
  executionAuthorized = () =>
    this.env.PAPER_PILOT_AUTHORIZATION === this.state.profileHash ||
    this.env.EXECUTION_ACCEPTANCE === this.state.profileHash;
  canExecute = () =>
    this.state.enabled &&
    this.state.mode === "paper" &&
    this.executionAuthorized() &&
    this.state.accountId === this.env.EXPECTED_ACCOUNT_ID;
  async configure(enabled: boolean, mode: "shadow" | "paper") {
    const epoch = this.state.controlEpoch ?? 0;
    if (this.state.profileHash !== (await hash(JSON.stringify(executionProfile(this.env.STRATEGY_ID)))))
      throw Error("profile_changed_review_required");
    await this.account();
    const positions = await this.alpaca.trading.getPositions(),
      orders = await this.alpaca.trading.listOrders({ status: "open", limit: 100 });
    if (mode !== this.state.mode && (positions.length || orders.length || Object.keys(this.state.pending).length))
      throw Error("mode_change_with_exposure_blocked");
    if (mode === "paper" && !this.executionAuthorized()) throw Error("paper_execution_authorization_required");
    if ((this.state.controlEpoch ?? 0) !== epoch) throw Error("configuration_interrupted_by_stop");
    this.state.mode = mode;
    this.state.enabled = enabled;
    await this.audit("configuration", {
      enabled,
      mode,
      profileHash: this.state.profileHash,
      authorizationBasis:
        this.env.PAPER_PILOT_AUTHORIZATION === this.state.profileHash
          ? "operator_paper_pilot"
          : this.env.EXECUTION_ACCEPTANCE === this.state.profileHash
            ? "legacy_execution_acceptance"
            : "none",
    });
    await this.persist();
    if (this.state.enabled && (this.state.controlEpoch ?? 0) === epoch) await this.store.setAlarm(Date.now() + 1000);
    else await this.store.deleteAlarm();
  }
  async stop() {
    this.state.controlEpoch = (this.state.controlEpoch ?? 0) + 1;
    this.state.enabled = false;
    this.state.nextTick = null;
    await this.persist();
    await this.store.deleteAlarm();
    return {
      enabled: false,
      note: "Harness stopped. Broker orders and positions remain; native stops remain broker-managed.",
    };
  }
  portfolio(account: Account, positions: Position[]): Portfolio {
    const allocations: Portfolio["allocations"] = [];
    for (const p of positions) {
      const entry = this.state.entries[p.symbol];
      if (
        !entry ||
        p.side !== "long" ||
        p.asset_class !== "us_equity" ||
        !Number.isFinite(p.qty) ||
        p.qty <= 0 ||
        p.qty > entry.quantity ||
        !Number.isFinite(p.avg_entry_price) ||
        p.avg_entry_price <= 0 ||
        !Number.isFinite(p.market_value) ||
        p.market_value < 0
      )
        throw Error("unknown_or_unreconciled_holding");
      allocations.push({
        issuer: entry.plan.issuer,
        sector: entry.plan.sector,
        value: Math.max(p.market_value, p.qty * entry.plan.limit),
        initialRisk: p.qty * Math.max(p.avg_entry_price - entry.plan.stop, entry.plan.limit - entry.plan.stop),
      });
    }
    let reservedCash = 0;
    for (const intent of Object.values(this.state.pending)) {
      if (!entryReservationPending(intent) || positions.some((p) => p.symbol === intent.symbol)) continue;
      const entry = this.state.entries[intent.symbol];
      if (!entry || intent.side !== "buy") throw Error("unreconciled_order_intent");
      const value = entry.quantity * entry.plan.limit;
      reservedCash += value;
      allocations.push({
        issuer: entry.plan.issuer,
        sector: entry.plan.sector,
        value,
        initialRisk: entry.quantity * (entry.plan.limit - entry.plan.stop),
      });
    }
    return {
      equity: account.equity,
      cash: Math.max(0, account.cash - reservedCash),
      peakEquity: this.state.peakEquity,
      paused: this.state.paused,
      allocations,
      attemptedEvents: [],
    };
  }
  broker(validate?: (intent: ProtectedBuy, account: Account, positions: Position[]) => Promise<string | null>) {
    return createPolicyBroker({
      alpaca: this.alpaca,
      policyConfig: policy,
      db: this.db,
      cryptoSymbols: [],
      allowedExchanges: ["NYSE", "NASDAQ", "AMEX", "ARCA", "BATS"],
      pendingExecutions: this.state.pending,
      persist: () => this.persist(),
      canSubmit: this.canExecute,
      // Broker errors are retained as action codes. Provider bodies do not enter public diagnostics.
      log: (_agent, action) => {
        if (/failed|pending|rejected|blocked/.test(action)) this.state.error = action;
      },
      onSell: (symbol) => {
        delete this.state.entries[symbol];
      },
      onBuyAbandoned: (symbol) => {
        delete this.state.entries[symbol];
      },
      validateProtectedEntry: validate,
    });
  }
  async exits(now: number) {
    // Identity is checked by tick before reconciliation, which may cancel/replace orders.
    const broker = this.broker();
    const ownedOrderIds = new Set([
      ...(this.state.auditOrderIds ?? []),
      ...Object.values(this.state.pending).flatMap((p) =>
        [p.order_id, ...(p.protected_entry?.protective_order_ids ?? []), p.protected_entry?.protective_order_id].filter(
          (id): id is string => !!id
        )
      ),
    ]);
    this.state.auditOrderIds = [...ownedOrderIds];
    await this.persist();
    await broker.reconcile!();
    const positions = await this.alpaca.trading.getPositions();
    for (const p of positions) {
      const entry = this.state.entries[p.symbol];
      if (!entry) {
        this.state.error = "unknown_holding_requires_review";
        continue;
      }
      // Time exits survive quote/news/calendar-source outages using the persisted exchange calendar.
      let reason = exitReason(
        { stop: entry.plan.stop, price: Number.NaN, enteredSession: entry.enteredSession, invalidation: "none" },
        this.state.sessions,
        now
      );
      if (!reason) {
        const q = await this.client
          .dataRequest<{ quote: { bp: number; t: string } }>("GET", `/v2/stocks/${p.symbol}/quotes/latest`, {
            feed: "iex",
          })
          .catch(() => null);
        if (
          q &&
          Number.isFinite(q.quote.bp) &&
          q.quote.bp > 0 &&
          Date.parse(q.quote.t) <= now &&
          now - Date.parse(q.quote.t) <= 30000
        )
          reason = exitReason(
            { stop: entry.plan.stop, price: q.quote.bp, enteredSession: entry.enteredSession, invalidation: "none" },
            this.state.sessions,
            now
          );
      }
      if (reason) await broker.sell(p.symbol, reason);
    }
    // Verified issuer invalidations run after mandatory exits. News/model concerns alone cannot flatten.
    if (positions.length && this.env.STRATEGY_ID === "guidance-continuation") {
      const events = await loadLatestGuidanceEvents(this.db, now);
      for (const p of positions) {
        const entry = this.state.entries[p.symbol],
          event = events.find((e) => e.event.event_key === entry?.plan.eventKey)?.event;
        if (
          event?.review.state === "contradicted" &&
          Date.parse(event.review.reviewed_at) <= now &&
          event.review.evidence.every((e) => evidenceAvailable(e, now))
        )
          await broker.sell(p.symbol, "verified_thesis_invalidation");
      }
    }
    // Persist order revisions only when they change, including actual broker fill prices.
    // This is an order audit, not a fabricated round-trip P&L record.
    for (const p of Object.values(this.state.pending))
      for (const id of [p.order_id, p.protected_entry?.protective_order_id]) if (id) ownedOrderIds.add(id);
    this.state.auditOrderIds = [...ownedOrderIds];
    await this.persist();
    for (const id of ownedOrderIds) {
      const order = await this.alpaca.trading.getOrder(id);
      for (const revision of [order, ...(order.legs ?? [])]) {
        const payload = JSON.stringify(revision),
          id = await hash(`${this.state.accountId}\n${payload}`);
        await this.db.run(
          "INSERT OR IGNORE INTO broker_order_snapshots (id,account_id,order_id,payload,observed_at) VALUES (?,?,?,?,?)",
          [id, this.state.accountId, revision.id, payload, new Date(now).toISOString()]
        );
      }
      this.state.auditOrderIds = this.state.auditOrderIds.filter((pendingId) => pendingId !== id);
      await this.persist();
    }
  }
  async prepare(now: number) {
    if (now - this.state.calendarAt > 86400000 || !this.state.sessions.length) {
      this.state.sessions = await readExchangeSessions(this.client, now);
      this.state.calendarAt = now;
      return;
    }
    if (now - this.state.finnhubAt > 6 * 3600000) {
      await captureFinnhub(this.db, this.env.FINNHUB_API_KEY, now);
      this.state.finnhubAt = now;
      return;
    }
    if (now - this.state.macroAt > 6 * 3600000) {
      try {
        this.state.macro = await collectMacro(this.db, now);
        this.state.macroError = null;
      } catch {
        this.state.macroError = "official_macro_fetch_or_parse_failed; source review required";
      }
      this.state.macroAt = now;
      return;
    }
    // Alternate news and one history symbol. No full universe backfill inside an exit loop.
    if (now - this.state.newsAt > 60000 || (this.state.news && !this.state.news.complete && !this.state.news.error)) {
      this.state.news = await collectNews(this.db, this.alpaca.marketData, Object.keys(UNIVERSE), now);
      this.state.newsAt = now;
      return;
    }
    const symbols = Object.keys(UNIVERSE),
      index = this.state.historyCursor++ % symbols.length,
      symbol = symbols[index]!;
    const old = await this.store.get<History>(`history:${symbol}`),
      latest = this.state.sessions.filter((s) => Date.parse(s.close) + 900000 < now).at(-1)?.date;
    if (old?.asof !== latest) {
      const history = await readHistory(this.client, symbol, this.state.sessions, now);
      await this.store.put(`history:${symbol}`, history);
    }
  }
  async evaluate(
    symbol: string,
    now: number,
    event?: Awaited<ReturnType<typeof loadLatestGuidanceEvents>>[number]["event"]
  ) {
    const history = await this.store.get<History>(`history:${symbol}`);
    if (!history || !this.state.macro || !this.state.news?.through) throw Error("market_inputs_not_ready");
    const news = this.state.news;
    const packet = await readMarketPacket(
      this.client,
      history,
      this.state.sessions,
      this.state.macro,
      { complete: news.complete && !news.error, from: news.historyFrom ?? news.from, through: news.through! },
      now
    );
    // Quote timestamps may advance while the HTTP request is in flight.
    const evaluatedAt = Math.max(now, Date.now());
    const input = event
      ? { ...packet, event, at: new Date(evaluatedAt).toISOString() }
      : { ...packet, symbol, issuer_id: symbol, history_adjustment: "split", at: new Date(evaluatedAt).toISOString() };
    const result = event ? evaluateCandidate(input) : evaluatePriceVolume(input);
    const newsReason = await newsEntryVeto(
      this.db,
      symbol,
      event?.released_at ?? this.state.sessions.filter((s) => Date.parse(s.close) < now).at(-1)!.open,
      evaluatedAt
    );
    if (newsReason) {
      result.reasons.push(newsReason);
      result.plan = null;
    }
    if (!event) {
      const current = this.state.sessions.findIndex((s) => s.date === localTime(now).date),
        horizon = this.state.sessions[current + GUIDANCE_PROFILE.holdSessions - 1];
      const reason =
        current < 0 || !horizon
          ? "holding_calendar_unknown"
          : await earningsBlocked(this.db, symbol, localTime(now).date, horizon.date, now);
      if (reason) {
        result.reasons.push(reason);
        result.plan = null;
      }
    }
    return { input, result };
  }
  async scan(now: number, freeze: boolean) {
    const date = localTime(now).date,
      batchId = `batch:${this.env.STRATEGY_ID}:${this.state.profileHash}:${date}`;
    const frozen = freeze
      ? await this.db.executeOne<{ payload: string }>("SELECT payload FROM experiment_audit WHERE id=?", [batchId])
      : null;
    if (frozen) {
      this.state.batch = JSON.parse(frozen.payload).batch;
      return this.state.batch!;
    }
    const events = this.env.STRATEGY_ID === "guidance-continuation" ? await loadLatestGuidanceEvents(this.db, now) : [];
    const candidates =
      this.env.STRATEGY_ID === "guidance-continuation"
        ? events.filter((e) => UNIVERSE[e.event.symbol]).map((e) => ({ symbol: e.event.symbol, event: e.event }))
        : Object.keys(UNIVERSE).map((symbol) => ({ symbol, event: undefined }));
    const rows: Decision[] = [],
      inputs: unknown[] = [];
    // Four at a time; deterministic ranking happens after the entire bounded universe resolves.
    for (let i = 0; i < candidates.length; i += 4) {
      const results = await Promise.allSettled(
        candidates.slice(i, i + 4).map((c) => this.evaluate(c.symbol, now, c.event))
      );
      results.forEach((r, j) => {
        if (r.status === "fulfilled") {
          rows.push(r.value.result);
          inputs.push(r.value.input);
        } else {
          rows.push({
            eventKey: candidates[i + j]!.event?.event_key ?? `${candidates[i + j]!.symbol}:${date}`,
            eventVersion: "unavailable",
            at: new Date(now).toISOString(),
            reasons: ["source_unavailable_or_invalid"],
            plan: null,
          });
          inputs.push(null);
        }
      });
    }
    const account = await this.account(),
      positions = await this.alpaca.trading.getPositions();
    let allocations: ReturnType<typeof allocate> = [];
    try {
      allocations = allocate(
        rows.flatMap((r) => (r.plan ? [r.plan] : [])),
        this.portfolio(account, positions)
      );
    } catch {
      this.state.error = "portfolio_unreconciled";
    }
    const batch: Batch = { date, rows, allocations, attempted: [], complete: true };
    if (freeze) {
      await this.audit(
        "session_batch",
        {
          batch,
          inputs,
          profile: executionProfile(this.env.STRATEGY_ID),
          profileHash: this.state.profileHash,
          brokerEquity: account.equity,
        },
        now,
        batchId
      );
      this.state.batch = batch;
      await this.persist();
    }
    return batch;
  }
  async enter(now: number) {
    const batch = this.state.batch;
    if (!batch || batch.date !== localTime(now).date || !this.canExecute() || this.state.paused) return;
    if (Object.values(this.state.pending).some(entryReservationPending)) return;
    const choice = batch.allocations.find((a) => a.quantity > 0 && !batch.attempted.includes(a.plan.eventKey));
    if (!choice) return;
    // Durable attempt before any external mutation. A skipped or uncertain entry is never chased later.
    batch.attempted.push(choice.plan.eventKey);
    await this.persist();
    const current =
      this.env.STRATEGY_ID === "guidance-continuation"
        ? (await loadLatestGuidanceEvents(this.db, now)).find((e) => e.event.event_key === choice.plan.eventKey)?.event
        : undefined;
    if (this.env.STRATEGY_ID === "guidance-continuation" && (!current || current.version !== choice.plan.eventVersion))
      return;
    const decision = (await this.evaluate(choice.plan.symbol, Date.now(), current)).result;
    const plan = decision.plan;
    if (!plan || plan.limit > choice.plan.limit) return;
    // A better price may shift the unsubmitted stop. Preserve frozen dollar risk,
    // quantity and price caps rather than accidentally demanding an unchanged quote.
    const account = await this.account(),
      positions = await this.alpaca.trading.getPositions();
    const allocation = allocate([plan], this.portfolio(account, positions))[0]!;
    const frozenRisk = choice.quantity * (choice.plan.limit - choice.plan.stop);
    const quantity = Math.min(choice.quantity, allocation.quantity, Math.floor(frozenRisk / (plan.limit - plan.stop)));
    if (!quantity) return;
    const intent = {
      symbol: plan.symbol,
      quantity,
      limit: plan.limit,
      stop: plan.stop,
      expiresAt: plan.expiresAt,
      reason: `${this.env.STRATEGY_ID}:${plan.eventKey}:${plan.eventVersion}`,
    };
    const broker = this.broker(async (order, a, held) => {
      if (a.id !== this.env.EXPECTED_ACCOUNT_ID || this.state.paused || order.expiresAt <= Date.now())
        return "account_or_risk_changed";
      const refreshed = await this.evaluate(plan.symbol, Date.now(), current);
      if (!refreshed.result.plan || refreshed.input.quote.ask > order.limit || refreshed.input.quote.bid <= order.stop)
        return "market_changed";
      const allowed = allocate([plan], this.portfolio(a, held))[0];
      return !allowed || allowed.quantity < order.quantity ? "risk_capacity_changed" : null;
    });
    this.state.entries[plan.symbol] = { plan, quantity, enteredSession: localTime(now).date };
    await this.audit("entry_attempt", { plan, quantity, profileHash: this.state.profileHash }, now);
    await this.persist();
    await broker.buyProtected!(intent);
    if (!this.state.pending[plan.symbol]) delete this.state.entries[plan.symbol];
    await this.persist();
  }
  async tick(manual = false) {
    if (this.busy) throw Error("cycle_in_progress");
    if (!this.state.enabled && !manual) return;
    this.busy = true;
    let delay = 30000;
    try {
      const now = Date.now();
      this.state.lastTick = new Date(now).toISOString();
      this.state.error = null;
      const account = await this.account(); // Must precede ALL reconciliation mutations.
      if (this.canExecute() && !manual) await this.exits(now);
      const clock = await this.alpaca.trading.getClock();
      if (!Number.isFinite(Date.parse(clock.timestamp)) || Math.abs(now - Date.parse(clock.timestamp)) > 60000)
        throw Error("broker_clock_stale");
      const nextOpen = Date.parse(clock.next_open),
        preparation = !clock.is_open && Number.isFinite(nextOpen) && nextOpen - now <= 3600000 && nextOpen > now;
      const positions = await this.alpaca.trading.getPositions(),
        orders = await this.alpaca.trading.listOrders({ status: "open", limit: 100 });
      this.state.broker = {
        equity: account.equity,
        cash: account.cash,
        positions: positions.length,
        openOrders: orders.length,
        at: new Date(now).toISOString(),
      };
      if (now - this.state.lastMark >= 300000) {
        await this.audit(
          "broker_mark",
          { ...this.state.broker, peakEquity: this.state.peakEquity, paused: this.state.paused, mode: this.state.mode },
          now
        );
        this.state.lastMark = now;
      }
      const t = localTime(now);
      if (!manual && clock.is_open && t.minute >= 605 && t.minute < 610) {
        if (this.state.batch?.date !== t.date) await this.scan(now, true);
        if (this.canExecute()) await this.enter(Date.now());
      } else await this.prepare(now);
      // Schedule towards premarket; source collection can continue hourly while the market is closed.
      if (!clock.is_open && !preparation)
        delay = Math.max(30000, Math.min(3600000, nextOpen - now - 3600000 || 3600000));
      if (!Number.isFinite(delay)) delay = 60000;
    } catch (error) {
      this.state.error =
        error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "cycle_dependency_failed";
    } finally {
      this.busy = false;
      this.state.nextTick = this.state.enabled ? new Date(Date.now() + delay).toISOString() : null;
      await this.persist();
      if (this.state.enabled) await this.store.setAlarm(Date.now() + delay);
    }
  }
  async status() {
    const now = Date.now(),
      latest = this.state.sessions.filter((s) => Date.parse(s.close) < now).at(-1)?.date;
    let historiesReady = 0;
    for (const symbol of Object.keys(UNIVERSE))
      if ((await this.store.get<History>(`history:${symbol}`))?.asof === latest && latest) historiesReady++;
    const coverage = await this.db.execute<{ stream: string; state_json: string }>(
      "SELECT stream,state_json FROM research_coverage WHERE stream='finnhub:earnings'"
    );
    return {
      strategy: this.env.STRATEGY_ID,
      profile: executionProfile(this.env.STRATEGY_ID),
      profileHash: this.state.profileHash,
      enabled: this.state.enabled,
      mode: this.state.mode,
      executionAccepted: this.env.EXECUTION_ACCEPTANCE === this.state.profileHash,
      executionAuthorized: this.executionAuthorized(),
      brokerFillValidation:
        this.env.EXECUTION_ACCEPTANCE === this.state.profileHash ? "operator_acceptance_recorded" : "pending",
      paused: this.state.paused,
      lastTick: this.state.lastTick,
      nextTick: this.state.nextTick,
      error: this.state.error,
      broker: this.state.broker ?? null,
      historiesReady,
      universeSize: Object.keys(UNIVERSE).length,
      news: this.state.news
        ? {
            complete: this.state.news.complete,
            through: this.state.news.through,
            error: this.state.news.error ? "news_source_failed" : null,
          }
        : null,
      macro: {
        rejection: this.state.macro ? calendarRejection(this.state.macro, now) : "macro_calendar_missing",
        sourceError: this.state.macroError,
      },
      finnhub: coverage.map((c) => JSON.parse(c.state_json)),
      pending: Object.values(this.state.pending).map((p) => ({ symbol: p.symbol, side: p.side, status: p.status })),
      lastBatch: this.state.batch ?? null,
      brokerOrdersSubmittedByStatus: false,
    };
  }
}
