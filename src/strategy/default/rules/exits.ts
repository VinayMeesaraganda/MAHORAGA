/**
 * Exit rules — decide which positions to sell.
 *
 * Core ALWAYS enforces stop-loss/take-profit on top of strategy exits.
 * This function handles: TP, SL, staleness, and options exits.
 */

import type { Account, Position } from "../../../core/types";
import type { SellCandidate, StrategyContext } from "../../types";
import { analyzeStaleness } from "./staleness";

/**
 * Evaluate all positions and return sell candidates.
 * Core handles the actual order execution.
 */
export function selectExits(ctx: StrategyContext, positions: Position[], _account: Account): SellCandidate[] {
  const exits: SellCandidate[] = [];

  for (const pos of positions) {
    // Options are handled separately
    if (pos.asset_class === "us_option") {
      const optionExit = checkOptionsExit(pos, ctx);
      if (optionExit) exits.push(optionExit);
      continue;
    }

    const plPct = (pos.unrealized_pl / (pos.market_value - pos.unrealized_pl)) * 100;

    // Entry price and peak are recorded as 0 at submission time, because the
    // fill price is not known until the broker reports the position. Backfill
    // them here: this runs on every open-market alarm, so the trailing stop and
    // the staleness score do not depend on anything polling /agent/status.
    const posEntry = ctx.positionEntries[pos.symbol];
    if (posEntry) {
      if (posEntry.entry_price === 0 && pos.avg_entry_price > 0) posEntry.entry_price = pos.avg_entry_price;
      if (pos.current_price > 0) posEntry.peak_price = Math.max(posEntry.peak_price, pos.current_price);
    }

    // Levels are fixed at entry from that name's volatility. Config values are
    // the fallback for positions opened before this existed, or when ATR was
    // unavailable, so a stop always exists either way.
    const stopPct = posEntry?.stop_pct ?? ctx.config.stop_loss_pct;
    const targetPct = posEntry?.target_pct ?? ctx.config.take_profit_pct;

    // Mandatory exits precede news adjudication for this issuer. The harness
    // also services all deterministic candidates before any issuer's LLM call.
    if (plPct <= -stopPct) {
      exits.push({ symbol: pos.symbol, reason: `Stop loss at ${plPct.toFixed(1)}%` });
      continue;
    }
    if (ctx.config.max_hold_days > 0 && posEntry) {
      const days = (Date.now() - posEntry.entry_time) / 86_400_000;
      if (days >= ctx.config.max_hold_days) {
        exits.push({ symbol: pos.symbol, reason: `Time stop: held ${days.toFixed(1)} days at ${plPct.toFixed(1)}%` });
        continue;
      }
    }

    // Adverse issuer news is the one evidence-based reason to leave before the
    // target. Placed ahead of it because a dilutive offering does not become
    // acceptable just because the position happens to be green.
    //
    // Reuses the news gatherer's per-issuer invalidation rather than keeping a
    // second cache: that record is single-issuer only, survives restarts, and
    // is already ordering-independent. Only invalidation that happened after
    // this position was opened counts — news that predates the entry was
    // already visible to the entry gate.
    if (ctx.config.exit_on_adverse_news && posEntry) {
      const invalidatedAt = ctx.state.get<Record<string, number>>("catalystInvalidatedAt") ?? {};
      const flaggedAt = invalidatedAt[pos.symbol.toUpperCase()] ?? invalidatedAt[pos.symbol];
      if (Number.isFinite(flaggedAt) && (flaggedAt as number) > posEntry.entry_time) {
        const ageMins = (Date.now() - (flaggedAt as number)) / 60_000;
        exits.push({
          symbol: pos.symbol,
          reason: `Adverse issuer news ${ageMins.toFixed(0)}m ago invalidated the thesis`,
        });
        continue;
      }
    }

    // Take profit
    if (plPct >= targetPct) {
      exits.push({
        symbol: pos.symbol,
        reason: `Take profit at +${plPct.toFixed(1)}%`,
      });
      continue;
    }

    // Stop loss
    if (plPct <= -stopPct) {
      exits.push({
        symbol: pos.symbol,
        reason: `Stop loss at ${plPct.toFixed(1)}%`,
      });
      continue;
    }

    // An overnight gap hands over a gain the position never earned intraday, and
    // nothing here can see or act on it while it happens: extended-hours prices
    // never reach peak_price because exits run only while the market is open,
    // and no exit could be taken then in any case. So the first check of a
    // session is the only chance to keep it. Above the threshold, take it rather
    // than hold for the remainder of a target the gap may have already retraced.
    if (ctx.config.gap_capture_r > 0 && posEntry && stopPct > 0) {
      const today = new Date().toISOString().slice(0, 10);
      if (posEntry.last_gap_check_day !== today) {
        posEntry.last_gap_check_day = today;
        const r = plPct / stopPct;
        if (r >= ctx.config.gap_capture_r) {
          exits.push({
            symbol: pos.symbol,
            reason: `Gap capture: session opened at +${plPct.toFixed(1)}% (${r.toFixed(2)}R) before the target`,
          });
          continue;
        }
      }
    }

    // Trailing stop — protect an open gain once there is one worth protecting.
    // The arm threshold is deliberately separate from the give-back distance:
    // when they are equal the exit lands near break-even, which caps average
    // wins at roughly the trail distance and pushes the break-even hit rate
    // above 50%. Arming higher than the trail locks in a real minimum gain
    // while leaving room for a position to reach the profit target.
    // R units are the correct frame once the stop is derived from volatility:
    // one R is this position's own stop distance, so the same setting means the
    // same risk on a 5.7% stop and a 15% one. Falls back to the percentage
    // fields when R trailing is not configured.
    const useR = ctx.config.trailing_stop_r > 0 && ctx.config.trailing_arm_r > 0 && stopPct > 0;
    const trail = useR ? ctx.config.trailing_stop_r * stopPct : ctx.config.trailing_stop_pct;
    const armAt = useR
      ? ctx.config.trailing_arm_r * stopPct
      : ctx.config.trailing_arm_pct > 0
        ? ctx.config.trailing_arm_pct
        : trail;
    if (trail > 0 && posEntry && posEntry.entry_price > 0 && posEntry.peak_price > 0) {
      const peakGainPct = ((posEntry.peak_price - posEntry.entry_price) / posEntry.entry_price) * 100;
      const drawdownFromPeakPct = ((posEntry.peak_price - pos.current_price) / posEntry.peak_price) * 100;
      // One R is a fixed dollar distance from the fill, not a percentage of an
      // ever-higher peak. At a $100 fill / 15% stop, a 1R trail is always $15:
      // a $122.50 peak therefore trails at $107.50, not $104.125.
      const trailingFloor = useR
        ? posEntry.peak_price - (posEntry.entry_price * trail) / 100
        : posEntry.peak_price * (1 - trail / 100);
      if (peakGainPct >= armAt && pos.current_price <= trailingFloor) {
        exits.push({
          symbol: pos.symbol,
          reason: `Trailing stop: ${drawdownFromPeakPct.toFixed(1)}% off peak (peak was +${peakGainPct.toFixed(1)}%, ${useR ? `${(peakGainPct / stopPct).toFixed(1)}R` : "pct mode"})`,
        });
        continue;
      }
    }

    // Time stop — a deterministic maximum hold that does not depend on social
    // history being available, unlike the staleness score below.
    if (ctx.config.max_hold_days > 0 && posEntry) {
      const holdDays = (Date.now() - posEntry.entry_time) / 86_400_000;
      if (holdDays >= ctx.config.max_hold_days) {
        exits.push({
          symbol: pos.symbol,
          reason: `Time stop: held ${holdDays.toFixed(1)} days at ${plPct.toFixed(1)}%`,
        });
        continue;
      }
    }

    // Staleness check
    if (ctx.config.stale_position_enabled) {
      // Get current social volume from strategy state
      const socialSnapshot = ctx.state.get<Record<string, { volume: number }>>("socialSnapshotCache") ?? {};
      const currentSocialVolume = socialSnapshot[pos.symbol]?.volume ?? 0;

      const stalenessResult = analyzeStaleness(
        pos.symbol,
        pos.current_price,
        currentSocialVolume,
        posEntry,
        ctx.config
      );

      // Store for status dashboard visibility
      const stalenessState = ctx.state.get<Record<string, unknown>>("stalenessAnalysis") ?? {};
      stalenessState[pos.symbol] = stalenessResult;
      ctx.state.set("stalenessAnalysis", stalenessState);

      if (stalenessResult.isStale) {
        exits.push({
          symbol: pos.symbol,
          reason: `STALE: ${stalenessResult.reason}`,
        });
      }
    }
  }

  return exits;
}

function checkOptionsExit(pos: Position, ctx: StrategyContext): SellCandidate | null {
  if (!ctx.config.options_enabled) return null;

  const entryPrice = pos.avg_entry_price || pos.current_price;
  const plPct = entryPrice > 0 ? ((pos.current_price - entryPrice) / entryPrice) * 100 : 0;

  if (plPct <= -ctx.config.options_stop_loss_pct) {
    return {
      symbol: pos.symbol,
      reason: `Options stop loss at ${plPct.toFixed(1)}%`,
    };
  }

  if (plPct >= ctx.config.options_take_profit_pct) {
    return {
      symbol: pos.symbol,
      reason: `Options take profit at +${plPct.toFixed(1)}%`,
    };
  }

  return null;
}
