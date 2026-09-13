# Guidance continuation: implementation and operation

Implementation date: September 12, 2026. Baseline source commit: `cd6ac8e`. This implements the accepted recommendation as a **shadow research path** alongside the existing strategy. It does not activate a new trading strategy or establish profitability.

## What is implemented

| Area | Executable behavior |
|---|---|
| Registration | `config/guidance-continuation-v1.json` explicitly omits revenue consensus, retains comparable EPS surprise, and disables pilot/promotion. Dates and operating budget remain unset until an evaluation is registered. |
| Evidence | Authenticated ingestion hashes source content and stamps first observation on the server. Events must reference stored documents and exact excerpts. A late consensus upload cannot be backdated into qualification. |
| Event ledger | Immutable issuer/event versions; corrections append new versions. Shadow evaluation rejects superseded versions. |
| Decisions | Typed inputs, once-per-event decisions, and an atomic frozen candidate set per session. Store all rejection reasons, input versions, profile hash and proposed allocations. |
| Qualification | D1 10:05–10:10 ET, outside-hours release, comparable EPS beat, raised forward revenue guidance, valid D0 reaction, completed regular SIP history, fresh quotes, liquidity and verified review state. |
| Risk | Whole-share sizing against rounded limit/stop; name, gross, sector, position-count and aggregate initial-risk limits. Held positions and pending reservations share capacity. No model-confidence sizing. |
| Exits | Challenger pure rules implement initial stop, ten-session horizon including early closes, and verified invalidation. These rules are available to replay; the active baseline is not switched. |
| News | Paginated provider reads plus a separate D1 collector with durable cursors, overlapping backfill, article content revisions, and explicit incomplete intervals. Held issuers receive a priority stream. |
| Optional features | Tested same-cutoff/same-feed relative volume and non-overlapping quarterly FCF calculation. Missing values remain unknown and do not gate v1. |
| Macro | Typed official-source calendar input, freshness/coverage checks, and fixed ±30-minute blackouts. No directional forecast or risk multiplier. |
| Replay | Explicit hypothetical fills, gap-aware stop outcomes, missing-exit handling, 10/25/50 bps costs, chronological shared-capital simulation and paired calendar-block confidence intervals. No automatic promotion verdict. |
| Broker contract | Policy-governed quantity/limit/OTO entry, persisted IDs, partial-parent cancellation, GTC protection verification, timeout recovery, and cancellation before closing. Production has **no protected-entry validator installed**, so this entry method refuses submission. |
| Loss accounting | Autonomous reconciled sell-order deltas update an idempotent ledger and legacy gross-loss/cooldown controls. Previous-close equity checks remain independent. |

## Corrected baseline

`config/baselines/cd6ac8e.json` preserves the original checked-in profile. The target/trailing/gap exit implementation remains in the repository. The replay in `findings.md` compared two policies that both retained a target; it does not justify deleting that target globally.

`config/baselines/corrected-runtime-2026-09-12.json` records the full configuration read back from the local Durable Object after the one-field patch. Its SHA-256 and the executable challenger profile hash are registered in the experiment manifest. No evaluation start date or income claim is inferred from that operational snapshot.

The snapshot's minute-volume/full-day-average ratio was removed, including its most-actives conviction multiplier. With no matching historical denominator, snapshot relative volume is unknown. The prepared default sets `entry_min_rel_volume` to zero. Existing explicit nonzero configurations continue to reject missing volume until deliberately patched; they do not silently receive a fabricated metric.

The local runtime already had `gap_capture_r: 0` before this work. The prepared profile now reflects that existing setting. Only `config/patches/correct-volume.json` was applied locally, preserving all other runtime settings and the disabled agent state. Entry prompts no longer ingest recent win/loss aggregates. Mandatory stops and time exits precede expensive news adjudication, including across different held issuers.

## Commands

Use Node 22.13 or later (verified with Node 24). Tests use Node's SQLite implementation to execute the actual D1 migrations and transactions. The offline CLI uses the explicit esbuild development dependency.

```sh
npm run db:migrate
npm run dev -- --port 8787
npm run research -- status
npm run research -- decisions
npm run research -- collect --drain
```

`collect --drain` processes up to 40 pages per invocation. An unfinished backfill returns a failure exit code and keeps its cursor; run it again to resume. Collection uses broker reads and news reads only. It is independent of the trading agent's enabled flag, and an invocation does not install a recurring schedule. Coverage describes the named provider and interval, not all possible market news.

The authenticated GET `/agent/research/decisions?cursor=<next_cursor>` exports immutable decisions in pages of 100. Cursor values are record offsets, never authentication tokens. The CLI `decisions` command prints the first page.

To apply only the volume correction on another prepared local instance:

```sh
npm run paper:apply -- --file config/patches/correct-volume.json
npm run paper:status
```

The helper reads the local token internally. Do not put tokens in URLs or command arguments. The experiment manifest is **not** a valid `paper:apply` profile.

### Supply event evidence

