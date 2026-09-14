import { z } from "zod";
import type { Env } from "../env.d";
import { createAlpacaProviders } from "../providers/alpaca";
import { EarningsEventSchema, EvidenceSchema, Timestamp } from "../schemas/earnings-event";
import { createD1Client } from "../storage/d1/client";
import { GUIDANCE_PROFILE } from "../strategy/guidance-continuation/config";
import {
  allocate,
  type CandidateInput,
  CandidateInputSchema,
  type Decision,
  evaluateCandidate,
  localTime,
} from "../strategy/guidance-continuation/rules";
import { appendImmutable, hash } from "./ledger";
import { collectNews } from "./news";

const EvidenceInput = z
  .object({
    source_url: EvidenceSchema.shape.source_url,
    content: z.string().min(1).max(250_000),
    published_at: Timestamp,
  })
  .strict();
const PortfolioSchema = z
  .object({
    equity: z.number().positive(),
    cash: z.number().nonnegative(),
    peakEquity: z.number().positive(),
    paused: z.boolean(),
    allocations: z.array(
      z
        .object({
          issuer: z.string(),
          sector: z.string(),
          value: z.number().nonnegative(),
          initialRisk: z.number().nonnegative(),
        })
        .strict()
    ),
    attemptedEvents: z.array(z.string()),
  })
  .strict();
const BatchSchema = z
  .object({
    candidates: z
      .array(z.object({ event_id: z.string(), market: CandidateInputSchema.omit({ event: true, at: true }) }).strict())
      .min(1)
      .max(100),
    portfolio: PortfolioSchema,
  })
  .strict();
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

/** Called only behind the existing authenticated, rate-limited Durable Object router.
 * No endpoint in this module submits broker orders or enables the trading harness.
 */
