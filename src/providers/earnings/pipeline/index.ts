import { z } from "zod";
import { fetchText } from "../../../experiments/http";
import { hash } from "../../../research/ledger";
import { EarningsEventSchema, type EarningsEvent } from "../../../schemas/earnings-event";
import type { D1Client } from "../../../storage/d1/client";
import { localTime } from "../../../strategy/guidance-continuation/rules";
import { UNIVERSE } from "../../../strategy/shared-market";

export const FinnhubRelease = z.object({
  symbol: z.string().regex(/^[A-Z][A-Z0-9.-]{0,14}$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hour: z.string().nullable().optional(),
  year: z.number().int().nullable().optional(),
  quarter: z.number().int().min(1).max(4).nullable().optional(),
  epsEstimate: z.number().finite().nullable().optional(),
  epsActual: z.number().finite().nullable().optional(),
  revenueEstimate: z.number().finite().nullable().optional(),
  revenueActual: z.number().finite().nullable().optional(),
});
export type FinnhubRelease = z.infer<typeof FinnhubRelease>;
export interface PipelineResult {
  status: "ok" | "blocked" | "error";
  observedAt: string;
  records: number;
  prospective: number;
  reason: string | null;
  from: string;
  through: string;
}

/** Record snapshots before results. Report dates are not precise release timestamps.
 * Never turn Finnhub's unspecified EPS accounting basis into verified issuer comparability.
 */
export async function captureFinnhub(db: D1Client, key: string | undefined, now = Date.now()): Promise<PipelineResult> {
  const today = localTime(now).date,
    through = new Date(now + 21 * 86400000).toISOString().slice(0, 10),
    observedAt = new Date(now).toISOString();
  const result: PipelineResult = {
    status: "blocked",
    observedAt,
    records: 0,
    prospective: 0,
    reason: "Finnhub key unavailable",
    from: today,
    through,
  };
  if (key) {
    try {
      const url = `https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${through}&international=false`;
      const content = await fetchText(url, { "X-Finnhub-Token": key });
      const body = z.object({ earningsCalendar: z.array(FinnhubRelease).max(10000) }).parse(JSON.parse(content));
      const digest = await hash(content),
        evidenceId = await hash(`${url}\n${digest}`);
      await db.run(
        "INSERT OR IGNORE INTO research_evidence (id,source_url,content_hash,content,published_at,observed_at) VALUES (?,?,?,?,?,?)",
        [evidenceId, url, digest, content, observedAt, observedAt]
      );
      for (const record of body.earningsCalendar) {
        if (!UNIVERSE[record.symbol]) continue;
        // Same-day observations are retained but cannot establish pre-release availability.
        const prospective = record.date > today && record.epsActual == null && record.epsEstimate != null;
        const payload = JSON.stringify(record),
          id = await hash(`${evidenceId}\n${payload}\n${observedAt}`);
        await db.run(
          "INSERT OR IGNORE INTO consensus_snapshots (id,provider,symbol,report_date,fiscal_year,fiscal_quarter,payload,observed_at,evidence_id,prospective) VALUES (?,?,?,?,?,?,?,?,?,?)",
          [
            id,
            "finnhub",
            record.symbol,
            record.date,
            record.year ?? null,
            record.quarter ?? null,
            payload,
            observedAt,
            evidenceId,
            prospective ? 1 : 0,
          ]
        );
        result.prospective += Number(prospective);
      }
      result.status = "ok";
      result.reason = null;
      result.records = body.earningsCalendar.length;
    } catch (error) {
      result.status = "error";
      result.reason =
        error instanceof z.ZodError
          ? "Finnhub returned an invalid earnings calendar"
          : error instanceof Error
            ? error.message
            : "Finnhub request failed";
    }
  }
  await db.run(
    "INSERT INTO research_coverage (stream,state_json,updated_at) VALUES (?,?,?) ON CONFLICT(stream) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at",
    ["finnhub:earnings", JSON.stringify(result), observedAt]
  );
  return result;
}

export async function loadLatestGuidanceEvents(
  db: D1Client,
  now = Date.now()
): Promise<Array<{ id: string; event: EarningsEvent }>> {
  const rows = await db.execute<{ id: string; payload: string }>(
    "SELECT r.id,r.payload FROM research_events r WHERE r.observed_at<=? AND NOT EXISTS (SELECT 1 FROM research_events newer WHERE newer.event_key=r.event_key AND newer.observed_at<=? AND (newer.observed_at>r.observed_at OR (newer.observed_at=r.observed_at AND newer.rowid>r.rowid))) ORDER BY r.observed_at DESC LIMIT 200",
    [new Date(now).toISOString(), new Date(now).toISOString()]
  );
  return rows.map((row) => ({ id: row.id, event: EarningsEventSchema.parse(JSON.parse(row.payload)) }));
}

/** Upcoming scheduled earnings are an entry veto for the price strategy, not a signal. */
export async function earningsBlocked(
  db: D1Client,
  symbol: string,
  from: string,
  through: string,
  now: number
): Promise<string | null> {
  const state = await db.executeOne<{ state_json: string }>(
    "SELECT state_json FROM research_coverage WHERE stream='finnhub:earnings'"
  );
  const coverage: PipelineResult | null = state ? JSON.parse(state.state_json) : null;
  if (
    !coverage ||
    coverage.status !== "ok" ||
    Date.parse(coverage.observedAt) > now ||
    now - Date.parse(coverage.observedAt) > 86400000 ||
    coverage.from > from ||
    coverage.through < through
  )
    return "earnings_calendar_unknown";
  const rows = await db.execute<{ payload: string }>(
    "SELECT payload FROM consensus_snapshots WHERE symbol=? AND report_date>=? AND report_date<=? AND observed_at>=?",
    [symbol, from, through, coverage.observedAt]
  );
  return rows.length ? "earnings_inside_holding_horizon" : null;
}
