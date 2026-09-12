# Trading and execution review — September 11, 2026

**Verdict: useful research prototype, not ready for unattended deployment or real capital. No demonstrated trading edge.**

This review covers the current working tree, including the newly added market-data, catalyst, macro, sizing, exit, and model-provider changes. It supersedes earlier readiness summaries. The old documentation still says the model key is missing and the cap is 300; a credential is now present, and local Wrangler specifies 600 completion attempts/day. Credential presence is not authenticated model readiness.

## Evidence

- Worker typecheck passed and all 335 existing tests passed across 24 files.
- Read-only paper API checks returned equity and previous-close equity of $100,000, no positions, and zero orders in the all-status query. There is no observed fill/return sample on this account.
- The local Worker at 127.0.0.1:8787 was unreachable during review. Its active configuration/enabled state could not be verified; I did not restart it because a persisted enabled state may resume autonomous activity.
- The profile file specifies five positions, $5,000 maximum notional, 0.25% planned equity risk per trade, ATR stops of 3–15%, 2R targets, 1.5R trailing activation, nominal 1R trailing distance, five calendar days maximum hold, and catalysts required. Local policy sets 6% concentration, $5,000 per order, five positions, 2% daily loss, and 600 completion attempts/day.
- Reproduction code ran from temporary files against actual project modules. It made no trades or paid model calls. No trading source or configuration was changed by this review.

## Findings, in repair order

### P1 — Daily technicals can be weeks stale

Location: `src/providers/alpaca/market-data.ts:128–164`; caller `src/durable-objects/mahoraga-harness.ts:619–624`.

The caller requests 252 daily bars. The provider starts about 383 calendar days back, accepts the first page in the API's ascending order, and ignores `next_page_token`. It therefore selects the first 252 sessions in that interval rather than the latest 252.

**Live read-only reproduction:** AAPL, start 2025-08-25, limit 252, SIP: HTTP 200, 252 bars, first 2025-08-25, last **2026-08-25**, with a nonempty next-page token. Review date is September 11. ATR, SMA, ADV20 and 52-week-high comparisons can therefore exclude the most recent weeks. The latest trade price is then compared with stale technical inputs.

**Repair:** request the newest bars explicitly and put them into chronological order, or paginate through the range and take the last complete sessions. Set a consistent corporate-action adjustment policy. Validate the newest bar against the market calendar, and test pagination and chronological order. Mock tests that only assert a start parameter cannot catch this error.

### P1 — Market-quality checks do not validate the market at submission time

Locations: `src/durable-objects/mahoraga-harness.ts:619–671`; `src/strategy/default/rules/entry-quality.ts:marketQualityRejection` and final call from `entryRejection`; `src/core/policy-broker.ts:submitBuy`.

Liquidity, spread, range position and extension are taken from `research.market`. Research may stay eligible for 15 minutes; quote/trade timestamps are discarded by `deriveMarketContext`. The broker rechecks account/clock/orders, but does not obtain a new quote and recompute the executable spread or extension before sending a market order.

**Reproduction:** a qualifying signal now plus 14-minute-old research containing a 10-bps spread passes `entryRejection` with no rejection. Nothing asks whether the current spread has become 150 bps, price has jumped, or the quote was already stale when fetched. A fresh research timestamp also does not make its underlying quote fresh.

**Repair:** separate research validity from execution validity. Refresh and age-check quote/trade data immediately before submission, reject stale or crossed quotes, and enforce a defined acceptable execution price. An IEX quote is not a consolidated NBBO guarantee. Keep feed identity visible rather than silently treating all feeds as equivalent.

### P1 — A close request deletes risk metadata before the position is gone

Locations: `src/core/policy-broker.ts:259–267`; `src/durable-objects/mahoraga-harness.ts:182–189`.

