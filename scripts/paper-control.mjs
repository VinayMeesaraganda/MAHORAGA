import { readFileSync } from 'node:fs';

// This helper only addresses a local worker and Alpaca's paper API.
const vars = Object.fromEntries(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
  .split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'))
  .map(line => { const i = line.indexOf('='); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }));
const action = process.argv[2] || 'check';
const allowed = ['check', 'apply', 'config', 'status', 'logs', 'costs', 'disable', 'kill', 'enable'];
if (!allowed.includes(action)) throw new Error(`Use: ${allowed.join(', ')}`);
if (vars.ALPACA_PAPER !== 'true') throw new Error('ALPACA_PAPER must be exactly true.');
const needed = ['ALPACA_API_KEY', 'ALPACA_API_SECRET', 'OPENAI_API_KEY'];
const missing = needed.filter(key => !vars[key] || /your_|placeholder/i.test(vars[key]));
if (action === 'check') {
  console.log(`Paper mode: true. Missing credentials: ${missing.join(', ') || 'none'}.`);
  process.exitCode = missing.length ? 1 : 0;
} else {
  if (action === 'enable') {
    if (missing.length) throw new Error(`Fill .dev.vars: ${missing.join(', ')}`);
    const account = await fetch('https://paper-api.alpaca.markets/v2/account', {
      headers: { 'APCA-API-KEY-ID': vars.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': vars.ALPACA_API_SECRET },
      signal: AbortSignal.timeout(15000),
    });
    if (!account.ok) throw new Error(`Paper account verification failed: HTTP ${account.status}`);
    const data = await account.json();
    if (data.status !== 'ACTIVE' || data.trading_blocked || data.account_blocked) {
      throw new Error('Paper account is not active and unrestricted.');
    }
  }
  const token = vars[action === 'kill' ? 'KILL_SWITCH_SECRET' : 'MAHORAGA_API_TOKEN'];
  if (!token) throw new Error('Missing local authentication token.');
  const response = await fetch(`http://127.0.0.1:8787/agent/${action === 'apply' ? 'config' : action}`, {
    method: ['apply', 'disable', 'kill', 'enable'].includes(action) ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(action === 'apply' ? { body: readFileSync(new URL('../config/paper-baseline.json', import.meta.url), 'utf8') } : {}),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Local worker returned HTTP ${response.status}`);
  console.log(JSON.stringify(await response.json(), null, 2));
}
