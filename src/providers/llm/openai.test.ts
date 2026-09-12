import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCode } from "../../lib/errors";
import { createOpenAIProvider, OPENAI_REQUEST_TIMEOUT_MS, OpenAIProvider } from "./openai";

describe("OpenAI Provider", () => {
  const mockFetch = vi.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  describe("createOpenAIProvider", () => {
    it("creates provider with required config", () => {
      const provider = createOpenAIProvider({ apiKey: "sk-test" });
      expect(provider).toBeInstanceOf(OpenAIProvider);
    });

    it("creates provider with custom model", () => {
      const provider = createOpenAIProvider({
        apiKey: "sk-test",
        model: "gpt-4o",
      });
      expect(provider).toBeInstanceOf(OpenAIProvider);
    });

    it("creates provider with custom base URL", () => {
      const provider = createOpenAIProvider({
        apiKey: "sk-test",
        baseUrl: "https://custom-api.example.com",
      });
      expect(provider).toBeInstanceOf(OpenAIProvider);
    });
  });

  describe("complete", () => {
    it("aborts a stalled model request at its deadline without retrying", async () => {
      vi.useFakeTimers();
      let transportAborted = false;
      mockFetch.mockImplementationOnce(
        (_url: string, options: RequestInit) =>
          new Promise((_, reject) => {
            options.signal?.addEventListener("abort", () => {
              transportAborted = true;
              reject(new DOMException("Aborted", "AbortError"));
            });
          })
      );
      const result = createOpenAIProvider({ apiKey: "sk-test" }).complete({
        messages: [{ role: "user", content: "Test" }],
      });
      const rejection = expect(result).rejects.toMatchObject({
        code: ErrorCode.PROVIDER_ERROR,
        message: expect.stringContaining("timed out"),
      });
      await vi.advanceTimersByTimeAsync(OPENAI_REQUEST_TIMEOUT_MS);
      await rejection;
      expect(transportAborted).toBe(true);
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([true, false])("bounds response body consumption after headers resolve (ok=%s)", async (ok) => {
      vi.useFakeTimers();
      mockFetch.mockResolvedValueOnce({
        ok,
        status: ok ? 200 : 500,
        json: () => new Promise(() => {}),
        text: () => new Promise(() => {}),
      });
      const result = createOpenAIProvider({ apiKey: "sk-test" }).complete({
        messages: [{ role: "user", content: "Test" }],
      });
      const rejection = expect(result).rejects.toMatchObject({
        code: ErrorCode.PROVIDER_ERROR,
        message: expect.stringContaining("timed out"),
      });
      await vi.advanceTimersByTimeAsync(OPENAI_REQUEST_TIMEOUT_MS);
      await rejection;
      const options = mockFetch.mock.calls[0]?.[1] as RequestInit;
      expect(options.signal?.aborted).toBe(true);
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it("clears the deadline when a completion finishes", async () => {
      vi.useFakeTimers();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "Done" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      });
      await createOpenAIProvider({ apiKey: "sk-test" }).complete({ messages: [{ role: "user", content: "Test" }] });
      expect(vi.getTimerCount()).toBe(0);
      const options = mockFetch.mock.calls[0]?.[1] as RequestInit;
      expect(options.signal?.aborted).toBe(false);
    });

    it("sends correct request to OpenAI API", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "chatcmpl-123",
          choices: [{ message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      });

      const provider = createOpenAIProvider({ apiKey: "sk-test" });
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const call = mockFetch.mock.calls[0] as [string, RequestInit];
      const [url, options] = call;
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
      expect(options.method).toBe("POST");
      expect(options.headers).toMatchObject({
        "Content-Type": "application/json",
        Authorization: "Bearer sk-test",
      });

      const body = JSON.parse(options.body as string);
      expect(body.messages).toEqual([{ role: "user", content: "Hi" }]);
    });

    it("returns completion result with content and usage", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "chatcmpl-123",
          choices: [{ message: { role: "assistant", content: "Test response" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
      });

      const provider = createOpenAIProvider({ apiKey: "sk-test" });
      const result = await provider.complete({
        messages: [{ role: "user", content: "Test" }],
      });

      expect(result.content).toBe("Test response");
      expect(result.usage).toEqual({
        prompt_tokens: 20,
        completion_tokens: 10,
        total_tokens: 30,
      });
    });

    it("uses custom model when provided in params", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "chatcmpl-123",
          choices: [{ message: { content: "Response" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      });

      const provider = createOpenAIProvider({ apiKey: "sk-test", model: "gpt-4o-mini" });
      await provider.complete({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Test" }],
      });

      const call = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(call[1].body as string);
      expect(body.model).toBe("gpt-4o");
    });

    it("includes response_format when provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "chatcmpl-123",
          choices: [{ message: { content: '{"key": "value"}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      });

      const provider = createOpenAIProvider({ apiKey: "sk-test" });
      await provider.complete({
        messages: [{ role: "user", content: "Test" }],
        response_format: { type: "json_object" },
      });

      const call = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(call[1].body as string);
      expect(body.response_format).toEqual({ type: "json_object" });
    });

    it("uses default temperature and max_tokens", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "chatcmpl-123",
          choices: [{ message: { content: "Response" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      });

      const provider = createOpenAIProvider({ apiKey: "sk-test" });
      await provider.complete({
        messages: [{ role: "user", content: "Test" }],
      });

      const call = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(call[1].body as string);
      expect(body.temperature).toBe(0.7);
      expect(body.max_tokens).toBe(1024);
    });

    it("throws PROVIDER_ERROR on API failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });

      const provider = createOpenAIProvider({ apiKey: "sk-test" });

      await expect(provider.complete({ messages: [{ role: "user", content: "Test" }] })).rejects.toMatchObject({
        code: ErrorCode.PROVIDER_ERROR,
      });
    });

    it("throws PROVIDER_ERROR on 401 unauthorized", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Invalid API key",
      });

      const provider = createOpenAIProvider({ apiKey: "invalid-key" });

      await expect(provider.complete({ messages: [{ role: "user", content: "Test" }] })).rejects.toMatchObject({
        code: ErrorCode.PROVIDER_ERROR,
        message: expect.stringContaining("401"),
      });
    });

    it("handles empty content in response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "chatcmpl-123",
          choices: [{ message: { role: "assistant" } }],
          usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
        }),
      });

      const provider = createOpenAIProvider({ apiKey: "sk-test" });
      const result = await provider.complete({
        messages: [{ role: "user", content: "Test" }],
      });

      expect(result.content).toBe("");
    });

    it("uses custom base URL when provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: "chatcmpl-123",
          choices: [{ message: { content: "Response" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      });

      const provider = createOpenAIProvider({
        apiKey: "sk-test",
        baseUrl: "https://custom-api.example.com",
      });
      await provider.complete({
        messages: [{ role: "user", content: "Test" }],
      });

      const call = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(call[0]).toBe("https://custom-api.example.com/chat/completions");
    });
  });
});
