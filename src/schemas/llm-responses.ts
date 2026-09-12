/**
 * Schemas for model-authored JSON.
 *
 * These responses decide whether money moves, and the JSON mode used for them
 * only guarantees syntactic validity — an empty object is a legal reply, and
 * NVIDIA documents exactly that for `response_format: {"type":"json_object"}`.
 * Validate the shape here so a degraded or off-spec model produces no trade
 * rather than a trade on undefined fields.
 */

import { z } from "zod";

export const SignalResearchResponseSchema = z.object({
  verdict: z.enum(["BUY", "SKIP", "WAIT"]),
  confidence: z.number().min(0).max(1),
  entry_quality: z.enum(["excellent", "good", "fair", "poor"]),
  reasoning: z.string().trim().min(1),
  red_flags: z.array(z.string()).default([]),
  catalysts: z.array(z.string()).default([]),
});

export type SignalResearchResponse = z.infer<typeof SignalResearchResponseSchema>;

export const AnalystRecommendationSchema = z.object({
  action: z.enum(["BUY", "SELL", "HOLD"]),
  symbol: z.string().trim().min(1).max(12),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().trim().min(1),
  suggested_size_pct: z.number().min(0).max(100).optional(),
});

export type AnalystRecommendation = z.infer<typeof AnalystRecommendationSchema>;

/** Recommendations are validated per item so one malformed entry does not discard the batch. */
export const AnalystResponseSchema = z.object({
  recommendations: z.array(z.unknown()).default([]),
  market_summary: z.string().default(""),
  high_conviction_plays: z.array(z.string()).default([]),
});

export const PositionResearchResponseSchema = z.object({
  recommendation: z.enum(["HOLD", "SELL", "ADD"]),
  risk_level: z.enum(["low", "medium", "high"]),
  reasoning: z.string().trim().min(1),
  key_factors: z.array(z.string()).default([]),
});

/** Strip code fences and parse. Returns null instead of throwing on malformed content. */
export function parseJsonObject(content: string): unknown {
  try {
    return JSON.parse(content.replace(/```json\n?|```/g, "").trim());
  } catch {
    return null;
  }
}

/** Validate each recommendation independently, dropping the ones that do not qualify. */
export function parseAnalystRecommendations(raw: unknown[]): {
  valid: AnalystRecommendation[];
  rejected: number;
} {
  const valid: AnalystRecommendation[] = [];
  let rejected = 0;
  for (const item of raw) {
    const parsed = AnalystRecommendationSchema.safeParse(item);
    if (parsed.success) valid.push(parsed.data);
    else rejected++;
  }
  return { valid, rejected };
}

/**
 * A second opinion on a headline the pattern matcher flagged as adverse.
 *
 * The regex decides on vocabulary; this decides on the event. `quote` is
 * required so the reasoning is auditable in the journal rather than a bare
 * verdict — a model that cannot point at the phrase it judged is guessing.
 */
export const NewsAdjudicationSchema = z.object({
  direction: z.enum(["adverse", "favourable", "neutral"]),
  event: z.string().trim().min(1).max(80),
  severity: z.enum(["high", "medium", "low"]),
  confidence: z.number().min(0).max(1),
  quote: z.string().trim().max(300),
  reasoning: z.string().trim().min(1).max(600),
});

export type NewsAdjudication = z.infer<typeof NewsAdjudicationSchema>;
