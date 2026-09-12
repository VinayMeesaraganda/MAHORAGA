import { describe, expect, it } from "vitest";
import type { CompletionParams, CompletionResult, LLMProvider } from "../../../providers/types";
import { adjudicateAdverse, adjudicationKey, MIN_ADJUDICATION_CONFIDENCE } from "./adjudicate";

/** An LLM that replies with exactly what the test puts in its mouth. */
function stub(reply: string | (() => never)): LLMProvider {
  return {
    complete: async (_params: CompletionParams): Promise<CompletionResult> => {
      if (typeof reply !== "string") reply();
      return {
        content: reply,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        model: "test",
      } as CompletionResult;
    },
  } as LLMProvider;
}

const flag = {
  symbol: "META",
  headline: "Meta settles antitrust class action, removing a major overhang",
  summary: "The company reached a settlement resolving the outstanding matter.",
  matched: "class action",
};

const good = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    direction: "favourable",
    event: "settled litigation",
    severity: "medium",
    confidence: 0.9,
    quote: "settles antitrust class action",
    reasoning: "The proceeding is resolved, which removes an overhang rather than creating one.",
    ...over,
  });

describe("the flag stands unless the model confidently withdraws it", () => {
  // Every one of these is a way the second opinion can be unavailable. None of
  // them may strand a position in news the pattern matcher called dangerous.
  it("upholds when there is no model configured", async () => {
    const r = await adjudicateAdverse(null, flag);
    expect(r.upheld).toBe(true);
    expect(r.note).toBe("no_llm");
  });

  it("upholds when the provider throws", async () => {
    const r = await adjudicateAdverse(
      stub(() => {
        throw new Error("timed out");
      }),
      flag
    );
    expect(r.upheld).toBe(true);
    expect(r.note).toContain("llm_error");
  });

  it("upholds on unparseable output", async () => {
    const r = await adjudicateAdverse(stub("not json at all"), flag);
    expect(r.upheld).toBe(true);
    expect(r.note).toBe("unparseable_json");
  });

  it("upholds on an empty object, which JSON mode permits", async () => {
    const r = await adjudicateAdverse(stub("{}"), flag);
    expect(r.upheld).toBe(true);
    expect(r.note).toBe("schema_rejected");
  });

  it("upholds when a field is out of range", async () => {
    const r = await adjudicateAdverse(stub(good({ confidence: 4 })), flag);
    expect(r.upheld).toBe(true);
    expect(r.note).toBe("schema_rejected");
  });

  it("upholds when the model is not confident, however it leans", async () => {
    const r = await adjudicateAdverse(stub(good({ confidence: MIN_ADJUDICATION_CONFIDENCE - 0.01 })), flag);
    expect(r.upheld).toBe(true);
    expect(r.note).toContain("low_confidence");
  });

  it("upholds when the model agrees the news is adverse", async () => {
    const r = await adjudicateAdverse(
      stub(good({ direction: "adverse", event: "guidance cut", severity: "high" })),
      flag
    );
    expect(r.upheld).toBe(true);
    expect(r.note).toBe("confirmed:high");
  });
});

describe("the one path that withdraws a flag", () => {
  it("overturns on a confident favourable verdict", async () => {
    const r = await adjudicateAdverse(stub(good()), flag);
    expect(r.upheld).toBe(false);
    expect(r.note).toBe("overturned:favourable");
    expect(r.verdict?.quote).toContain("settles");
  });

  it("overturns when the story is not really about this issuer", async () => {
    const r = await adjudicateAdverse(
      stub(good({ direction: "neutral", event: "mentioned in passing", confidence: 0.85 })),
      { ...flag, symbol: "GOOGL" }
    );
    expect(r.upheld).toBe(false);
    expect(r.note).toBe("overturned:neutral");
  });

  it("keeps the quote, so the journal records evidence and not a verdict", async () => {
    const r = await adjudicateAdverse(stub(good()), flag);
    expect(r.verdict?.quote).toBeTruthy();
    expect(r.verdict?.reasoning).toBeTruthy();
  });
});

describe("adjudicationKey", () => {
  it("is stable across calls so an article is judged once", () => {
    expect(adjudicationKey("META", flag.headline)).toBe(adjudicationKey("META", flag.headline));
  });

  it("separates symbols and headlines", () => {
    expect(adjudicationKey("META", flag.headline)).not.toBe(adjudicationKey("GOOGL", flag.headline));
    expect(adjudicationKey("META", flag.headline)).not.toBe(adjudicationKey("META", "something else"));
  });

  it("is prefixed by the symbol, so the log is readable", () => {
    expect(adjudicationKey("ORCL", "Larry Ellison cancels his plan to sell Oracle stock")).toMatch(/^ORCL:/);
  });
});
