import { describe, expect, it } from "vitest";
import { IngestedCatalystsSchema } from "./catalyst-ingest";

const valid = {
  symbol: "AVAV",
  type: "earnings" as const,
  quality: "high" as const,
  headline: "Q1 EPS 0.59 vs 0.24 estimate (+146% surprise)",
  at: "2026-09-09T20:30:00Z",
};

describe("IngestedCatalystsSchema", () => {
  it("accepts a well-formed push", () => {
    expect(IngestedCatalystsSchema.safeParse({ catalysts: [valid] }).success).toBe(true);
    expect(IngestedCatalystsSchema.safeParse({ catalysts: [] }).success).toBe(true);
  });

  it("rejects payloads that could smuggle an entry permission through", () => {
    // These become entry permissions, so the shape is validated as strictly as
    // model output: an unvalidated push bypasses the gate entirely.
    for (const bad of [
      { ...valid, type: "rumour" },
      { ...valid, quality: "excellent" },
      { ...valid, symbol: "" },
      { ...valid, symbol: "'; DROP TABLE" },
      { ...valid, symbol: "A".repeat(20) },
      { ...valid, headline: "" },
      { ...valid, at: "" },
    ]) {
      expect(IngestedCatalystsSchema.safeParse({ catalysts: [bad] }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("rejects a missing envelope and caps batch size", () => {
    expect(IngestedCatalystsSchema.safeParse({}).success).toBe(false);
    expect(IngestedCatalystsSchema.safeParse(null).success).toBe(false);
    expect(IngestedCatalystsSchema.safeParse({ catalysts: Array(201).fill(valid) }).success).toBe(false);
  });

  it("allows tickers with dots and hyphens", () => {
    expect(IngestedCatalystsSchema.safeParse({ catalysts: [{ ...valid, symbol: "BRK.B" }] }).success).toBe(true);
  });
});
