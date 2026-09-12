import { afterEach, describe, expect, it, vi } from "vitest";
import type { StrategyContext } from "../../types";
import {
  getRedditToken,
  hasRedditCredentials,
  OAUTH_BASE,
  PUBLIC_BASE,
  REDDIT_USER_AGENT,
  redditRequest,
  resetRedditToken,
} from "./reddit-auth";

function ctx(env: Record<string, string | undefined> = {}, log = vi.fn()): StrategyContext {
  return { env, log } as unknown as StrategyContext;
}
const creds = { REDDIT_CLIENT_ID: "id", REDDIT_CLIENT_SECRET: "secret" };

afterEach(() => {
  resetRedditToken();
  vi.unstubAllGlobals();
});

describe("reddit credentials", () => {
  it("detects presence and ignores blank values", () => {
    expect(hasRedditCredentials(ctx(creds))).toBe(true);
    expect(hasRedditCredentials(ctx({}))).toBe(false);
    expect(hasRedditCredentials(ctx({ REDDIT_CLIENT_ID: "  ", REDDIT_CLIENT_SECRET: "s" }))).toBe(false);
  });
});

describe("getRedditToken", () => {
  it("returns null without credentials and makes no request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await getRedditToken(ctx({}))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests an application-only token with basic auth and no user password", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "tok", expires_in: 3600 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await getRedditToken(ctx(creds))).toBe("tok");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://www.reddit.com/api/v1/access_token");
    expect(init.body).toBe("grant_type=client_credentials");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa("id:secret")}`);
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(REDDIT_USER_AGENT);
    expect(String(init.body)).not.toContain("password");
  });

  it("reuses a cached token and refreshes before expiry", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "tok", expires_in: 3600 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const c = ctx(creds);
    const t0 = 1_000_000;

    await getRedditToken(c, t0);
    await getRedditToken(c, t0 + 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Inside the last minute of the window it refreshes rather than risk expiry mid-pass.
    await getRedditToken(c, t0 + 3600_000 - 30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("degrades to null on a rejected or malformed token response", async () => {
    const log = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    expect(await getRedditToken(ctx(creds, log))).toBeNull();
    expect(log).toHaveBeenCalledWith("Reddit", "oauth_failed", { status: 401 });

    resetRedditToken();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    expect(await getRedditToken(ctx(creds))).toBeNull();

    resetRedditToken();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await getRedditToken(ctx(creds))).toBeNull();
  });
});

describe("redditRequest", () => {
  it("routes to the OAuth host when authenticated", () => {
    const r = redditRequest("tok");
    expect(r.base).toBe(OAUTH_BASE);
    expect(r.headers.Authorization).toBe("Bearer tok");
  });

  it("falls back to the public host without a token", () => {
    const r = redditRequest(null);
    expect(r.base).toBe(PUBLIC_BASE);
    expect(r.headers.Authorization).toBeUndefined();
    expect(r.headers["User-Agent"]).toBe(REDDIT_USER_AGENT);
  });
});
