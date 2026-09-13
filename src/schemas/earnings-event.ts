import { z } from "zod";

export const Timestamp = z.string().datetime({ offset: true });
export const EvidenceSchema = z
  .object({
    source_url: z
      .string()
      .url()
      .refine((s) => new URL(s).protocol === "https:" && !new URL(s).username && !new URL(s).password),
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    excerpt: z.string().min(1).max(8000),
    published_at: Timestamp,
    first_observed_at: Timestamp,
  })
  .strict();
const Metric = z
  .object({
    value: z.number().finite(),
    period: z.string().min(1),
    basis: z.string().min(1),
    currency: z.string().length(3),
    unit: z.enum(["per_share", "units", "thousands", "millions", "billions"]),
    evidence: EvidenceSchema,
  })
  .strict();
const Guidance = Metric.omit({ value: true })
  .extend({ low: z.number().finite(), high: z.number().finite() })
  .refine((v) => v.low <= v.high, "Guidance range is reversed");

/** Values can be unknown. Qualification, not ingestion, decides whether they are required. */
export const EarningsEventSchema = z
  .object({
    event_key: z.string().min(1).max(200),
    version: z.string().min(1).max(100),
    issuer_id: z.string().min(1),
    symbol: z.string().regex(/^[A-Z][A-Z0-9.-]{0,14}$/),
    fiscal_period: z.string().min(1),
    released_at: Timestamp,
    actual_eps: Metric.nullable(),
    consensus_eps: Metric.nullable(),
    actual_revenue: Metric.nullable(),
    consensus_revenue: Metric.nullable(),
    previous_guidance: Guidance.nullable(),
    new_guidance: Guidance.nullable(),
    guidance_metric: z.literal("revenue"),
    consensus_snapshot_at: Timestamp.nullable(),
    extraction_version: z.string().min(1),
    model_version: z.string().nullable(),
    review: z
      .object({
        state: z.enum(["verified", "pending", "contradicted"]),
        method: z.enum(["deterministic", "operator"]),
        reason: z.string().min(1),
        evidence: z.array(EvidenceSchema).min(1),
        reviewed_at: Timestamp,
      })
      .strict(),
  })
  .strict()
  .refine((e) => e.event_key === `${e.issuer_id}:${e.fiscal_period}`, "Event key must be issuer_id:fiscal_period");
export type EarningsEvent = z.infer<typeof EarningsEventSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;

export function evidenceAvailable(e: Evidence, at: number): boolean {
  return Date.parse(e.published_at) <= Date.parse(e.first_observed_at) && Date.parse(e.first_observed_at) <= at;
}
export function eventRejections(event: EarningsEvent, at: number): string[] {
  const reasons: string[] = [];
  const release = Date.parse(event.released_at);
  if (!Number.isFinite(at) || release > at) reasons.push("event_not_available");
  const pair = (a: typeof event.actual_eps, b: typeof event.actual_eps) =>
    !!a && !!b && a.period === b.period && a.basis === b.basis && a.unit === b.unit && a.currency === b.currency;
  if (!pair(event.actual_eps, event.consensus_eps) || event.actual_eps?.period !== event.fiscal_period)
    reasons.push("eps_basis_unknown_or_mismatch");
  if (event.actual_eps && event.consensus_eps && event.actual_eps.value <= event.consensus_eps.value)
    reasons.push("no_eps_beat");
  if (
    !event.consensus_snapshot_at ||
    Date.parse(event.consensus_snapshot_at) >= release ||
    !event.consensus_eps ||
    Date.parse(event.consensus_eps.evidence.published_at) > Date.parse(event.consensus_snapshot_at) ||
    Date.parse(event.consensus_snapshot_at) > Date.parse(event.consensus_eps.evidence.first_observed_at) ||
    Date.parse(event.consensus_eps.evidence.first_observed_at) >= release
  )
    reasons.push("preannouncement_consensus_unverified");
  const old = event.previous_guidance,
    next = event.new_guidance;
  if (
    !old ||
    !next ||
    old.period !== next.period ||
    old.basis !== next.basis ||
    old.currency !== next.currency ||
    old.unit !== next.unit
  ) {
    reasons.push("guidance_basis_unknown_or_mismatch");
  } else {
    if (old.low + old.high <= 0 || next.low + next.high <= old.low + old.high)
      reasons.push("no_positive_guidance_revision");
    if (Date.parse(old.evidence.published_at) >= release) reasons.push("prior_guidance_not_prior");
  }
  if (!event.actual_revenue || event.actual_revenue.period !== event.fiscal_period || event.actual_revenue.value <= 0)
    reasons.push("actual_revenue_unknown_or_mismatch");
  if (
    event.actual_eps?.unit !== "per_share" ||
    event.actual_revenue?.unit === "per_share" ||
    old?.unit === "per_share" ||
    next?.unit === "per_share"
  )
    reasons.push("metric_units_invalid");
  if ([event.actual_eps, event.actual_revenue, next].some((m) => m && Date.parse(m.evidence.published_at) < release))
    reasons.push("release_metrics_predate_event");
  // Revenue consensus is deliberately NOT an entry rule in guidance-continuation-v1.
  const required = [event.actual_eps, event.consensus_eps, event.actual_revenue, old, next];
  if (
    required.some((m) => m && !evidenceAvailable(m.evidence, at)) ||
    event.review.evidence.some((e) => !evidenceAvailable(e, at)) ||
    Date.parse(event.review.reviewed_at) > at
  )
    reasons.push("evidence_not_available");
  if (event.review.state !== "verified") reasons.push(`review_${event.review.state}`);
  return [...new Set(reasons)];
}
