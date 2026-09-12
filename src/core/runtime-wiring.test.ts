/**
 * Capabilities must exist where the code that needs them runs.
 *
 * The adverse-news adjudicator was first placed inside the news gatherer, which
 * is the one context in this codebase architecturally forbidden from calling a
 * model: `gatherWithinDeadline` hands every gatherer `llm: null` and a 15-second
 * budget so a slow or hostile source can neither stall the alarm nor spend model
 * credit. The adjudicator therefore returned "no model configured" on every
 * call, fell through to the regex exactly as before, and did so silently — with
 * thirteen passing unit tests, because each unit was correct in isolation.
 *
 * Unit tests cannot see this class of defect. These are the wiring assertions
 * that can.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const harness = read("../durable-objects/mahoraga-harness.ts");
const boundary = read("./gather-boundary.ts");

describe("the gather boundary stays closed", () => {
  it("denies gatherers a model and an order path", () => {
    // If this ever loosens, it is a deliberate security decision and not a
    // convenient way to make some gatherer's model call start working.
    expect(boundary).toContain("llm: null");
    expect(boundary).toContain("Gatherers cannot run model requests");
    expect(boundary).toContain("Gatherers cannot submit orders");
  });

  it("no gatherer tries to adjudicate", () => {
    const gatherers = [
      "../strategy/default/gatherers/news.ts",
      "../strategy/default/gatherers/most-actives.ts",
      "../strategy/default/gatherers/sec.ts",
      "../strategy/default/gatherers/insider.ts",
      "../strategy/default/gatherers/macro.ts",
    ];
    for (const g of gatherers) {
      expect(read(g), `${g} calls the model from inside the gather boundary`).not.toContain("adjudicateAdverse(");
    }
  });

  it("the gatherer records evidence for the decision instead of making it", () => {
    const news = read("../strategy/default/gatherers/news.ts");
    expect(news).toContain('ctx.state.set("adverseEvidence"');
  });
});

describe("adjudication runs where the model exists", () => {
  it("is called from the harness, which holds a real provider", () => {
    expect(harness).toContain("adjudicateAdverse(ctx.llm");
    expect(harness).toMatch(/llm: this\._llm \?/);
  });

  it("gates the sell rather than following it", () => {
    const loop = harness.slice(harness.indexOf("for (const exit of exits) {"));
    const check = loop.indexOf("adverseExitOverturned");
    const sell = loop.indexOf("ctx.broker.sell(");
    expect(check).toBeGreaterThan(-1);
    expect(sell).toBeGreaterThan(-1);
    expect(check).toBeLessThan(sell);
  });

  it("is awaited, so the exit cannot race the verdict", () => {
    expect(harness).toContain("await this.adverseExitOverturned(ctx, exit.symbol)");
  });

  it("clears the flag when it spares a position, so it cannot re-fire next pass", () => {
    const method = harness.slice(harness.indexOf("private async adverseExitOverturned"));
    expect(method.slice(0, 3000)).toContain('ctx.state.set("catalystInvalidatedAt"');
  });
});

describe("an options route does not also buy the stock", () => {
  it("leaves the entry loop instead of falling through to the equity path", () => {
    const block = harness.slice(harness.indexOf("if (entry.useOptions) {"));
    const exitLoop = block.indexOf("continue;");
    const equityBuy = block.indexOf("ctx.broker.buy(");
    expect(exitLoop).toBeGreaterThan(-1);
    expect(equityBuy).toBeGreaterThan(-1);
    // Double exposure on success, silent instrument substitution on refusal.
    expect(exitLoop).toBeLessThan(equityBuy);
  });
});
