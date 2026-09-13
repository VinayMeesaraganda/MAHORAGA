# Final recommendation: guidance continuation implementation and evaluation

Updated September 12, 2026 from baseline `cd6ac8e`. Status: research specification with a shadow implementation, not a verified profitable strategy. See [implementation status and operating commands](guidance-continuation-status.md) for implemented behavior, local verification and remaining prerequisites. The paper harness remains disabled.

Recommendation revision: `2026-09-12-final-2`. This incorporates the accepted review: name the revenue-consensus-free challenger explicitly; begin evidence collection alongside execution verification; preserve the baseline exit alternatives; keep news adjudication bounded; and require paired, calendar-aware evaluation. Register evaluation dates and the implemented profile hash before collecting the evaluation sample. Data ingestion can start before that sample is registered.

## 1. Decision and economic hypothesis

Archive the current strategy and correct verified measurement/execution defects before freezing the comparison. Build one simpler challenger, named `guidance-continuation-v1`, and first evaluate it without broker orders. Keep broker reconciliation, deterministic protection, request budgets, authentication and emergency control. Preserve the baseline's target/trailing implementation for comparison; their deletion is not justified by the cited replay.

Revenue consensus is not currently a verified input to this deployment. V1 therefore requires a comparable EPS beat and an increase in the issuer's own forward revenue guidance, but does not require an actual revenue beat. Record revenue consensus as unknown when unavailable. Raised issuer guidance is not necessarily above market expectations. This is a different hypothesis from the original earnings-and-revenue-surprise conjunction, not evidence that revenue confirmation is unimportant.

The hypothesis is that some positive earnings surprises accompanied by improved forward guidance are incorporated into prices over several sessions. Buy only when the event is verified, the first regular session shows a positive response, and the remaining opportunity can be entered within risk and execution limits. This is a continuation hypothesis, not an attempt to predict the announcement or win a race to its first price change.

