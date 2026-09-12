/**
 * PolicyEngine-wrapped broker — every autonomous trade goes through policy checks.
 *
 * This is the H2 security fix: the harness used to call alpaca.trading.createOrder()
 * directly, bypassing kill switch, daily loss limits, position concentration, etc.
 * Entries go through PolicyEngine; position closes remain available during a
 * policy kill switch so that risk-reducing exits are not trapped.
 *
 * Strategies call ctx.broker.buy()/sell() and get back true/false.
 * They cannot bypass these safety checks.
 */

import type { OrderPreview } from "../mcp/types";
import type { PolicyConfig } from "../policy/config";
import { type PolicyContext, PolicyEngine } from "../policy/engine";
import type { AlpacaProviders } from "../providers/alpaca";
import type { Account, MarketClock, Order, Position } from "../providers/types";
import type { D1Client } from "../storage/d1/client";
import type { RiskState } from "../storage/d1/queries/risk-state";
import { getRiskState } from "../storage/d1/queries/risk-state";
import { isCryptoSymbol, normalizeCryptoSymbol } from "../strategy/default/helpers/crypto";
import type { StrategyContext } from "../strategy/types";
import type { PendingExecution } from "./types";

export interface PolicyBrokerDeps {
  alpaca: AlpacaProviders;
  policyConfig: PolicyConfig;
  db: D1Client | null;
  log: (agent: string, action: string, details: Record<string, unknown>) => void;
  cryptoSymbols: string[];
  allowedExchanges: string[];
  validateBuy?: (symbol: string) => string | null;
  /** Fetch and validate current market data immediately before submitting an entry. */
  validateExecution?: (symbol: string) => Promise<string | null>;
  canSubmit?: () => boolean;
  pendingExecutions?: Record<string, PendingExecution>;
  persist?: () => Promise<void>;
  maxBuyNotional?: (account: Account, symbol: string) => number;
  /** Save stop/target metadata before the request can reach the broker. */
  onBuyIntent?: (symbol: string, notional: number, reason: string, account: Account) => void;
  onBuyAbandoned?: (symbol: string) => void;
  /** Called after an acknowledged buy submission, not a fill. */
  onBuy?: (symbol: string, notional: number) => void;
  /** Called only after a terminal close order and broker-confirmed zero holding. */
  onSell?: (symbol: string, reason: string) => void;
}

/**
 * Create the broker adapter that strategies use via ctx.broker.
 * Entry policies and persisted submission intents guard broker execution.
 */
