import type { D1Client } from "../storage/d1/client";
import { adverseCatalystReason } from "../strategy/default/helpers/catalyst";

/** Conservative veto only. Headlines cannot prove a guidance raise or trigger liquidation. */
export async function newsEntryVeto(db: D1Client, symbol: string, from: string, now: number): Promise<string | null> {
  const rows = await db.execute<{ payload: string }>(
    "SELECT n.payload FROM research_news n WHERE n.observed_at<=? AND julianday(json_extract(n.payload,'$.created_at'))>=julianday(?) AND EXISTS (SELECT 1 FROM json_each(n.payload,'$.symbols') WHERE value=?) AND NOT EXISTS (SELECT 1 FROM research_news newer WHERE newer.article_id=n.article_id AND newer.observed_at<=? AND (newer.observed_at>n.observed_at OR (newer.observed_at=n.observed_at AND newer.rowid>n.rowid))) ORDER BY n.observed_at DESC LIMIT 500",
    [new Date(now).toISOString(), from, symbol, new Date(now).toISOString()]
  );
  if (rows.length >= 500) return "news_review_truncated";
  for (const row of rows) {
    const article = JSON.parse(row.payload);
    if (
      !Array.isArray(article.symbols) ||
      typeof article.headline !== "string" ||
      !Number.isFinite(Date.parse(article.created_at))
    )
      return "news_document_invalid";
    if (Date.parse(article.created_at) > now) return "news_document_future";
    const symbols = [...new Set(article.symbols)];
    if (
      symbols.length === 1 &&
      symbols[0] === symbol &&
      adverseCatalystReason(`${article.headline} ${article.summary ?? ""}`)
    )
      return "adverse_issuer_news_pending_review";
  }
  return null;
}
