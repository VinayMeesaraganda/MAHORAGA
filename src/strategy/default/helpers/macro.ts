/**
 * Macro regime — measured, not predicted.
 *
 * The tempting design is to read a headline ("CPI came in hot") and assert what
 * it implies ("sell duration, buy energy"). Those mappings invert often enough
 * that an asserted one is worth less than nothing, and it is exactly the
 * unverifiable-claim problem the entry gates were built to remove.
 *
 * Instead the regime is read off the tape: one batched snapshot of liquid
 * proxies says what the market actually did with the news. A model given
 * "XLE +2.1%, USO +4.0%, TLT -1.3%" can reason; a model asked what a CPI print
 * means can only guess.
 *
 * Deliberately NOT an attempt to trade the print. A CPI release is priced in
 * microseconds; this loop polls every 30 seconds and then makes a network call
 * to an LLM. What is tradable at this speed is the multi-day drift afterwards.
 */

import type { Snapshot } from "../../../providers/types";

export const RATE_PROXIES = ["TLT", "IEF", "SHY"] as const;
export const COMMODITY_PROXIES = ["USO", "UNG", "GLD", "DBC"] as const;
export const MACRO_PROXIES = ["UUP", "VIXY"] as const;
export const BROAD_PROXIES = ["SPY", "QQQ", "IWM"] as const;

/**
 * Pairs read as ratios rather than absolute moves.
 *
 * An absolute "SPY +0.84%" says the tape rose. The ratio of cap-weight to
 * equal-weight says whether a handful of megacaps carried it or participation
 * was broad, and high yield against investment grade says whether credit is
 * being bid — which is generally a cleaner risk tell than equities themselves,
 * because credit reprices first. Ratios are self-normalising: a common market
 * move cancels, leaving only the relative signal.
 */
export const RATIO_PROXIES = ["RSP", "HYG", "LQD"] as const;

export const SECTOR_ETFS: Record<string, string> = {
  XLE: "Energy",
  XLF: "Financials",
  XLK: "Technology",
  XLV: "Health Care",
  XLI: "Industrials",
  XLU: "Utilities",
  XLP: "Consumer Staples",
  XLY: "Consumer Discretionary",
  XLB: "Materials",
  XLRE: "Real Estate",
  XLC: "Communication Services",
};

export const MACRO_BASKET: string[] = [
  ...RATIO_PROXIES,
  ...RATE_PROXIES,
  ...COMMODITY_PROXIES,
  ...MACRO_PROXIES,
  ...BROAD_PROXIES,
  ...Object.keys(SECTOR_ETFS),
];

export interface SectorMove {
  symbol: string;
  name: string;
  change_pct: number;
}

export interface MacroRegime {
  as_of: number;
  /** Composite read from equities, volatility and duration. */
  risk: "risk-on" | "risk-off" | "mixed" | "unknown";
  /**
   * Direction of YIELDS, not bond prices. Long-duration ETFs rise when yields
   * fall, so the sign is inverted here once rather than at every call site.
   */
  yields: "rising" | "falling" | "flat" | "unknown";
  oil_pct: number | null;
  gold_pct: number | null;
  dollar_pct: number | null;
  volatility_pct: number | null;
  spy_pct: number | null;
  qqq_pct: number | null;
  iwm_pct: number | null;
  leaders: SectorMove[];
  laggards: SectorMove[];
  /** Cap-weight against equal-weight: positive means a narrow, megacap-led tape. */
  breadth_pct: number | null;
  /** High yield against investment grade: positive means credit is being bid. */
  credit_pct: number | null;
  /** Small caps against large: positive means small caps leading. */
  size_pct: number | null;
}

function changePct(snap: Snapshot | undefined): number | null {
  const price = snap?.latest_trade?.price || snap?.daily_bar?.c;
  const prev = snap?.prev_daily_bar?.c;
  if (!price || !prev || price <= 0 || prev <= 0) return null;
  return ((price - prev) / prev) * 100;
}

/** Treat moves inside this band as noise rather than direction. */
const FLAT_BAND_PCT = 0.15;

/** Percentage change in the a/b ratio, which cancels any move common to both. */
function ratioChange(snapshots: Record<string, Snapshot>, a: string, b: string): number | null {
  const aNow = snapshots[a]?.latest_trade?.price || snapshots[a]?.daily_bar?.c;
  const bNow = snapshots[b]?.latest_trade?.price || snapshots[b]?.daily_bar?.c;
  const aPrev = snapshots[a]?.prev_daily_bar?.c;
  const bPrev = snapshots[b]?.prev_daily_bar?.c;
  if (!aNow || !bNow || !aPrev || !bPrev || aNow <= 0 || bNow <= 0 || aPrev <= 0 || bPrev <= 0) return null;
  return (aNow / bNow / (aPrev / bPrev) - 1) * 100;
}

