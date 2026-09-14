import { describe, expect, it } from "vitest";
import { testDatabase } from "../research/test-db";
import { newsEntryVeto } from "./news-risk";
describe("issuer news entry veto", () => {
  it("does not attribute a multi-company guidance cut to every ticker", async () => {
    const { db, close } = testDatabase(),
      now = Date.parse("2026-09-14T14:00:00Z");
    const payload = {
      headline: "Company cuts revenue guidance",
      summary: "",
      symbols: ["AAPL", "MSFT"],
      created_at: "2026-09-14T13:00:00Z",
    };
    try {
      await db.run(
        "INSERT INTO research_news (id,article_id,updated_at,content_hash,payload,observed_at) VALUES (?,?,?,?,?,?)",
        ["one", "1", payload.created_at, "hash1", JSON.stringify(payload), "2026-09-14T13:01:00.000Z"]
      );
      expect(await newsEntryVeto(db, "AAPL", "2026-09-13T00:00:00Z", now)).toBeNull();
      await db.run(
        "INSERT INTO research_news (id,article_id,updated_at,content_hash,payload,observed_at) VALUES (?,?,?,?,?,?)",
        [
          "two",
          "1",
          payload.created_at,
          "hash2",
          JSON.stringify({ ...payload, symbols: ["AAPL"] }),
          "2026-09-14T13:02:00.000Z",
        ]
      );
      expect(await newsEntryVeto(db, "AAPL", "2026-09-13T00:00:00Z", now)).toBe("adverse_issuer_news_pending_review");
      expect(await newsEntryVeto(db, "MSFT", "2026-09-13T00:00:00Z", now)).toBeNull();
    } finally {
      close();
    }
  });
});