`closePosition` returning successfully causes `onSell`, which immediately deletes the position's entry, ATR stop/target, peak and social history and starts the re-entry cooldown. HTTP acceptance is not confirmation that every share sold. With an accepted, partial, canceled or subsequently rejected close, the residual holding loses its original stop/target, trailing peak and time-stop metadata. The next exit pass can fall back to the global 5% stop instead of that holding's original ATR stop, while trailing/time exits require the deleted entry.

**Repair:** retain entry state until broker reconciliation confirms zero quantity. Track close order IDs/status/fills and update realized results from executions. Test partial fills, canceled closes, delayed acknowledgements, restarts and repeated close requests. The existing success-path mock returns immediately and does not establish lifecycle correctness.

### P1 — Slow research can delay the next protective exit pass

Locations: `src/providers/llm/openai.ts:62–69`; `src/providers/alpaca/client.ts:48–58`; harness scheduling at `src/durable-objects/mahoraga-harness.ts:391–397`.

The direct model and Alpaca fetches have no explicit request deadlines. Research is awaited serially inside the alarm; the next alarm is scheduled only after the work finishes. Running exits first improves ordering, but a long request can still delay all subsequent software-stop checks. The configured 30 seconds is not a hard bound.

**Repair:** bound individual requests and the total research cycle, keep position supervision independent from research work, and reconcile ambiguous order submissions rather than blindly retrying them. Determine broker-native protection separately. Overnight gaps and closed-market periods remain exposure even with software deadlines.

### P2 — Catalyst classification admits negative and unconfirmed events

Location: `src/strategy/default/helpers/catalyst.ts:64–77`; assignment to tickers in `src/strategy/default/gatherers/news.ts:145–155`.

Direct execution of the classifier produced:

| Headline | Actual classification |
|---|---|
| Company awaits PDUFA decision next week | regulatory / high |
| FDA approval denied for experimental drug | regulatory / high |
| Company did not meet primary endpoint | regulatory / high |

These are not confirmed favorable catalysts. In addition, the same classification is attached to every ticker tagged in a multi-company article, even where a ticker is a competitor or acquirer and the event concerns another issuer. A later adverse headline returning null does not invalidate an older positive cached catalyst.

The LLM may reject some such trades, but that does not make the deterministic catalyst gate trustworthy. It currently claims more verification than it supplies.

**Repair:** separate issuer, event date, confirmation status, direction and evidence. Explicitly handle negation and anticipated binary events; invalidate conflicting cached evidence. Add adversarial headline fixtures, not only positive phrase matches. Do not call a short-squeeze mention a verified change in company value.

### P2 — The nominal 1R trail is measured from the peak, not the initial risk distance

Location: `src/strategy/default/rules/exits.ts:71–83`.

A 1R trail is calculated as the initial stop percentage but compared with percentage drawdown from the peak. That is not a fixed dollar distance of one initial R.

**Reproduction:** entry $100; initial stop 15% means R=$15; activation peak at 1.5R=$122.50. A true one-initial-R giveback triggers at $107.50. Current code triggers at $104.125. The protected profit at activation is 0.275R, not 0.5R. The discrepancy grows with stop width and peak gain.

**Repair:** either calculate the trailing price from `peak - entryPrice * stopPct/100 * trailing_stop_r`, or explicitly describe the existing rule as a percentage-of-peak trail. Test exact prices and R outcomes at several volatility levels. Do not promise a locked-in floor across price gaps.

## Trader's assessment

### What is sensible

Equities-only paper operation, no automatic pyramiding, planned risk-based sizing, centralized entry checks, strict model-response schemas, liquidity filters, re-entry cooldowns, deterministic exits and a request allowance are useful controls. A catalyst-conditioned momentum hypothesis is more specific and testable than asking an LLM to find winners. These are improvements in structure; none establishes positive expectancy.

### What is overclaimed or mismatched

