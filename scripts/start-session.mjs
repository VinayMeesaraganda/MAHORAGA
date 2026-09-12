#!/usr/bin/env node
/**
 * Bring the agent up for a trading session, in the order the pieces depend on
 * each other.
 *
 *   node scripts/start-session.mjs [--base URL] [--no-enable]
 *
 * Assumes the worker is already running (npm run dev, or a deployment).
 * Each step reports and a failure stops the sequence: enabling an agent whose
 * profile did not apply, or whose catalysts never arrived, would run the
 * previous configuration against an empty candidate set.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const baseIdx = args.indexOf("--base");
const base = baseIdx !== -1 ? args[baseIdx + 1] : "http://127.0.0.1:8787";
const skipEnable = args.includes("--no-enable");

const vars = Object.fromEntries(
  readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const auth = { Authorization: `Bearer ${vars.MAHORAGA_API_TOKEN}`, "Content-Type": "application/json" };

function step(n, label) { process.stdout.write(`${n}. ${label.padEnd(34)}`); }
function ok(msg) { console.log(`OK    ${msg}`); }
function fail(msg) { console.log(`FAIL  ${msg}`); process.exit(1); }

// 1. Worker reachable.
step(1, "worker reachable");
let status;
try {
  const r = await fetch(`${base}/agent/status`, { headers: auth, signal: AbortSignal.timeout(15000) });
  if (!r.ok) fail(`HTTP ${r.status} — is the worker running?`);
  status = (await r.json()).data;
  ok(`${base}`);
} catch (e) { fail(`${String(e).slice(0, 80)} — start it with: npm run dev`); }

// 2. Credentials and model, via the same probe the doctor uses.
step(2, "credentials and model");
try {
  execFileSync("node", ["scripts/doctor.mjs"], { stdio: "pipe" });
  ok("doctor passed");
} catch (e) {
  const out = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "");
  const bad = out.split("\n").filter((l) => l.includes("FAIL")).join("; ");
  fail(bad || "doctor reported a failure");
}

// 3. Push the profile. Saving the JSON does not configure the durable object.
step(3, "apply trading profile");
const profile = JSON.parse(readFileSync(new URL("../agent-config.json", import.meta.url), "utf8"));
const cfgRes = await fetch(`${base}/agent/config`, { method: "POST", headers: auth, body: JSON.stringify(profile) });
if (!cfgRes.ok) fail(`HTTP ${cfgRes.status}: ${(await cfgRes.text()).slice(0, 140)}`);
const applied = (await cfgRes.json()).config;
ok(`52wH ${applied.entry_min_pct_of_52w_high}% · catalyst ${applied.entry_require_catalyst ? applied.entry_min_catalyst_quality + "+" : "off"} · ${applied.llm_model}`);

// 4. Catalysts. Without them a catalyst-gated strategy has nothing to qualify.
step(4, "push catalysts");
try {
  const out = execFileSync("node", ["scripts/push-catalysts.mjs", "--base", base], { stdio: "pipe" }).toString();
  const parsed = JSON.parse(out.slice(out.indexOf("{")));
  if (applied.entry_require_catalyst && parsed.symbols === 0) {
    fail("no catalysts in the cache — refresh config/catalysts.json before enabling");
  }
  ok(`${parsed.symbols} symbol(s), ${parsed.expired} expired`);
} catch (e) { fail(String(e.stdout?.toString() ?? e).slice(0, 140)); }

// 5. Enable.
if (skipEnable) { console.log("\n--no-enable: agent left as-is."); }
else {
  step(5, "enable agent");
  const r = await fetch(`${base}/agent/enable`, { method: "POST", headers: auth });
  const body = await r.json();
  if (!r.ok || !body.ok) fail(JSON.stringify(body).slice(0, 160));
  ok("armed");
}

const final = await (await fetch(`${base}/agent/status`, { headers: auth })).json();
const d = final.data;
console.log(
  `\nenabled=${d.enabled} · equity $${Number(d.account?.equity ?? 0).toLocaleString()} · positions ${d.positions?.length ?? 0} · market ${d.clock?.is_open ? "OPEN" : "closed"}`
);
console.log(`budget ${JSON.stringify(d.llmDailyBudget)} · stop with: npm run paper:stop`);