Research documents earnings underreaction and an attention-based explanation, which motivates investigation. It does not validate our universe, proposed entry time, stop, holding period, or ability to earn returns after costs. [DellaVigna and Pollet, NBER working paper](https://www.nber.org/papers/w11683)

Every numerical setting below is an initial engineering or research choice. None is claimed to be optimal. Freeze them before evaluation; do not tune them to the most recent chart.

The initial universe deliberately excludes non-guiders and companies with incomparable earnings metrics. This creates coverage and sector biases that must be reported. Do not generalize its findings to all stocks or silently admit missing-data cases.

## 2. What stays, what changes

| Component | Current setup | Challenger decision |
|---|---|---|
| Thesis | Multiple catalyst types plus sentiment | One verified earnings-and-guidance event |
| Selection | Social signals, technical gates and LLM BUY verdict | Explicit event qualification and first-session response |
| AI | Research, discretionary recommendations, recent-results feedback | Evidence extraction; uncertain extractions go to review |
| Sizing | ATR risk cap; some paths also use confidence/cash percentage | One deterministic whole-share calculation |
| Exits | Target, trail, gap capture, time, adverse news and discretionary sells | Initial protective stop, fixed session horizon, verified thesis invalidation |
| Extras | RSI, 52-week location, relative volume, insider activity, social feeds | Log as research features; do not gate this version |
| Evaluation | Realized trades and hypothesis buckets | All candidates, same-entry exit replay and full portfolio simulation |

The current strategy remains a frozen comparison. Do not slowly transform it into the challenger and then describe the resulting record as one unchanged strategy.

### Give each input one job

| Input | Role in v1 | What must wait for evidence |
|---|---|---|
| Earnings and guidance news | Verify the economic catalyst and its novelty | Adding unrelated catalyst families |
| Held-position news | Identify verified changes to the original thesis | Broad sentiment-driven automatic selling |
| Technicals | D0 price response, entry distance and volatility-based risk | RSI, moving-average or 52-week gates |
| Volume | Enforce dollar liquidity; record event participation | Relative-volume entry thresholds |
| Macro | Scheduled-event entry blackout and exposure context | Directional macro predictions or dynamic risk multipliers |
| Free cash flow and balance sheet | Record earnings quality and financing context; route explicit adverse disclosures for review | Mandatory positive FCF, valuation cutoffs or quality-based sizing |

Do not combine these into an arbitrary weighted score. Several measurements describe the same event response; counting them as independent confirmations exaggerates the evidence. Qualification, execution safety and optional research features have different missing-data rules, defined below.

## 3. Data is the first implementation milestone

### Required event record

Store immutable versions, with at least:

- Issuer identifier such as CIK, ticker and share class, fiscal period, currency and units.
- Provider event ID and a stable issuer/period event key; news copies do not create extra events.
- Actual publication time, first time our system observed it, ingestion time, and any correction time.
- Source document URL, content hash and exact excerpts supporting every extracted number.
- Actual EPS and revenue; matching pre-announcement consensus; consensus observation timestamp and contributing estimate count if available.
- Accounting basis for each number: GAAP versus adjusted, diluted versus basic, and fiscal period. Never compare mismatched bases.
- Prior and new forward guidance, including range endpoints, metric, basis and period; store the old published guidance source as well.
- Extraction version, model version if used, validation status, and reasons for missing or disputed values.

SEC submissions and XBRL APIs provide filing history and reported financial facts. They are not a historical analyst-consensus service, and XBRL does not eliminate the need to inspect release text and accounting context. [SEC API documentation](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)

### Source contract

Use issuer releases and SEC filing exhibits for reported results and guidance. A separately verified data source must supply point-in-time consensus for the exact metric and fiscal period. Check coverage, timestamps, revisions, storage rights and cost before choosing a provider; no provider subscription is assumed by this plan.

If historical EPS consensus is unavailable, collect it prospectively. Do not query today's consensus for a past event, use the LLM's recollection, or treat a headline saying "beat" as a numerical substitute. The named guidance-continuation experiment explicitly omits the revenue-consensus gate; missing EPS consensus still rejects an entry. A strategy omitting EPS surprise too would require another registration.

For a backtest, a fact is usable only after its documented availability time plus a conservative ingestion delay. For the forward system, use the actual first-observed time. Preserve corrections as new versions. Recompute future decisions when corrected, without rewriting what the system knew at a past decision.

Initially reject zero or negative consensus EPS from percentage-based ranking, or use a separately specified normalization. Near-zero EPS denominators can turn trivial dollar differences into enormous percentage surprises. The first implementation can rank on guidance revision instead and use EPS only as an actual-greater-than-consensus qualification.

### News: discovery, position monitoring and context

Use three separate workflows. Discovery searches for the earnings-and-guidance event allowed by this strategy. Position monitoring searches for new information affecting every held issuer, even when it belongs to a different event category. Market and sector news supplies context and links to scheduled events; it does not expand the entry rulebook.

Alpaca's historical news documentation identifies Benzinga as its news provider. Use that feed for discovery and backfill, while verifying quantitative earnings and guidance claims against issuer releases or filings. Confirm actual account access and coverage before implementation. [Alpaca historical news documentation](https://docs.alpaca.markets/us/docs/historical-news-data)

For each potentially actionable item, record:

- The affected issuer and its role: subject, customer, supplier, competitor or incidental mention. A ticker tag alone is insufficient attribution.
- Event time, publication time, first observation, updates and corrections. A newly syndicated article may describe an old event.
- Original source and supporting excerpts; distinguish issuer/official disclosure, attributed reporting, opinion and rumor.
- What changed from the previously known facts or expectations, the magnitude and period of that change, and the unresolved comparisons.
- Related article IDs and a stable event key. Ten copies of one release are one event, not ten independent confirmations.
- The predefined rule the evidence could affect, the adjudication result and its author/version. Extraction certainty is separate from the likelihood of a profitable trade.

Use issuer releases, SEC filings and relevant official announcements as primary evidence. News reports can prompt verification. Social posts, anonymous rumors and headlines without supporting detail cannot establish a qualifying earnings event. Positive wording is insufficient: a company can report growth while missing expectations or reducing guidance.

Prioritize held issuers in the ingestion queue. Persist the last successful cursor and covered time interval, paginate through the entire interval, overlap backfills and deduplicate versions. A fixed first page of recent articles cannot establish complete coverage. Save fetch failures, lag and unresolved gaps; a successful empty response means only that the requested source returned no items in that interval.

Capture or backfill overnight and premarket disclosures before the next entry decision. Continue monitoring throughout the holding period, rather than only around new trade selection. Data ingestion outside market hours does not authorize outside-hours orders. Streaming is optional; reliable recovery and demonstrated coverage are mandatory.

On a corrected release, preserve the prior version and reassess affected pending intents and positions. Cancel or exit only through the coordinated execution path. Deterministic stops and scheduled exits must run before expensive news analysis and must survive a failed source or model call.

### Free cash flow: assess the quality behind the reported beat

Build a point-in-time fundamentals panel from the latest information actually available at the decision. Record operating cash flow, capital expenditure, trailing-four-quarter FCF and FCF margin; comparable revenue growth; cash, debt and disclosed near-term maturities; working-capital movements; stock-based compensation and diluted share-count change. Keep missing fields explicitly unknown.

Use operating cash flow minus capital expenditure as the baseline FCF calculation, with capex stored as a positive outflow. Store the issuer's adjusted definition separately with its reconciliation. FCF has no uniform definition and is not necessarily cash freely available for discretionary spending. [SEC non-GAAP guidance, Question 102.07](https://www.sec.gov/rules-regulations/staff-guidance/corporation-finance-interpretations/non-gaap-financial-measures)

Convert cumulative year-to-date cash-flow statements into discrete quarters before summing four quarters. Preserve fiscal periods, units and source availability; never sum overlapping year-to-date totals. Compare seasonal businesses with comparable prior-year periods. If the latest earnings release precedes the cash-flow statement, retain the older available observation with its age rather than importing a subsequently filed number.

The research question is whether the earnings improvement is accompanied by durable cash generation or depends on adjustments, working-capital timing, financing or dilution. Negative FCF alone does not distinguish expansion investment from operating weakness. Positive FCF alone does not establish attractive valuation or a useful entry date. Avoid applying an industrial-company FCF interpretation to banks and insurers; mark that interpretation inapplicable pending a separate sector method.

In v1, this panel does not change ranking, size or eligibility merely because FCF is missing or negative. Explicit disclosures of financing distress, restatement or withdrawal of the supporting guidance enter the adverse-event review process. A generic “low quality” model verdict does not. Test an FCF-quality filter later against all eligible candidates, including those it would reject, with matching capital constraints.

### Missing information is not one universal state

| Condition | Required behavior |
|---|---|
| Missing/mismatched actual EPS/revenue, EPS consensus or guidance | No qualifying entry |
| Missing revenue consensus | Record unknown; the registered guidance challenger does not require this gate |
| Missing valid quote, liquidity, sector or broker reconciliation | No new entry; reconcile or repair the dependency |
| Required news interval or scheduled-event calendar has unresolved coverage gaps | Block new entries until restored; continue protection and monitoring |
| Valid news fetch returns no items | Record source and coverage interval; do not claim absence of adverse information everywhere |
| Missing FCF or optional relative-volume feature | Record unknown; no invented neutral value or extra rejection |
| Material potentially contradictory disclosure remains unresolved | Hold the affected candidate for review; an existing position keeps its deterministic protection |

Define and test source-specific freshness limits, ingestion coverage checks and retry budgets before the shadow run. Record them in the experiment manifest. Review decisions need evidence, a fixed rubric and an audit trail; discretionary overrides cannot be mixed into the unmodified strategy results.

## 4. An exact first rulebook

### Universe

Use US-listed common stocks on permitted exchanges, broker status active and tradable, price at least $10 and completed-session ADV20 of at least $50 million. ADV20 is the mean of traded dollars over the latest 20 completed regular sessions from a consistent consolidated feed. Missing history rejects a candidate.

Exclude options, leverage, shorts, ETFs, warrants and OTC securities from this experiment. An explicit security-type mapping is needed; exchange membership alone does not identify common stock. Save the universe as it existed on each evaluation date, including securities that later delist.

Require a reliable sector mapping for sector limits. Missing sector classification means no entry in v1. Do not ask the model to guess an industry from a company name.

### Event qualification

All of these must be true:

1. Actual EPS exceeds the comparable pre-announcement consensus.
2. Actual revenue is disclosed for the matching fiscal period. Revenue consensus is recorded when available, but does not qualify or reject this version.
3. The midpoint of forward revenue guidance increases from the previous published midpoint for the same fiscal period and basis. Mere repetition of guidance is insufficient.
4. No known simultaneous event explicitly contradicts the long thesis, such as a material guidance withdrawal, accounting restatement, or announced dilutive capital raise. This check records evidence and provenance rather than relying on a broad negative-word blacklist.
5. Each required input is valid and was available before the entry decision. Ambiguous comparisons remain in a review queue.

This narrow conjunction may produce few trades. That is a result to measure, not a reason to loosen thresholds during the experiment. Revenue guidance is the initial ranking metric; companies giving only EPS guidance are excluded rather than compared on an incompatible scale.

### Session timing

Use the broker exchange calendar, with America/New_York local times and early-close support.

- D0 is the first regular session opening after an outside-hours earnings release. Exclude intraday releases in v1 to avoid mixing different reaction windows.
- D1 is the next trading session after D0. Weekends and holidays are not sessions.
- Require all event evidence to be validated before the D1 evaluation. Late discovery does not permit a D2 or later catch-up entry in this version.
- Evaluate once at 10:05 ET on D1; allow order initiation only until 10:10 ET. Persist the decision ID so restarts cannot cause repeated evaluation or entry.
- Require D0 close above the preceding regular close and at or above the midpoint of D0's regular-session high and low. Missing or zero-range bars reject the setup.
- Reject an entry ask more than one completed daily ATR above D0 close. This is a proposed anti-chasing rule, not a scientifically established boundary.

The D1 choice deliberately trades off missing some early continuation against complete D0 information and simpler timing. A D0 entry is a later challenger, not an informal exception. Ensure the D0 bar is a regular-session bar: a provider's daily bar may have different session coverage, which must be checked before using it.

### Technicals and volume without redundant gates

The enforced technical rules are the D0 response, entry-distance limit and ATR-based stop/size. Record sector-relative price performance, moving-average location, RSI and distance from prior highs for later analysis; none adds a vote to the first version.

Dollar liquidity is enforced. Event participation is initially observed:

```
D0 relative volume = D0 regular-session volume
                     / mean regular-session volume over the prior 20 sessions

D1 volume pace = cumulative regular-session volume through 10:05 ET
                 / mean volume through the same cutoff over prior comparable sessions
```

Exclude D0 from its own reference average. Use consistent feed coverage, session boundaries and corporate-action treatment in numerator and denominator. Handle early-close comparability explicitly. If matching intraday history is unavailable, D1 volume pace is unknown; do not divide partial-session volume by a full-day average or mix IEX volume with consolidated volume.

Higher volume describes participation, not proof of institutional buying or future gains. Log it together with price response. A threshold such as 1.5 times normal volume belongs in a later registered comparison, not an assumed requirement for profitability.

### Macro: event timing and portfolio exposure

For the initial challenger, use a fixed no-new-entry window from 30 minutes before until 30 minutes after each scheduled US CPI release, Employment Situation release, FOMC policy announcement and scheduled Fed Chair post-meeting press-conference start. Union overlapping windows. This is a reproducible starting parameter, not evidence that market risk ends after 30 minutes.

Load verified dates and timestamps from the [BLS release schedule](https://www.bls.gov/schedule/) and [Federal Reserve meeting calendar](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm), following official event details for exact times and retaining source versions and timezone conversion. An empty configuration is not proof that the calendar has no events. A failed or stale required calendar blocks new entries; protective and scheduled exits continue. If a blackout overlaps the 10:05–10:10 entry window, skip that day's affected decision rather than queueing it outside the defined window.

Record broad-market and sector returns, volatility observations and relevant rate/commodity context at the decision. Label proxies accurately and timestamp each observation. Do not describe an ETF price as the underlying index, yield or commodity spot price. These contextual observations do not change v1's fixed trade risk, sector caps or ranking. Macro-based size changes would be a separate hypothesis.

### More candidates than capacity

Freeze eligible candidates at evaluation time. Rank by percentage increase in forward revenue-guidance midpoint, then ADV20, then stable issuer ID. Only compare guidance for matching periods within each issuer. Use strict positive denominators and reject invalid values. Record the entire queue and reason for each selection or capacity rejection.

One position per issuer and one entry attempt per event. No averaging down or reopening after a stop on the same earnings event. Manual overrides create a separate record and are excluded from the frozen strategy sample.

## 5. Risk sizing and portfolio controls

Suggested paper-research limits:

| Limit | Initial choice | Meaning |
|---|---:|---|
| Planned risk per trade | 0.125% of current equity | $125 at $100,000 equity |
| Single-name purchase value | 5% of equity | $5,000 at $100,000 |
| Total gross purchase exposure | 25% of equity | At most $25,000 initially deployed |
| Positions | 5 | Includes reserved opening intents |
| Sector exposure | 10% of equity and at most 2 names | Reduces one-sector concentration |
| Total initial open risk | 0.625% of equity | Sum of remaining initial stop risk, conservatively reserved |
| Existing daily equity-loss gate | Preserve 2% | Blocks new risk; does not automatically liquidate |
| Separate experiment pause | 3% strategy-equity drawdown from its high | Pause new entries and investigate; existing protection continues |

These are proposed challenger limits. Existing policy limits may be stricter and always win. Persist a distinct experiment pause; neither a midnight rollover nor a model decision clears it. Resumption is an explicit operator decision. Separate account-wide losses from the challenger ledger when other activity shares the account.

The initial stop distance is the larger of 2.5 daily ATR(14) and 1.5% of the reference entry price. Use completed, split-consistent bars available at D1. If the required distance exceeds 8% of entry price, skip the setup rather than clipping the stop inside its intended volatility allowance. This is an initial research parameterization, not a loss guarantee.

Before submission, fix a stop price S from the reference price and distance, and a maximum acceptable entry limit L. For long entries, size against the worst permitted fill:

```
equity_risk_dollars = current_equity * 0.00125
per_share_risk = L - S
quantity = floor(min(
  equity_risk_dollars / per_share_risk,
  single_name_capacity / L,
  gross_capacity / L,
  sector_capacity / L,
  available_cash / L
))
```

Also enforce remaining portfolio-risk capacity divided by per-share risk and all independent policy checks. Reject invalid or nonpositive quantities/prices. Round prices to supported ticks before calculating size. Reserve cash, exposure and risk before sending the order; release only after broker-confirmed termination or fills.

Example: equity $100,000; L=$100; S=$95. Risk allows 25 whole shares, costing at most $2,500 and planning $125 loss at the stop. At S=$97, 41 shares plan $123 risk. The dollar allocation changes with the stop; an LLM confidence score does not change it.

Initial R is based on confirmed weighted-average fill and the original stop. Save planned R and fill-based R separately. Never rewrite initial R when a stop changes. Pending partial fills reserve risk for both held shares and the remaining order. Sector caps help but cannot eliminate cross-sector correlations; add explicit gap stress reports rather than assuming five names are independent.

## 6. Execution and protection

Retain the fresh-snapshot and session checks. Current IEX quotes are single-venue observations, not consolidated NBBO; completed SIP history does not establish a live SIP subscription. Use the feed label in every record. Reject stale, crossed, zero-sized or otherwise unusable quotes.

Proposed entry policy: a marketable DAY limit, rounded to permitted ticks, at no more than five basis points above the current ask and never above the price used to approve risk. If a fresh price cannot meet that cap, skip. Submit one attempt, cancel any remaining entry after 60 seconds or the entry-window end, whichever comes first. Cancellation acknowledgement is not cancellation confirmation. Do not replace a potentially live order after a timeout.

A limit controls the maximum purchase price but may not fill. Broker-native stops also do not guarantee a fill at the trigger price. Alpaca's linked order types have constraints; in particular, bracket exit legs activate after the parent is completely filled. [Alpaca order documentation](https://docs.alpaca.markets/us/docs/orders-at-alpaca)

Prefer a broker-held initial stop using a tested quantity-based protective-order design. An OTO entry with only a stop leg is a candidate, not an assumed working implementation. Verify account support, partial-fill behavior, cancellation relationships and order replacement using mocks plus a controlled paper acceptance test before unattended entry.

The mandatory failure policy is explicit: if any position quantity lacks confirmed protection, block new entries, cancel its unfilled parent remainder, reconcile all related orders, and protect or flatten the residual quantity through one coordinated execution owner. Never send competing liquidation and protective sells that could create an unintended short.

The legacy `broker.buy(symbol, notional, reason)` cannot express whole-share limit entries with attached protection. The implemented optional `buyProtected` contract and protection-aware reconciliation address that interface, but production entry remains gated pending pilot acceptance. Do not bypass PolicyBroker or classify a protective exit as an unresolved opening order.

Use a persistent state machine with intent, client order ID, broker order IDs, cumulative fills, cancel status, protected quantity and reconciliation timestamps. Process trade updates idempotently and use broker reads for reconnect recovery. A submitted or canceled HTTP request is never final fill truth.

Keep software monitoring in addition to the broker stop. A sleeping laptop is inadequate supervision for unattended positions; reliable hosting and recovery are operational milestones, not optional strategy features. No protective order eliminates overnight gaps, halts, or venue outages.

## 7. A small, explicit exit policy

For the first challenger:

1. Initial protective stop, never widened to avoid realizing a loss.
2. Time exit ten trading sessions after entry, counting entry session as one; submit at five minutes before that session's calendar close. Cancel/reconcile the protective order through the execution coordinator before closing the remaining quantity. Handle early closes and halts explicitly.
3. Thesis invalidation only on verified new information such as withdrawal/reversal of the guidance supporting the trade. A model can extract a source-backed candidate event, but cannot invent or independently authorize it. Encode objective cases as source-backed deterministic rules; cases requiring interpretation need a recorded operator adjudication. Ambiguous news escalates while price protection remains active. An unattended run therefore cannot assume discretionary news cases will receive immediate resolution.

No fixed profit target, gain-based gap capture, trailing overlay, ordinary LLM SELL, or loss-history adaptation in this challenger. These are alternative exit hypotheses to measure on the same entries. They remain available in the archived baseline.

Ten sessions is a research choice, not a claim that this is the optimal earnings-drift horizon. The comparison must show whether holding longer just adds market exposure or improves event-related returns.

## 8. AI's useful role

Give the model bounded extraction tasks: identify the issuer and reporting period; extract results and old/new guidance; preserve exact quotes and source locations; flag inconsistent units and accounting bases; classify uncertainty. Code verifies arithmetic, timestamps, source membership and schema.

Separate extraction confidence from expected return. An accurate reading of an earnings release does not imply a profitable trade. Do not convert model confidence into capital allocation.

Cache extraction by source ID, complete content hash, update timestamp, prompt/schema version and model version. Re-extract revisions. Bound input size, calls and latency. Do not let external documents issue operational instructions. A timeout leaves an unqualified event, not a guessed approval.

Keep performance analysis outside the frozen decision prompt. Record proposed adaptations as new experiments; do not let recent losses silently change which otherwise valid events are admitted.

## 9. Records and comparison design

Persist all observed events, not only executed trades. Each decision stores its eligibility vector, rejection reasons, source versions, feature values, reference quotes, strategy/profile hash and intended entry/exit policy. Store raw evidence separately from interpretations.

Keep three views distinct:

- Broker ledger: actual orders, fills, remaining positions, realized/unrealized P&L, cash flows and corporate actions.
- Candidate replay: what predefined alternative rules would have done to the same timestamped opportunities.
- Portfolio replay: those rules under shared capital, sector, risk and concurrent-position constraints. Independent trade results cannot simply be summed into an executable portfolio return.

If only one physical paper account exists, run one broker-connected strategy and simulate alternatives in separate ledgers. Two strategies should not co-own an aggregate Alpaca position without an allocation layer. Clearly label simulated comparisons; do not describe them as actual fills.

For exit comparisons, hold entries fixed. For gate comparisons, include the candidates rejected by the gate and simulate the whole portfolio under both rules. Sorting completed trades by their eventual exit cause introduces selection bias and does not answer which exit caused better performance.

Use timestamped historical universe and events, delisted names where available, corporate-action consistency, commissions/fees applicable to the account, spread and slippage assumptions. With daily OHLC, intraday order of stop/target touches is unknown; use finer data or a stated conservative rule. A simulated limit is not automatically filled merely because a bar touched its price.

Use at least three assumed round-trip cost scenarios, for example 10, 25 and 50 basis points, alongside measured paper execution. They are stress assumptions, not predictions of actual costs. Alpaca paper simulation excludes several live execution effects, including market impact and latency slippage. [Alpaca paper-trading documentation](https://docs.alpaca.markets/us/docs/paper-trading)

Transaction costs deserve explicit modeling: institutional live-trade research finds implementability depends on strategy and trading-cost optimization. That finding does not establish our costs or edge. [AQR trading-cost research](https://www.aqr.com/Insights/Research/Working-Paper/Trading-Costs-of-Asset-Pricing-Anomalies)

## 10. How to decide whether it works

Publish weekly operational results and pre-scheduled statistical reviews. Do not continuously search for a favorable stopping date.

Report net daily returns, drawdown, gross/sector exposure, turnover, fill and rejection rates, data coverage, realized mean/median R, payoff ratio, tail losses, and contribution from the largest winners. Show all trades and the effect of removing the top few winners as sensitivity, not as permission to discard observations.

Compare with cash and broad-market returns. Also create a diagnostic benchmark using prior-known strategy exposure and matching market/sector returns over the same windows. Label that as an attribution benchmark rather than a directly investable strategy unless it has its own executable allocation rules.

A simple expectancy calculation is:

```
net expectancy in R = win_rate * average_win_R
                    - loss_rate * average_loss_magnitude_R
                    - incremental_cost_R
```

Use net fills without subtracting included costs twice. A nominal 2R target does not enter this formula unless winners actually realize 2R.

Correct the sample-size interpretation in the existing hypotheses. In the approximate formula `n per group = 16 / d^2`, d is a standardized effect (mean difference divided by outcome standard deviation), not a raw R difference unless standard deviation is exactly 1R. For a desired 0.5R difference with 2R standard deviation, d=0.25 and the rough requirement is 256 per group before dependence and other complications. Reaching a preset count and seeing one mean exceed another is not evidence of significance.

Use confidence intervals for paired strategy differences and resampling that respects clustered calendar periods and overlapping holdings. Restrict the number of comparisons. For historical data, separate development and untouched later periods; purge overlapping trade windows at split boundaries. After inspecting a holdout, it is no longer untouched for the next revision.

Promotion criteria must be written before the sample is inspected: reconciled records; credible data coverage; no unresolved operational incidents; positive net expectancy under the declared base costs; acceptable tail losses; improvement on the chosen comparison with uncertainty reported; and no dependence solely on one exceptional event or one market regime. If uncertainty remains wide, the decision is "not established," not "profitable."

Twenty sessions is an operational shakedown, not a statistical proof. Sparse event strategies can require many months of forward observations. Good point-in-time historical data can accelerate research, but cannot replace forward execution checks.

## 11. Repository implementation map

The following map describes the intended complete system. The [status document](guidance-continuation-status.md) distinguishes implemented shadow functionality from pilot prerequisites. None of these paths is itself a live configuration key.

| Work | Location or integration point | Acceptance criterion |
|---|---|---|
| Typed event schema | `src/schemas/earnings-event.ts` | Rejects mismatched basis, stale/missing consensus and future availability |
| Earnings and consensus adapters | `src/providers/earnings/` | Versioned evidence and provenance; no secret exposure |
| News coverage and held-issuer monitor | Existing news providers plus proposed ingestion ledger | Complete pagination/backfill, issuer attribution, deduplication, corrections and explicit coverage failures |
| Fundamentals panel | Proposed point-in-time fundamentals adapter | Non-overlapping quarterly cash flows, definition reconciliation and missing-data semantics |
| Scheduled-event calendar | Proposed verified calendar adapter and strategy entry check | Versioned official timestamps, blackout boundaries and fail-closed entry checks |
| Event/candidate/fill ledgers | New D1 migrations and queries | Idempotent event versions, decisions and fills; immutable historical decisions |
| Challenger strategy | `src/strategy/guidance-continuation/` | Pure qualification, ranking, entry timing and exits |
| Strategy-independent market validation | `src/core/execution-market.ts` | Freshness/liquidity checks do not force old LLM BUY/sentiment gates on the challenger |
| Entry intent and protection | `src/core/policy-broker.ts`, Alpaca trading adapter and provider types | Limit/quantity/protective orders through policy; crash/cancel/partial-fill recovery |
| Scheduling | Harness only for execution and scheduling invariants | Calendar-based once-per-event decision; exits survive research failure |
| Replay and reports | Separate offline evaluator | Same-entry and constrained-portfolio comparisons with costs |
| Versioned experiment | `config/guidance-continuation-v1.json` and strategy `config.ts` | Shadow manifest and executable fixed settings; not an agent-config patch |

Inspect actual strategy selection and shared defaults before wiring the challenger. The existing generic interface still accepts research objects and confidence, while sizing and market checks import default-strategy helpers. Refactor only the contracts needed to avoid fabricating a BUY research result or a confidence score just to satisfy the old pipeline.

Do not place hypothetical keys in the live JSON and assume they work. Agent configuration must pass its schema and be applied to the Durable Object; policy environment values remain a separate layer. When existing positions exist, freeze their original risk policy through exit instead of applying the new strategy retroactively.

## 12. Delivery sequence and stop conditions

1. **Archive, correct and verify.** Record current commit/profile hash; repair verified defects while preserving baseline exit alternatives. Test restart with pending orders and open positions using mocks. Confirm exact broker equity/positions through read-only checks before any pilot. Start step 2 alongside this work; a successful trading session is not a prerequisite for a no-orders ledger.
2. **Build event evidence and candidate logging.** Deliver auditable examples of comparable actual/consensus/guidance values and rejected malformed events. Include held-issuer news coverage, correction handling, a verified macro calendar and the optional fundamentals/volume panel. Freeze source freshness limits and review rules. This can proceed before any new trading path exists.
3. **Build offline deterministic rules and replay.** Produce candidate decisions from stored inputs with no LLM trade verdicts. Verify no future data enters a decision.
4. **Implement execution protection.** Extend policy and provider contracts, then test lifecycle behavior before connecting strategy entries. Keep the pilot disabled until partial fills and protective-order reconciliation are covered.
5. **Shadow the challenger.** Compare opportunities with the frozen current strategy. Start the first 20-session operational report without calling this proof of edge.
6. **Controlled broker-connected paper pilot.** Only one strategy owns each account position; retain history, record the switch date and read back settings. No automatic move to live trading or larger risk follows from this guide.
7. **Pre-scheduled decision.** Keep, simplify, reject or continue gathering evidence based on the registered criteria. Change one strategy dimension at a time; code correctness fixes are separately versioned and disclosed.

Behavioral tests must cover holiday/early-close timing, release and correction availability, universe/sector gaps, rank ties and capacity, invalid prices, tick rounding, partial fills, timeouts with unknown outcome, cancellation races, restart recovery, duplicate fill events, stopped research, and exits while entries are blocked. Run `npm run typecheck` and `npm run test:run` for implementation changes; build the dashboard if it changes.

Also cover paginated news gaps, syndicated duplicates, incorrect issuer attribution, stale calendars, blackout boundaries, cumulative cash-flow conversion, unavailable optional features and contradictory news awaiting review. A source outage must never become a fabricated clean bill of health or suppress a mandatory exit.

If event coverage is poor, fix the source or stop the experiment. If the strategy is unprofitable after realistic costs, reject it rather than increase size. If it produces too few independent events, narrow the research questions before adding more unrelated signals. The first deliverable worth building is a trustworthy event-and-decision ledger; every later decision depends on it.
