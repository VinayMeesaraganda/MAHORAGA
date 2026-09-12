import { describe, expect, it } from "vitest";
import { attributeExit, type ExitEvidence } from "./postmortem";

const base: ExitEvidence = {
  pnl_pct: -7.4,
  stop_pct: 7.4,
  exit_reason: "Stop loss at -7.4%",
  market_pct: 0.3,
  sector_pct: 0.2,
  adverse_news: [],
  recovered_to_pct: null,
  atr_pct_at_entry: 3.0,
};

describe("attributeExit", () => {
  it("credits a target hit", () => {
    const a = attributeExit({ ...base, pnl_pct: 14.8, exit_reason: "Take profit at +14.8%" });
    expect(a.cause).toBe("target_hit");
    expect(a.selection_still_valid).toBe(true);
  });

  it("blames the company when adverse news arrived after entry", () => {
    // Selection was sound on the information available; the facts changed.
    const a = attributeExit({ ...base, adverse_news: ["Acme announces dilutive secondary offering"] });
    expect(a.cause).toBe("company_event");
    expect(a.selection_still_valid).toBe(true);
    expect(a.explanation).toContain("dilutive");
  });

  it("blames the tape when the market fell and the name tracked it", () => {
    const a = attributeExit({ ...base, pnl_pct: -4.2, market_pct: -3.5, exit_reason: "Time stop" });
    expect(a.cause).toBe("macro");
    expect(a.selection_still_valid).toBe(true);
  });

  it("does not excuse a name that fell far beyond the market", () => {
    // Market -1%, position -9%: that is the name's own problem.
    const a = attributeExit({ ...base, pnl_pct: -9, market_pct: -1, atr_pct_at_entry: 1.0 });
    expect(a.cause).not.toBe("macro");
  });

  it("blames the sector when the sector fell and the tape held", () => {
    const a = attributeExit({ ...base, pnl_pct: -3.8, market_pct: 0.2, sector_pct: -3.2, exit_reason: "Time stop" });
    expect(a.cause).toBe("sector");
    expect(a.selection_still_valid).toBe(true);
  });

  it("blames the stop when the adverse move was inside normal daily range", () => {
    // Stopped at -3.5% on a name whose ATR is 3%: that is one ordinary day.
    const a = attributeExit({ ...base, pnl_pct: -3.5, stop_pct: 3.5, atr_pct_at_entry: 3.0 });
    expect(a.cause).toBe("stop_too_tight");
    expect(a.selection_still_valid).toBe(true);
    expect(a.explanation).toContain("1.5x daily ATR");
  });

  it("uses recovery as evidence when a later review supplies it", () => {
    const a = attributeExit({ ...base, pnl_pct: -7.4, recovered_to_pct: 6.2, atr_pct_at_entry: 1.0 });
    expect(a.cause).toBe("stop_too_tight");
    expect(a.explanation).toContain("recovered to +6.2%");
  });

  it("blames the thesis when nothing external explains the loss", () => {
    // No news, flat market, flat sector, adverse move well beyond normal range.
    const a = attributeExit({ ...base, pnl_pct: -7.4, atr_pct_at_entry: 1.2 });
    expect(a.cause).toBe("thesis");
    expect(a.selection_still_valid).toBe(false);
    expect(a.explanation).toContain("on selection");
  });

  it("records a time-expired trade as a selection failure, not an accident", () => {
    const a = attributeExit({
      ...base,
      pnl_pct: -0.4,
      exit_reason: "Time stop: held 5.1 days",
      market_pct: 0.4,
      atr_pct_at_entry: 3,
    });
    expect(a.cause).toBe("time_expired");
    expect(a.selection_still_valid).toBe(false);
  });

  it("says unknown rather than guessing on a flat close with no evidence", () => {
    // "LLM recommendation" now classifies as discretionary, so this uses a
    // reason that genuinely carries no signal about why the position closed.
    const a = attributeExit({
      ...base,
      pnl_pct: 0,
      exit_reason: "manual close",
      market_pct: null,
      sector_pct: null,
      atr_pct_at_entry: null,
    });
    expect(a.cause).toBe("unknown");
  });
});

describe("discretionary exits", () => {
  const early: ExitEvidence = {
    pnl_pct: 3.0,
    stop_pct: 7.5,
    target_pct: 15.0,
    exit_reason: "LLM recommendation: sentiment deteriorating",
    market_pct: 0.4,
    sector_pct: 0.2,
    adverse_news: [],
    recovered_to_pct: null,
    atr_pct_at_entry: 3.0,
  };

  it("records a judgement-based close as its own cause, with the R it realised", () => {
    // The quietest way to destroy expectancy: +3% on a 7.5% stop is 0.40R, and
    // the break-even hit rate goes from 33% to 71%.
    const a = attributeExit(early);
    expect(a.cause).toBe("discretionary");
    expect(a.explanation).toContain("0.40R");
    expect(a.explanation).toContain("Target was +15.0%");
  });

  it("covers the premarket plan path too", () => {
    expect(attributeExit({ ...early, exit_reason: "Pre-market plan: rotating out" }).cause).toBe("discretionary");
  });

  it("does not claim a selection failure — the entry may have been fine", () => {
    expect(attributeExit(early).selection_still_valid).toBe(true);
  });

  it("still lets genuine adverse news take precedence over judgement", () => {
    const a = attributeExit({ ...early, pnl_pct: -2, adverse_news: ["Acme announces dilutive secondary offering"] });
    expect(a.cause).toBe("company_event");
  });

  it("attributes an adverse-news exit to the company, not the thesis", () => {
    const a = attributeExit({
      ...early,
      pnl_pct: -4.1,
      exit_reason: "Adverse issuer news 12m ago invalidated the thesis",
      adverse_news: ["Guidance cut for the full year"],
    });
    expect(a.cause).toBe("company_event");
    expect(a.selection_still_valid).toBe(true);
  });
});
