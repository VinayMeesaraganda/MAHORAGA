/**
 * Architecture invariant: every order reaches the broker through a policy check.
 *
 * The header of `policy-broker.ts` records that the harness once called
 * `alpaca.trading.createOrder()` directly and that this was fixed. The fix
 * covered equities; the autonomous options path kept its own direct call and so
 * skipped all fourteen options rules the engine defines — including
 * `options_min_dte`, which is the rule that refuses 0DTE — along with the
 * account-wide kill switch, loss cooldown and daily loss limit.
 *
 * A rule that exists but is routed around is worse than a rule that was never
 * written, because the configuration reads as protection. This test fails if any
 * new direct order path appears, which is the only way to notice the class of
 * regression that has now happened twice.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
/** Strip comments so prose describing the old bug does not count as a call. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const directCalls = (src: string) => [...code(src).matchAll(/\.createOrder\s*\(/g)].length;

describe("no order reaches the broker without a policy check", () => {
  it("the harness never calls the broker directly", () => {
    // The harness runs unattended. Any order it places must go through
    // executeWithPolicy, which is the only caller permitted to reach Alpaca.
    expect(directCalls(read("../durable-objects/mahoraga-harness.ts"))).toBe(0);
  });

  it("the policy broker is the single equity order path", () => {
    expect(directCalls(read("./policy-broker.ts"))).toBe(1);
  });

  it("every MCP order path is preceded by a policy evaluation", () => {
    const src = code(read("../mcp/agent.ts"));
    // Each direct call is token-gated, and each token is minted only after
    // PolicyEngine has evaluated the previewed order.
    const calls = directCalls(read("../mcp/agent.ts"));
    expect(calls).toBeGreaterThan(0);
    expect([...src.matchAll(/generateApprovalToken\s*\(/g)].length).toBe(calls);
    expect([...src.matchAll(/new PolicyEngine\s*\(/g)].length).toBe(calls);
    expect([...src.matchAll(/validateApprovalToken\s*\(/g)].length).toBe(calls);
  });

  it("the options entry path is refused while it would bypass the engine", () => {
    const src = read("../durable-objects/mahoraga-harness.ts");
    const fn = src.slice(src.indexOf("private async executeOptionsOrder("));
    expect(fn).toContain("blocked_policy_bypass");
    expect(code(fn).includes(".createOrder(")).toBe(false);
  });
});
