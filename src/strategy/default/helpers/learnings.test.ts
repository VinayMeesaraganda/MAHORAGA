import { describe, expect, it } from "vitest";
import { describeLearnings, type JournalRowLike, MIN_SAMPLE, summariseJournal } from "./learnings";

function row(o: {
  pnl_pct: number;
  stop_pct?: number;
  catalyst?: string;
  confidence?: number;
  cause?: string;
  selection?: string;
  closed?: boolean;
}): JournalRowLike {
  const stop = o.stop_pct ?? 7.5;
  return {
    symbol: "TEST",
    outcome: o.pnl_pct > 0 ? "win" : "loss",
    pnl_usd: o.pnl_pct * 50,
    pnl_pct: o.pnl_pct,
    exit_at: o.closed === false ? null : "2026-09-12T14:00:00Z",
    signals_json: JSON.stringify({
      catalyst: { type: o.catalyst ?? "earnings" },
      research: { confidence: o.confidence ?? 0.75 },
      plan: { stop_pct: stop },
    }),
    lessons_learned: `cause=${o.cause ?? "thesis"} | selection_valid=${o.selection ?? "false"} | note`,
  };
}

describe("summariseJournal", () => {
  it("ignores open positions — only closed trades are evidence", () => {
    const l = summariseJournal([row({ pnl_pct: 10 }), row({ pnl_pct: -5, closed: false })]);
    expect(l.total_closed).toBe(1);
  });

  it("computes R from each trade's own stop, not a shared one", () => {
    // +15% on a 15% stop is 1R; +15% on a 5% stop is 3R. Averaging raw percentages
    // across ATR-sized positions would be meaningless.
    const l = summariseJournal([
      ...Array(3)
        .fill(null)
        .map(() => row({ pnl_pct: 15, stop_pct: 15 })),
      ...Array(2)
        .fill(null)
        .map(() => row({ pnl_pct: 15, stop_pct: 5 })),
    ]);
    expect(l.overall.avg_r).toBeCloseTo((1 + 1 + 1 + 3 + 3) / 5, 6);
  });

  it("refuses to state an average below the sample floor", () => {
    const thin = summariseJournal(
      Array(MIN_SAMPLE - 1)
        .fill(null)
        .map(() => row({ pnl_pct: 10 }))
    );
    expect(thin.overall.avg_r).toBeNull();
    const enough = summariseJournal(
      Array(MIN_SAMPLE)
        .fill(null)
        .map(() => row({ pnl_pct: 10 }))
    );
    expect(enough.overall.avg_r).not.toBeNull();
  });

  it("groups by catalyst and marks thin buckets as insufficient", () => {
    const l = summariseJournal([
      ...Array(6)
        .fill(null)
        .map(() => row({ catalyst: "earnings", pnl_pct: 8 })),
      ...Array(2)
        .fill(null)
        .map(() => row({ catalyst: "analyst", pnl_pct: -6 })),
    ]);
    const earnings = l.by_catalyst.find((b) => b.key === "earnings")!;
    const analyst = l.by_catalyst.find((b) => b.key === "analyst")!;
    expect(earnings.sufficient).toBe(true);
    expect(earnings.avg_r).not.toBeNull();
    expect(analyst.sufficient).toBe(false);
    expect(analyst.avg_r).toBeNull();
    expect(analyst.trades).toBe(2);
  });

  it("separates losses caused by selection from those caused by everything else", () => {
    const l = summariseJournal([
      row({ pnl_pct: -7, cause: "thesis", selection: "false" }),
      row({ pnl_pct: -7, cause: "macro", selection: "true" }),
      row({ pnl_pct: -7, cause: "stop_too_tight", selection: "true" }),
      row({ pnl_pct: 12, cause: "target_hit", selection: "true" }),
    ]);
    expect(l.selection_failures).toBe(1);
    expect(l.risk_or_external_failures).toBe(2);
  });
});

describe("describeLearnings", () => {
  it("says there is no record rather than implying one", () => {
    expect(describeLearnings(summariseJournal([]))).toContain("No closed trades yet");
    expect(describeLearnings(null)).toContain("No closed trades yet");
  });

  it("marks thin buckets rather than quoting a number for them", () => {
    const text = describeLearnings(
      summariseJournal([
        ...Array(6)
          .fill(null)
          .map(() => row({ catalyst: "earnings", pnl_pct: 8 })),
        ...Array(2)
          .fill(null)
          .map(() => row({ catalyst: "theme", pnl_pct: -6 })),
      ])
    );
    expect(text).toContain("theme 0/2 (thin)");
    expect(text).toMatch(/earnings 6\/6 at [\d.]+R/);
  });

  it("calls out uninformative confidence when the buckets do not separate", () => {
    // High-confidence calls doing no better than low ones is the single most
    // useful thing the journal can reveal about the model.
    const text = describeLearnings(
      summariseJournal([
        ...Array(6)
          .fill(null)
          .map(() => row({ confidence: 0.9, pnl_pct: -4 })),
        ...Array(6)
          .fill(null)
          .map(() => row({ confidence: 0.65, pnl_pct: 6 })),
      ])
    );
    expect(text).toContain("Treat your own confidence as uninformative");
  });

  it("always states that the record is evidence, not a rule", () => {
    const text = describeLearnings(
      summariseJournal(
        Array(8)
          .fill(null)
          .map(() => row({ pnl_pct: 5 }))
      )
    );
    expect(text).toContain("weigh it, do not obey it");
  });
});
