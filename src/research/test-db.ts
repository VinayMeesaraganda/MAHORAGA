// Test-only D1 adapter: execute the real migrations and SQL against SQLite.
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { D1Client } from "../storage/d1/client";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export function testDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  const directory = new URL("../../migrations/", import.meta.url);
  for (const file of readdirSync(directory)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync(new URL(file, directory), "utf8"));
  const prepare = (sql: string, parameters: unknown[] = []) => ({
    bind: (...args: unknown[]) => prepare(sql, args),
    first: async () => sqlite.prepare(sql).get(...(parameters as Array<string | number | null>)) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(parameters as Array<string | number | null>)) }),
    run: async () => ({
      success: true,
      meta: sqlite.prepare(sql).run(...(parameters as Array<string | number | null>)),
    }),
  });
  const raw = {
    prepare,
    batch: async (statements: Array<ReturnType<typeof prepare>>) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  return { raw, db: new D1Client(raw), close: () => sqlite.close() };
}
