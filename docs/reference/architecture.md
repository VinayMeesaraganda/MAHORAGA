# Architecture and configuration

## Execution flow

`src/index.ts` authenticates `/agent/*` and `/mcp`. It forwards agent requests to `MahoragaHarness`, a Durable Object. The harness persists state, runs alarms, gathers signals, asks an LLM to research/analyze, checks entry/exit rules, and submits through an Alpaca broker adapter. D1 stores policy/session/trade-related data; KV and R2 bindings support the broader application.

The active strategy is selected in `src/strategy/index.ts`. The default implementation in `src/strategy/default/` contains gatherers, prompts, source weights, entry/exit rules, staleness, options, and crypto logic. Use the TypeScript interfaces in `src/strategy/types.ts` as the actual contract; HTML snippets are simplified examples and some relative imports/types are illustrative.

Active-market alarms target 30 seconds; closed-market alarms now back off (see runtime-improvements.md). `data_poll_interval_ms` and `analyst_interval_ms` gate parts of the loop; increasing them does not eliminate all active-market wakeups, API work, position research, or storage writes. Closed-market gating now skips expensive equity work outside preparation. Long/short social sentiment values are inputs; an LLM's confidence is not a calibrated probability of profit.

## Prepared baseline

| Setting | Value | Reason |
|---|---:|---|
| Account | Paper only | Competition uses paper accounts |
| Maximum position value | $2,500 | Small initial deployment of simulated capital |
| Maximum positions | 5 | Observe a limited portfolio |
| Position allocation | 5% of available cash | Additional size constraint |
| Policy concentration | 5% of equity | Separate broker-level constraint |
| Policy trade notional | $2,500 | Align with strategy cap |
| Stop / profit target | 5% / 10% | Retain default exit thresholds |
| Sentiment / confidence | 0.3 / 0.6 | Retain defaults for an interpretable baseline |
| Gathering / analysis | 120 / 300 seconds | Reduce work compared with default cadence |
| Research / analyst model | gpt-4o-mini / gpt-4o-mini | Initial compatibility/cost baseline, not an optimal-model claim |
| Options / crypto | Off / off | Begin with the equity strategy |
| Twitter / Discord | Unconfigured | Avoid optional usage and notifications |

These parameters are engineering starting points, not a tested profitable strategy. At $100,000 equity, five $2,500 holdings imply about 12.5% invested before price changes; this deliberately leaves most cash unused and may trail fully invested competitors. Change exposure only after comparing results and drawdowns.

## Two configuration layers

- Agent layer: `src/strategy/default/config.ts`, validated by `src/schemas/agent-config.ts`, updated through POST `/agent/config`.
- Policy layer: `src/policy/config.ts`, populated from `DEFAULT_*` Worker variables. Changing agent JSON does not change policy limits.

The JSON profile is a partial patch; the endpoint merges it into full defaults and validates the result. `starting_equity` in the example JSON is not part of the active agent schema and does not fund/reset Alpaca. Model settings saved in runtime configuration take precedence over environment defaults in harness reinitialization; apply provider and model choices through the configuration endpoint.

Policy defaults disallow short selling and use cash only, even though Alpaca reports margin buying power. Stop losses here are application-managed exits, not a guarantee of execution at the threshold. An offline worker, market gaps, API errors, or fill delays can change outcomes.

## Extension points

Change one component at a time: gatherer quality, entry filtering, exit rules, or prompt. Keep execution checks centralized in the broker. Test new modules against recorded, time-appropriate input. Do not interpret the phrase 'learns and adapts' as evidence of an implemented, validated online learning system.
