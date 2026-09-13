import { readFileSync } from 'node:fs';

const vars = Object.fromEntries(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').split(/\r?\n/)
  .filter(line => line.trim() && !line.trim().startsWith('#')).map(line => {
    const at = line.indexOf('=');
    return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^(['"])(.*)\1$/, '$2')];
  }));
if (vars.ALPACA_PAPER !== 'true' || !vars.MAHORAGA_API_TOKEN) throw new Error('Explicit paper mode and local authentication are required');
const [action = 'status', argument] = process.argv.slice(2);
const drain = action === 'collect' && argument === '--drain';
const file = drain ? undefined : argument;
if (!['status', 'decisions', 'collect', 'evidence', 'events', 'evaluate'].includes(action)) throw new Error('Use status, decisions, collect, evidence FILE, events FILE, or evaluate FILE');
if (['evidence', 'events', 'evaluate'].includes(action) && !file) throw new Error('A JSON input file is required');
const body = file ? readFileSync(file, 'utf8') : '{}';
JSON.parse(body);
for (let page = 0; page < (drain ? 40 : 1); page++) {
const result = await fetch(`http://127.0.0.1:8787/agent/research/${action}`, {
  method: ['status', 'decisions'].includes(action) ? 'GET' : 'POST',
  headers: { Authorization: `Bearer ${vars.MAHORAGA_API_TOKEN}`, 'Content-Type': 'application/json' },
  ...(['status', 'decisions'].includes(action) ? {} : { body }), signal: AbortSignal.timeout(60_000),
});
const data = await result.json();
if (!result.ok) { console.error(JSON.stringify(data, null, 2)); process.exitCode = 1; break; }
if (!drain) { console.log(JSON.stringify(data, null, 2)); break; }
if (data.market?.error || data.held?.error) { console.error(JSON.stringify(data)); process.exitCode = 1; break; }
if (data.market?.complete && (!data.held || data.held.complete)) { console.log(JSON.stringify({ complete: true, through: data.market.through, pages: page + 1, broker_orders_enabled: false })); break; }
if (page === 39) { console.error('Coverage remains incomplete after 40 pages; resume collect --drain.'); process.exitCode = 1; }
}
