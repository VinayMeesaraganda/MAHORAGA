import type { D1Client } from "../storage/d1/client";

export async function hash(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}
export async function appendImmutable(
  db: D1Client,
  table: "research_events" | "research_decisions",
  id: string,
  columns: Record<string, string>
): Promise<void> {
  const keys = Object.keys(columns);
  if (keys.some((k) => !/^[a-z_]+$/.test(k))) throw new Error("Invalid ledger column");
  await db.run(`INSERT OR IGNORE INTO ${table} (id, ${keys.join(",")}) VALUES (?, ${keys.map(() => "?").join(",")})`, [
    id,
    ...Object.values(columns),
  ]);
  const existing = await db.executeOne<Record<string, string>>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  const payload = table === "research_events" ? "payload" : "input_json";
  if (!existing || existing[payload] !== columns[payload])
    throw new Error("Immutable record conflict; use a new event version, never rewrite a decision");
}
