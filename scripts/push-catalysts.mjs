#!/usr/bin/env node
/**
 * Push catalysts into the running agent.
 *
 * The strongest catalyst signal available is an earnings calendar carrying
 * actual versus estimated EPS, and no free endpoint reachable from a Cloudflare
 * Worker supplies one. This bridges that gap: an outside process assembles the
 * catalysts and posts them to /agent/catalysts, where they land in the same
 * cache the news gatherer fills and face the same entry gate.
 *
 *   node scripts/push-catalysts.mjs [file] [--base URL] [--dry-run]
 *
 * Input is either a catalyst array (symbol/type/quality/headline/at) or raw
 * earnings rows (symbol/estimate/actual/date/timing), which are converted here.
 * Misses are dropped: this is a long-only strategy, and a negative surprise
 * drifts the wrong way.
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const baseIdx = args.indexOf("--base");
const base = baseIdx !== -1 ? args[baseIdx + 1] : "http://127.0.0.1:8787";
const file = args.find((a) => !a.startsWith("--") && a !== base) ?? "config/catalysts.json";

const vars = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

/** A larger surprise is a larger revision to forward estimates, so it grades higher. */
function gradeSurprise(estimate, actual) {
  if (!Number.isFinite(estimate) || !Number.isFinite(actual)) return null;
  if (actual <= estimate) return null; // long-only: a miss drifts the wrong way
  const denom = Math.abs(estimate);
  if (denom === 0) return { pct: Number.POSITIVE_INFINITY, quality: "high" };
  const pct = ((actual - estimate) / denom) * 100;
  if (pct < 3) return null;                       // inside noise
  return { pct, quality: pct >= 10 ? "high" : "medium" };
}

function toCatalysts(raw) {
  if (Array.isArray(raw?.catalysts)) return raw.catalysts;
  const rows = Array.isArray(raw) ? raw : (raw?.earnings ?? []);
  const out = [];
  for (const r of rows) {
    const graded = gradeSurprise(Number(r.estimate), Number(r.actual));
    if (!graded) continue;
    // am reports land pre-open, pm after the close.
    const at = `${r.date}T${r.timing === "pm" ? "20:30" : "12:00"}:00Z`;
    const pct = Number.isFinite(graded.pct) ? `+${graded.pct.toFixed(0)}%` : "from a loss estimate";
    out.push({
      symbol: r.symbol,
      type: "earnings",
      quality: graded.quality,
      headline: `Q${r.quarter ?? "?"} EPS ${r.actual} vs ${r.estimate} estimate (${pct} surprise)`,
      at,
    });
  }
  return out;
}

const raw = JSON.parse(readFileSync(file, "utf8"));
const catalysts = toCatalysts(raw);

if (!catalysts.length) {
  console.log(`No qualifying catalysts in ${file} (misses and sub-3% surprises are dropped).`);
  process.exit(0);
}

console.log(`${catalysts.length} catalyst(s) from ${file}:`);
for (const c of catalysts) console.log(`  ${c.symbol.padEnd(6)} ${c.type}/${c.quality.padEnd(6)} ${c.at.slice(0, 10)}  ${c.headline.slice(0, 58)}`);

if (dryRun) { console.log("\n--dry-run: nothing sent."); process.exit(0); }

const res = await fetch(`${base}/agent/catalysts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${vars.MAHORAGA_API_TOKEN}` },
  body: JSON.stringify({ catalysts }),
  signal: AbortSignal.timeout(20000),
});
const body = await res.text();
if (!res.ok) { console.error(`\nFAIL HTTP ${res.status}: ${body.slice(0, 200)}`); process.exit(1); }
console.log(`\n${body}`);
