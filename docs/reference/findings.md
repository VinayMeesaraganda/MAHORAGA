# Review findings and verification

## September 12 implementation update

The sections below include historical observations. [Guidance-continuation implementation status](guidance-continuation-status.md) is the current record of this change.

- The snapshot-based relative-volume denominator and most-actives conviction multiplier have been removed. Snapshot relative volume remains unknown; the corrected profile disables that gate. A tested same-cutoff/same-feed helper is available when suitable history exists.
- News retrieval now paginates and reports incomplete coverage. The separate research ledger persists article revisions and resumable coverage cursors. Held-issuer adverse evidence can survive beyond entry-catalyst age limits.
- Mandatory stop/time exits precede news adjudication; the baseline target/trailing branches remain available.
- Autonomous sell-order reconciliation now records idempotent cumulative fill deltas and updates the legacy gross-loss counter/cooldown. The New York date rollover preserves an unexpired cooldown. This does not backfill external trades or replace broker equity checks. Partial-fill day attribution uses broker order update time when a final fill time is unavailable.
- Entry prompts no longer contain recent win/loss aggregates. The review command produces exploratory statistics without promotion verdicts; outcome-selected exit groups cannot establish causal benefits.
- A separate `guidance-continuation-v1` shadow pipeline records unknown revenue consensus explicitly. Its optional protected-order contract is not wired into the production strategy. No pilot or profitability claim follows from passing tests.
- The legacy journal still contains decision-price P&L marks. Use broker fills for fill accounting; do not treat old journal marks as net realized performance. Historical journal reconciliation and external-trade attribution remain pilot prerequisites.

## Fixed in this checkout

**Emergency stop could not use its documented separate token.** `src/index.ts` required the regular token for all `/agent/*` paths, while the harness required a different token for `/kill`. The router now accepts the emergency token only on the exact kill path and bypasses normal rate limiting there. Four regression tests verify forwarding under exhausted rate limits, rejection of normal/incorrect tokens, no emergency-token access to normal actions, and preserved normal rate limiting.

**The entry gate could not pass a realistic research result.** The shared gate
rejected any non-empty `red_flags` entry while the research prompt explicitly
asked the model to name concerns, so qualifying entries were close to impossible.
StockTwits sentiment was separately deflated by the untagged share of each
message stream, keeping `min_sentiment_score` out of reach. Both are corrected in
[runtime improvements](runtime-improvements.md); the gate now classifies red-flag
severity deterministically and liquidity is checked against measured snapshot
data rather than model assertions.

## Updated runtime

See [runtime improvements](runtime-improvements.md): previous-close equity now supplies a second daily-loss guard, exits run independently of analyst cadence, and a daily completion-attempt cap is enforced. The legacy fill counter/cooldown issue remains.

## Important unresolved implementation limitations

- **Daily loss/cooldown accounting:** the policy reads `daily_loss_usd`, and storage provides an increment function, but repository search found no caller updating it from autonomous fills. A new previous-close equity guard now blocks new orders at the configured threshold; realized-fill accounting/cooldown is still incomplete. A proper repair requires choosing realized versus equity-based loss semantics, daily baseline/timezone, cash-flow treatment and reconciliation tests.
- **Pending orders/fills:** the broker treats order submission as success and refreshes account/positions later. Pending-order reservations and partial-fill reconciliation need testing before relying on position caps during bursts. Do not assume every successful submission is a fill.
- **Kill semantics:** harness kill disables alarms and clears research. It does not liquidate, cancel orders, or set the separate global D1 policy kill switch. This is not a universal emergency liquidation function.
- **Dependency audit:** the original locked root install reported 37 advisories (14 low, 7 moderate, 15 high, 1 critical); dashboard reported 8 (1 low, 1 moderate, 6 high). These are npm package advisory counts, not a verified exploitability analysis. No blind force-upgrade was applied. Review and remediate before public deployment.
- **Data/model availability:** paper account authenticated successfully, but social sources and the paid model path have not yet been validated with a working LLM key. Claims of always-on social access remain unverified.

## Documentation corrections

