#!/usr/bin/env node
// Secrets stay in ignored files or HTTP headers. No credential values in CLI arguments or output.
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const [action = "status", strategy, argument] = process.argv.slice(2);
if (!["guidance-continuation", "price-volume"].includes(strategy)) throw Error("Specify guidance-continuation or price-volume");
const root = resolve(import.meta.dirname, ".."), directory = resolve(root, ".paper-accounts", strategy);
const configPath = resolve(directory, "wrangler.jsonc");
const parseVars = text => Object.fromEntries(text.split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, "")]; }));
const privateWrite = async (path, value) => { await writeFile(path, value, { mode: 0o600 }); await chmod(path, 0o600); };
const wrangler = args => {
  const r = spawnSync(resolve(root, "node_modules/.bin/wrangler"), args, { cwd: root, encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  if (r.status !== 0) throw Error(`Wrangler ${args[0]} ${args[1] ?? ""} failed (exit ${r.status}); inspect Cloudflare configuration`);
  return r.stdout;
};
async function paperAccount(credential) {
  if (credential.mode !== "paper" || credential.endpoint !== "https://paper-api.alpaca.markets/v2") throw Error("Explicit paper credential file required");
  const response = await fetch(`${credential.endpoint}/account`, { headers: { "APCA-API-KEY-ID": credential.api_key, "APCA-API-SECRET-KEY": credential.api_secret }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw Error(`Alpaca identity probe HTTP ${response.status}`);
  const account = await response.json();
  if (!account.id || account.status !== "ACTIVE" || account.currency !== "USD") throw Error("Alpaca paper account unavailable");
  return account;
}
async function verifyAccountIsolation() {
  const accounts = await Promise.all(["guidance-continuation", "price-volume"].map(async id => {
    const credential = JSON.parse(await readFile(resolve(root, ".paper-accounts", `${id}.json`), "utf8"));
    return { strategy: id, credential, account: await paperAccount(credential) };
  }));
  const baseline = parseVars(await readFile(resolve(root, ".dev.vars"), "utf8"));
  const baselineAccount = await paperAccount({ mode: "paper", endpoint: "https://paper-api.alpaca.markets/v2", api_key: baseline.ALPACA_API_KEY, api_secret: baseline.ALPACA_API_SECRET });
  if (new Set([...accounts.map(a => a.account.id), baselineAccount.id]).size !== 3) throw Error("All three accounts must be distinct");
  return accounts;
}
if (action === "provision") {
  // Verify all three identities before touching either experimental Worker.
  const all = await verifyAccountIsolation();
  const selected = all.find(a => a.strategy === strategy);
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  let secrets;
  try { secrets = JSON.parse(await readFile(resolve(directory, "secrets.json"), "utf8")); }
  catch { secrets = { MAHORAGA_API_TOKEN: randomBytes(36).toString("base64url"), KILL_SWITCH_SECRET: randomBytes(36).toString("base64url") }; }
  if (secrets.EXPECTED_ACCOUNT_ID && secrets.EXPECTED_ACCOUNT_ID !== selected.account.id) throw Error("Existing experiment account pin differs");
  const finnhub = parseVars(await readFile(resolve(root, ".paper-accounts/finnhub.env"), "utf8"));
  Object.assign(secrets, { ALPACA_API_KEY: selected.credential.api_key, ALPACA_API_SECRET: selected.credential.api_secret, EXPECTED_ACCOUNT_ID: selected.account.id, FINNHUB_API_KEY: finnhub.FINNHUB_API_KEY });
  await privateWrite(resolve(directory, "secrets.json"), JSON.stringify(secrets, null, 2));
  await privateWrite(resolve(directory, ".dev.vars"), Object.entries(secrets).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("\n") + "\n");
  const name = `mahoraga-${strategy}`, databaseName = `${name}-db`;
  let databases = JSON.parse(wrangler(["d1", "list", "--json"]));
  let database = databases.find(d => d.name === databaseName);
  if (!database) { wrangler(["d1", "create", databaseName]); databases = JSON.parse(wrangler(["d1", "list", "--json"])); database = databases.find(d => d.name === databaseName); }
  if (!database?.uuid) throw Error("D1 identity unavailable");
  const config = JSON.parse(await readFile(resolve(root, "config/experiments/worker.template.jsonc"), "utf8"));
  config.name = name; config.vars.STRATEGY_ID = strategy;
  config.d1_databases[0].database_name = databaseName; config.d1_databases[0].database_id = database.uuid;
  await privateWrite(configPath, JSON.stringify(config, null, 2));
  console.log(JSON.stringify({ strategy, accountIsolationVerified: true, configPrepared: true, database: databaseName, orderExecutionEnabled: false }));
} else if (action === "deploy") {
  wrangler(["deploy", "--config", configPath, "--dry-run"]);
  wrangler(["d1", "migrations", "apply", "DB", "--remote", "--config", configPath]);
  const deployed = wrangler(["deploy", "--config", configPath]);
  const url = deployed.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/)?.[0];
  if (!url) throw Error("Deployment URL unavailable; inspect Worker before continuing");
  wrangler(["secret", "bulk", resolve(directory, "secrets.json"), "--config", configPath]);
  await privateWrite(resolve(directory, "deployment.json"), JSON.stringify({ strategy, url, deployedAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ strategy, url, deployed: true, note: "Read status and explicitly start collection; deployment does not enable trading." }));
} else if (action === "start-paper") {
  // Running this explicit operator command authorizes a paper pilot, not a profitability/fill attestation.
  const accounts = await verifyAccountIsolation();
  const account = accounts.find(a => a.strategy === strategy).account;
  const secrets = JSON.parse(await readFile(resolve(directory, "secrets.json"), "utf8"));
  if (account.id !== secrets.EXPECTED_ACCOUNT_ID) throw Error("Paper account pin differs");
  const deployment = JSON.parse(await readFile(resolve(directory, "deployment.json"), "utf8"));
  const url = new URL(deployment.url);
  if (url.protocol !== "https:" || !url.hostname.startsWith(`mahoraga-${strategy}.`) || !url.hostname.endsWith(".workers.dev")) throw Error("Invalid experiment destination");
  const headers = { Authorization: `Bearer ${secrets.MAHORAGA_API_TOKEN}`, "Content-Type": "application/json" };
  const statusResponse = await fetch(new URL("/status", url), { headers, redirect: "error", signal: AbortSignal.timeout(15000) });
  const status = await statusResponse.json();
  if (!statusResponse.ok || status.strategy !== strategy || !/^[a-f0-9]{64}$/.test(status.profileHash)) throw Error("Invalid deployed experiment profile");
  if (status.paused || status.pending?.length) throw Error("Resolve paused risk or pending executions before pilot activation");
  secrets.PAPER_PILOT_AUTHORIZATION = status.profileHash;
  await privateWrite(resolve(directory, "secrets.json"), JSON.stringify(secrets, null, 2));
  await privateWrite(resolve(directory, ".dev.vars"), Object.entries(secrets).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("\n") + "\n");
  await privateWrite(resolve(directory, "paper-pilot-authorization.json"), JSON.stringify({ strategy, profileHash: status.profileHash, basis: "Explicit operator start-paper command", authorizedAt: new Date().toISOString(), brokerFillValidation: "pending" }, null, 2));
  wrangler(["secret", "bulk", resolve(directory, "secrets.json"), "--config", configPath]);
  // Cloudflare can briefly serve the previous secret bindings after upload.
  // Read readiness first; never blindly replay configuration mutations.
  let authorizationReady = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    const probe = await fetch(new URL("/status", url), { headers, redirect: "error", signal: AbortSignal.timeout(15000) });
    const current = await probe.json();
    if (!probe.ok || current.profileHash !== status.profileHash || current.strategy !== strategy)
      throw Error("Deployment changed or status unavailable during paper authorization");
    if (current.executionAuthorized) { authorizationReady = true; break; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (!authorizationReady) throw Error("Paper authorization not visible yet; inspect status before retrying start-paper");
  const activated = await fetch(new URL("/configure", url), { method: "POST", headers, body: JSON.stringify({ enabled: true, mode: "paper" }), redirect: "error", signal: AbortSignal.timeout(30000) });
  const result = await activated.json();
  if (!activated.ok || !result.enabled || result.mode !== "paper" || !result.executionAuthorized) {
    const reason = typeof result.error === "string" && /^[a-z_]+$/.test(result.error) ? result.error : "inspect_status";
    throw Error(`Paper activation failed (HTTP ${activated.status}, ${reason})`);
  }
  console.log(JSON.stringify({ strategy, enabled: result.enabled, mode: result.mode, executionAuthorized: result.executionAuthorized, brokerFillValidation: result.brokerFillValidation, profileHash: result.profileHash, accountIsolationVerified: true }));
} else {
  const secrets = JSON.parse(await readFile(resolve(directory, "secrets.json"), "utf8"));
  const deployment = JSON.parse(await readFile(resolve(directory, "deployment.json"), "utf8"));
  const allowed = { status: ["GET", "/status"], audit: ["GET", "/audit"], orders: ["GET", "/orders"], "research-status": ["GET", "/research/status"], "refresh-finnhub": ["POST", "/refresh/finnhub"], "refresh-macro": ["POST", "/refresh/macro"], prepare: ["POST", "/prepare"], "dry-run": ["POST", "/dry-run"], "start-shadow": ["POST", "/configure"], stop: ["POST", "/stop"], kill: ["POST", "/kill"], calendar: ["POST", "/calendar"], evidence: ["POST", "/research/evidence"], events: ["POST", "/research/events"] };
  const selected = allowed[action]; if (!selected) throw Error("Unknown experiment action");
  const [method, path] = selected;
  let body;
  if (action === "start-shadow") body = JSON.stringify({ enabled: true, mode: "shadow" });
  else if (["calendar", "evidence", "events"].includes(action)) { if (!argument) throw Error("JSON input file required"); body = await readFile(resolve(argument), "utf8"); JSON.parse(body); }
  else if (method === "POST") body = "{}";
  const url = new URL(path, deployment.url);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".workers.dev")) throw Error("Invalid deployment URL");
  const response = await fetch(url, { method, headers: { Authorization: `Bearer ${action === "kill" ? secrets.KILL_SWITCH_SECRET : secrets.MAHORAGA_API_TOKEN}`, "Content-Type": "application/json" }, body, redirect: "error", signal: AbortSignal.timeout(60000) });
  const result = await response.json();
  console.log(JSON.stringify({ http: response.status, ...result }, null, 2));
  if (!response.ok) process.exitCode = 1;
}
