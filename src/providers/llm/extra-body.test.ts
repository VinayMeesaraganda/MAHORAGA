import { describe, expect, it, vi } from "vitest";
import { parseExtraBody } from "./factory";
import { createOpenAIProvider } from "./openai";

function mockFetch() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      id: "t",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof mockFetch>) {
  const call = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(call[1].body as string);
}

describe("parseExtraBody", () => {
  it("accepts a JSON object", () => {
    expect(parseExtraBody('{"chat_template_kwargs":{"enable_thinking":false}}')).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  it("ignores blank, malformed and non-object values with a warning", () => {
    const warn = vi.fn();
    expect(parseExtraBody(undefined, warn)).toBeUndefined();
    expect(parseExtraBody("   ", warn)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();

    expect(parseExtraBody("{not json", warn)).toBeUndefined();
    expect(parseExtraBody("[1,2]", warn)).toBeUndefined();
    expect(parseExtraBody("null", warn)).toBeUndefined();
    expect(parseExtraBody('"a string"', warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(4);
  });
});

describe("OpenAIProvider extraBody", () => {
  it("merges vendor fields into the request body", async () => {
    const fetchMock = mockFetch();
    const provider = createOpenAIProvider({
      apiKey: "k",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      model: "nvidia/nemotron-3.5-lightning-30b-a3b",
      extraBody: { chat_template_kwargs: { enable_thinking: false } },
    });
    await provider.complete({ messages: [{ role: "user", content: "hi" }] });

    const body = sentBody(fetchMock);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.model).toBe("nvidia/nemotron-3.5-lightning-30b-a3b");
    vi.unstubAllGlobals();
  });

  it("never lets vendor fields override the core request fields", async () => {
    const fetchMock = mockFetch();
    const provider = createOpenAIProvider({
      apiKey: "k",
      model: "gpt-4o-mini",
      extraBody: { model: "attacker/model", messages: [], max_tokens: 99999, temperature: 2 },
    });
    await provider.complete({
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-4o",
      max_tokens: 300,
      temperature: 0.3,
    });

    const body = sentBody(fetchMock);
    expect(body.model).toBe("gpt-4o");
    expect(body.max_tokens).toBe(300);
    expect(body.temperature).toBe(0.3);
    expect(body.messages).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("sends no vendor fields when none are configured", async () => {
    const fetchMock = mockFetch();
    const provider = createOpenAIProvider({ apiKey: "k", model: "gpt-4o-mini" });
    await provider.complete({ messages: [{ role: "user", content: "hi" }] });

    expect(Object.keys(sentBody(fetchMock)).sort()).toEqual(["max_tokens", "messages", "model", "temperature"]);
    vi.unstubAllGlobals();
  });
});
