import { z } from "zod";
import { DurableObject } from "cloudflare:workers";
import { handleResearch } from "../research/api";
import { enableKillSwitch } from "../storage/d1/queries/risk-state";
import { authorized, readBody } from "./http";
import { saveCalendarReview } from "./calendar";
import { ExperimentRuntime, type ExperimentEnv } from "./runtime";
import { captureFinnhub } from "../providers/earnings/pipeline";
import { collectMacro } from "./calendar";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
export class ExperimentHarness extends DurableObject<ExperimentEnv> {
  readonly runtime: ExperimentRuntime;
  private window = 0;
  private requests = 0;
  constructor(ctx: DurableObjectState, env: ExperimentEnv) {
    super(ctx, env);
    this.runtime = new ExperimentRuntime(ctx.storage, env);
    ctx.blockConcurrencyWhile(async () => {
      await this.runtime.init();
      // Recover the alarm chain after code deployment without enabling a stopped experiment.
      if (this.runtime.state.enabled && (await ctx.storage.getAlarm()) === null)
        await ctx.storage.setAlarm(Date.now() + 1000);
    });
  }
  async alarm() {
    await this.runtime.tick();
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname,
      env = this.runtime.env;
    const emergency = path === "/kill" && request.method === "POST";
    if (!(await authorized(request, emergency ? env.KILL_SWITCH_SECRET : env.MAHORAGA_API_TOKEN)))
      return json({ error: "Unauthorized" }, 401);
    // Authorized emergency shutdown remains reachable even during normal traffic limits.
    if (emergency) {
      const stopped = await this.runtime.stop();
      await enableKillSwitch(this.runtime.db, "Authenticated experiment emergency shutdown");
      return json({ ...stopped, policyKillSwitch: true });
    }
    const window = Math.floor(Date.now() / 60000);
    if (window !== this.window) {
      this.window = window;
      this.requests = 0;
    }
    if (++this.requests > 60) return json({ error: "Rate limited" }, 429);
    let maintenance = false;
    try {
      if (path === "/status" && request.method === "GET") return json(await this.runtime.status());
      if (path.startsWith("/research/") && request.method === "GET") return handleResearch(request, env);
      if (path === "/orders" && request.method === "GET") {
        const cursor = z.coerce
          .number()
          .int()
          .nonnegative()
          .parse(new URL(request.url).searchParams.get("cursor") ?? 0);
        const rows = await this.runtime.db.execute<{ cursor: number }>(
          "SELECT rowid AS cursor,order_id,payload,observed_at FROM broker_order_snapshots WHERE rowid>? ORDER BY rowid LIMIT 100",
          [cursor]
        );
        return json({ rows, nextCursor: rows.length === 100 ? rows.at(-1)!.cursor : null });
      }
      if (path === "/audit" && request.method === "GET") {
        const cursor = z.coerce
          .number()
          .int()
          .nonnegative()
          .parse(new URL(request.url).searchParams.get("cursor") ?? 0);
        const rows = await this.runtime.db.execute<{ cursor: number }>(
          "SELECT rowid AS cursor,id,kind,payload,observed_at FROM experiment_audit WHERE rowid>? ORDER BY rowid LIMIT 100",
          [cursor]
        );
        return json({ rows, nextCursor: rows.length === 100 ? rows.at(-1)!.cursor : null });
      }
      if (request.method !== "POST") return json({ error: "Not found" }, 404);
      if (path === "/stop") return json(await this.runtime.stop());
      // Maintenance writes and manual work cannot race an alarm's source/batch writes.
      if (this.runtime.busy) return json({ error: "Cycle in progress; retry shortly" }, 409);
      if (path === "/prepare") {
        await this.runtime.tick(true);
        return json(await this.runtime.status());
      }
      this.runtime.busy = true;
      maintenance = true;
      if (path === "/refresh/finnhub") {
        const result = await captureFinnhub(this.runtime.db, env.FINNHUB_API_KEY, Date.now());
        this.runtime.state.finnhubAt = Date.now();
        await this.runtime.persist();
        return json(result, result.status === "ok" ? 200 : 503);
      }
      if (path === "/refresh/macro") {
        this.runtime.state.macro = await collectMacro(this.runtime.db, Date.now());
        this.runtime.state.macroAt = Date.now();
        this.runtime.state.macroError = null;
        await this.runtime.persist();
        return json({ ok: true, calendar: this.runtime.state.macro });
      }
      if (path.startsWith("/research/")) {
        const body = await readBody(request);
        return handleResearch(
          new Request(request.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
          env
        );
      }
      if (path === "/configure") {
        const body = z
          .object({ enabled: z.boolean(), mode: z.enum(["shadow", "paper"]) })
          .strict()
          .parse(await readBody(request));
        await this.runtime.configure(body.enabled, body.mode);
        return json(await this.runtime.status());
      }
      if (path === "/calendar") {
        this.runtime.state.macro = await saveCalendarReview(this.runtime.db, await readBody(request), Date.now());
        this.runtime.state.macroAt = Date.now();
        this.runtime.state.macroError = null;
        await this.runtime.persist();
        return json({ ok: true, calendar: this.runtime.state.macro });
      }
      if (path === "/dry-run")
        return json({ mode: "dry-run", ordersSubmitted: false, batch: await this.runtime.scan(Date.now(), false) });
      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json(
        {
          error:
            error instanceof z.ZodError
              ? "Invalid request schema"
              : error instanceof Error && /^[a-z_]+$/.test(error.message)
                ? error.message
                : "Request failed validation or dependency check",
        },
        422
      );
    } finally {
      if (maintenance) this.runtime.busy = false;
    }
  }
}
export default {
  async fetch(request: Request, env: ExperimentEnv): Promise<Response> {
    if (new URL(request.url).pathname === "/health" && request.method === "GET")
      return json({ service: "mahoraga-experiment", strategy: env.STRATEGY_ID });
    const stub = env.EXPERIMENT.get(env.EXPERIMENT.idFromName("isolated-paper-experiment-v1"));
    return stub.fetch(request);
  },
};
