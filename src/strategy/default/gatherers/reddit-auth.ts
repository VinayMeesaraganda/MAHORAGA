/**
 * Reddit application-only OAuth.
 *
 * The unauthenticated www.reddit.com JSON endpoints are blocked from datacenter
 * IPs (HTTP 403) and capped near 10 requests per minute where they do respond.
 * A script app's client_credentials grant lifts that to roughly 100 queries per
 * minute per client and returns a token with no user context — so no Reddit
 * account password is involved, only the app's own id and secret.
 *
 * https://github.com/reddit-archive/reddit/wiki/OAuth2
 */

import type { StrategyContext } from "../../types";

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
export const OAUTH_BASE = "https://oauth.reddit.com";
export const PUBLIC_BASE = "https://www.reddit.com";

/** Reddit rejects generic agents; this is the documented platform:id:version form. */
export const REDDIT_USER_AGENT = "cloudflare-worker:mahoraga:v0.3.0 (trading signal gatherer)";

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Module-scoped so a token survives across gather passes within an isolate. */
let cached: CachedToken | null = null;

export function hasRedditCredentials(ctx: StrategyContext): boolean {
  return !!(ctx.env.REDDIT_CLIENT_ID?.trim() && ctx.env.REDDIT_CLIENT_SECRET?.trim());
}

/** Exposed for tests; also lets a credential change take effect without a redeploy. */
export function resetRedditToken(): void {
  cached = null;
}

/**
 * Fetch (or reuse) an application-only access token.
 *
 * Returns null rather than throwing: a credential problem should downgrade the
 * gatherer to the public endpoint, never fail the whole alarm cycle.
 */
export async function getRedditToken(ctx: StrategyContext, now = Date.now()): Promise<string | null> {
  if (!hasRedditCredentials(ctx)) return null;
  // Refresh a minute early so a token cannot expire mid-pass.
  if (cached && cached.expiresAt - 60_000 > now) return cached.token;

  const basic = btoa(`${ctx.env.REDDIT_CLIENT_ID?.trim()}:${ctx.env.REDDIT_CLIENT_SECRET?.trim()}`);
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": REDDIT_USER_AGENT,
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      ctx.log("Reddit", "oauth_failed", { status: res.status });
      return null;
    }

    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      ctx.log("Reddit", "oauth_failed", { reason: "No access_token in response" });
      return null;
    }

    const ttlSeconds =
      Number.isFinite(data.expires_in) && (data.expires_in ?? 0) > 0 ? (data.expires_in as number) : 3600;
    cached = { token: data.access_token, expiresAt: now + ttlSeconds * 1000 };
    ctx.log("Reddit", "oauth_token_acquired", { expires_in_s: ttlSeconds });
    return cached.token;
  } catch (error) {
    ctx.log("Reddit", "oauth_error", { error: String(error) });
    return null;
  }
}

/** Base URL and headers for a listing request, authenticated when possible. */
export function redditRequest(token: string | null): { base: string; headers: Record<string, string> } {
  return token
    ? { base: OAUTH_BASE, headers: { Authorization: `Bearer ${token}`, "User-Agent": REDDIT_USER_AGENT } }
    : { base: PUBLIC_BASE, headers: { "User-Agent": REDDIT_USER_AGENT } };
}