export function deriveMacroRegime(snapshots: Record<string, Snapshot>, now = Date.now()): MacroRegime {
  const pct = (sym: string) => changePct(snapshots[sym]);

  const spy = pct("SPY");
  const vixy = pct("VIXY");
  // Long duration is the cleanest of the three; fall back down the curve.
  const duration = pct("TLT") ?? pct("IEF") ?? pct("SHY");

  let yields: MacroRegime["yields"] = "unknown";
  if (duration !== null) {
    if (duration > FLAT_BAND_PCT) yields = "falling";
    else if (duration < -FLAT_BAND_PCT) yields = "rising";
    else yields = "flat";
  }

  const breadth = ratioChange(snapshots, "SPY", "RSP");
  const credit = ratioChange(snapshots, "HYG", "LQD");
  const size = ratioChange(snapshots, "IWM", "SPY");

  // Equities, volatility and credit must agree before calling a regime; when
  // they disagree the honest answer is mixed. Credit is included because it
  // typically reprices ahead of equities, so an equity rally the credit market
  // is not confirming is worth flagging rather than trusting.
  let risk: MacroRegime["risk"] = "unknown";
  if (spy !== null && vixy !== null) {
    const equitiesUp = spy > FLAT_BAND_PCT;
    const equitiesDown = spy < -FLAT_BAND_PCT;
    const volDown = vixy < -1;
    const volUp = vixy > 1;
    const creditDisagrees = credit !== null && ((equitiesUp && credit < -0.1) || (equitiesDown && credit > 0.1));
    if (creditDisagrees) risk = "mixed";
    else if (equitiesUp && !volUp) risk = "risk-on";
    else if (equitiesDown && !volDown) risk = "risk-off";
    else risk = "mixed";
  } else if (spy !== null) {
    risk = spy > FLAT_BAND_PCT ? "risk-on" : spy < -FLAT_BAND_PCT ? "risk-off" : "mixed";
  }

  const sectors: SectorMove[] = [];
  for (const [symbol, name] of Object.entries(SECTOR_ETFS)) {
    const change = pct(symbol);
    if (change !== null) sectors.push({ symbol, name, change_pct: change });
  }
  sectors.sort((a, b) => b.change_pct - a.change_pct);

  return {
    as_of: now,
    risk,
    yields,
    oil_pct: pct("USO"),
    gold_pct: pct("GLD"),
    dollar_pct: pct("UUP"),
    volatility_pct: vixy,
    spy_pct: spy,
    qqq_pct: pct("QQQ"),
    iwm_pct: pct("IWM"),
    leaders: sectors.slice(0, 3),
    laggards: sectors.slice(-3).reverse(),
    breadth_pct: breadth,
    credit_pct: credit,
    size_pct: size,
  };
}

/** Render for a prompt. Unknown fields are stated as unknown, never inferred. */
export function describeMacroRegime(regime: MacroRegime | null | undefined): string {
  if (!regime) return "- Macro regime: unknown (no data)";
  const p = (v: number | null) => (v === null ? "unknown" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
  const sectorLine = (s: SectorMove) => `${s.name} ${p(s.change_pct)}`;
  return [
    `- Risk appetite: ${regime.risk} (SPY ${p(regime.spy_pct)}, QQQ ${p(regime.qqq_pct)}, small caps ${p(regime.iwm_pct)}, VIX proxy ${p(regime.volatility_pct)})`,
    `- Yields: ${regime.yields} (from long-duration bond prices, inverted)`,
    `- Oil ${p(regime.oil_pct)} · Gold ${p(regime.gold_pct)} · Dollar ${p(regime.dollar_pct)}`,
    `- Credit (high yield vs investment grade): ${p(regime.credit_pct)}${regime.credit_pct === null ? "" : regime.credit_pct >= 0 ? " — credit being bid" : " — credit under pressure"}`,
    `- Breadth (cap-weight vs equal-weight): ${p(regime.breadth_pct)}${regime.breadth_pct === null ? "" : regime.breadth_pct >= 0 ? " — megacap-led" : " — broad participation"}`,
    `- Small caps vs large: ${p(regime.size_pct)}`,
    `- Strongest sectors: ${regime.leaders.map(sectorLine).join(" · ") || "unknown"}`,
    `- Weakest sectors: ${regime.laggards.map(sectorLine).join(" · ") || "unknown"}`,
  ].join("\n");
}
