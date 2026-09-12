import { createError, ErrorCode } from "../../lib/errors";
import { withRequestDeadline } from "../../lib/request-deadline";
import type { CompletionParams, CompletionResult, LLMProvider } from "../types";

export const OPENAI_REQUEST_TIMEOUT_MS = 30_000;

export interface OpenAIConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /**
   * Vendor-specific fields merged into every request body.
   *
   * OpenAI-compatible upstreams add their own knobs. NVIDIA NIM reasoning
   * models enable thinking by default and bill it against max_tokens, which
   * leaves `content` empty under this harness's small budgets; turning it off
   * needs {"chat_template_kwargs":{"enable_thinking":false}}. Core fields
   * always win, so this can never rewrite the model or the messages.
   */
  extraBody?: Record<string, unknown>;
}

interface OpenAIResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class OpenAIProvider implements LLMProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private extraBody: Record<string, unknown>;

  constructor(config: OpenAIConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "gpt-4o-mini";
    this.baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").trim().replace(/\/+$/, "");
    this.extraBody = config.extraBody ?? {};
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    return withRequestDeadline(
      OPENAI_REQUEST_TIMEOUT_MS,
      createError(ErrorCode.PROVIDER_ERROR, `OpenAI request timed out after ${OPENAI_REQUEST_TIMEOUT_MS}ms.`),
      (signal) => this.completeWithinDeadline(params, signal)
    );
  }

  private async completeWithinDeadline(params: CompletionParams, signal: AbortSignal): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      ...this.extraBody,
      model: params.model ?? this.model,
      messages: params.messages,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.max_tokens ?? 1024,
    };

    if (params.response_format) {
      body.response_format = params.response_format;
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw createError(ErrorCode.PROVIDER_ERROR, `OpenAI API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as OpenAIResponse;

    const content = data.choices[0]?.message?.content ?? "";

    return {
      content,
      usage: {
        prompt_tokens: data.usage.prompt_tokens,
        completion_tokens: data.usage.completion_tokens,
        total_tokens: data.usage.total_tokens,
      },
    };
  }
}

export function createOpenAIProvider(config: OpenAIConfig): OpenAIProvider {
  return new OpenAIProvider(config);
}
