/** Cash-flow observations are cumulative fiscal YTD. Unknown remains unknown. */
export interface CashFlowYtd {
  year: number;
  quarter: number;
  currency: string;
  unit: string;
  cfo: number;
  capex: number;
  availableAt: number;
}
export function trailingCashFlow(rows: CashFlowYtd[], at: number): { cfo: number; capex: number; fcf: number } | null {
  const available = rows.filter((r) => r.availableAt <= at);
  const keys = available.map((r) => r.year * 4 + r.quarter);
  if (new Set(keys).size !== keys.length || !available.length) return null; // revisions must be resolved as-of by the adapter
  if (
    available.some(
      (r) =>
        ![r.cfo, r.capex, r.availableAt].every(Number.isFinite) ||
        r.capex < 0 ||
        !Number.isInteger(r.quarter) ||
        r.quarter < 1 ||
        r.quarter > 4
    )
  )
    return null;
  const sorted = [...available].sort((a, b) => a.year - b.year || a.quarter - b.quarter);
  const latest = sorted.at(-1)!;
  const discrete = sorted
    .map((r) => {
      const prior = r.quarter === 1 ? null : sorted.find((p) => p.year === r.year && p.quarter === r.quarter - 1);
      if (
        r.currency !== latest.currency ||
        r.unit !== latest.unit ||
        (r.quarter !== 1 && (!prior || prior.currency !== r.currency || prior.unit !== r.unit))
      )
        return null;
      return { key: r.year * 4 + r.quarter, cfo: r.cfo - (prior?.cfo ?? 0), capex: r.capex - (prior?.capex ?? 0) };
    })
    .slice(-4);
  if (
    discrete.length !== 4 ||
    discrete.some((r, i) => !r || r.capex < 0 || r.key !== latest.year * 4 + latest.quarter - 3 + i)
  )
    return null;
  const cfo = discrete.reduce((n, r) => n + r!.cfo, 0),
    capex = discrete.reduce((n, r) => n + r!.capex, 0);
  return { cfo, capex, fcf: cfo - capex };
}
