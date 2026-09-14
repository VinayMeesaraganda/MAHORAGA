# Three independent paper experiments

Implementation date: September 13, 2026. This document supersedes the earlier account-only and unwired-runtime descriptions. It does not establish profitability.

Paper-pilot activation: the user explicitly requested all three strategies be able to submit orders to their individual Alpaca paper accounts. The baseline remains enabled. Both new Workers are configured for `enabled=true`, `mode=paper`, and `executionAuthorized=true`. `brokerFillValidation=pending` records that a real broker fill/protection lifecycle has not yet been verified. They run at `https://mahoraga-guidance-continuation.raj-vinay2408.workers.dev` and `https://mahoraga-price-volume.raj-vinay2408.workers.dev`. Their APIs require header authentication, so opening those addresses without the CLI/token is not a dashboard login.

Monday September 14 macro coverage was reviewed against the official BLS September calendar and Fed meeting calendar, recorded with source excerpts and a server observation timestamp. It covers Monday's session, with normal 24-hour freshness expiry at approximately 9:53 p.m. Eastern Monday. Automatic official fetches still fail, and Finnhub's economic-calendar endpoint returned 403. If automatic access remains unavailable, a fresh official-calendar review is necessary for subsequent entries; this is not permanent unattended macro coverage. Guidance also still requires a verified event, rather than inventing one because paper mode is enabled.

## What runs

| Experiment | Worker | Decision process |
|---|---|---|
| Existing sentiment baseline | `mahoraga-paper` | Existing LLM research, sentiment and execution policies |
| Guidance continuation | `mahoraga-guidance-continuation` | Verified EPS/guidance event, D0 reaction, D1 continuation |
| Price/volume | `mahoraga-price-volume` | Completed-session breakout, trend and volume confirmation |

Each new Worker has its own Alpaca account pin, Durable Object, D1 database, API token, emergency secret, holdings metadata, pending orders, risk state and experiment history. Provisioning verifies all three broker IDs are different. Changing credentials to another account makes the runtime refuse reconciliation and trading. No accounts were reset.

The experimental entrypoint is `src/experiments/worker.ts`; it never launches the sentiment harness under a different name. Signal logic lives in strategy modules. The shared broker retains deterministic execution policy. Neither new strategy requests an LLM completion. The existing dashboard still displays the baseline; use the authenticated experiment CLI for the two new Workers.

## Trading rules

Both experiments use a registered 24-stock liquid US common-stock universe. This is a prospective universe, not a point-in-time historical universe or a claim that these stocks are optimal. Universe membership and sectors are versioned in `src/strategy/shared-market/index.ts`.

**Guidance continuation:** EPS actual must exceed a comparable estimate observed before the release. Issuer revenue guidance must improve on comparable prior guidance. Revenue consensus and free cash flow remain optional/unknown. Existing event rules require sourced, immutable evidence, a completed D0 response and the next-session entry window. A Finnhub earnings row does not identify a trustworthy EPS accounting basis or certify a guidance revision; those facts require reviewed issuer evidence. The evidence/event ingestion API is implemented, but unattended issuer-document extraction and verification are not.

**Price/volume:** the completed session closes above the prior 20-session high and its 50-session average, finishes in the upper quarter of its range, and trades at least 1.5 times the prior 20-session mean volume. At entry, the bid must retain the breakout and the ask cannot be more than half an ATR above that close. Known earnings inside the ten-session holding horizon veto entry. Unknown/stale earnings-calendar coverage also blocks it. Unexpected announcements and schedule revisions remain possible.

Market inputs use 51 completed sessions built from split-adjusted SIP 30-minute buckets wholly inside the Alpaca-reported regular session. Missing/duplicate buckets, calendar gaps and implausible discontinuities fail closed. Early closes and DST are respected. The bucket beginning at the closing boundary is excluded: these bars are **not** the official closing-auction price/volume. Current IEX quotes are checked for age, spread and displayed size; IEX is not consolidated NBBO. These data conventions are part of the execution-profile hash.

Entries are evaluated at 10:05–10:10 America/New_York on actual market sessions. A daily candidate batch and its input evidence are frozen before allocation. All candidates resolve before deterministic ranking. Restart reuses the batch. Each selected event is attempted at most once that day; prices and risk capacity are rechecked before submission, with no chasing or increasing a frozen allocation.

## Risk and execution