```sh
npm run research -- evidence /absolute/path/source.json
npm run research -- events /absolute/path/event.json
npm run research -- evaluate /absolute/path/candidates.json
```

1. `source.json` contains `source_url`, `published_at`, and the actual document `content`. The response returns its hash and immutable observation timestamp. Capture EPS consensus **before** the release; uploading a historical estimate after publication does not satisfy the forward protocol.
2. `event.json` follows `src/schemas/earnings-event.ts`. Each metric includes value, currency, unit, fiscal period, accounting basis and evidence reference. Guidance includes old/new range endpoints. Evidence timestamps and quotations must match stored sources. Review is `verified`, `pending` or `contradicted`, with a deterministic/operator attribution and evidence; an arbitrary LLM trading verdict is not an authorization method.
3. `candidates.json` has a `candidates` array of `{ event_id, market }` and a `portfolio` object. `market` follows `CandidateInputSchema` excluding `event` and `at`. The server loads the stored event and stamps the current decision time. Supply the full candidate batch once, with the shadow portfolio's holdings and reservations. Inputs and portfolio provenance are stored as operator-supplied; they are not broker fills.

The market packet requires a complete exchange-session calendar, latest 21 completed regular-session consolidated bars, an explicitly identified fresh quote, security type/sector mapping, official-source macro calendar coverage and news coverage. These are **input contracts**, not proof that a vendor adapter has verified those facts. Review the actual source coverage before submitting a packet. The integration tests contain synthetic schema examples; do not ingest those fixtures into the operational ledger.

### Replay

```sh
npm run research:replay -- /absolute/path/replay-input.json /absolute/path/new-report.json
```

The input contains `initialEquity`, `trades` as defined by `ReplayTrade`, and optionally `pairedCalendarBlocks`. Each trade supplies an explicitly assumed entry fill and timestamped post-entry bars. A missing horizon bar leaves the position open. Stops use a conservative gap price; neither a touched limit nor a daily high proves an executable fill. Output files must be new; the command does not overwrite an existing report.

Blocks must be non-overlapping calendar periods longer than the holding horizon, use paired strategy differences, and include zero-trade days. The minimum 20 blocks is an implementation guard, not a proof of statistical adequacy. The CLI reports costs and diagnostic intervals, never a profitable/not-profitable verdict. Operating costs remain a separate dollar deduction from strategy returns.

## Prerequisites that remain open

- No verified EPS-consensus vendor or autonomous issuer-release/guidance extraction adapter has been connected. The authenticated evidence adapter accepts source documents and reviewed event records. Unknown data cannot be replaced with a headline saying “beat.”
- Official macro calendars and certified regular-session market packets currently require an external producer/operator. Source URL checks do not prove semantic correctness, point-in-time completeness or a live market-data entitlement.
- The challenger is not registered as the active harness strategy. Shadow evaluation is invoked through the research endpoint/CLI, not automatically as a new broker-connected alarm stage. No collection automation was installed.
- Protected-order lifecycle tests use mocks, not actual account fills. A controlled paper acceptance session, deterministic strategy-to-broker validation wiring, reliable hosting, trade-update recovery and reconciliation of any external activity are required before a pilot. The disabled production entry gate prevents accidental use of the prototype.
- Unknown broker submission outcomes remain blocked for reconciliation; this can leave residual risk needing operator attention. A broker stop does not remove gap/halting risk, and native DAY children are not accepted as overnight protection.
- The loss ledger records autonomous orders with known broker cost basis. It does not backfill manual trades, handle corporate-action/tax-lot adjustments, or make partial order `updated_at` an exact execution timestamp. These limitations are distinct from the broker-equity loss gate.
- The legacy journal's decision-price marks are still labeled as such and must not be promoted to actual net-fill performance. Historical journal reconciliation is required before using that record as a performance benchmark.
- Evaluation dates, scheduled reviews, operating budget and promotion thresholds must be registered before evaluating an edge. Sparse event counts and illustrative expectancy assumptions cannot support an income target or leaderboard promise.

## Local verification

Migrations 0004 and 0005 were applied locally without resetting existing history. The authenticated research endpoint returned the fixed shadow profile and `broker_orders_enabled: false`. Broker reads reported $100,000 equity, zero positions and zero pending intents; the agent remained disabled. A seven-day news backfill completed in 45 pages. No orders, remote deployment, account reset or secret changes were performed.

The initial doctor run passed the broker check but timed out on the LLM provider and could not reach the stopped local Worker. The Worker was subsequently started and its authenticated endpoints verified. A successful Worker check does not repair or validate the separate LLM connection.

Final verification on September 13: `npm run typecheck`, all 627 tests across 44 files, `git diff --check`, and the Wrangler dry-run Worker build passed. The offline replay CLI smoke check produced all three cost scenarios with lower equity as costs increased. The local research endpoint rejected an unauthenticated request with HTTP 401 and reported 2,229 stored article versions, completed backfill coverage, and broker orders disabled. These checks verify implementation behavior, not a trading edge or live broker acceptance.
