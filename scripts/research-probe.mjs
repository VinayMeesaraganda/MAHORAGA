// Read-only broker/status inspection plus diagnostic LLM calls; never invokes trading routes.
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const root = new URL("../", import.meta.url).pathname;
const vars = Object.fromEntries((await readFile(new URL("../.dev.vars", import.meta.url), "utf8"))
  .split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => {
    const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
  }));
const target = args.includes("--remote") ? "https://mahoraga-paper.raj-vinay2408.workers.dev" : "http://127.0.0.1:8787";
const response = await fetch(`${target}/agent/status`, {
  headers: { Authorization: `Bearer ${vars.MAHORAGA_API_TOKEN}` }, signal: AbortSignal.timeout(15000),
});
if (!response.ok) throw Error(`Status probe HTTP ${response.status}`);
const { data: status } = await response.json();
const compiled = await build({
  stdin: { contents: `export { researchSignalPrompt } from './src/strategy/default/prompts/research.ts';
    export { analyzeSignalsPrompt as analystPrompt } from './src/strategy/default/prompts/analyst.ts';
    export { SignalResearchResponseSchema, AnalystResponseSchema, parseAnalystRecommendations, parseJsonObject } from './src/schemas/llm-responses.ts';`, resolveDir: root },
  bundle: true, platform: "node", format: "esm", write: false,
});
const { researchSignalPrompt, analystPrompt, SignalResearchResponseSchema, AnalystResponseSchema, parseAnalystRecommendations, parseJsonObject } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
const analyst = args.includes("--analyst");
const model = option("--model") || (analyst ? status.config.llm_analyst_model : status.config.llm_model);
const repeat = Number(option("--repeat") || 1);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) throw Error("Repeat must be 1–5");
let extra = vars.LLM_EXTRA_BODY ? JSON.parse(vars.LLM_EXTRA_BODY) : {};
if (args.includes("--low-reasoning")) extra = { reasoning_effort: "low" };
if (args.includes("--no-thinking")) extra = { chat_template_kwargs: { enable_thinking: false } };
// Use an observed market packet when available. Unavailable context stays unknown.
const research = Object.values(status.signalResearch || {});
const baseline = research.find(row => row.market) || { symbol: status.signals?.[0]?.symbol || "SPY" };
const signal = status.signals?.find(row => row.symbol === baseline.symbol);
const context = { config: status.config, state: { get: () => undefined }, positionEntries: status.positionEntries || {} };
const prompt = analyst ? analystPrompt(status.signals || [], status.positions || [], status.account, context) : researchSignalPrompt(baseline.symbol, signal?.sentiment ?? 0,
  signal ? [signal.source] : [], baseline.market?.price ?? 0,
  context, baseline.market, []);
for (let run = 1; run <= repeat; run++) {
  const started = Date.now();
  try {
    const r = await fetch(`${(vars.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${vars.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...extra, model, messages: [{ role: "system", content: prompt.system },
        { role: "user", content: prompt.user }], temperature: 0.3, max_tokens: prompt.maxTokens,
        response_format: { type: "json_object" } }), signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw Error(`HTTP ${r.status}`);
    const result = await r.json();
    const parsed = (analyst ? AnalystResponseSchema : SignalResearchResponseSchema).safeParse(parseJsonObject(result.choices?.[0]?.message?.content || ""));
    const valid = parsed.success && (!analyst || parseAnalystRecommendations(parsed.data.recommendations).rejected === 0);
    console.log(JSON.stringify({ model, stage: analyst ? "analyst" : "research", run, elapsedMs: Date.now() - started, valid,
      verdict: parsed.success ? parsed.data.verdict : null, finishReason: result.choices?.[0]?.finish_reason,
      tokens: result.usage?.completion_tokens, ordersSubmitted: false }));
    if (!valid) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ model, run, elapsedMs: Date.now() - started,
      error: /^HTTP \d+$/.test(error.message) ? error.message : error.name, ordersSubmitted: false }));
    process.exitCode = 1;
  }
}