export function createPolicyBroker(deps: PolicyBrokerDeps): StrategyContext["broker"] {
  const { alpaca, policyConfig, db, log } = deps;
  const engine = new PolicyEngine(policyConfig);

  // Cache account/positions/clock per cycle to avoid redundant API calls
  let cachedAccount: Account | null = null;
  let cachedPositions: Position[] | null = null;
  let cachedClock: MarketClock | null = null;
  let buyInFlight = false;
  let buySubmitted = false;
  const pendingExecutions = deps.pendingExecutions ?? {};
  const terminal = new Set(["filled", "canceled", "expired", "rejected"]);
  const persist = () => deps.persist?.() ?? Promise.resolve();
  const definitiveRejection = (error: unknown) =>
    ["UNAUTHORIZED", "FORBIDDEN", "INVALID_INPUT", "RATE_LIMITED", "NOT_FOUND"].includes(
      (error as { code?: string })?.code ?? ""
    );

  async function reconcile(): Promise<void> {
    cachedAccount = null;
    cachedPositions = null;
    cachedClock = null;
    for (const [symbol, intent] of Object.entries(pendingExecutions)) {
      try {
        let order: Order | undefined;
        if (intent.order_id) order = await alpaca.trading.getOrder(intent.order_id);
        else if (intent.client_order_id) order = await alpaca.trading.getOrderByClientId(intent.client_order_id);
        else {
          // DELETE /positions cannot accept our client ID. After a timeout,
          // identify a unique recent sell; ambiguous/missing results stay blocked.
          const orders = await alpaca.trading.listOrders({
            status: "all",
            symbols: [symbol],
            after: new Date(intent.submitted_at - 2000).toISOString(),
            limit: 100,
          });
          const matches = orders.filter((o) => {
            const submitted = Date.parse(o.submitted_at);
            return (
              o.symbol === symbol &&
              o.side === "sell" &&
              submitted >= intent.submitted_at - 2000 &&
              submitted <= intent.submitted_at + 12_000 &&
              Number(o.qty) === intent.expected_qty
            );
          });
          if (matches.length === 1) order = matches[0];
        }
        if (!order || order.symbol !== symbol || order.side !== intent.side) continue;
        intent.order_id = order.id;
        intent.status = order.status;
        if (terminal.has(order.status)) {
          const positions = await alpaca.trading.getPositions();
          const matching = positions.filter((p) => p.symbol === symbol);
          if (matching.some((p) => !Number.isFinite(p.qty))) continue;
          const held = matching.some((p) => Math.abs(p.qty) > 0);
          const filledQty = Number(order.filled_qty);
          if (
            typeof order.filled_qty !== "string" ||
            !order.filled_qty.trim() ||
            !Number.isFinite(filledQty) ||
            filledQty < 0
          )
            continue;
          if (intent.side === "buy" && (filledQty > 0 || order.status === "filled") && !held) continue;
          if (intent.side === "sell" && !held) deps.onSell?.(symbol, intent.reason);
          if (intent.side === "buy" && !held) deps.onBuyAbandoned?.(symbol);
          // Filled + residual holding can be broker propagation or an external
          // position change. Wait for agreement; never issue a second close yet.
          if (!(intent.side === "sell" && order.status === "filled" && held)) {
            delete pendingExecutions[symbol];
          }
        }
        await persist();
      } catch (error) {
        log("PolicyBroker", "reconciliation_pending", { symbol, error: String(error) });
      }
    }
  }

  async function getAccount(): Promise<Account> {
    if (!cachedAccount) {
      cachedAccount = await alpaca.trading.getAccount();
    }
    return cachedAccount;
  }

  async function getPositions(): Promise<Position[]> {
    if (!cachedPositions) {
      cachedPositions = await alpaca.trading.getPositions();
    }
    return cachedPositions;
  }

  async function getClock(): Promise<MarketClock> {
    if (!cachedClock) {
      cachedClock = await alpaca.trading.getClock();
    }
    return cachedClock;
  }

  async function getRiskStateOrDefault(): Promise<RiskState> {
    if (!db) {
      return {
        kill_switch_active: false,
        kill_switch_reason: null,
        kill_switch_at: null,
        daily_loss_usd: 0,
        daily_loss_reset_at: null,
        last_loss_at: null,
        cooldown_until: null,
        updated_at: new Date().toISOString(),
      };
    }
    return getRiskState(db);
  }

  async function buy(symbol: string, notional: number, reason: string): Promise<boolean> {
    if (buyInFlight || buySubmitted || Object.keys(pendingExecutions).length > 0) {
      log("PolicyBroker", "buy_blocked", { symbol, reason: "An entry is already in flight or submitted this cycle" });
      return false;
    }
    buyInFlight = true;
    try {
      return await submitBuy(symbol, notional, reason);
    } finally {
      buyInFlight = false;
    }
  }

  async function submitBuy(symbol: string, notional: number, reason: string): Promise<boolean> {
    if (!symbol || symbol.trim().length === 0) {
      log("PolicyBroker", "buy_blocked", { reason: "Empty symbol" });
      return false;
    }

    if (notional <= 0 || !Number.isFinite(notional)) {
      log("PolicyBroker", "buy_blocked", { symbol, reason: "Invalid notional", notional });
      return false;
    }

    const isCrypto = isCryptoSymbol(symbol, deps.cryptoSymbols);
    const orderSymbol = isCrypto ? normalizeCryptoSymbol(symbol) : symbol;
    const assetClass = isCrypto ? "crypto" : "us_equity";
    const timeInForce = isCrypto ? "gtc" : "day";

    if (!isCrypto) {
      const rejection = deps.validateBuy?.(symbol);
      if (rejection) {
        log("PolicyBroker", "buy_blocked", { symbol, reason: rejection });
        return false;
      }
    }

    // Exchange validation for equities
    if (!isCrypto && deps.allowedExchanges.length > 0) {
      try {
        const asset = await alpaca.trading.getAsset(symbol);
        if (!asset || !asset.tradable) {
          log("PolicyBroker", "buy_blocked", { symbol, reason: "Asset not found" });
          return false;
        }
        if (!deps.allowedExchanges.includes(asset.exchange)) {
          log("PolicyBroker", "buy_blocked", {
            symbol,
            reason: "Exchange not allowed",
            exchange: asset.exchange,
          });
          return false;
        }
      } catch {
        log("PolicyBroker", "buy_blocked", { symbol, reason: "Asset lookup failed" });
        return false;
      }
    }

    // Build OrderPreview for PolicyEngine
    const order: OrderPreview = {
      symbol: orderSymbol,
      asset_class: assetClass,
      side: "buy",
      notional: Math.round(notional * 100) / 100,
      order_type: "market",
      time_in_force: timeInForce,
    };

    let ownIntent: PendingExecution | undefined;
    try {
      const [account, positions, clock, riskState] = await Promise.all([
        alpaca.trading.getAccount(),
        alpaca.trading.getPositions(),
        alpaca.trading.getClock(),
        getRiskStateOrDefault(),
      ]);

      // Do not allocate more capital while the broker is still processing an order.
      const pending = await alpaca.trading.listOrders({ status: "open", limit: 1 });
      if (pending.length > 0) {
        log("PolicyBroker", "buy_blocked", { symbol, reason: "Open orders must settle before another entry" });
        return false;
      }
      if (positions.some((p) => p.symbol === orderSymbol || p.symbol === symbol)) {
        log("PolicyBroker", "buy_blocked", { symbol, reason: "Already held; no automatic pyramiding" });
        return false;
      }
      if (!isCrypto && deps.maxBuyNotional) {
        notional = Math.min(notional, deps.maxBuyNotional(account, symbol));
        if (!Number.isFinite(notional) || notional < 100) return false;
        notional = Math.floor(notional * 100) / 100;
        order.notional = notional;
      }
      const ctx: PolicyContext = { order, account, positions, clock, riskState };
      const result = engine.evaluate(ctx);

      if (!result.allowed) {
        log("PolicyBroker", "buy_rejected", {
          symbol,
          notional,
          violations: result.violations.map((v) => v.message),
        });
        return false;
      }

      if (result.warnings.length > 0) {
        log("PolicyBroker", "buy_warnings", {
          symbol,
          warnings: result.warnings.map((w) => w.message),
        });
      }

      if (!isCrypto) {
        const rejection = await deps.validateExecution?.(symbol);
        if (rejection) {
          log("PolicyBroker", "buy_blocked", { symbol, reason: rejection });
          return false;
        }
      }
      // Stop may have been requested while any of the above reads were pending.
      if (deps.canSubmit && !deps.canSubmit()) return false;
      if (Object.keys(pendingExecutions).length > 0) return false;
      if (!isCrypto && deps.validateBuy?.(symbol)) return false;
      const clientOrderId = `mahoraga-${crypto.randomUUID()}`;
      ownIntent = {
        symbol: orderSymbol,
        side: "buy",
        reason,
        submitted_at: Date.now(),
        client_order_id: clientOrderId,
        status: "submitting",
      };
      pendingExecutions[orderSymbol] = ownIntent;
      deps.onBuyIntent?.(symbol, notional, reason, account);
      // Persist BEFORE HTTP: a crash or timeout must not permit duplicate orders.
      await persist();
      if (deps.canSubmit && !deps.canSubmit()) {
        delete pendingExecutions[orderSymbol];
        deps.onBuyAbandoned?.(symbol);
        await persist();
        return false;
      }
      const alpacaOrder = await alpaca.trading.createOrder({
        symbol: orderSymbol,
        notional: Math.round(notional * 100) / 100,
        side: "buy",
        type: "market",
        time_in_force: timeInForce,
        client_order_id: clientOrderId,
      });

      pendingExecutions[orderSymbol]!.order_id = alpacaOrder.id;
      pendingExecutions[orderSymbol]!.status = alpacaOrder.status;
      await persist();

      buySubmitted = true;
      log("PolicyBroker", "buy_submitted", {
        symbol: orderSymbol,
        isCrypto,
        status: alpacaOrder.status,
        notional,
        reason,
      });

      // Invalidate cache after order
      cachedAccount = null;
      cachedPositions = null;

      deps.onBuy?.(symbol, notional);
      return true;
    } catch (error) {
      if (ownIntent && definitiveRejection(error) && pendingExecutions[orderSymbol] === ownIntent) {
        delete pendingExecutions[orderSymbol];
        deps.onBuyAbandoned?.(symbol);
        await persist();
      }
      log("PolicyBroker", "buy_failed", { symbol, error: String(error) });
      return false;
    }
  }

  async function sell(symbol: string, reason: string): Promise<boolean> {
    if (!symbol || symbol.trim().length === 0) {
      log("PolicyBroker", "sell_blocked", { reason: "Empty symbol" });
      return false;
    }

    if (!reason || reason.trim().length === 0) {
      log("PolicyBroker", "sell_blocked", { symbol, reason: "No sell reason provided" });
      return false;
    }
    if (pendingExecutions[symbol] || (deps.canSubmit && !deps.canSubmit())) return false;

    // For sells (closing positions), we skip full PolicyEngine evaluation.
    // Closing a position is risk-reducing — blocking exits on kill switch
    // or cooldown would trap users in losing positions.
    // We only check kill switch to log a warning (but still execute).
    let ownIntent: PendingExecution | undefined;
    try {
      if (db) {
        const riskState = await getRiskStateOrDefault();
        if (riskState.kill_switch_active) {
          log("PolicyBroker", "sell_during_kill_switch", {
            symbol,
            reason,
            note: "Executing sell despite kill switch — closing positions is risk-reducing",
          });
        }
      }

      const open = await alpaca.trading.listOrders({ status: "open", symbols: [symbol], limit: 100 });
      const holding = (await alpaca.trading.getPositions()).find((p) => p.symbol === symbol);
      if (!holding || !Number.isFinite(holding.qty) || holding.qty <= 0 || holding.side === "short") return false;
      if (open.length || pendingExecutions[symbol] || (deps.canSubmit && !deps.canSubmit())) return false;
      ownIntent = {
        symbol,
        side: "sell",
        reason,
        submitted_at: Date.now(),
        status: "submitting",
        expected_qty: holding.qty,
      };
      pendingExecutions[symbol] = ownIntent;
      await persist();
      if (deps.canSubmit && !deps.canSubmit()) {
        delete pendingExecutions[symbol];
        await persist();
        return false;
      }
      const order = await alpaca.trading.closePosition(symbol);
      pendingExecutions[symbol]!.order_id = order.id;
      pendingExecutions[symbol]!.status = order.status;
      await persist();
      log("PolicyBroker", "sell_submitted", { symbol, reason, status: order.status });

      // Invalidate cache after order
      cachedAccount = null;
      cachedPositions = null;

      return true;
    } catch (error) {
      if (ownIntent && definitiveRejection(error) && pendingExecutions[symbol] === ownIntent) {
        delete pendingExecutions[symbol];
        await persist();
      }
      log("PolicyBroker", "sell_failed", { symbol, error: String(error) });
      return false;
    }
  }

  return {
    getAccount,
    getPositions,
    getClock,
    reconcile,
    buy,
    sell,
  };
}
