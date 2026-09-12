#!/usr/bin/env node
/**
 * Read the trade journal — why each trade was taken, and what it did.
 *
 *   node scripts/journal.mjs [--base URL] [--limit N] [--open]
 *
 * The summary groups closed trades by catalyst type and by outcome, which is
 * the point of keeping it: to find out which reasons actually pay before
 * trusting them with more size.
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const pick = (flag, dflt) => { const i = args.indexOf(flag); return i === -1 ? dflt : args[i + 1]; };
const base = pick("--base", "http://127.0.0.1:8787");
const limit = pick("--limit", "50");
const openOnly = args.includes("--open");

const vars = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const res = await fetch(`${base}/agent/journal?limit=${limit}`, {
  headers: { Authorization: `Bearer ${vars.MAHORAGA_API_TOKEN}` },
  signal: AbortSignal.timeout(20000),
});
if (!res.ok) { console.error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`); process.exit(1); }
const { entries = [] } = await res.json();

if (!entries.length) { console.log("No journal entries yet."); process.exit(0); }

const rows = openOnly ? entries.filter((e) => !e.exit_at) : entries;
const parse = (s) => { try { return JSON.parse(s ?? "null"); } catch { return null; } };

console.log(`${rows.length} entr${rows.length === 1 ? "y" : "ies"}\n`);
for (const e of rows) {
  const sig = parse(e.signals_json) ?? {};
  const cat = sig.catalyst;
  const plan = sig.plan ?? {};
  const state = e.exit_at
    ? `${e.outcome?.toUpperCase() ?? "?"}  ${Number(e.pnl_pct ?? 0) >= 0 ? "+" : ""}${Number(e.pnl_pct ?? 0).toFixed(1)}%  $${Number(e.pnl_usd ?? 0).toFixed(0)}  held ${e.hold_duration_mins ?? "?"}m`
    : "OPEN";
  console.log(`${e.symbol.padEnd(6)} ${e.entry_at?.slice(0, 16).replace("T", " ") ?? "?"}   ${state}`);
  console.log(`   why   : ${e.notes ?? "—"}`);
  if (cat) console.log(`   cause : ${cat.type}/${cat.quality} — ${String(cat.headline).slice(0, 72)}`);
  if (plan.stop_pct) console.log(`   plan  : stop ${plan.stop_pct.toFixed(1)}% · target ${plan.target_pct.toFixed(1)}% · $${Math.round(plan.notional)} · risk $${Math.round(plan.risk_usd)}`);
  if (e.regime_tags) console.log(`   tape  : ${e.regime_tags}`);
  if (e.lessons_learned) console.log(`   out   : ${e.lessons_learned}`);
  console.log("");
}

const closed = entries.filter((e) => e.exit_at);
if (closed.length) {
  console.log("─".repeat(64));
  const wins = closed.filter((e) => e.outcome === "win").length;
  const totalPnl = closed.reduce((s, e) => s + Number(e.pnl_usd ?? 0), 0);
  console.log(`closed ${closed.length} · wins ${wins} (${((wins / closed.length) * 100).toFixed(0)}%) · net $${totalPnl.toFixed(0)}`);

  const byCatalyst = {};
  for (const e of closed) {
    const t = parse(e.signals_json)?.catalyst?.type ?? "none";
    (byCatalyst[t] ??= []).push(Number(e.pnl_usd ?? 0));
  }
  console.log("\nby catalyst type:");
  for (const [t, pnls] of Object.entries(byCatalyst).sort((a, b) => b[1].length - a[1].length)) {
    const net = pnls.reduce((s, n) => s + n, 0);
    const w = pnls.filter((n) => n > 0).length;
    console.log(`  ${t.padEnd(14)} ${String(pnls.length).padStart(3)} trades · ${w} won · net $${net.toFixed(0)}`);
  }
}
