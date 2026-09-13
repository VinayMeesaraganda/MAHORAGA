import type { Order, Position } from "../providers/types";
import type { PendingExecution } from "./types";

export const TERMINAL = new Set(["filled", "canceled", "expired", "rejected"]);
export function confirmedProtection(order: Order, position: Position, stop: number): boolean {
  if (
    typeof order.filled_qty !== "string" ||
    !order.filled_qty.trim() ||
    !Number.isFinite(Number(order.filled_qty)) ||
    Number(order.filled_qty) < 0
  )
    return false;
  return (
    order.symbol === position.symbol &&
    order.side === "sell" &&
    order.type === "stop" &&
    ["new", "accepted", "partially_filled"].includes(order.status) &&
    Number(order.qty) - Number(order.filled_qty) === position.qty &&
    Number(order.stop_price) >= stop &&
    order.time_in_force === "gtc" &&
    position.side === "long" &&
    position.qty > 0
  );
}
export function entryReservationPending(intent: PendingExecution): boolean {
  return !intent.protected_entry || intent.status !== "protected" || !!intent.protected_entry.closing_reason;
}
