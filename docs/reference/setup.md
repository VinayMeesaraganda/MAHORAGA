# Setup and operation

## Local runtime

Use the installed Node 24 runtime. Upstream says Node 18+, but current dependency requirements can be newer. Both lockfiles were installed with `npm ci --ignore-scripts`; the installed binaries and builds were verified.

1. Edit `.dev.vars` locally and fill `OPENAI_API_KEY`. Alpaca paper keys and independent authentication tokens are already present. Keep `ALPACA_PAPER=true`.
2. Run `node scripts/paper-control.mjs check`. This checks for missing credentials, not whether the model API accepts them.
3. Start the worker: `npm run dev -- --ip 127.0.0.1`.
4. Apply the profile: `node scripts/paper-control.mjs apply`.
5. Inspect the applied profile: `node scripts/paper-control.mjs config`.
6. Start the dashboard: `npm run dev --prefix dashboard -- --host 127.0.0.1`.
7. Open http://127.0.0.1:3000 and enter `MAHORAGA_API_TOKEN` from `.dev.vars` in Settings. The actual Vite port is 3000, not the 5173 in the getting-started guide.
8. Check `node scripts/paper-control.mjs status`; ensure the expected paper account, profile, and disabled state are present.
9. After model authentication is checked, `node scripts/paper-control.mjs enable` starts autonomous PAPER orders and paid model calls. The helper verifies an active paper account first. Watch logs for successful research and valid signals before leaving it unattended.

The helper addresses localhost only and assumes the worker uses this checkout's `.dev.vars`. It is not a global block against changing the worker to live trading. It currently supports the configured OpenAI baseline; adapt credential validation if selecting another provider.

Local development stops when the process/computer stops. Durable state is saved under `.wrangler/`; a previously enabled agent can resume on restart. Saving `agent-config.json` does not apply it: the harness loads Durable Object state and accepts configuration through POST `/agent/config`.

## Observe and stop

```bash
node scripts/paper-control.mjs status
node scripts/paper-control.mjs logs
node scripts/paper-control.mjs costs
node scripts/paper-control.mjs disable
# Emergency stop uses the separate KILL_SWITCH_SECRET:
node scripts/paper-control.mjs kill
```

Disable/kill stops the harness; it does not cancel broker orders or liquidate positions. Review open orders and positions in Alpaca separately. The harness stop is also distinct from the D1 policy kill switch exposed through MCP. Do not assume it disables every possible trade interface.

Never paste the README's author's deployed worker URL into account-control commands. Use your own endpoint. The helper keeps tokens out of shell command arguments.

## Cloud deployment when credentials and budget are ready

The prepared `wrangler.jsonc` is LOCAL ONLY: database/KV identifiers are dummy values and scheduled crons are disabled. Before deploying:

- Authenticate Wrangler to your Cloudflare account.
- Create D1 with `npx wrangler d1 create mahoraga-db` and copy its ID into the configuration.
- Create KV with `npx wrangler kv namespace create CACHE` and copy its ID.
- Create R2 with `npx wrangler r2 bucket create mahoraga-artifacts`; its binding is present in the worker template but omitted from the README quick start.
- Set `ENVIRONMENT` to a meaningful deployed-paper value, retain `ALPACA_PAPER=true`, and retain conservative policy values.
- Set secrets with `npx wrangler secret put NAME` for ALPACA_API_KEY, ALPACA_API_SECRET, OPENAI_API_KEY, MAHORAGA_API_TOKEN, and KILL_SWITCH_SECRET. Local `.dev.vars` is not a substitute for deployed secrets.
- Apply remote migrations: `npm run db:migrate:remote`.
- Review the example's cron schedules and cost implications before restoring them. Harness alarms run separately; disabling crons does not disable an enabled harness.
- Deploy with `npm run deploy`, then POST the profile to your own `/agent/config`, verify paper-account state, and enable deliberately.

Cloud setup requires the user's Cloudflare account. This work has not created any billable cloud resources. Consult current Cloudflare plan pricing before choosing a plan; upstream free-tier and dollar-per-day statements are historical estimates.
