/**
 * Macro regime gatherer.
 *
 * Emits no trading signals. Its job is to record what the tape is doing at the
 * index, rate, commodity and sector level so the research and analyst prompts
 * can reason about a candidate in context instead of in isolation. One batched
 * snapshot call covers the whole basket.
 */

import type { Signal } from "../../../core/types";
import { createAlpacaProviders } from "../../../providers/alpaca";
import type { Gatherer, StrategyContext } from "../../types";
import { deriveMacroRegime, MACRO_BASKET } from "../helpers/macro";

async function gatherMacro(ctx: StrategyContext): Promise<Signal[]> {
  const alpaca = createAlpacaProviders(ctx.env);
  try {
    const snapshots = await alpaca.marketData.getSnapshots(MACRO_BASKET);
    const regime = deriveMacroRegime(snapshots);
    ctx.state.set("macroRegime", regime);
    ctx.log("Macro", "regime", {
      risk: regime.risk,
      yields: regime.yields,
      oil_pct: regime.oil_pct === null ? null : Number(regime.oil_pct.toFixed(2)),
      leaders: regime.leaders.map((l) => l.symbol),
      laggards: regime.laggards.map((l) => l.symbol),
    });
  } catch (error) {
    ctx.log("Macro", "fetch_failed", { error: String(error) });
  }
  // Context only — the regime shapes decisions, it is not itself a candidate.
  return [];
}

export const macroGatherer: Gatherer = {
  name: "macro",
  gather: gatherMacro,
};