export async function handleResearch(request: Request, env: Pick<Env, "DB" | "ALPACA_API_KEY" | "ALPACA_API_SECRET" | "ALPACA_PAPER">, now = Date.now()): Promise<Response> {
  const db = createD1Client(env.DB),
    action = new URL(request.url).pathname.split("/").at(-1);
  if (request.method === "GET") {
    if (action === "decisions") {
      const cursor = Number(new URL(request.url).searchParams.get("cursor") ?? 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0) return response({ error: "Invalid cursor" }, 422);
      const rows = await db.execute<{ cursor: number; input_json: string; result_json: string }>(
        "SELECT rowid AS cursor, id, input_json, result_json, profile_hash, created_at FROM research_decisions WHERE rowid > ? ORDER BY rowid LIMIT 100",
        [cursor]
      );
      return response({ mode: "shadow", rows, next_cursor: rows.length === 100 ? rows.at(-1)!.cursor : null });
    }
    if (action !== "status") return response({ error: "Not found" }, 404);
    const [events, decisions, coverage, news] = await Promise.all([
      db.executeOne("SELECT COUNT(*) AS count FROM research_events"),
      db.executeOne("SELECT COUNT(*) AS count FROM research_decisions"),
      db.execute("SELECT stream, state_json, updated_at FROM research_coverage"),
      db.executeOne("SELECT COUNT(*) AS count FROM research_news"),
    ]);
    return response({
      profile: GUIDANCE_PROFILE,
      profile_hash: await hash(JSON.stringify(GUIDANCE_PROFILE)),
      events,
      decisions,
      coverage,
      news,
      broker_orders_enabled: false,
      blockers: [
        "Point-in-time EPS consensus and issuer evidence must be ingested",
        "Shadow results are not broker fills",
        "Pilot requires separate execution acceptance",
      ],
    });
  }
  if (request.method !== "POST") return response({ error: "Method not allowed" }, 405);
  if (env.ALPACA_PAPER !== "true") return response({ error: "Research deployment requires explicit paper mode" }, 409);
  const text = await request.text();
  if (text.length > 1_000_000) return response({ error: "Research payload too large" }, 413);
  try {
    const body: unknown = JSON.parse(text || "{}"),
      observed = new Date(now).toISOString();
    if (action === "evidence") {
      const doc = EvidenceInput.parse(body);
      if (Date.parse(doc.published_at) > now) return response({ error: "Future publication" }, 422);
      const contentHash = await hash(doc.content),
        id = await hash(`${doc.source_url}\n${contentHash}`);
      await db.run(
        "INSERT OR IGNORE INTO research_evidence (id, source_url, content_hash, content, published_at, observed_at) VALUES (?, ?, ?, ?, ?, ?)",
        [id, doc.source_url, contentHash, doc.content, doc.published_at, observed]
      );
      const stored = await db.executeOne(
        "SELECT id, source_url, content_hash, published_at, observed_at FROM research_evidence WHERE id = ?",
        [id]
      );
      return response({ ok: true, evidence: stored });
    }
    if (action === "events") {
      const event = EarningsEventSchema.parse(body);
      if (Date.parse(event.released_at) > now || Date.parse(event.review.reviewed_at) > now)
        return response({ error: "Future event or review" }, 422);
      const refs = [
        event.actual_eps,
        event.consensus_eps,
        event.actual_revenue,
        event.consensus_revenue,
        event.previous_guidance,
        event.new_guidance,
      ]
        .flatMap((m) => (m ? [m.evidence] : []))
        .concat(event.review.evidence);
      for (const ref of refs) {
        const source = await db.executeOne<{ content: string; observed_at: string; published_at: string }>(
          "SELECT content, observed_at, published_at FROM research_evidence WHERE source_url = ? AND content_hash = ?",
          [ref.source_url, ref.content_hash]
        );
        if (
          !source ||
          !source.content.includes(ref.excerpt) ||
          ref.first_observed_at !== source.observed_at ||
          ref.published_at !== source.published_at
        )
          return response(
            { error: "Evidence is missing, excerpt mismatched or availability backdated; ingest source first" },
            422
          );
      }
      const id = await hash(`${event.event_key}\n${event.version}`);
      await appendImmutable(db, "research_events", id, {
        event_key: event.event_key,
        version: event.version,
        symbol: event.symbol,
        payload: JSON.stringify(event),
        observed_at: observed,
      });
      return response({ ok: true, id });
    }
    if (action === "collect") {
      const parsed = z
        .object({
          symbols: z
            .array(z.string().regex(/^[A-Z][A-Z0-9.-]{0,14}$/))
            .max(100)
            .default([]),
        })
        .strict()
        .parse(body);
      const alpaca = createAlpacaProviders(env);
      // Held symbols are their own priority stream; a failure cannot masquerade as an empty portfolio.
      const held = (await alpaca.trading.getPositions())
        .filter((p) => p.asset_class === "us_equity")
        .map((p) => p.symbol);
      const heldCoverage = held.length ? await collectNews(db, alpaca.marketData, held, now) : null;
      const marketCoverage = await collectNews(db, alpaca.marketData, parsed.symbols, now);
      return response({ held: heldCoverage, market: marketCoverage, broker_orders_enabled: false });
    }
    if (action === "evaluate") {
      const batch = BatchSchema.parse(body),
        session = localTime(now).date;
      const inputs: CandidateInput[] = [],
        decisions: Decision[] = [];
      const profileHash = await hash(JSON.stringify(GUIDANCE_PROFILE));
      for (const candidate of batch.candidates) {
        const row = await db.executeOne<{ payload: string; observed_at: string; event_key: string }>(
          "SELECT payload, observed_at, event_key FROM research_events WHERE id = ?",
          [candidate.event_id]
        );
        if (!row || Date.parse(row.observed_at) > now) return response({ error: "Event unavailable" }, 422);
        const event = EarningsEventSchema.parse(JSON.parse(row.payload));
        const latest = await db.executeOne<{ payload: string }>(
          "SELECT payload FROM research_events WHERE event_key = ? ORDER BY observed_at DESC, rowid DESC LIMIT 1",
          [row.event_key]
        );
        if (latest?.payload !== row.payload) return response({ error: "Superseded event version" }, 409);
        const input = CandidateInputSchema.parse({ ...candidate.market, event, at: observed });
        inputs.push(input);
        decisions.push(evaluateCandidate(input));
      }
      if (new Set(decisions.map((d) => d.eventKey)).size !== decisions.length)
        return response({ error: "Duplicate event in batch" }, 422);
      const batchId = `${GUIDANCE_PROFILE.name}:${session}`;
      const eventKeys = JSON.stringify(decisions.map((d) => d.eventKey).sort());
      const frozen = await db.executeOne<{ event_keys: string }>(
        "SELECT event_keys FROM research_batches WHERE id = ?",
        [batchId]
      );
      if (frozen && frozen.event_keys !== eventKeys)
        return response({ error: "Session candidate set is already frozen" }, 409);
      const allocations = allocate(
        decisions.flatMap((d) => (d.plan ? [d.plan] : [])),
        batch.portfolio
      );
      const rows = await Promise.all(
        decisions.map(async (decision, i) => {
          const id = await hash(`${GUIDANCE_PROFILE.name}\n${decision.eventKey}\n${session}`);
          const prior = await db.executeOne<{ result_json: string }>(
            "SELECT result_json FROM research_decisions WHERE id = ?",
            [id]
          );
          if (prior) return { id, replayed: true, result: JSON.parse(prior.result_json) };
          const result = {
            decision,
            allocation: allocations.find((a) => a.plan.eventKey === decision.eventKey) ?? null,
            mode: "shadow",
            execution: "not_submitted",
            portfolio_source: "operator_supplied_shadow_ledger",
          };
          return {
            id,
            replayed: false,
            result,
            input: JSON.stringify({ candidate: inputs[i], portfolio: batch.portfolio }),
          };
        })
      );
      // Atomic batch freezes the entire ranked candidate set. Mixing old and new batches would misallocate capacity.
      if (rows.some((r) => r.replayed) && rows.some((r) => !r.replayed))
        return response({ error: "Candidate set already frozen; mixed reevaluation is not allowed" }, 409);
      if (!rows[0]!.replayed) {
        await db.batch([
          db
            .prepare("INSERT INTO research_batches (id, event_keys, created_at) VALUES (?, ?, ?)")
            .bind(batchId, eventKeys, observed),
          ...rows.map((row, i) =>
            db
              .prepare(
                "INSERT INTO research_decisions (id, experiment, event_key, session, input_json, result_json, profile_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
              )
              .bind(
                row.id,
                GUIDANCE_PROFILE.name,
                decisions[i]!.eventKey,
                session,
                row.input,
                JSON.stringify(row.result),
                profileHash,
                observed
              )
          ),
        ]);
      }
      return response({
        profile_hash: profileHash,
        results: rows.map(({ id, result, replayed }) => ({ id, result, replayed })),
        broker_orders_enabled: false,
      });
    }
    return response({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof z.ZodError)
      return response(
        { error: "Invalid research input", issues: error.issues.map((i) => ({ path: i.path, message: i.message })) },
        422
      );
    return response({ error: String(error) }, 400);
  }
}
