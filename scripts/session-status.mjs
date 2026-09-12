#!/usr/bin/env node
/**
 * Pre-open readiness check — everything the 09:17 verification needs, in one
 * command with an exit code.
 *
 *   npm run paper:check [-- --base URL]
 *
 * Exits non-zero when something would stop the agent trading, so the scheduled
 * task does not have to interpret prose to decide whether to raise an alarm.
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const i = args.indexOf("--base");
const base = i === -1 ? "http://127.0.0.1:8787" : args[i + 1];

const vars = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8").split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map((l) => { const k = l.indexOf("="); return [l.slice(0, k).trim(), l.slice(k + 1).trim()]; })
);
const auth = { Authorization: `Bearer ${vars.MAHORAGA_API_TOKEN}` };
const problems = [];

let data;
try {
  const r = await fetch(`${base}/agent/status`, { headers: auth, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  data = (await r.json()).data;
} catch (e) {
  console.log(`worker        UNREACHABLE at ${base} — ${String(e).slice(0, 60)}`);
  console.log("\nFix: npm run paper:start");
  process.exit(1);
}

const cfg = data.config ?? {};
console.log(`enabled       ${data.enabled}`);
console.log(`equity        $${Number(data.account?.equity ?? 0).toLocaleString()} · cash $${Number(data.account?.cash ?? 0).toLocaleString()} · prev close $${Number(data.account?.last_equity ?? 0).toLocaleString()}`);
console.log(`positions     ${data.positions?.length ?? 0}${data.positions?.length ? " — " + data.positions.map((p) => `${p.symbol} ${p.qty}@${p.avg_entry_price}`).join(", ") : ""}`);
console.log(`market        ${data.clock?.is_open ? "OPEN" : "closed"} · next open ${data.clock?.next_open?.slice(0, 16).replace("T", " ")}`);
console.log(`model         ${cfg.llm_model} · budget ${JSON.stringify(data.llmDailyBudget)}`);
console.log(`gates         52wH ${cfg.entry_min_pct_of_52w_high}% · relVol ${cfg.entry_min_rel_volume}x · ADV20 $${(cfg.entry_min_dollar_volume / 1e6).toFixed(0)}M · catalyst ${cfg.entry_require_catalyst ? `${cfg.entry_min_catalyst_quality}+` : "off"}`);
console.log(`risk          ${cfg.risk_per_trade_pct}%/trade · ATR x${cfg.stop_atr_multiple} stop · ${cfg.target_r_multiple}R target · max ${cfg.max_positions}`);

if (!data.enabled) problems.push("agent is NOT enabled — it will not trade. Fix: npm run paper:start");

let catalystCount = 0;
try {
  const c = (await (await fetch(`${base}/agent/catalysts`, { headers: auth })).json()).catalysts ?? {};
  const now = Date.now();
  const ages = Object.values(c).map((hits) => (now - (hits?.[0]?.at ?? 0)) / 86_400_000);
  catalystCount = Object.keys(c).length;
  const oldest = ages.length ? Math.max(...ages) : 0;
  console.log(`catalysts     ${catalystCount} symbol(s)${ages.length ? ` · oldest ${oldest.toFixed(1)}d of ${(cfg.entry_max_catalyst_age_minutes / 1440).toFixed(0)}d window` : ""}`);
  if (cfg.entry_require_catalyst && catalystCount === 0) {
    problems.push("catalyst cache is EMPTY and the strategy requires one — nothing can be entered");
  } else if (cfg.entry_require_catalyst && oldest > (cfg.entry_max_catalyst_age_minutes / 1440) * 0.9) {
    problems.push(`catalysts are near expiry (oldest ${oldest.toFixed(1)}d) — refresh config/catalysts.json`);
  }
} catch { problems.push("could not read the catalyst cache"); }

const used = data.llmDailyBudget?.calls ?? 0;
if (used > 500) problems.push(`LLM budget nearly spent (${used} calls) — research stops when it is exhausted`);

const bad = (data.logs ?? []).filter((l) => /error|failed|invalid_response|oauth_failed|buy_rejected/i.test(`${l.action}`));
if (bad.length) {
  console.log(`\nrecent problems in the log (${bad.length}):`);
  for (const l of bad.slice(-6)) console.log(`  ${l.timestamp?.slice(11, 19)} ${l.agent} ${l.action}`);
}

if (problems.length) {
  console.log(`\n${problems.length} PROBLEM(S):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log(`\nReady. ${catalystCount} catalyst(s) · ${data.positions?.length ?? 0} position(s) · opens ${data.clock?.next_open?.slice(11, 16) ?? "?"}`);
