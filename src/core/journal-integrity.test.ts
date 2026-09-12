/**
 * Ordering invariants in the journal path.
 *
 * These are integration failures that unit tests structurally cannot see: every
 * function involved was individually correct, and the defect lived in the order
 * two of them were called. The R multiple is the unit every registered
 * hypothesis and the whole learning loop are denominated in, so a stop_pct read
 * from the wrong place silently corrupts the entire record rather than failing.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rMultiple } from "../strategy/default/helpers/thesis";

const harness = readFileSync(new URL("../durable-objects/mahoraga-harness.ts", import.meta.url), "utf8");
const slice = (from: string, to: string) => {
  const a = harness.indexOf(from);
  const b = harness.indexOf(to, a);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return harness.slice(a, b);
};

describe("the exit snapshot is taken before the entry is discarded", () => {
  const onSell = slice("onSell: (symbol) => {", "},");

  it("captures the entry before deleting it", () => {
    const capture = onSell.indexOf("const closing = self.state.positionEntries[symbol]");
    const remove = onSell.indexOf("delete self.state.positionEntries[symbol]");
    expect(capture).toBeGreaterThan(-1);
    expect(remove).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(remove);
  });

  it("hands that snapshot to the journal", () => {
    expect(onSell).toContain("journalExit(symbol, closing)");
  });

  it("shows why it matters: the wrong stop rescales every R in the record", () => {
    // A 12% ATR-derived stop that fills at -12% is a textbook -1R loss. Read
    // against the 5% config default it books as -2.4R, and every comparison of
    // mean R between groups inherits that distortion.
    expect(rMultiple(-12, 12)).toBeCloseTo(-1.0, 5);
    expect(rMultiple(-12, 5)).toBeCloseTo(-2.4, 5);
  });
});

describe("an order that never filled leaves no trade record", () => {
  const onAbandoned = slice("onBuyAbandoned: (symbol) => {", "},");

  it("discards the journal row written at intent", () => {
    expect(onAbandoned).toContain("discardJournalEntry(symbol)");
  });

  it("the thesis is still written at intent, where it can be observed", () => {
    // Writing at intent is deliberate — gate values, catalyst and macro regime
    // cannot be reconstructed afterwards. The fix is removal on abandonment,
    // not moving the write.
    expect(slice("onBuyIntent: (symbol", "onBuyAbandoned")).toContain("journalEntry(symbol");
  });
});

describe("exit marks survive an isolate eviction", () => {
  it("are held in persisted state, not on the instance", () => {
    expect(harness).toContain("this.state.pendingExitMarks[exit.symbol]");
    expect(harness).not.toMatch(/private pendingExitMarks/);
  });

  it("are consumed from persisted state too", () => {
    expect(harness).toContain("this.state.pendingExitMarks?.[symbol]");
  });
});
