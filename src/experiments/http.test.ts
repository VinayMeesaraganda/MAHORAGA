import { afterEach, describe, expect, it, vi } from "vitest";
import { authorized, fetchText, readBody } from "./http";
afterEach(() => vi.unstubAllGlobals());
describe("bounded authenticated source IO", () => {
  it("uses a Workers-supported redirect policy without forwarding credentials to a redirect", async () => {
    const fetcher = vi.fn(
      async () => new Response(null, { status: 302, headers: { Location: "https://untrusted.invalid" } })
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      fetchText("https://finnhub.io/api/v1/calendar/earnings", { "X-Finnhub-Token": "private" })
    ).rejects.toThrow("HTTP 302");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: "manual" }));
  });
  it("rejects oversized bodies", async () => {
    await expect(readBody(new Request("http://test", { method: "POST", body: "123456" }), 5)).rejects.toThrow("large");
  });
  it("accepts only the correct bearer secret", async () => {
    expect(
      await authorized(new Request("http://test", { headers: { Authorization: "Bearer correct" } }), "correct")
    ).toBe(true);
    expect(
      await authorized(new Request("http://test", { headers: { Authorization: "Bearer wrong" } }), "correct")
    ).toBe(false);
    expect(await authorized(new Request("http://test?token=correct"), "correct")).toBe(false);
  });
});
