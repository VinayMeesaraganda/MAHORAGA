import type { AlpacaMarketDataProvider } from "../providers/alpaca/market-data";
import type { D1Client } from "../storage/d1/client";
import { hash } from "./ledger";

export interface Coverage {
  from: string;
  /** Earliest contiguous successfully collected history; `from` is the current page cycle. */
  historyFrom?: string;
  through: string | null;
  end: string;
  pageToken: string | null;
  complete: boolean;
  error: string | null;
  seenTokens: string[];
}
/** One bounded page per call. A crash repeats a page safely; cursor advances after durable article writes. */
export async function collectNews(
  db: D1Client,
  provider: Pick<AlpacaMarketDataProvider, "getNewsPage">,
  symbols: string[],
  now = Date.now()
): Promise<Coverage> {
  const normalized = [...new Set(symbols)].sort();
  const stream = `alpaca:${normalized.join(",") || "all"}`;
  const row = await db.executeOne<{ state_json: string }>("SELECT state_json FROM research_coverage WHERE stream = ?", [
    stream,
  ]);
  const old: Coverage | null = row ? JSON.parse(row.state_json) : null;
  const state: Coverage =
    old && !old.complete
      ? old
      : {
          from: new Date(old?.through ? Date.parse(old.through) - 300_000 : now - 7 * 86_400_000).toISOString(),
          historyFrom: old?.historyFrom ?? old?.from ?? new Date(now - 7 * 86_400_000).toISOString(),
          through: old?.through ?? null,
          end: new Date(now).toISOString(),
          pageToken: null,
          complete: false,
          error: null,
          seenTokens: [],
        };
  try {
    const page = await provider.getNewsPage({
      symbols: normalized,
      start: state.from,
      end: state.end,
      sort: "asc",
      limit: 50,
      page_token: state.pageToken ?? undefined,
    });
    for (const article of page.news) {
      const payload = JSON.stringify(article),
        contentHash = await hash(payload);
      await db.run(
        "INSERT OR IGNORE INTO research_news (id, article_id, updated_at, content_hash, payload, observed_at) VALUES (?, ?, ?, ?, ?, ?)",
        [
          `${article.id}:${contentHash}`,
          String(article.id),
          article.updated_at,
          contentHash,
          payload,
          new Date(now).toISOString(),
        ]
      );
    }
    if (page.next_page_token && state.seenTokens.includes(page.next_page_token))
      throw new Error("Repeated news cursor");
    if (page.next_page_token) state.seenTokens.push(page.next_page_token);
    state.pageToken = page.next_page_token;
    state.complete = !page.next_page_token;
    if (state.complete) {
      state.through = state.end;
      state.seenTokens = [];
    }
    state.error = null;
  } catch (error) {
    state.error = String(error);
    state.complete = false;
  }
  await db.run(
    "INSERT INTO research_coverage (stream, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(stream) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
    [stream, JSON.stringify(state), new Date(now).toISOString()]
  );
  return state;
}
