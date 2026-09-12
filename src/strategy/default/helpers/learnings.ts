/**
 * Turn the trade journal into evidence the model can weigh at decision time.
 *
 * The tempting design is to let the model retune its own thresholds from past
 * results. At roughly three trades a week, a month gives twelve observations and
 * a hit rate accurate to plus or minus twenty-eight points; splitting by
 * catalyst type divides that again. Fitting twenty thresholds to that is fitting
 * noise, and an agent that can widen its own risk limits has no risk limits.
 *
 * So nothing here changes a threshold. It produces a factual record — this
 * catalyst type has gone 2-7 for -1.2R — and puts it in the prompt alongside the
 * catalyst and the gates, as one more piece of evidence. The model weighs it;
 * the limits stay where a human put them.
 *
 * Every figure carries its sample size, and anything under the floor reports as
 * insufficient rather than as a number. A statistic without its n invites
 * exactly the overfitting this is built to avoid.
 */

/** Below this, report the count and decline to draw a conclusion. */
export const MIN_SAMPLE = 5;

export interface JournalRowLike {
  symbol: string;
  outcome: string | null;
  pnl_usd: number | null;
  pnl_pct: number | null;
  exit_at: string | null;
  signals_json: string | null;
  lessons_learned: string | null;
}

export interface Bucket {
  key: string;
  trades: number;
  wins: number;
  net_usd: number;
  /** Mean R, null when the sample is too small to mean anything. */
  avg_r: number | null;
  sufficient: boolean;
}

export interface Learnings {
  total_closed: number;
  overall: { wins: number; net_usd: number; avg_r: number | null };
  by_catalyst: Bucket[];
  by_cause: Bucket[];
  /** Does the model's stated confidence predict anything? */
  confidence_calibration: Bucket[];
  /** Losses split by whether selection or risk settings were at fault. */
  selection_failures: number;
  risk_or_external_failures: number;
}

function parse(json: string | null): Record<string, never> | null {
  try {
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
}

function field(lessons: string | null, key: string): string | null {
  return lessons?.match(new RegExp(`${key}=([a-z_]+)`))?.[1] ?? null;
}

function bucket(key: string, rows: Array<{ pnl_usd: number; r: number | null }>): Bucket {
  const rs = rows.map((x) => x.r).filter((r): r is number => r !== null);
  const sufficient = rows.length >= MIN_SAMPLE;
  return {
    key,
    trades: rows.length,
    wins: rows.filter((x) => x.pnl_usd > 0).length,
    net_usd: rows.reduce((s, x) => s + x.pnl_usd, 0),
    avg_r: sufficient && rs.length ? rs.reduce((s, r) => s + r, 0) / rs.length : null,
    sufficient,
  };
}

export function summariseJournal(entries: JournalRowLike[]): Learnings {
  const closed = entries.filter((e) => e.exit_at);
  const enriched = closed.map((e) => {
    const sig = parse(e.signals_json);
    const stop = (sig?.plan as { stop_pct?: number } | undefined)?.stop_pct;
    const pnlPct = Number(e.pnl_pct ?? 0);
    return {
      pnl_usd: Number(e.pnl_usd ?? 0),
      r: stop && stop > 0 && Number.isFinite(pnlPct) ? pnlPct / stop : null,
      catalyst: (sig?.catalyst as { type?: string } | undefined)?.type ?? "none",
      confidence: (sig?.research as { confidence?: number } | undefined)?.confidence ?? null,
      cause: field(e.lessons_learned, "cause") ?? "unrecorded",
      selectionValid: field(e.lessons_learned, "selection_valid"),
    };
  });

  const group = (keyOf: (x: (typeof enriched)[number]) => string) => {
    const m = new Map<string, Array<{ pnl_usd: number; r: number | null }>>();
    for (const x of enriched) {
      const k = keyOf(x);
      (m.get(k) ?? m.set(k, []).get(k)!).push({ pnl_usd: x.pnl_usd, r: x.r });
    }
    return [...m].map(([k, rows]) => bucket(k, rows)).sort((a, b) => b.trades - a.trades);
  };

  const allR = enriched.map((x) => x.r).filter((r): r is number => r !== null);
  const losses = enriched.filter((x) => x.pnl_usd < 0);

  return {
    total_closed: closed.length,
    overall: {
      wins: enriched.filter((x) => x.pnl_usd > 0).length,
      net_usd: enriched.reduce((s, x) => s + x.pnl_usd, 0),
      avg_r: closed.length >= MIN_SAMPLE && allR.length ? allR.reduce((s, r) => s + r, 0) / allR.length : null,
    },
    by_catalyst: group((x) => x.catalyst),
    by_cause: group((x) => x.cause),
    // Bucketed rather than correlated: with these samples a correlation
    // coefficient would imply precision that is not there.
    confidence_calibration: group((x) =>
      x.confidence === null
        ? "unstated"
        : x.confidence >= 0.8
          ? "0.80+"
          : x.confidence >= 0.7
            ? "0.70-0.79"
            : "under 0.70"
    ),
    selection_failures: losses.filter((x) => x.selectionValid === "false").length,
    risk_or_external_failures: losses.filter((x) => x.selectionValid === "true").length,
  };
}

/** Render for a prompt. States sample sizes and refuses to conclude from thin data. */
export function describeLearnings(l: Learnings | null | undefined): string {
  if (!l || l.total_closed === 0) {
    return "- No closed trades yet. There is no track record to weigh; judge this setup on its own evidence.";
  }

  const lines: string[] = [
    `- Closed trades: ${l.total_closed}, ${l.overall.wins} winners, net $${l.overall.net_usd.toFixed(0)}` +
      (l.overall.avg_r === null ? ` (too few to state an average R)` : `, average ${l.overall.avg_r.toFixed(2)}R`),
  ];

  const fmt = (b: Bucket) =>
    `${b.key} ${b.wins}/${b.trades}` + (b.avg_r === null ? " (thin)" : ` at ${b.avg_r.toFixed(2)}R`);

  if (l.by_catalyst.length) lines.push(`- By catalyst: ${l.by_catalyst.map(fmt).join(" · ")}`);
  if (l.by_cause.length) lines.push(`- Exit causes: ${l.by_cause.map((b) => `${b.key} ${b.trades}`).join(" · ")}`);

  const stated = l.confidence_calibration.filter((b) => b.key !== "unstated" && b.sufficient);
  if (stated.length >= 2) {
    lines.push(`- Confidence calibration: ${stated.map(fmt).join(" · ")}`);
    const high = stated.find((b) => b.key === "0.80+");
    const low = stated.find((b) => b.key === "under 0.70");
    if (high?.avg_r !== null && low?.avg_r != null && high && high.avg_r <= low.avg_r) {
      lines.push(
        "- High-confidence calls have not outperformed low-confidence ones. Treat your own confidence as uninformative here."
      );
    }
  }

  if (l.selection_failures + l.risk_or_external_failures >= MIN_SAMPLE) {
    lines.push(
      `- Of the losses, ${l.selection_failures} came from selection and ${l.risk_or_external_failures} from the tape, the sector, a post-entry event or too tight a stop.`
    );
  }

  lines.push("- This is a record, not a rule. Sample sizes are small; weigh it, do not obey it.");
  return lines.join("\n");
}
