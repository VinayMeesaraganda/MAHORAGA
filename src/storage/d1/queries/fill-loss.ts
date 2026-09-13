import type { Order } from "../../../providers/types";
import type { D1Client } from "../client";
import { riskDay } from "./risk-state";

const day = (at: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
/** Cumulative broker fill deltas, fixed broker cost basis. Atomic idempotency and risk-state update.
 * Partial fills use broker updated_at when filled_at is not yet available. This is an
 * autonomous-order ledger, not tax-lot accounting or a backfill of external trades.
 */
export async function recordOrderLoss(
  db: D1Client,
  order: Order,
  basis: number,
  cooldownMinutes: number,
  now = Date.now()
): Promise<void> {
  const qty = Number(order.filled_qty),
    price = Number(order.filled_avg_price);
  if (qty === 0) return;
  const fillAt = order.filled_at ?? order.updated_at;
  if (
    !order.id ||
    order.side !== "sell" ||
    ![qty, price, basis].every((v) => Number.isFinite(v) && v > 0) ||
    !Number.isFinite(Date.parse(fillAt)) ||
    Date.parse(fillAt) > now
  )
    throw new Error("Unusable broker fill for loss accounting");
  const previous = await db.executeOne<{ cumulative_qty: number; cumulative_proceeds: number }>(
    "SELECT cumulative_qty, cumulative_proceeds FROM reconciled_loss_fills WHERE order_id = ? ORDER BY cumulative_qty DESC LIMIT 1",
    [order.id]
  );
  if (previous && qty <= previous.cumulative_qty) {
    if (qty < previous.cumulative_qty) throw new Error("Broker filled quantity regressed; reconcile correction");
    if (qty === previous.cumulative_qty && Math.abs(price * qty - previous.cumulative_proceeds) > 0.01)
      throw new Error("Broker fill correction requires reconciliation");
    return;
  }
  const proceeds = qty * price,
    deltaQty = qty - (previous?.cumulative_qty ?? 0);
  const loss = Math.max(0, deltaQty * basis - (proceeds - (previous?.cumulative_proceeds ?? 0)));
  const today = day(new Date(now).toISOString()),
    fillDay = day(fillAt);
  const cooldown = new Date(Date.parse(fillAt) + cooldownMinutes * 60_000).toISOString();
  const id = `${order.id}:${qty}`;
  const state = await db.executeOne<{ daily_loss_reset_at: string | null }>(
    "SELECT daily_loss_reset_at FROM risk_state WHERE id = 1"
  );
  if (!state) throw new Error("Risk state missing");
  const legacyToday =
    state.daily_loss_reset_at && riskDay(state.daily_loss_reset_at) === today ? state.daily_loss_reset_at : today;
  await db.batch([
    db
      .prepare(
        "INSERT OR IGNORE INTO reconciled_loss_fills (id, symbol, order_id, cumulative_qty, cumulative_proceeds, loss_usd, filled_at, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(id, order.symbol, order.id, qty, proceeds, loss, fillAt, new Date(now).toISOString()),
    db
      .prepare(`UPDATE risk_state SET
      daily_loss_usd = CASE WHEN daily_loss_reset_at IN (?, ?) THEN daily_loss_usd ELSE 0 END + ?,
      daily_loss_reset_at = ?,
      last_loss_at = CASE WHEN ? > 0 AND (last_loss_at IS NULL OR last_loss_at < ?) THEN ? ELSE last_loss_at END,
      cooldown_until = CASE WHEN ? > 0 AND (cooldown_until IS NULL OR cooldown_until < ?) THEN ? ELSE cooldown_until END,
      updated_at = ? WHERE id = 1 AND changes() = 1`)
      .bind(
        today,
        legacyToday,
        fillDay === today ? loss : 0,
        today,
        loss,
        fillAt,
        fillAt,
        loss,
        cooldown,
        cooldown,
        new Date(now).toISOString()
      ),
  ]);
}
