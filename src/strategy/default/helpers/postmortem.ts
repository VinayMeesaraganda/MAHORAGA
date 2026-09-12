/**
 * Exit attribution — why a thesis did not play out.
 *
 * "It lost money" is not a lesson. The useful question is which part was wrong,
 * because each answer implies a different fix:
 *
 *   thesis          the catalyst simply produced no drift   -> selection is wrong
 *   company_event   adverse news arrived after entry        -> selection was fine
 *   macro           the tape moved against everything       -> nothing was wrong
 *   sector          the sector moved against it             -> add a sector filter
 *   stop_too_tight  stopped out, then it recovered          -> risk sizing is wrong
 *
 * The distinction between the first and the last two matters most. A thesis that
 * was right but stopped out by noise, or drowned by a market-wide selloff, is
 * evidence *for* the selection process and against the risk settings. Treating
 * those as thesis failures is how a working edge gets tuned away.
 *
 * Attribution needs entry state, exit state, and what the benchmark did in
 * between — none of which can be recovered after the fact, which is why the
 * journal captures entry state at entry.
 */

export type ExitCause =
  | "target_hit"
  | "thesis"
  | "company_event"
  | "macro"
  | "sector"
  | "stop_too_tight"
  | "time_expired"
  | "unknown";

export interface ExitEvidence {
  /** Percentage move from entry to exit. */
  pnl_pct: number;
  /** Planned stop distance at entry, in percent. */
  stop_pct: number;
  /** Whatever the exit rule reported. */
  exit_reason: string;
  /** Benchmark move over the same window, in percent. Null when unavailable. */
  market_pct: number | null;
  /** Sector ETF move over the same window, in percent. */
  sector_pct: number | null;
  /** Disqualifying headlines published after entry. */
  adverse_news: string[];
  /**
   * Highest price seen after the exit, against entry, in percent. Null at exit
   * time — it is a future measurement, added by a later review pass.
   */
  recovered_to_pct: number | null;
  /** Daily ATR at entry, for judging whether the adverse move was ordinary. */
  atr_pct_at_entry: number | null;
}

export interface ExitAttribution {
  cause: ExitCause;
  /** One line stating the finding and the evidence behind it. */
  explanation: string;
  /** True when the loss says more about risk settings than about selection. */
  selection_still_valid: boolean;
}

/** A move this far beyond the benchmark is the name's own, not the tape's. */
const IDIOSYNCRATIC_BAND_PCT = 2;

export function attributeExit(e: ExitEvidence): ExitAttribution {
  const won = e.pnl_pct > 0;
  const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

  if (won && /take profit|target/i.test(e.exit_reason)) {
    return { cause: "target_hit", explanation: `Target reached at ${pct(e.pnl_pct)}.`, selection_still_valid: true };
  }

  // 1. Did the company change after we bought it? Selection was sound at entry;
  //    the information arrived afterwards.
  if (e.adverse_news.length) {
    return {
      cause: "company_event",
      explanation: `Adverse company news after entry — "${e.adverse_news[0]?.slice(0, 90)}". Result ${pct(e.pnl_pct)}. The thesis was reasonable on the information available at entry.`,
      selection_still_valid: true,
    };
  }

  // 2. Was the adverse move merely an ordinary day for this name?
  //
  //    Recovery after the exit is the cleanest evidence, but it lies in the
  //    future and cannot be known when the trade closes. The ATR test is
  //    available immediately: being stopped by a move smaller than one and a
  //    half normal daily ranges says the stop sat inside the noise, whatever
  //    the price does next.
  const stopped = /stop loss|trailing stop/i.test(e.exit_reason);
  const withinNoise = e.atr_pct_at_entry !== null && Math.abs(e.pnl_pct) < e.atr_pct_at_entry * 1.5;
  if (e.pnl_pct < 0 && (e.recovered_to_pct !== null ? e.recovered_to_pct > 0 : stopped && withinNoise)) {
    const recovery = e.recovered_to_pct !== null ? ` then recovered to ${pct(e.recovered_to_pct)}` : "";
    const noise = withinNoise
      ? ` The adverse move was under 1.5x daily ATR (${e.atr_pct_at_entry?.toFixed(1)}%), so it was ordinary range rather than a broken thesis.`
      : "";
    return {
      cause: "stop_too_tight",
      explanation: `Exited at ${pct(e.pnl_pct)}${recovery}.${noise} Direction may have been right; the stop was too close.`,
      selection_still_valid: true,
    };
  }

  // 3. Did everything fall? Losing with the tape is not a selection error.
  if (e.market_pct !== null && e.market_pct < -0.5 && e.pnl_pct < 0) {
    const excess = e.pnl_pct - e.market_pct;
    if (excess > -IDIOSYNCRATIC_BAND_PCT) {
      return {
        cause: "macro",
        explanation: `Market fell ${pct(e.market_pct)} over the hold; this lost ${pct(e.pnl_pct)}, within ${IDIOSYNCRATIC_BAND_PCT}% of the tape. The name did not underperform.`,
        selection_still_valid: true,
      };
    }
  }

  // 4. Did the sector go against it while the tape held up?
  if (e.sector_pct !== null && e.sector_pct < -1 && e.pnl_pct < 0) {
    const excess = e.pnl_pct - e.sector_pct;
    if (excess > -IDIOSYNCRATIC_BAND_PCT) {
      return {
        cause: "sector",
        explanation: `Sector fell ${pct(e.sector_pct)} over the hold; this lost ${pct(e.pnl_pct)}, tracking it. Selection was right about the name and wrong about the sector.`,
        selection_still_valid: true,
      };
    }
  }

  // 5. Ran out of time without doing anything.
  if (/time stop|stale/i.test(e.exit_reason)) {
    return {
      cause: "time_expired",
      explanation: `Closed on time at ${pct(e.pnl_pct)} without reaching either level. The catalyst produced no meaningful drift within the holding window.`,
      selection_still_valid: false,
    };
  }

  // 6. Nothing external explains it: the catalyst did not produce drift.
  if (e.pnl_pct < 0) {
    return {
      cause: "thesis",
      explanation:
        `Lost ${pct(e.pnl_pct)} with no adverse news` +
        (e.market_pct !== null ? `, market ${pct(e.market_pct)}` : "") +
        (e.sector_pct !== null ? `, sector ${pct(e.sector_pct)}` : "") +
        ". The catalyst did not produce the expected drift — this one is on selection.",
      selection_still_valid: false,
    };
  }

  return {
    cause: "unknown",
    explanation: `Closed at ${pct(e.pnl_pct)} via "${e.exit_reason}"; evidence was insufficient to attribute.`,
    selection_still_valid: true,
  };
}
