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
import { recordOrderLoss } from "../storage/d1/queries/fill-loss";
import { isCryptoSymbol, normalizeCryptoSymbol } from "../strategy/default/helpers/crypto";
import type { StrategyContext } from "../strategy/types";
import type { PendingExecution } from "./types";
import { confirmedProtection, entryReservationPending } from "./protection";

export interface ProtectedBuy {
  symbol: string;
  quantity: number;
  limit: number;
  stop: number;
  expiresAt: number;
  reason: string;
}

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
  /** Deliberately absent in the production harness until paper lifecycle acceptance. */
  validateProtectedEntry?: (intent: ProtectedBuy, account: Account, positions: Position[]) => Promise<string | null>;
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
  const hasOpeningIntent = () => Object.values(pendingExecutions).some(entryReservationPending);
  const placeOrder = (params: Parameters<typeof alpaca.trading.createOrder>[0]) => alpaca.trading.createOrder(params);
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
        if (intent.protected_entry) {
          await reconcileProtected(symbol, intent, order);
          await persist();
          continue;
        }
        if (intent.side === "sell" && Number(order.filled_qty) > 0 && db) {
          await recordOrderLoss(db, order, intent.entry_basis ?? Number.NaN, policyConfig.cooldown_minutes_after_loss);
        }
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

  async function reconcileProtected(symbol: string, intent: PendingExecution, parent: Order): Promise<void> {
    const protection = intent.protected_entry!;
    const positions = await alpaca.trading.getPositions();
    const held = positions.find((p) => p.symbol === symbol && p.qty !== 0);
    if (held && (!Number.isFinite(held.qty) || held.qty <= 0 || held.side !== "long"))
      throw new Error("Unexpected protected holding");
    const parentQty = Number(parent.filled_qty);
    if (
      typeof parent.filled_qty !== "string" ||
      !parent.filled_qty.trim() ||
      !Number.isFinite(parentQty) ||
      parentQty < 0 ||
      (parent.status === "filled" && parentQty === 0) ||
      (intent.expected_qty !== undefined && parentQty > intent.expected_qty)
    )
      throw new Error("Invalid parent fills");
    // Resolve all children before replacing protection or liquidating. Unknown outcomes stay blocked.
    const siblings = await alpaca.trading.listOrders({
      status: "all",
      symbols: [symbol],
      nested: true,
      after: new Date(intent.submitted_at - 2000).toISOString(),
      limit: 100,
    });
    const expanded = siblings.flatMap((o) => [o, ...(o.legs ?? [])]);
    const parentRecord = siblings.find((o) => o.id === parent.id) ?? parent;
    let child = protection.protective_order_id
      ? await alpaca.trading.getOrder(protection.protective_order_id)
      : parentRecord.legs?.find((o) => o.side === "sell" && o.type === "stop");
    if (!child && protection.protective_client_id)
      child = await alpaca.trading.getOrderByClientId(protection.protective_client_id);
    if (child) {
      protection.protective_order_id = child.id;
      protection.protective_order_ids = [...new Set([...(protection.protective_order_ids ?? []), child.id])];
    }
    let protectiveFills = 0;
    for (const id of protection.protective_order_ids ?? []) {
      const owned = id === child?.id ? child : await alpaca.trading.getOrder(id);
      const quantity = Number(owned.filled_qty);
      if (
        owned.symbol !== symbol ||
        owned.side !== "sell" ||
        typeof owned.filled_qty !== "string" ||
        !owned.filled_qty.trim() ||
        !Number.isFinite(quantity) ||
        quantity < 0
      )
        throw new Error("Invalid protective fills");
      protectiveFills += quantity;
      if (quantity > 0 && db)
        await recordOrderLoss(db, owned, Number(parent.filled_avg_price), policyConfig.cooldown_minutes_after_loss);
    }
    if (!terminal.has(parent.status)) {
      // Partial quantity must not wait indefinitely for a native OTO leg to activate.
      if (parentQty > 0 || Date.now() >= protection.expires_at || protection.closing_reason)
        await alpaca.trading.cancelOrder(parent.id);
      return; // cancel acknowledgement does not terminate the parent
    }
    if (!held) {
      if (parentQty > 0 && (!child || !terminal.has(child.status) || Math.abs(protectiveFills - parentQty) > 1e-8))
        return;
      if (child && !terminal.has(child.status)) {
        await alpaca.trading.cancelOrder(child.id);
        return;
      }
      delete pendingExecutions[symbol];
      if (parentQty > 0) deps.onSell?.(symbol, "broker protective stop filled");
      else deps.onBuyAbandoned?.(symbol);
      return;
    }
    if (
      !Number.isFinite(Number(parent.filled_avg_price)) ||
      Number(parent.filled_avg_price) <= 0 ||
      held.qty > parentQty ||
      Math.abs(held.qty + protectiveFills - parentQty) > 1e-8 ||
      !Number.isFinite(held.avg_entry_price) ||
      Math.abs(held.avg_entry_price - Number(parent.filled_avg_price)) > 0.01
    )
      throw new Error("Holding does not reconcile with protected parent");
    if (child && !terminal.has(child.status)) {
      if (!protection.closing_reason && confirmedProtection(child, held, protection.stop)) {
        intent.status = "protected";
        return;
      }
      await alpaca.trading.cancelOrder(child.id);
      return;
    }
    const otherOpen = expanded.filter((o) => !terminal.has(o.status) && o.id !== parent.id);
    if (otherOpen.length || siblings.length >= 100) return; // incomplete or competing order view
    if (protection.closing_reason) {
      // Hand off only after every protective order is broker-confirmed terminal.
      const reason = protection.closing_reason;
      delete pendingExecutions[symbol];
      await sell(symbol, reason);
      if (!pendingExecutions[symbol]) {
        pendingExecutions[symbol] = intent;
        await persist();
      }
      return;
    }
    // A canceled partial parent may leave no usable child. Create one stop with a
    // persisted client ID. Timeout recovery looks up that ID, never submits another.
    if (protection.protective_client_id && !child) return;
    protection.protective_order_id = undefined;
    protection.protective_client_id = `mahoraga-stop-${crypto.randomUUID()}`;
    intent.status = "protecting";
    await persist();
    const stop = await placeOrder({
      symbol,
      qty: held.qty,
      side: "sell",
      type: "stop",
      stop_price: protection.stop,
      time_in_force: "gtc",
      client_order_id: protection.protective_client_id,
    });
    protection.protective_order_id = stop.id;
    if (terminal.has(stop.status) && stop.status !== "filled")
      protection.closing_reason = "Protective stop rejected; flatten residual";
    // An acknowledgement is insufficient: next reconciliation verifies open quantity.
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
    if (buyInFlight || buySubmitted || hasOpeningIntent()) {
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

  async function submitBuy(
    symbol: string,
    notional: number,
    reason: string,
    protectedBuy?: ProtectedBuy
  ): Promise<boolean> {
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

    if (!isCrypto && !protectedBuy) {
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
      order_type: protectedBuy ? "limit" : "market",
      ...(protectedBuy ? { qty: protectedBuy.quantity, limit_price: protectedBuy.limit } : {}),
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
      const pending = await alpaca.trading.listOrders({ status: "open", limit: 100 });
      const unowned = pending.filter((o) => {
        const owner = pendingExecutions[o.symbol];
        const position = positions.find((p) => p.symbol === o.symbol);
        return !(
          owner?.protected_entry &&
          owner.status === "protected" &&
          owner.protected_entry.protective_order_id === o.id &&
          position &&
          confirmedProtection(o, position, owner.protected_entry.stop)
        );
      });
      if (unowned.length > 0 || pending.length >= 100) {
        log("PolicyBroker", "buy_blocked", { symbol, reason: "Open orders must settle before another entry" });
        return false;
      }
      if (positions.some((p) => p.symbol === orderSymbol || p.symbol === symbol)) {
        log("PolicyBroker", "buy_blocked", { symbol, reason: "Already held; no automatic pyramiding" });
        return false;
      }
      if (protectedBuy) {
        if (!deps.validateProtectedEntry || (await deps.validateProtectedEntry(protectedBuy, account, positions)))
          return false;
      }
      if (!isCrypto && !protectedBuy && deps.maxBuyNotional) {
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

      if (!isCrypto && !protectedBuy) {
        const rejection = await deps.validateExecution?.(symbol);
        if (rejection) {
          log("PolicyBroker", "buy_blocked", { symbol, reason: rejection });
          return false;
        }
      }
      // Stop may have been requested while any of the above reads were pending.
      if (deps.canSubmit && !deps.canSubmit()) return false;
      if (hasOpeningIntent()) return false;
      if (!isCrypto && !protectedBuy && deps.validateBuy?.(symbol)) return false;
      if (protectedBuy && Date.now() >= protectedBuy.expiresAt) return false;
      const clientOrderId = `mahoraga-${crypto.randomUUID()}`;
      ownIntent = {
        symbol: orderSymbol,
        side: "buy",
        reason,
        submitted_at: Date.now(),
        client_order_id: clientOrderId,
        status: "submitting",
        ...(protectedBuy
          ? {
              expected_qty: protectedBuy.quantity,
              protected_entry: {
                stop: protectedBuy.stop,
                limit: protectedBuy.limit,
                expires_at: protectedBuy.expiresAt,
              },
            }
          : {}),
      };
      pendingExecutions[orderSymbol] = ownIntent;
      if (!protectedBuy) deps.onBuyIntent?.(symbol, notional, reason, account);
      // Persist BEFORE HTTP: a crash or timeout must not permit duplicate orders.
      await persist();
      if (deps.canSubmit && !deps.canSubmit()) {
        delete pendingExecutions[orderSymbol];
        deps.onBuyAbandoned?.(symbol);
        await persist();
        return false;
      }
      const alpacaOrder = await placeOrder({
        symbol: orderSymbol,
        ...(protectedBuy
          ? {
              qty: protectedBuy.quantity,
              limit_price: protectedBuy.limit,
              order_class: "oto" as const,
              stop_loss: { stop_price: protectedBuy.stop },
            }
          : { notional: Math.round(notional * 100) / 100 }),
        side: "buy",
        type: protectedBuy ? "limit" : "market",
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

  async function buyProtected(intent: ProtectedBuy): Promise<boolean> {
    if (!deps.validateProtectedEntry || !deps.persist || buyInFlight || buySubmitted || hasOpeningIntent())
      return false;
    if (
      !/^[A-Z][A-Z0-9.-]{0,14}$/.test(intent.symbol) ||
      !intent.reason.trim() ||
      !Number.isSafeInteger(intent.quantity) ||
      intent.quantity <= 0 ||
      ![intent.limit, intent.stop, intent.expiresAt].every(Number.isFinite) ||
      intent.stop <= 0 ||
      intent.limit <= intent.stop ||
      Date.now() >= intent.expiresAt ||
      intent.expiresAt - Date.now() > 60_000 ||
      [intent.stop, intent.limit].some((p) => Math.abs(p * 100 - Math.round(p * 100)) > 1e-7) ||
      isCryptoSymbol(intent.symbol, deps.cryptoSymbols)
    )
      return false;
    buyInFlight = true;
    try {
      return await submitBuy(intent.symbol, intent.quantity * intent.limit, intent.reason, intent);
    } finally {
      buyInFlight = false;
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
    if (deps.canSubmit && !deps.canSubmit()) return false;
    const protectedIntent = pendingExecutions[symbol];
    if (protectedIntent?.protected_entry) {
      protectedIntent.protected_entry.closing_reason = reason;
      protectedIntent.status = "closing_protection";
      await persist();
      return false; // reconciliation cancels protection before closing
    }
    if (pendingExecutions[symbol]) return false;

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
        entry_basis: holding.avg_entry_price,
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
    buyProtected,
    sell,
  };
}