- **No return evidence:** 335 green tests prove neither positive expected return nor live execution quality. This account has no trades. Documentation discussing named-stock gate pass rates is not a timestamped, out-of-sample portfolio result.
- **Too many moving parts before validation:** sentiment, keyword catalysts, relative volume, price extension, 52-week distance, range position, LLM confidence, macro context, ATR stops, targets, trails and time exits were combined before isolating their incremental contribution. More filters can simply reduce opportunities and fit examples already inspected.
- **Risk budget is a plan, not a maximum:** $100,000 × 0.25% = $250 planned loss per trade. At a 5% stop that allows $5,000; at a 15% stop about $1,667. Five fully risk-sized positions total $1,250 planned stop risk, but correlated sector moves and gaps can exceed it. The 2% daily-loss gate blocks new risk; it does not flatten holdings or guarantee a 2% maximum drawdown.
- **Targets versus holding time:** a 15% stop sets a 30% target, while the time stop exits after five calendar days. It is an empirical question whether qualifying stocks reach that target often enough. Weekends count against holding time. Effective winners will often be time/trailing/model exits rather than the stated 2R target.
- **Exposure and rank:** five $5,000 positions cap initial deployment around 25% of this account, less with wide ATR stops. Expecting top absolute return while retaining substantial cash is a different objective from maximizing risk-adjusted quality. Raising leverage to catch a leaderboard does not create an edge.
- **Relative volume is crude:** latest-minute volume divided by the previous day's volume/390 is not time-of-day-normalized relative volume. Normal opening/closing volume can pass 1.5x while a meaningful midday surge fails. Use same-minute or cumulative same-time historical baselines if this is meant to measure unusual participation.
- **Macro protection is mostly context:** the configured `macro_events` list is empty, so scheduled-event blackouts have no events to act on. Proxy ratios in a prompt do not impose a deterministic sector/correlation or event-risk limit.
- **Cost model:** request counts are not bills. Model configuration now uses `openai/gpt-oss-20b`, while the harness's hard-coded cost mapping must be checked against the actual provider. API keys are present; no paid model call was made in this review.

### Expectancy must be measured net of costs

Use `P(win) × average win − P(loss) × average loss − execution and operating costs`, using actual observed exits rather than the configured target. Illustratively, 35% wins at 2R and 65% losses at 1R yield just 0.05R gross. At $250 risk this is $12.50 before costs. A stationary 30-bps full spread on $5,000 costs about $15 for an ask-to-bid round trip relative to unchanged midprice, before additional slippage and model/hosting costs. This is arithmetic, not an estimate of this strategy's win rate or future returns.

Alpaca explicitly says paper trading omits effects including latency slippage, market impact and some costs, and can simulate fills beyond displayed liquidity. Thus paper rank or balance is not spendable trading profit and does not validate live profitability. Source: https://docs.alpaca.markets/us/docs/paper-trading . No leaderboard payout mechanism was verified in this review; official syncing was previously reported paused, and the site yielded no readable status during this review.

## What I would do next

1. Fix and regression-test the four P1 execution/data defects before enabling unattended paper operation.
2. Correct catalyst semantics and trailing-R math. Freeze a named, hashed profile; stop adding indicators until there is baseline evidence.
3. Run read-only shadow decisions with fresh market data and record the entire candidate funnel, rejected reasons, timestamps, model responses, feed identity and hypothetical executable prices.
4. Exercise order lifecycle behavior in paper with explicit fill reconciliation, then collect forward results across enough trades and varying sessions to estimate uncertainty. Compare with cash and an exposure-matched benchmark over identical dates.
5. Compare the complete strategy with a simpler non-LLM baseline and remove modules that do not improve held-out net results. Report turnover, spread/slippage, realized R distribution, drawdown, sector exposure and operating costs.
6. Consider live capital only after evidence and operational reliability justify a separate decision. Do not use leaderboard pressure as a sizing rule.

No guarantee of profits, payout or leaderboard placement is supported by the current evidence.
