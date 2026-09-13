import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../env.d";
import { candidate } from "../strategy/guidance-continuation/fixtures.test-helper";
import { handleResearch } from "./api";
import { appendImmutable, hash } from "./ledger";
import { testDatabase } from "./test-db";

const databases: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
  databases.splice(0).forEach((d) => d.close());
});
const setup = () => {
  const d = testDatabase();
  databases.push(d);
  return d;
};
const request = (action: string, body: unknown) =>
  new Request(`http://harness/research/${action}`, { method: "POST", body: JSON.stringify(body) });

describe("immutable research ledger and actual SQL migrations", () => {
  it("retries identical event versions but rejects rewriting them", async () => {
    const { db } = setup();
    const columns = {
      event_key: "event",
      version: "1",
      symbol: "TEST",
      payload: "original",
      observed_at: new Date().toISOString(),
    };
    await appendImmutable(db, "research_events", "id", columns);
    await appendImmutable(db, "research_events", "id", columns);
    await expect(appendImmutable(db, "research_events", "id", { ...columns, payload: "changed" })).rejects.toThrow(
      /Immutable/
    );
    expect(await db.executeOne("SELECT COUNT(*) AS count FROM research_events")).toEqual({ count: 1 });
  });
  it("server stamps source observation and cannot backdate it on retry", async () => {
    const { raw } = setup();
    const env = { DB: raw, ALPACA_PAPER: "true" } as Env;
    const doc = {
      source_url: "https://issuer.example/release",
      content: "EPS 2.00",
      published_at: "2026-09-10T20:00:00Z",
    };
    const now = Date.parse("2026-09-11T10:00:00Z");
    const first = (await (await handleResearch(request("evidence", doc), env, now)).json()) as {
      evidence: { observed_at: string; content_hash: string };
    };
    const retry = (await (await handleResearch(request("evidence", doc), env, now + 1000)).json()) as typeof first;
    expect(first.evidence.observed_at).toBe(new Date(now).toISOString());
    expect(retry.evidence).toEqual(first.evidence);
    expect(first.evidence.content_hash).toBe(await hash(doc.content));
    expect(
      (await handleResearch(request("evidence", { ...doc, first_observed_at: doc.published_at }), env, now)).status
    ).toBe(422);
  });
  it("rejects events with missing source documents or fabricated excerpts", async () => {
    const { raw } = setup();
    const x = candidate();
    expect(
      (await handleResearch(request("events", x.event), { DB: raw, ALPACA_PAPER: "true" } as Env, Date.parse(x.at)))
        .status
    ).toBe(422);
  });
  it("supports collection independently of trading enablement and exposes no pilot switch", async () => {
    const { raw } = setup();
    const env = { DB: raw, ALPACA_PAPER: "true" } as Env;
    const status = (await (await handleResearch(new Request("http://harness/research/status"), env)).json()) as {
      broker_orders_enabled: boolean;
    };
    expect(status.broker_orders_enabled).toBe(false);
    expect((await handleResearch(request("enable", {}), env)).status).toBe(404);
    expect((await handleResearch(request("events", {}), { ...env, ALPACA_PAPER: "false" })).status).toBe(409);
  });
  it("ingests evidence, qualifies an event, and freezes the session decision across retries", async () => {
    const { raw, db } = setup();
    const env = { DB: raw, ALPACA_PAPER: "true" } as Env;
    const x = candidate();
    const refs = [
      x.event.actual_eps,
      x.event.consensus_eps,
      x.event.actual_revenue,
      x.event.previous_guidance,
      x.event.new_guidance,
    ]
      .map((m) => m!.evidence)
      .concat(x.event.review.evidence);
    for (const ref of refs) {
      const content = `${ref.excerpt} ${ref.published_at}`;
      const result = await handleResearch(
        request("evidence", { source_url: ref.source_url, content, published_at: ref.published_at }),
        env,
        Date.parse(ref.first_observed_at)
      );
      expect(result.status).toBe(200);
      ref.content_hash = await hash(content);
    }
    const inserted = await handleResearch(request("events", x.event), env, Date.parse("2026-09-11T11:00:00Z"));
    expect(inserted.status).toBe(200);
    const { id } = (await inserted.json()) as { id: string };
    const { event: _event, at: _at, ...market } = x;
    const body = {
      candidates: [{ event_id: id, market }],
      portfolio: {
        equity: 100000,
        cash: 100000,
        peakEquity: 100000,
        paused: false,
        allocations: [],
        attemptedEvents: [],
      },
    };
    const first = await handleResearch(request("evaluate", body), env, Date.parse(x.at));
    expect(first.status).toBe(200);
    const data = (await first.json()) as {
      results: Array<{ result: { decision: { reasons: string[] }; allocation: { quantity: number } } }>;
    };
    expect(data.results[0]!.result.decision.reasons).toEqual([]);
    expect(data.results[0]!.result.allocation.quantity).toBeGreaterThan(0);
    const again = await handleResearch(request("evaluate", body), env, Date.parse(x.at) + 1000);
    expect(again.status).toBe(200);
    expect(await db.executeOne("SELECT COUNT(*) AS count FROM research_decisions")).toEqual({ count: 1 });
    expect(await db.executeOne("SELECT COUNT(*) AS count FROM research_batches")).toEqual({ count: 1 });
  });
});
