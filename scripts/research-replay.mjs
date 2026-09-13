import { readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Compile only the offline evaluator. It has no brokerage or credential imports.
const [input, output] = process.argv.slice(2);
if (!input) throw new Error('Use: npm run research:replay -- INPUT.json [OUTPUT.json]');
const temp = mkdtempSync(join(tmpdir(), 'mahoraga-replay-'));
try {
  const entry = new URL('../src/research/replay.ts', import.meta.url).pathname;
  const bundled = join(temp, 'replay.mjs');
  await build({ entryPoints: [entry], outfile: bundled, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { replayPortfolio, pairedBlockInterval } = await import(pathToFileURL(bundled).href);
  const data = JSON.parse(readFileSync(input, 'utf8'));
  if (!Array.isArray(data.trades) || !Number.isFinite(data.initialEquity)) throw new Error('trades and initialEquity are required');
  const result = {
    label: 'Hypothetical fills and costs; not broker P&L or a profitability verdict',
    scenarios: [10, 25, 50].map(bps => replayPortfolio(data.trades, data.initialEquity, bps)),
    pairedDiagnostic: data.pairedCalendarBlocks ? pairedBlockInterval(data.pairedCalendarBlocks) : null,
  };
  const json = JSON.stringify(result, null, 2);
  if (output) writeFileSync(output, json + '\n', { flag: 'wx', mode: 0o600 }); else console.log(json);
} finally { rmSync(temp, { recursive: true, force: true }); }