| Limit | Initial value |
|---|---:|
| Planned stop risk per entry | 0.125% of equity ($125 at $100,000) |
| Single-name exposure | 5% |
| Gross exposure | 25% |
| Sector exposure / positions | 10% / 2 |
| Total positions / planned stop risk | 5 / 0.625% |
| Per-order notional ceiling | $5,000 |
| Previous-close daily loss guard | 2%, plus legacy recorded-loss checks |
| Peak-equity drawdown pause | 3%, persistent latch |
| Maximum holding period | 10 exchange sessions |

Sizing includes held exposure and opening reservations; short positions, unknown holdings and conflicting open orders block new allocation. Cash-only sizing, whole shares, regular hours and equities-only scope are retained. No streak-based size increases. Planned stop risk is not a guaranteed loss cap: gaps and slippage can exceed it. Daily loss and peak equity are not adjusted for transfers; keep experiment accounts free of resets and cash flows.

Entries use capped limit orders with native OTO stop instructions. Submission acknowledgement is not a fill. Intents and client IDs are persisted before broker HTTP calls. Partial fills trigger parent cancellation and broker reconciliation before residual GTC protection is established. Unknown outcomes block another entry. A position exit cancels owned protection and waits for terminal confirmation before closing; it never races two independent sells. Broker order revisions and actual fill fields are stored separately from shadow decisions.

Each executing cycle checks account identity, reconciles broker state and evaluates deterministic exits before optional data collection. Time exits use the stored exchange calendar, so a macro/news outage does not remove them. Native stops remain at Alpaca when the Worker is unavailable. A verified issuer invalidation can exit guidance holdings; a headline or model concern alone cannot liquidate them. The new issuer-news veto is conservative and single-issuer only, not a general language-understanding system.

## Scheduling and commands

Run from the repository root. Commands load credentials privately; never put tokens in browser URLs.

```sh
node scripts/experiment.mjs status guidance-continuation
node scripts/experiment.mjs status price-volume
node scripts/experiment.mjs prepare price-volume
node scripts/experiment.mjs dry-run price-volume
node scripts/experiment.mjs research-status guidance-continuation
node scripts/experiment.mjs refresh-finnhub price-volume
node scripts/experiment.mjs refresh-macro price-volume
node scripts/experiment.mjs audit price-volume
node scripts/experiment.mjs orders price-volume
```

`prepare` does one bounded collection step; it never reconciles or submits broker orders. `dry-run` evaluates current inputs without freezing the daily trading batch or submitting orders. Running it on Sunday correctly fails the session/quote gates; it is not a historical backtest.

`start-shadow` enables collection and daily shadow decisions. Durable Object alarms resume without the laptop: approximately 30 seconds during the session and the hour before open, hourly otherwise. The alarm is scheduled after each cycle, so execution latency adds to the interval. No extra cron is required. Finnhub/macro refreshes are scheduled about every six hours; history is cached per completed session and news advances through persisted page cursors. One optional source stage runs per cycle.

```sh
node scripts/experiment.mjs start-shadow guidance-continuation
node scripts/experiment.mjs start-shadow price-volume
node scripts/experiment.mjs start-paper guidance-continuation
node scripts/experiment.mjs start-paper price-volume
node scripts/experiment.mjs stop price-volume
node scripts/experiment.mjs kill price-volume
```

`stop` disables that harness and its alarms, retaining broker orders and positions. `kill` also sets that experiment's separate D1 policy switch, and remains reachable when normal API requests are rate limited. Neither command liquidates or cancels all broker orders. A stopped harness does not actively manage exits; already confirmed native stops remain broker-managed. Resume requires explicit review of broker exposure and the policy switch.

Provision/deploy use `node scripts/experiment.mjs provision <strategy>` and `deploy <strategy>`. The script reads private per-account files, creates an isolated D1 database, applies migrations via binding `DB`, packages the dedicated entrypoint and uploads secrets. Deployment alone does not enable trading. `start-paper` explicitly authorizes a paper pilot: it rechecks all three account identities, pins the deployed profile through the `PAPER_PILOT_AUTHORIZATION` secret and applies/readbacks `mode=paper`. This is an operator authorization, not a claim that a fill lifecycle passed. The legacy `EXECUTION_ACCEPTANCE` path is separate and was not asserted. Neither accepts a generic `true`. The activation CLI waits for the uploaded authorization to appear in status before configuring paper mode, and reports a sanitized error code on failure. Runtime `mode` determines execution; the embedded strategy profile's original shadow label is research metadata.

