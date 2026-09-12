#!/usr/bin/env node
/**
 * Periodic review — the layer where learning actually happens.
 *
 *   npm run paper:review [-- --base URL]
 *
 * Two tiers on two clocks. Operational questions are answerable in the first
 * session and are about whether the machinery behaves. Statistical questions
 * need tens of trades per group and are about whether the strategy works;
 * answering those early is how noise becomes a conclusion, so this reports
 * progress toward the sample and refuses to conclude before it.
 *
 * Questions are read from config/hypotheses.json, registered before the data
 * existed. Deciding what counts as an answer after seeing results is the
 * failure this is built to prevent.
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const i = args.indexOf("--base");
const base = i === -1 ? "http://127.0.0.1:8787" : args[i + 1];
const ROOT = new URL("..", import.meta.url).pathname;

const vars = Object.fromEntries(
  readFileSync(`${ROOT}/.dev.vars`, "utf8").split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map((l) => { const k = l.indexOf("="); return [l.slice(0, k).trim(), l.slice(k + 1).trim()]; })
);
const hypotheses = JSON.parse(readFileSync(`${ROOT}/config/hypotheses.json`, "utf8"));

let entries = [];
try {
  const r = await fetch(`${base}/agent/journal?limit=200`, {
    headers: { Authorization: `Bearer ${vars.MAHORAGA_API_TOKEN}` },
    signal: AbortSignal.timeout(20000),
  });
  if (r.ok) entries = (await r.json()).entries ?? [];
  else console.log(`(journal unreachable: HTTP ${r.status} — reporting what can be answered offline)\n`);
} catch {
  console.log("(worker not running — reporting what can be answered offline)\n");
}

const parse = (j) => { try { return j ? JSON.parse(j) : null; } catch { return null; } };
const closed = entries.filter((e) => e.exit_at);
const rows = closed.map((e) => {
  const sig = parse(e.signals_json) ?? {};
  const stop = sig.plan?.stop_pct;
  const pnl = Number(e.pnl_pct ?? 0);
  return {
    r: stop > 0 ? pnl / stop : null,
    catalyst: sig.catalyst?.type ?? "none",
    confidence: sig.research?.confidence ?? null,
    pct52: parse(e.technicals_json)?.pct_of_52w_high ?? null,
    rsi: sig.gates?.rsi_14 ?? parse(e.technicals_json)?.rsi_14 ?? null,
    cause: e.lessons_learned?.match(/cause=([a-z_]+)/)?.[1] ?? "unrecorded",
  };
});

console.log("═".repeat(70));
console.log(`REVIEW — ${closed.length} closed trade(s), ${entries.length - closed.length} open`);
console.log("═".repeat(70));

console.log("\nTIER 1 — does the machinery behave? (answerable immediately)\n");
for (const q of hypotheses.operational) {
  console.log(`  [ ] ${q.question}`);
  console.log(`      answerable after ${q.answerable_after}`);
}
console.log("\n  These are checked by reading a session's logs, not by statistics.");
console.log("  Until they all pass, no statistical question is worth asking.");

console.log("\nTIER 2 — does the strategy work? (needs sample)\n");
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const pick = (spec) => {
  const [dim, val] = spec.split(":");
  if (dim === "catalyst") return rows.filter((x) => x.catalyst === val);
  if (dim === "cause") return rows.filter((x) => val.split("+").includes(x.cause));
  if (dim === "confidence")
    return rows.filter((x) => x.confidence !== null && (val === "0.80+" ? x.confidence >= 0.8 : x.confidence < 0.7));
  if (dim === "pct_of_52w_high")
    return rows.filter((x) => x.pct52 !== null && (val === "75+" ? x.pct52 >= 75 : x.pct52 >= 70 && x.pct52 < 75));
  // The band is a claim about risk geometry, not direction: inside it, measured
  // favourable and adverse excursion are near-equal, so a 2R target is asking
  // the price path for something it does not deliver.
  if (dim === "rsi_band")
    return rows.filter((x) => x.rsi !== null && (val === "40-52" ? x.rsi >= 40 && x.rsi <= 52 : x.rsi < 40 || x.rsi > 52));
  return [];
};

for (const h of hypotheses.statistical) {
  const [aSpec, bSpec] = h.compare;
  const a = pick(aSpec), b = pick(bSpec);
  const need = h.min_per_group;
  const ready = a.length >= need && b.length >= need;
  console.log(`  ${h.question}`);
  console.log(`      ${aSpec}: ${a.length}/${need}   ${bSpec}: ${b.length}/${need}`);
  if (!ready) {
    const short = Math.max(need - a.length, need - b.length);
    console.log(`      NOT ANSWERABLE — ${short} more trade(s) needed in the thinner group.`);
  } else {
    const ra = mean(a.map((x) => x.r).filter((r) => r !== null));
    const rb = mean(b.map((x) => x.r).filter((r) => r !== null));
    const verdict = ra > rb ? "supported" : "NOT supported";
    console.log(`      ${ra?.toFixed(2)}R vs ${rb?.toFixed(2)}R — ${verdict}`);
    console.log(`      falsified if: ${h.falsified_if}`);
  }
  console.log("");
}

console.log("─".repeat(70));
console.log("Change one thing at a time, record the date and the commit, and keep");
console.log("the previous setting long enough to compare against. A change made");
console.log("before its question was answerable is a guess, not a learning.");
