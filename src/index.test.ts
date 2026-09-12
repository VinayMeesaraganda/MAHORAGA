import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env.d";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }))),
  limit: vi.fn(async () => ({ allowed: false, resetAt: 123 })),
  increment: vi.fn(),
}));
vi.mock("./durable-objects/mahoraga-harness", () => ({
  getHarnessStub: () => ({ fetch: mocks.fetch }),
  MahoragaHarness: class {},
}));
vi.mock("./durable-objects/session", () => ({
  checkRateLimit: mocks.limit,
  incrementRequest: mocks.increment,
  SessionDO: class {},
}));
vi.mock("./mcp/agent", () => ({ MahoragaMcpAgent: class {} }));
vi.mock("./jobs/cron", () => ({ handleCronEvent: vi.fn() }));

import worker from "./index";

const env = { MAHORAGA_API_TOKEN: "regular-token", KILL_SWITCH_SECRET: "emergency-token" } as Env;
const ctx = {} as ExecutionContext;
function request(path: string, token: string) {
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }),
    env,
    ctx
  );
}
describe("emergency stop routing", () => {
  beforeEach(() => vi.clearAllMocks());
  it("forwards the separate emergency token even when normal API is rate limited", async () => {
    expect((await request("/agent/kill", "emergency-token")).status).toBe(200);
    expect(mocks.limit).not.toHaveBeenCalled();
    const forwarded = mocks.fetch.mock.calls[0] as unknown as [Request];
    expect(new URL(forwarded[0].url).pathname).toBe("/kill");
    expect(forwarded[0].headers.get("Authorization")).toBe("Bearer emergency-token");
  });
  it("rejects the normal token and incorrect tokens for emergency stop", async () => {
    for (const token of ["regular-token", "wrong-token", ""]) {
      expect((await request("/agent/kill", token)).status).toBe(401);
    }
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("does not grant emergency tokens access to normal actions", async () => {
    expect((await request("/agent/enable", "emergency-token")).status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("retains rate limits for normal actions", async () => {
    expect((await request("/agent/disable", "regular-token")).status).toBe(429);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
