import { readFileSync } from 'node:fs';
const vars = Object.fromEntries(readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
  .split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#')).map(l => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }));
let profile = {};
try { profile = JSON.parse(readFileSync(new URL('../agent-config.json', import.meta.url), 'utf8')); } catch {}
let failed = false;
/** Provider error bodies can echo request material; never let a secret reach stdout. */
function redact(text) {
  let out = String(text);
  for (const key of ['OPENAI_API_KEY', 'ALPACA_API_KEY', 'ALPACA_API_SECRET', 'MAHORAGA_API_TOKEN', 'KILL_SWITCH_SECRET']) {
    if (vars[key]) out = out.split(vars[key]).join('<redacted>');
  }
  return out;
}
async function check(name, fn) {
  try { console.log(`${name}: ${await fn()}`); }
  catch (e) { failed = true; console.log(`${name}: FAIL (${e.message})`); }
}
async function json(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
await check('Configuration', async () => {
  if (vars.ALPACA_PAPER !== 'true') throw new Error('ALPACA_PAPER must be true');
  const missing = ['ALPACA_API_KEY', 'ALPACA_API_SECRET', 'OPENAI_API_KEY', 'MAHORAGA_API_TOKEN', 'KILL_SWITCH_SECRET'].filter(k => !vars[k]);
  if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
  return 'paper-only baseline credentials present';
});
await check('Alpaca paper account', async () => {
  const d = await json('https://paper-api.alpaca.markets/v2/account', {
    'APCA-API-KEY-ID': vars.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': vars.ALPACA_API_SECRET,
  });
  if (d.status !== 'ACTIVE' || d.trading_blocked || d.account_blocked) throw new Error('account is blocked or inactive');
  return `active; equity ${d.equity}; previous close ${d.last_equity}`;
});
await check('LLM provider', async () => {
  // The worker resolves the model from agent-config.json, not from LLM_MODEL, so
  // probe what will actually be sent. Verifies authentication and that the model
  // id resolves; it does not verify JSON-mode fidelity or answer quality.
  const base = (vars.OPENAI_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  const models = [...new Set([
    profile.llm_model || vars.LLM_MODEL || 'gpt-4o-mini',
    profile.llm_analyst_model || profile.llm_model || vars.LLM_MODEL || 'gpt-4o-mini',
  ])];
  const host = new URL(base).host;
  const budget = profile.llm_research_max_tokens || 2048;
  let extra = {};
  if (vars.LLM_EXTRA_BODY) {
    try { extra = JSON.parse(vars.LLM_EXTRA_BODY); }
    catch { throw new Error('LLM_EXTRA_BODY is not valid JSON'); }
  }
  for (const model of models) {
    // Mirror what the harness actually sends: JSON mode at the configured
    // research budget. Authentication alone is not enough — a model that
    // cannot return parseable JSON within that budget authenticates cleanly
    // and then never produces a tradable research result.
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${vars.OPENAI_API_KEY}` },
      body: JSON.stringify({
        ...extra,
        model,
        messages: [{ role: 'user', content: 'Reply with exactly this JSON and nothing else: {"ok":true}' }],
        max_tokens: budget,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) {
      const body = redact(await res.text()).slice(0, 160).replace(/\s+/g, ' ');
      throw new Error(`${model} -> HTTP ${res.status} ${body}`);
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error(
        `${model} returned empty content under a ${budget}-token budget. If this is a reasoning model, ` +
        'disable thinking via LLM_EXTRA_BODY (NVIDIA: {"chat_template_kwargs":{"enable_thinking":false}}) ' +
        'or choose a non-reasoning model.'
      );
    }
    try { JSON.parse(content.replace(/```json\n?|```/g, '').trim()); }
    catch { throw new Error(`${model} did not return parseable JSON in json_object mode: ${content.slice(0, 80)}`); }
  }
  return `${host} authenticated; ${models.join(', ')} returned parseable JSON`;
});
await check('Local worker', async () => {
  const d = await json('http://127.0.0.1:8787/agent/status', { Authorization: `Bearer ${vars.MAHORAGA_API_TOKEN}` });
  if (!d.ok || !d.data?.account) throw new Error('worker cannot read account');
  return `enabled=${d.data.enabled}; research=${d.data.config.llm_model}; analyst=${d.data.config.llm_analyst_model}`;
});
if (process.argv.includes('--sources')) {
  // Read-only availability probes; failure is reported rather than evading access controls.
  await check('StockTwits', async () => {
    const d = await json('https://api.stocktwits.com/api/2/trending/symbols.json', {
      'User-Agent': 'MahoragaPaperDiagnostics/1.0',
    });
    if (!Array.isArray(d.symbols)) throw new Error('unexpected response');
    return 'reachable; this does not verify signal quality';
  });

  await check('Reddit', async () => {
    // Mirror the gatherer: application-only OAuth when credentials exist, the
    // public host otherwise. The public host 403s from most non-residential IPs.
    const ua = 'cloudflare-worker:mahoraga:v0.3.0 (trading signal gatherer)';
    let base = 'https://www.reddit.com';
    let headers = { 'User-Agent': ua };
    let mode = 'unauthenticated';

    if (vars.REDDIT_CLIENT_ID && vars.REDDIT_CLIENT_SECRET) {
      const tokenRes = await fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${vars.REDDIT_CLIENT_ID}:${vars.REDDIT_CLIENT_SECRET}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': ua,
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(15000),
      });
      if (!tokenRes.ok) throw new Error(`OAuth token HTTP ${tokenRes.status} — check client id/secret and that the app type is "script"`);
      const tok = await tokenRes.json();
      if (!tok.access_token) throw new Error('OAuth response carried no access_token');
      base = 'https://oauth.reddit.com';
      headers = { Authorization: `Bearer ${tok.access_token}`, 'User-Agent': ua };
      mode = 'OAuth (client_credentials)';
    }

    const d = await json(`${base}/r/stocks/hot.json?limit=1`, headers);
    if (!Array.isArray(d.data?.children)) throw new Error('unexpected response');
    return `reachable via ${mode}; this does not verify signal quality`;
  });
}
process.exitCode = failed ? 1 : 0;
