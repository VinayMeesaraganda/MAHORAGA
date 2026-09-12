import type { Env } from "../../env.d";
import type { LLMProvider } from "../types";
import { createAISDKProvider, SUPPORTED_PROVIDERS, type SupportedProvider } from "./ai-sdk";
import { createCloudflareGatewayProvider } from "./cloudflare-gateway";
import { createOpenAIProvider } from "./openai";

export type LLMProviderType = "openai-raw" | "ai-sdk" | "cloudflare-gateway";

/**
 * Resolve the model id sent to an OpenAI-compatible endpoint.
 *
 * "openai/gpt-4o" is a provider-qualified name used by the gateway modes, and
 * the OpenAI API itself wants the bare id. Every other OpenAI-compatible
 * upstream owns its own namespace: NVIDIA NIM ids are always
 * "publisher/model" (meta/llama-3.1-70b-instruct) and 404 if the prefix is
 * stripped. So remove only the openai/ qualifier, and only when no custom base
 * URL has redirected the request somewhere else.
 */
export function resolveOpenAIModel(model: string, customBaseUrl?: string): string {
  if (customBaseUrl) return model;
  return model.toLowerCase().startsWith("openai/") ? model.slice("openai/".length) : model;
}

/**
 * Parse LLM_EXTRA_BODY, a JSON object of vendor-specific request fields.
 *
 * Malformed values are ignored with a warning rather than disabling the
 * provider: a typo here should not silently stop the agent from trading.
 */
export function parseExtraBody(
  raw: string | undefined,
  warn: (message: string) => void = console.warn
): Record<string, unknown> | undefined {
  if (!raw?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn("LLM_EXTRA_BODY is not valid JSON; ignoring it");
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    warn("LLM_EXTRA_BODY must be a JSON object; ignoring it");
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Factory function to create LLM provider based on environment configuration.
 *
 * Provider selection (via LLM_PROVIDER env):
 * - "openai-raw": Direct OpenAI API calls (default, backward compatible)
 * - "ai-sdk": Vercel AI SDK with 5 providers (OpenAI, Anthropic, Google, xAI, DeepSeek)
 * - "cloudflare-gateway": Cloudflare AI Gateway (/compat) for unified access
 *
 * @param env - Environment variables
 * @returns LLMProvider instance or null if no valid configuration
 */
export function createLLMProvider(env: Env): LLMProvider | null {
  const providerType = (env.LLM_PROVIDER as LLMProviderType) ?? "openai-raw";
  const model = env.LLM_MODEL ?? "gpt-4o-mini";
  const openaiBaseUrlRaw = env.OPENAI_BASE_URL?.trim().replace(/\/+$/, "");
  const openaiBaseUrl = openaiBaseUrlRaw ? openaiBaseUrlRaw : undefined;

  switch (providerType) {
    case "cloudflare-gateway": {
      if (!env.CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID || !env.CLOUDFLARE_AI_GATEWAY_ID || !env.CLOUDFLARE_AI_GATEWAY_TOKEN) {
        console.warn(
          "LLM_PROVIDER=cloudflare-gateway requires CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID, CLOUDFLARE_AI_GATEWAY_ID, and CLOUDFLARE_AI_GATEWAY_TOKEN"
        );
        return null;
      }

      // Cloudflare /compat expects provider/model. If user passes an unqualified model, default to OpenAI.
      const effectiveModel = model.includes("/") ? model : `openai/${model}`;

      return createCloudflareGatewayProvider({
        accountId: env.CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID,
        gatewayId: env.CLOUDFLARE_AI_GATEWAY_ID,
        token: env.CLOUDFLARE_AI_GATEWAY_TOKEN,
        model: effectiveModel,
      });
    }

    case "ai-sdk": {
      // Collect all available API keys
      const apiKeys: Partial<Record<SupportedProvider, string>> = {};
      if (env.OPENAI_API_KEY) apiKeys.openai = env.OPENAI_API_KEY;
      if (env.ANTHROPIC_API_KEY) apiKeys.anthropic = env.ANTHROPIC_API_KEY;
      if (env.GOOGLE_GENERATIVE_AI_API_KEY) apiKeys.google = env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (env.XAI_API_KEY) apiKeys.xai = env.XAI_API_KEY;
      if (env.DEEPSEEK_API_KEY) apiKeys.deepseek = env.DEEPSEEK_API_KEY;

      if (Object.keys(apiKeys).length === 0) {
        console.warn("LLM_PROVIDER=ai-sdk requires at least one provider API key");
        return null;
      }

      // Check if the selected model's provider has an API key
      const [providerName] = model.split("/");
      const provider = providerName?.toLowerCase() as SupportedProvider;
      if (providerName && provider in SUPPORTED_PROVIDERS && !apiKeys[provider]) {
        console.warn(`Model '${model}' requires ${SUPPORTED_PROVIDERS[provider].envKey}`);
        return null;
      }

      return createAISDKProvider({ model, apiKeys, openaiBaseUrl });
    }
    default:
      // Backward compatible: use existing OpenAI provider
      if (!env.OPENAI_API_KEY) {
        return null;
      }
      return createOpenAIProvider({
        apiKey: env.OPENAI_API_KEY,
        model: resolveOpenAIModel(model, openaiBaseUrl),
        baseUrl: openaiBaseUrl,
        extraBody: parseExtraBody(env.LLM_EXTRA_BODY),
      });
  }
}

/**
 * Check if LLM features are available based on environment configuration.
 */
export function isLLMConfigured(env: Env): boolean {
  const providerType = (env.LLM_PROVIDER as LLMProviderType) ?? "openai-raw";

  switch (providerType) {
    case "cloudflare-gateway":
      return !!(
        env.CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID &&
        env.CLOUDFLARE_AI_GATEWAY_ID &&
        env.CLOUDFLARE_AI_GATEWAY_TOKEN
      );
    case "ai-sdk":
      // Any provider API key enables AI SDK
      return !!(
        env.OPENAI_API_KEY ||
        env.ANTHROPIC_API_KEY ||
        env.GOOGLE_GENERATIVE_AI_API_KEY ||
        env.XAI_API_KEY ||
        env.DEEPSEEK_API_KEY
      );
    default:
      return !!env.OPENAI_API_KEY;
  }
}

/**
 * Get list of configured providers based on available API keys
 */
export function getConfiguredProviders(env: Env): SupportedProvider[] {
  const configured: SupportedProvider[] = [];
  if (env.OPENAI_API_KEY) configured.push("openai");
  if (env.ANTHROPIC_API_KEY) configured.push("anthropic");
  if (env.GOOGLE_GENERATIVE_AI_API_KEY) configured.push("google");
  if (env.XAI_API_KEY) configured.push("xai");
  if (env.DEEPSEEK_API_KEY) configured.push("deepseek");
  return configured;
}