- Dashboard configured port is 3000, not 5173.
- The deployment template includes R2 and three Durable Object bindings in addition to D1/KV.
- `.dev.vars` serves local development; deployed secrets must be configured separately.
- `agent-config.json` is not loaded automatically by the worker.
- Runtime config can override LLM environment settings.
- Crons use fixed UTC times while the harness uses the Alpaca market clock; do not interpret every cron as an Eastern-time schedule across daylight saving changes.
- A new Durable Object migration tag alone is not a documented reliable reset of existing state. Do not use the HTML reset tip on a funded deployment.
- Historical claims about free-tier compatibility, model cost, and risk enforcement require validation rather than being copied as guarantees.

## Completed checks

- Root TypeScript check passed.
- All 214 unit tests passed (including router, scheduling, budget, and daily-equity-loss regressions).
- Dashboard TypeScript/Vite production build passed.
- All three local D1 migrations applied successfully.
- Read-only Alpaca account, positions, open orders and market clock checks passed.
- Local worker HTTP smoke checks passed: profile applied/read back, separate-token kill returned success, status showed disabled and $100,000 equity, and dashboard API proxy returned HTTP 200.
- No real-money or paper orders placed during setup.

Pending: model key and authenticated research, source availability, full paper order/fill lifecycle, corrected loss accounting, cloud identity/resources, public fork/username, OAuth registration and resumed official leaderboard syncing.

## External review, 12 Sep 2026 — two claims measured

A review argued the decision layer is overbuilt relative to any demonstrated
edge. Two of its claims were checkable against data already in hand, and both
hold.

**The relative-volume gate is a clock.** `rel_volume` compares the current
minute against the previous session's *average* minute, with no adjustment for
where in the session we are. Across 20,670 five-minute bars, the share of bars
clearing the 1.5x threshold runs from 71% in the first half hour to 3% around
13:00 ET, recovering to 34% into the close. Median relative volume by that
definition is 2.00 at the open and 0.49 at lunch. The gate does not measure
participation; it measures the time of day, and it is roughly twenty times more
permissive at 09:30 than at 13:00. Comparing against the same slot on prior
sessions is the fix; leaving it as-is means an unintended "trade near the open"
rule is running.

**The 2R target is largely fiction.** Holding the entry set fixed and varying
only the exit policy — the counterfactual design, since comparing gap-captured
trades against trades that ran to a stop selects on the price path — over 4,090
entries across ten names and five years:

| Exit policy | mean | win rate | avg win | avg loss |
|---|---:|---:|---:|---:|
| Full ladder | +0.081R | 55% | +0.56R | -0.51R |
| Stop / target / time only | +0.076R | 55% | +0.56R | -0.51R |

The target is reached on **1.0%** of ladder trades and 1.8% of simple ones. The
five-day hold, the trail arming at 1.5R and gap capture at 1.5R between them
ensure that almost nothing runs to 2R, so the advertised risk-reward is not the
realised one. The entire ladder is worth +0.005R per trade against a plain
stop/target/time exit, which on this sample is nothing.

Review clarification: both compared policies retain a target. This comparison does not establish the effect of deleting the target, and a small mean difference alone is not a statistical equivalence result.

These are unconditional entries, not catalyst-selected ones, and the intrabar
assumption is pessimistic (the adverse extreme is assumed to be reached first).
A selective system may well realise a different path distribution. But the
structural point does not depend on selection: a 2R target with a five-day
ceiling and two rules that cut winners at 1.5R cannot produce 2R winners often.

**The arithmetic that follows.** At `risk_per_trade_pct` 0.25 and roughly 13
trades a month, +0.081R is **0.26% a month before costs**, against a 2-3%
target — short by a factor of eight to eleven. Reaching 2% requires **0.62R
average across all trades**, and the measured average *winner* is 0.56R. Every
trade could win and the target would still be missed. Either the return target
or the risk unit has to move, and only one of them is a preference.

**Fixed in response:** `paper:review` declared a hypothesis "supported" when one
mean exceeded another after both groups reached their sample. Sample size alone
ignores variance and repeated comparisons. It now reports Welch's t with a
Bonferroni-adjusted threshold over the number of registered questions, returns
INCONCLUSIVE when the difference sits inside the noise, and states that trades
opened in the same regime are correlated, so even that overstates confidence.
