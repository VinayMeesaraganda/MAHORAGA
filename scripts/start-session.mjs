#!/usr/bin/env node
/**
 * Bring the agent up for a trading session — everything, in dependency order.
 *
 *   npm run paper:start               start the worker if needed, then arm
 *   npm run paper:start -- --no-enable    rehearse without arming
 *   npm run paper:start -- --dry-run      report what it would do, change nothing
 *   npm run paper:start -- --force        run even when the market is closed today
 *
 * Deliberately a script rather than steps in a scheduled prompt: a prompt is
 * re-interpreted every morning, cannot be tested, and has no exit code. This
 * can be rehearsed on a Saturday and either succeeds or fails loudly.
 *
 * Every step stops the sequence on failure. Arming an agent whose profile did
 * not apply, or whose catalyst cache is empty under a catalyst-gated strategy,
 * runs the previous configuration against nothing.
 */
import { readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const pick = (f, d) => { const i = args.indexOf(f); return i === -1 ? d : args[i + 1]; };
const base = pick("--base", "http://127.0.0.1:8787");
const dryRun = has("--dry-run");
const skipEnable = has("--no-enable") || dryRun;

const vars = Object.fromEntries(
  readFileSync(`${ROOT}/.dev.vars`, "utf8").split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const auth = { Authorization: `Bearer ${vars.MAHORAGA_API_TOKEN}`, "Content-Type": "application/json" };

let n = 0;
const step = (label) => process.stdout.write(`${++n}. ${label.padEnd(32)}`);
const ok = (msg) => console.log(`OK    ${msg}`);
const skip = (msg) => console.log(`SKIP  ${msg}`);
const fail = (msg) => { console.log(`FAIL  ${msg}`); console.log(`\nSequence stopped at step ${n}. Agent not armed.`); process.exit(1); };

// ── 1. Is the market trading today? ─────────────────────────────────────────
step("market open today");
let clock;
try {
  const r = await fetch("https://paper-api.alpaca.markets/v2/clock", {
    headers: { "APCA-API-KEY-ID": vars.ALPACA_API_KEY, "APCA-API-SECRET-KEY": vars.ALPACA_API_SECRET },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) fail(`clock HTTP ${r.status}`);
  clock = await r.json();
} catch (e) { fail(String(e).slice(0, 90)); }

const today = new Date(clock.timestamp).toISOString().slice(0, 10);
const opensToday = clock.is_open || clock.next_open?.slice(0, 10) === today;
if (!opensToday && !has("--force")) {
  ok(`no — next open ${clock.next_open?.slice(0, 16).replace("T", " ")}`);
  console.log("\nHoliday or weekend. Nothing to start. Use --force to override.");
  process.exit(0);
}
ok(clock.is_open ? "open now" : `opens ${clock.next_open?.slice(11, 16)}`);

// ── 2. Worker ───────────────────────────────────────────────────────────────
step("worker running");
const reachable = async () => {
  try { return (await fetch(`${base}/`, { signal: AbortSignal.timeout(4000) })).status < 600; }
  catch { return false; }
};

if (await reachable()) ok(`already up at ${base}`);
else if (dryRun) skip("would start wrangler dev (dry run)");
else if (!base.includes("127.0.0.1") && !base.includes("localhost")) fail(`${base} unreachable and not local — cannot start it`);
else {
  // Detached so the worker outlives this process and the session that ran it.
  const child = spawn("npm", ["run", "dev"], { cwd: ROOT, detached: true, stdio: "ignore" });
  child.unref();
  let up = false;
  for (let i = 0; i < 45; i++) { if (await reachable()) { up = true; break; } await sleep(2000); }
  if (!up) fail("wrangler dev did not answer within 90s — check the port and try `npm run dev` by hand");
  ok(`started (pid ${child.pid})`);
}

// ── 3. Credentials and model ────────────────────────────────────────────────
step("credentials and model");
{
  let out = "";
  let doctorFailed = false;
  try {
    out = execFileSync("node", ["scripts/doctor.mjs"], { cwd: ROOT, stdio: "pipe" }).toString();
  } catch (e) {
    doctorFailed = true;
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  // The doctor also checks the local worker. On a dry run nothing was started,
  // so that line is expected to fail and must not mask the checks that matter:
  // credentials, the broker, and the model.
  const failures = out.split("\n").filter((l) => l.includes("FAIL"));
  const relevant = dryRun ? failures.filter((l) => !l.startsWith("Local worker")) : failures;
  if (relevant.length) fail(relevant.join("; "));
  if (doctorFailed && dryRun) skip("credentials and model OK (worker check skipped on a dry run)");
  else ok("doctor passed");
}

// ── 4. Profile ──────────────────────────────────────────────────────────────
step("apply trading profile");
const profile = JSON.parse(readFileSync(`${ROOT}/agent-config.json`, "utf8"));
if (dryRun) skip(`would apply 52wH ${profile.entry_min_pct_of_52w_high}% · ${profile.llm_model}`);
else {
  const r = await fetch(`${base}/agent/config`, { method: "POST", headers: auth, body: JSON.stringify(profile) });
  if (!r.ok) fail(`HTTP ${r.status}: ${(await r.text()).slice(0, 140)}`);
  const c = (await r.json()).config;
  ok(`52wH ${c.entry_min_pct_of_52w_high}% · catalyst ${c.entry_require_catalyst ? `${c.entry_min_catalyst_quality}+` : "off"} · ${c.llm_model}`);
}

// ── 5. Catalysts ────────────────────────────────────────────────────────────
step("push catalysts");
try {
  const out = execFileSync("node", ["scripts/push-catalysts.mjs", "--base", base, ...(dryRun ? ["--dry-run"] : [])],
    { cwd: ROOT, stdio: "pipe" }).toString();
  if (dryRun) skip(`${out.match(/^(\d+) catalyst/m)?.[1] ?? "0"} would be pushed`);
  else {
    // push-catalysts exits 0 and prints no JSON when the file yields nothing —
    // a legitimate outcome for it, and a blocking one here.
    const brace = out.indexOf("{");
    const res = brace === -1 ? null : JSON.parse(out.slice(brace));
    if (profile.entry_require_catalyst && (!res || res.symbols === 0)) {
      fail(
        "catalyst cache is empty and the strategy requires one. " +
          "Refresh config/catalysts.json with recent earnings surprises, then re-run."
      );
    }
    ok(res ? `${res.symbols} symbol(s), ${res.expired} expired` : "none to push (catalysts not required)");
  }
} catch (e) { fail(String(e.stdout ?? e).slice(0, 160)); }

// ── 6. Arm ──────────────────────────────────────────────────────────────────
step("enable agent");
if (skipEnable) skip(dryRun ? "dry run" : "--no-enable");
else {
  const r = await fetch(`${base}/agent/enable`, { method: "POST", headers: auth });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.ok) fail(JSON.stringify(body).slice(0, 160));
  ok("armed");
}

// ── Summary ─────────────────────────────────────────────────────────────────
if (!dryRun) {
  const d = (await (await fetch(`${base}/agent/status`, { headers: auth })).json()).data;
  console.log(
    `\nenabled=${d.enabled} · equity $${Number(d.account?.equity ?? 0).toLocaleString()} · ` +
    `positions ${d.positions?.length ?? 0} · market ${d.clock?.is_open ? "OPEN" : "closed"} · ` +
    `budget ${JSON.stringify(d.llmDailyBudget)}`
  );
}
console.log(dryRun ? "\nDry run complete — nothing was changed." : "\nReady. Stop with: npm run paper:stop");
