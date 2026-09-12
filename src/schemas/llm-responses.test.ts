import { describe, expect, it } from "vitest";
import {
  AnalystResponseSchema,
  PositionResearchResponseSchema,
  parseAnalystRecommendations,
  parseJsonObject,
  SignalResearchResponseSchema,
} from "./llm-responses";

const valid = {
  verdict: "BUY",
  confidence: 0.72,
  entry_quality: "good",
  reasoning: "Volume confirms the move and the spread is tight.",
  red_flags: [],
  catalysts: ["product launch"],
};

describe("parseJsonObject", () => {
  it("strips code fences and returns null instead of throwing", () => {
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject("not json at all")).toBeNull();
    expect(parseJsonObject("")).toBeNull();
  });
});

describe("SignalResearchResponseSchema", () => {
  it("accepts a well-formed response and defaults the optional arrays", () => {
    expect(SignalResearchResponseSchema.safeParse(valid).success).toBe(true);
    const bare = SignalResearchResponseSchema.parse({ ...valid, red_flags: undefined, catalysts: undefined });
    expect(bare.red_flags).toEqual([]);
    expect(bare.catalysts).toEqual([]);
  });

  it("rejects the empty object that json_object mode permits", () => {
    // NVIDIA documents that response_format json_object allows any valid JSON,
    // including {}. Unvalidated, that reaches the gates as an undefined verdict.
    expect(SignalResearchResponseSchema.safeParse({}).success).toBe(false);
  });

  it("rejects off-spec verdicts, quality labels and confidence values", () => {
    for (const bad of [
      { ...valid, verdict: "STRONG_BUY" },
      { ...valid, verdict: "buy" },
      { ...valid, entry_quality: "great" },
      { ...valid, confidence: "high" },
      { ...valid, confidence: 1.4 },
      { ...valid, confidence: -0.1 },
      { ...valid, reasoning: "   " },
      { ...valid, red_flags: [7] },
    ]) {
      expect(SignalResearchResponseSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("analyst response", () => {
  it("keeps valid recommendations and drops malformed ones", () => {
    const envelope = AnalystResponseSchema.parse({
      recommendations: [
        { action: "BUY", symbol: "AAPL", confidence: 0.8, reasoning: "strong" },
        { action: "BUY", symbol: "MSFT", confidence: "high", reasoning: "string confidence" },
        { action: "HOLD", symbol: "NVDA", confidence: 0.5, reasoning: "wait" },
        { action: "YOLO", symbol: "GME", confidence: 0.9, reasoning: "invalid action" },
        null,
      ],
      market_summary: "mixed",
    });
    const { valid: kept, rejected } = parseAnalystRecommendations(envelope.recommendations);
    expect(kept.map((r) => r.symbol)).toEqual(["AAPL", "NVDA"]);
    expect(rejected).toBe(3);
  });

  it("defaults a missing envelope to an empty batch", () => {
    const envelope = AnalystResponseSchema.parse({});
    expect(envelope.recommendations).toEqual([]);
    expect(envelope.market_summary).toBe("");
    expect(envelope.high_conviction_plays).toEqual([]);
  });
});

describe("PositionResearchResponseSchema", () => {
  it("accepts documented values and rejects invented ones", () => {
    expect(
      PositionResearchResponseSchema.safeParse({
        recommendation: "HOLD",
        risk_level: "medium",
        reasoning: "range-bound",
      }).success
    ).toBe(true);
    expect(
      PositionResearchResponseSchema.safeParse({ recommendation: "TRIM", risk_level: "medium", reasoning: "x" }).success
    ).toBe(false);
  });
});

describe("completion budgets", () => {
  it("are large enough for a reasoning model's separate thinking output", async () => {
    const { DEFAULT_CONFIG } = await import("../strategy/default/config");
    // NVIDIA's own samples use 4096 (gpt-oss-20b) and 16384 (nemotron lightning).
    // The visible JSON is ~150 tokens; the rest is headroom for reasoning that
    // the provider bills against max_tokens and returns in another field.
    expect(DEFAULT_CONFIG.llm_research_max_tokens).toBeGreaterThanOrEqual(2048);
    expect(DEFAULT_CONFIG.llm_analyst_max_tokens).toBeGreaterThanOrEqual(DEFAULT_CONFIG.llm_research_max_tokens);
  });

  it("are carried by the prompt builders rather than hard-coded", async () => {
    const { researchSignalPrompt } = await import("../strategy/default/prompts/research");
    const { DEFAULT_CONFIG } = await import("../strategy/default/config");
    const ctx = {
      config: { ...DEFAULT_CONFIG, llm_research_max_tokens: 777 },
      state: { get: () => undefined, set: () => {} },
    } as never;
    expect(researchSignalPrompt("AAPL", 0.6, ["stocktwits"], 190, ctx, null).maxTokens).toBe(777);
  });
});