## Evidence workflow and remaining gates

Finnhub authentication and earnings-calendar access passed both locally and on the deployed Workers. The initial response contained 211 calendar records. Only registered-universe rows are indexed to contain D1 writes; the full source response is retained as evidence. Estimates captured on the release date are not treated as proven pre-release observations. Identical calendar responses preserve each observation, so refreshing cannot accidentally erase an upcoming-earnings veto. The supplied webhook secret is stored privately; no webhook endpoint or Finnhub subscription has been enabled. These strategies currently poll the API.

Issuer review uses the existing `EarningsEventSchema` and endpoints:

```sh
node scripts/experiment.mjs evidence guidance-continuation /absolute/path/evidence.json
node scripts/experiment.mjs events guidance-continuation /absolute/path/reviewed-event.json
```

Evidence is server-stamped on ingestion. Events must reference matching source hashes, excerpts and availability timestamps. Corrections need a new version. Keep unsupported metrics unknown; never backdate consensus or certify unverified accounting bases. See `guidance-continuation-status.md` for schema examples and the research replay workflow.

Direct official macro fetches currently fail. The system does not substitute an empty calendar. A bounded manual fallback accepts `CalendarReview` from `src/experiments/calendar.ts`: explicit reviewer, completeness attestation, official BLS/Fed source content, interval and event timestamps. Submit with `calendar <strategy> <file>`. This is an operator completeness assertion, visibly distinct from successful automated collection. The server stamps the review; freshness expires after 24 hours. A daily check or working official fetch is still necessary. Current rules cover CPI, Employment Situation, FOMC decisions and Fed press conferences, not every macro announcement.

During the authorized paper pilot, verify current source coverage and inspect the full daily decision batch. Guidance entries require ingested qualifying evidence. Verify normal fills, partial-fill cancellation, stop activation/GTC recovery, close/protective-order coordination and restart recovery against the paper broker as qualifying orders occur. Unit fixtures cover those execution branches, but no real fill lifecycle was exercised during the Sunday setup. Do not represent authorization or these tests as a profitable forward run or completed broker acceptance.

## Evaluation and validation

Hypotheses and proposed review dates are in `config/experiments/registry.json`. First inspect operational behavior, then review at least 20 observed sessions before a preliminary performance comparison. Include rejected signals, unavailable data, unfilled orders and failed trials. Compare same-date cash/broad-market benchmarks, exposure, turnover, drawdown and actual costs. The 10/25/50 bps per-side scenarios are registered sensitivity assumptions, not fees automatically deducted from Alpaca equity. There is no automated promotion engine or claim of an established edge.

Validation includes TypeScript, the full regression suite, native local Worker configuration/readback, and deployed authenticated data probes. Remote probes verified three distinct accounts, $100,000 each and no holdings/orders, both new Workers, Finnhub, complete news pagination and history for all 24 symbols. Local Wrangler falls back from the requested 2026-09-13 compatibility date to its supported 2026-01-28 runtime; remote probes were therefore essential. Baseline doctor verified a parseable LLM response and reported Reddit HTTP 403. The baseline local disabled state was preserved.

Sunday activation readback: both new Workers completed an automatic alarm cycle with no runtime error, scheduled their next alarm, and had clear D1 emergency switches. Account pins matched distinct ACTIVE, unblocked accounts. A no-order dry run returned zero guidance events and evaluated 24 price/volume names with no allocations. All IEX quotes were stale outside market hours; 11 also had zero/invalid price or size and failed input validation. Sunday has no trading session, explaining the holding-calendar rejection for the other 13. This verifies fail-closed behavior, not Monday quote quality or a qualifying trade.

Final regression run: **670 tests passed in 51 files**, and type checking passed. Native local checks rejected unauthorized paper mode (HTTP 422) and successfully executed authenticated emergency shutdown (HTTP 200) while ordinary requests were rate-limited (HTTP 429). Tests also verify improved-price entries preserve the frozen dollar-risk budget, negative cash/exhausted equity do not prevent risk-reducing exits, and paper authorization is separate from fill acceptance. No broker test orders were placed.

Primary contracts: [Alpaca orders](https://docs.alpaca.markets/us/docs/orders-at-alpaca), [Finnhub earnings calendar](https://finnhub.io/docs/api/earnings-calendar), [Cloudflare alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), [BLS calendar](https://www.bls.gov/schedule/), [FOMC calendar](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm).
