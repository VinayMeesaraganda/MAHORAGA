# Runtime improvements — September 11, 2026

This document supersedes the initial runtime findings where noted.

## Active paper profile

`config/paper-baseline.json` retains $2,500 per position, five positions, 5% cash sizing, 5% stop loss, 10% profit target and equities only. Preparation begins ten minutes before the Alpaca-reported open. Data polling is two minutes and analyst/signal-research cadence is five minutes. Staleness exits are disabled pending dependable source history; deterministic stop/profit exits remain enabled.

The local Worker has `MAX_LLM_REQUESTS_PER_DAY=600`, raised from 300 on
September 11, 2026. Worst-case demand at the five-minute cadence is 479 calls
per market day (78 cycles x 5 signal-research calls, plus 78 analyst calls and
11 premarket), so the old cap was exhausted around 13:30 ET and the afternoon
ran without new entries. The cap is retained as a runaway guard, sized to the
workload rather than to a provider balance. The implementation defaults to the same limit if unset. This counts logical completion attempts across research, analysis and strategy-context calls, reserves/persists before sending, counts failures, and resets on a new America/New_York date. Provider-internal retries can add billed requests. It is not a dollar budget. Hitting it leaves deterministic exits running but causes further LLM calls to fail until reset. Current usage appears as `llmDailyBudget` in `/agent/status`.

## Implemented runtime changes

- Closed equity markets outside the preparation window skip data gathering, LLM work and position polling. The next alarm rechecks within one hour or at the preparation-window boundary, whichever comes first. Invalid/old next-open values retry in one minute. Crypto-enabled profiles retain their continuous loop.
- Equity strategy exits run before data fetching and LLM calls on each open-market alarm, independent of the five-minute analyst interval. Thirty seconds is a scheduling target, not a guaranteed maximum latency: work duration and API failures can delay a loop.
- The policy engine checks the larger of legacy recorded loss/equity and decline from broker `last_equity` to current `equity`. At a 2% previous-close decline, new policy-governed orders are blocked even if the legacy loss counter is zero. Invalid equity baselines fail closed. Broker position-close exits remain available.
- Enable returns HTTP 409 when Alpaca credentials or the selected LLM provider are absent. This checks configuration availability, not whether provider billing/authentication succeeds.
- StockTwits and Reddit requests time out after ten seconds. Access-denied/rate-limit responses are logged and not repeatedly retried in the same gather pass. Reddit stops its remaining subreddit requests on 403/429.
- Prompts explicitly retain missing news/fundamentals as unknown and avoid inventing catalysts from sentiment and price alone. These instructions improve evidence handling but do not replace schema/decision validation.

Alpaca documents comparing current equity with `last_equity` for change since the last market close: https://docs.alpaca.markets/us/docs/working-with-account . The guard is not cash-flow adjusted: deposits can hide trading losses, withdrawals can trigger the guard. Keep this paper account free of resets and transfers during an experiment. This is a new-order guard, not liquidation, an intraday peak-drawdown latch, or a repair of realized-fill cooldown accounting.

## Entry-gate and execution revision — September 11, 2026

Profile revision `paper-baseline` r2. Hypothesis under test: the previous profile
could not produce entries, and the gates that did exist were not the ones that
decide whether a social-momentum long is tradable. Forward results are not yet
available; nothing below is evidence of an edge.

### Defects corrected

- **The entry gate and the research prompt contradicted each other.** The gate
  rejected an entry if `red_flags` held any non-empty string, while the prompt
  asked the model "Any red flags?" and supplied a `red_flags` array. A competent
  model always names a concern, so the qualifying set was close to empty. Red
  flags are now classified deterministically in `rules/entry-quality.ts`:
  dilution and pending offerings, going-concern and delisting risk, fraud and
  regulatory action, trading halts, suspected manipulation, and a known earnings
  date inside the holding window disqualify on their own. Other concerns count
  against `entry_max_red_flags` (default 2, 0 restores the previous behaviour).
  The prompt now asks for disqualifying concerns only and puts generic caveats
  in `reasoning`.
- **StockTwits sentiment was structurally deflated.** The net of bullish and
  bearish tags was divided by the time-decayed weight of every sampled message,
  including the majority that carry no tag, so a unanimously bullish stream
  scored roughly its tagged share. `min_sentiment_score` was therefore
  unreachable in practice. Scoring now runs over tagged messages only, requires
  at least three of them, and reports `tagged_ratio` separately. The existing
  0.3 threshold now means what it reads as: a 65/35 bullish split among posters
  who expressed a view.
- **`min_price` and `min_avg_volume` in `PolicyConfig` were never enforced.** No
  check function referenced them. Liquidity is now gated in the strategy from
  data measured at research time, not asserted by the model.
- **Entry and peak price were only backfilled by `/agent/status`.** Positions
  record `entry_price: 0` at submission because the fill price is unknown then,
  and the sole backfill lived in the status handler. Any trailing or staleness
  logic silently saw a zero entry price unless something polled the dashboard.
  The backfill now runs in `selectExits`, on every open-market alarm.
- **No re-entry cooldown.** `onSell` cleared position entries but not
  `signalResearch`, so a stop-out could be re-bought on the next analyst cycle
  while the same research was still inside its freshness window. Exits are now
  recorded in `recentExits` and `reentry_cooldown_minutes` (default 120) blocks
  the re-buy.
- **Pre-market SELL recommendations were submitted for symbols not held**, which
  can only fail at the broker. They are now filtered against current positions.
- The two LLM-driven buy paths sized off `max_position_value` while
  `selectEntries` sized off `riskSizedNotional`. The broker capped both, so the
  divergence was latent; all three now use the same function.

### Tradability gates added

Derived in `helpers/market.ts` from the Alpaca snapshot that the research call
already fetches, so no additional requests are made. Each field is independently
nullable: unknown liquidity fails closed, unknown extension passes to the model.

| Setting | Default | Baseline | Rejects |
|---|---|---|---|
| `entry_min_price` | 3 | 5 | Sub-threshold share prices |
| `entry_min_dollar_volume` | 5,000,000 | 20,000,000 | Previous-session dollar volume too thin to exit |
| `entry_max_spread_bps` | 50 | 30 | Quoted spreads that consume the risk budget |
| `entry_max_extension_pct` | 10 | 7 | Names already run up against a fixed percentage stop |
| `entry_min_rel_volume` | 1 | 1.5 | Sentiment with no participation behind it |

Relative volume compares the current minute's volume with the previous session's
per-minute average, so it is not distorted by time of day. Dollar volume uses the
previous session's volume and VWAP.

### Exits added

- `trailing_stop_pct` (baseline 4): arms only after the position has been up by
  at least the trail distance, then exits on the same give-back from the peak.
  At equal arm and give-back distances this is a break-even protector, not a
  profit lock — it prevents the round trip from a gain back through the entry.
- `max_hold_days` (baseline 5): a deterministic time stop. Unlike the staleness
  score it does not depend on social history, so it applies while
  `stale_position_enabled` stays false.

Deterministic stop-loss and take-profit remain ahead of both, and all of them
still run before data gathering and paid research on each open-market alarm.

### Verification

Worker type checking passes and 253 unit tests pass, including new regression
coverage for red-flag severity, each tradability gate, unknown-field handling,
the re-entry cooldown, the trailing and time stops, entry-price backfill, and
StockTwits stream scoring. `npm run doctor` reports the paper account active at
$100,000 with previous close $100,000, and configuration FAIL for the absent
`OPENAI_API_KEY`. No orders were submitted and no paid model requests were sent.

### Provider quota, measured

The NVIDIA free tier is a throughput limit, not a credit balance: the signed-in
account page shows only "Your API Rate Limit - Up to 40 rpm", and the API
exposes no quota at all — no rate-limit response headers, and `/v1/credits`,
`/v1/account`, `/v1/usage`, `/v1/quota` and `/v1/billing` all return 404. The
key sees 82 models. Third-party reports of a 1,000-credit allowance were not
reproduced on this account and should not be relied on.

Peak demand is 11 requests inside one minute, during the premarket tick; the
research loop is sequential with 500ms sleeps, so the 40 rpm ceiling is not
approached. Measured usage from live calls on September 11: signal research 509
tokens in / 607 out, analyst 544 in / 401 out. The 607-token research reply
confirms the former 300-token budget would have truncated the JSON.

### Not addressed

Risk per trade stays at 0.125% of equity ($125 against a $2,500 notional), so
five concurrent positions risk 0.625% while the daily-loss guard trips at 2% —
the guard cannot be reached by trading losses alone. Stops remain polled rather
than resting at the broker, so there is no overnight or weekend gap protection,
and positions are still held overnight. Entries are still market orders, and the
pre-market plan still executes within `market_open_execute_window_minutes` of the
open, when spreads are widest. `src/providers/technicals.ts` remains unused. All
of these are posture and execution decisions rather than defects, and are listed
here so they are chosen rather than inherited.

## Model provider and response validation — September 11, 2026

Profile revision `paper-baseline` r3. The SUKUNA leaderboard is live and syncing
(observed last sync September 11, 2026, 20:15 ET, 15 agents, 1,766 trades), which
supersedes the paused-sync note in [competition](competition.md). Registration is
open and pulls performance from Alpaca by read-only OAuth, so the leaderboard
never contacts this worker.

### Any OpenAI-compatible endpoint, including NVIDIA's free tier

`OPENAI_BASE_URL` already redirected `openai-raw` to an OpenAI-compatible
upstream, but `createLLMProvider` truncated any `publisher/model` id at the
slash. NVIDIA NIM ids are always `publisher/model` and 404 without the prefix.
`resolveOpenAIModel` now strips only the `openai/` qualifier, and only when no
custom base URL is set. Behaviour against api.openai.com is unchanged.

The worker sends `state.config.llm_model`, not the `LLM_MODEL` environment
variable, so the model belongs in the agent profile. NVIDIA's free tier is
documented at roughly 40 requests per minute, well above this loop's sequential
cadence. NVIDIA advises `guided_json` over `response_format: {"type":
"json_object"}` because the latter permits any valid JSON, including `{}`. That
extension is not adopted here: it is provider-specific and OpenAI rejects unknown
parameters. The provider-neutral response validation below covers the same risk.

### The current free catalog is reasoning-first, which needed a code change

Verified against build.nvidia.com on September 11, 2026: 97 models, 36 with a
free endpoint. NVIDIA's own sample for `nvidia/nemotron-3.5-lightning-30b-a3b`
confirms `base_url=https://integrate.api.nvidia.com/v1` and the
`publisher/model` id, and sends
`extra_body={"chat_template_kwargs":{"enable_thinking":true},"reasoning_budget":16384}`
with `max_tokens=16384`, streaming `reasoning_content` separately from
`content`.

Thinking is billed against `max_tokens`. This harness caps signal research at
300 tokens and the analyst at 800, so a reasoning model with thinking enabled
spends the budget before emitting any `content`, and the schemas below then
correctly reject an empty reply. The agent would authenticate cleanly and never
trade.

The catalog has no Text-to-Text use-case filter; that string is a card label.
The usable set is reached by the Free Endpoint toggle (36 models) or the label
URL `/models?label=Text-to-Text`, which returns five, all free:
`nvidia/nemotron-3.5-lightning-30b-a3b`, `meta/muse-glimmer-30b`,
`google/diffusiongemma-26b-a4b-it`, `google/gemma-4-31b-it` and
`openai/gpt-oss-20b` (19M calls in 30 days, text-only, no extra body in its
sample). Every one of them is reasoning-capable and returns thinking in a
separate `reasoning_content` field, which this provider already excludes by
reading `message.content`.

The durable fix is budget, not model selection. `llm_research_max_tokens`
(default 2048) and `llm_analyst_max_tokens` (default 4096) replace the
hard-coded 300 and 800 in the prompt builders; NVIDIA's own samples use 4096 and
16384. `max_tokens` is a cap rather than a spend, so a non-reasoning model still
emits only what it needs and nothing about the OpenAI path gets more expensive.

Where a model exposes a thinking switch, `OpenAIConfig.extraBody` merges
vendor-specific fields into every request body,
populated from the `LLM_EXTRA_BODY` environment variable as a JSON object.
Core fields — model, messages, temperature, max_tokens, response_format — are
applied after the spread and always win, so the variable cannot rewrite the
request. Malformed values are ignored with a warning rather than disabling the
provider. For NVIDIA Nemotron set
`LLM_EXTRA_BODY={"chat_template_kwargs":{"enable_thinking":false}}`;
`openai/gpt-oss-20b` needs none.

This corrects the earlier claim that no code change was required: that held for
OpenAI-style completion models, not for the reasoning models that now make up
most of the free tier.

### Model output is validated before it can move money

`src/schemas/llm-responses.ts` validates every model-authored payload. Previously
the parsed object was cast and read directly, so an empty or off-spec reply
produced a `ResearchResult` with an undefined verdict and confidence. The gates
refused it, but by comparison against undefined rather than by design.

- Signal research must supply a documented verdict, a confidence in [0,1], a
  documented entry-quality label, non-empty reasoning, and string arrays.
  Failures are logged with the offending paths and no research is stored, so the
  entry gate reports missing research.
- Analyst recommendations are validated per item; malformed entries are dropped
  and counted rather than discarding the batch.
- Position research is validated against its documented enums.

### Position research is off by default

`position_research_enabled` defaults to false. Its output was written to state
and surfaced in `/agent/status`, but repository search found no entry or exit rule
reading it. At a five-minute cadence with five positions it consumed roughly 390
completion attempts per day against a 300-per-day cap, exhausting the budget
before midday and leaving no allowance for entries. The code path is retained.

### Diagnostics now authenticate

`npm run doctor` previously passed on the presence of a non-empty
`OPENAI_API_KEY` without ever contacting a provider, so a wrong or expired key
surfaced only at the first research call. It now mirrors what the harness
actually sends — JSON mode, the configured `llm_research_max_tokens`, and any
`LLM_EXTRA_BODY` — for each distinct configured model, and fails when the reply
is empty or unparseable, naming the reasoning-budget remedy. Authentication
alone was not a sufficient check: a reasoning model authenticates and returns
nothing usable. Secrets are redacted from provider error bodies before printing.
This still does not verify answer quality.

### Verification

Type checking passes and 268 unit tests pass, including model-id resolution under
a custom base URL, rejection of the empty object that JSON mode permits, per-item
recommendation filtering, and the position-research enum contract. `npm run
doctor` correctly reports `LLM provider: FAIL` while `OPENAI_API_KEY` is blank —
the condition it previously passed. Tests include vendor-field merging,
precedence of core request fields over vendor fields, and rejection of
malformed `LLM_EXTRA_BODY`. No provider key was added to this checkout,
so no authenticated model request has been made and the full research-to-order
loop remains unexercised.

## Reddit application-only OAuth — September 11, 2026

The gatherer requested `www.reddit.com/r/{sub}/hot.json` with a `Mahoraga/2.0`
agent. That host returns HTTP 403 from datacenter IPs and is capped near 10
queries per minute where it answers at all, so Reddit contributed no signals and
StockTwits was the only live social source.

`gatherers/reddit-auth.ts` obtains an application-only token from
`https://www.reddit.com/api/v1/access_token` using the `client_credentials`
grant with the script app's id and secret. No Reddit account password is
involved and the token carries no user context. Authenticated requests go to
`oauth.reddit.com` at roughly 100 queries per minute per client, averaged over
ten minutes; the gatherer polls four subreddits every two minutes, about two per
minute. Tokens are cached in the isolate and refreshed a minute before expiry.

Failures degrade rather than throw: a missing, rejected or malformed token logs
and falls back to the public host, so a credential problem cannot fail an alarm
cycle. `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` are optional; without them
behaviour is unchanged. `npm run doctor -- --sources` now performs the same
token exchange and reports which mode answered.

Reddit's free tier is limited to non-commercial use. Confirm that a leaderboard
entry qualifies before relying on it.

## Expectancy arithmetic for a monthly return target

Recorded because it constrains configuration rather than because it is a
prediction. At a 5% stop and a $100,000 account, reaching 2.5% a month requires
average wins near +8 to +10% at $5,000 positions and roughly one trade per
session; every combination at $2,500 positions or with average wins at or below
+4% is unreachable. Breakeven hit rates are 63% at +3% average wins, 56% at +4%,
45% at +6% and 33% at +10%.

This exposes a defect in the trailing stop added earlier the same day. With
`trailing_stop_pct` serving as both the arm threshold and the give-back
distance, a 4% setting caps average wins near +3 to +4% and therefore demands a
hit rate above 56% merely to break even. Splitting the arm threshold from the
trail distance is outstanding work; the parameter should not be treated as
tuned. No forward results exist for any of this.

## Evidence sources — September 11, 2026

Reddit self-serve app creation is closed. The Responsible Builder Policy states
that "approval is required" before any Data API access, and the non-commercial
path it describes is Devvit, which hosts apps inside Reddit rather than serving
an external process. A ticket can be filed but should not be depended on. The
gatherer keeps its OAuth support for whenever credentials arrive.

Three sources already reachable with existing credentials were activated
instead. StockTwits and the SEC 8-K feed were already working — the SEC
`getcurrent` feed returned 40 live filings when checked — so the starting point
was two sources, not one as previously recorded.

**Alpaca news** (`gatherers/news.ts`). Benzinga-sourced and symbol-tagged, so
headlines attach to tickers without regex-matching symbols out of free text.
Articles tagged with more than eight symbols are skipped as market wrap-ups.
Freshness decays linearly over a three-hour window; a 90-minute window went
empty on a quiet evening. Headlines are cached to `newsCache` and quoted in the
research prompt, which previously had no catalyst input at all despite
instructing the model to treat missing news as unknown.

**Alpaca most-actives** (`gatherers/most-actives.ts`). Volume-ranked rather than
the movers screener, whose gainers are dominated by sub-dollar names — one
observed at +124% on a $0.1887 price. Direction comes from the change against
the previous close, conviction from relative volume, via one batched snapshot
call. A price and previous-session-liquidity pre-filter runs in the gatherer so
untradable symbols do not consume paid research calls; spread and relative
volume are deliberately left to the entry gate, because quotes are zeroed while
the market is closed and that is exactly when the premarket plan builds its
list. Measured on a closed market: 40 screened, 8 rejected, 16 signals.

**Technicals**. `providers/technicals.ts` had no callers. ATR, RSI and the
20/50-day trend are now folded into `MarketContext` by `withTechnicals` and
described in the research prompt. ATR is expressed as a percentage of price so
it is directly comparable with the configured stop: a measured 2.9% daily ATR
means the 5% stop is about 1.7 ATR, while a name at 8% ATR would be stopped by
ordinary noise. ATR-based stop sizing is not implemented; only the reading is
surfaced.

### Defect found while wiring this

`getBars` requested a `limit` with no `start`. Alpaca defaults the bar range to
the current day and a limit only caps the response, so `{ limit: 60 }` on a
daily timeframe returned exactly one bar. Every indicator downstream reported
unknown, and the same call shape appears throughout `mcp/agent.ts` at limits of
60 and 250. `defaultStartFor` now derives a start covering the requested count
for day, week and month timeframes, leaves intraday and single-bar requests
alone, and never overrides a caller-supplied start. Verified live: the same
request returned 60 bars instead of 1, and ATR, RSI and trend populated.

## Macro awareness — September 11, 2026

Requested: track wars, political meetings, CPI, yields, oil and other macro
events, and pick stocks from them for multi-day holds.

The design decision is that the regime is **measured, not predicted**. Reading a
headline and asserting its implication ("CPI hot, therefore sell duration and
buy energy") inverts often enough to be worth less than nothing, and it
reintroduces exactly the unverifiable-claim problem the entry gates were built
to remove. Instead one batched snapshot of 23 liquid proxies records what the
tape actually did, and that measurement goes into the prompts.

`helpers/macro.ts` covers three rate proxies, four commodity proxies, the dollar
and a volatility proxy, three breadth proxies and all eleven sector SPDRs.
Derived: a risk reading that requires equities and volatility to agree (and
returns "mixed" when they do not), a yield direction inverted once from bond
prices so no call site has to remember the sign, and a ranked sector table.
Unknown inputs produce "unknown" rather than a guess. Measured live: risk-on,
yields flat, oil -2.19%, strongest Technology +1.31%, weakest Utilities -0.35%.

`gatherers/macro.ts` emits no signals; the regime is context, not a candidate.
Both the research and analyst prompts now carry it, and the analyst is told
explicitly that headlines describe what was published while the backdrop
describes what the market did with it, and to trust the backdrop when they
disagree.

The news gatherer additionally captures macro-topic headlines regardless of
symbol tagging — tariff and OPEC stories are often tagged with a long list of
names or none — under patterns covering central banks, inflation prints, labour
data, growth and yields, trade and sanctions, armed conflict, energy supply and
fiscal deadlines.

### Scheduled event blackout

`helpers/event-calendar.ts` blocks new entries inside a configurable window
before a scheduled release, via `macro_events` (entries of the form
"<ISO datetime> <label>") and `macro_event_blackout_minutes` (default 60). The
window closes at the event itself, after which the regime read takes over.

Exits never consult it: being unable to leave a position before a known event is
strictly worse than entering one. Dates are configuration rather than code
because they change annually and should not be asserted from memory. Malformed
entries are skipped rather than blocking every entry.

This does not attempt to trade the release. A CPI print is repriced in
microseconds; this loop polls every thirty seconds and then makes a network call
to a model. What is reachable at that latency is the drift over following days,
not the reaction.

### Options remain disabled

Requested alongside the above; not enabled. `executeOptionsOrder` calls
`alpaca.trading.createOrder` directly rather than going through
`createPolicyBroker`, so an options order is not evaluated by the policy engine
and is covered by neither the position cap, the daily-loss guard, the kill
switch, nor the shared entry gate. That is a structural gap, not a
configuration preference, and `AGENTS.md` requires separate policy review before
the path is used.

## Sizing and trailing decisions resolved — September 11, 2026

Both were left open across several revisions and are now settled. Profile
revision `paper-baseline` r4.

### Position size raised to $5,000

`max_position_value` 2500 to 5000 and `risk_per_trade_pct` 0.125 to 0.25, giving
$250 risk per trade, 25% deployed across five positions and 1.25% total risk at
the stop against a 2% daily guard that was previously unreachable at 0.625%.

Two further changes were required for that to take effect, and without them the
headline change would have done nothing:

- `position_size_pct_of_cash` 5 to 15. The sizing formula takes the lesser of
  the cash percentage and the risk cap; at 5% the cash term bound first and a
  nominal $5,000 position actually sized $3,250 at typical confidence, falling
  further as cash depleted. At 15% the risk cap binds, producing a flat $5,000
  until cash runs low enough to taper.
- `DEFAULT_MAX_NOTIONAL_PER_TRADE` 2500 to 5000 and `DEFAULT_MAX_POSITION_PCT`
  0.05 to 0.06 in the worker environment. The policy engine rejects any order
  above the notional limit, so every $5,000 order would have been refused. The
  position-percentage limit left a $5,000 order exactly on the line, where a
  fill a cent higher trips it.

Verified through the real code path: strategy sizing $5,000, risk at stop $250
(0.250% of equity), 25% invested and 75% cash at five positions, policy engine
ALLOWED.

### Trailing stop split into arm and give-back

`trailing_arm_pct` (6) is now separate from `trailing_stop_pct` (3). With a
single parameter serving both roles the exit landed near break-even, capping
average wins near the trail distance: at a +4% average win against a 5% stop the
break-even hit rate is 56%, and 2.5% a month was unreachable at any plausible
trade count. Arming at +6% and trailing 3% exits no lower than roughly +2.8%
while leaving a runner free to reach the 10% target; at a +6% average win the
break-even hit rate falls to 45%.

This is a change in expectancy structure, not evidence of profitability. At a
60% hit rate and +6% average wins the target still needs about 32 trades a
month, and no forward results exist.

## Volatility-normalised risk and a 52-week-high gate — September 11, 2026

Profile revision `paper-baseline` r5. Two changes derived from published
evidence rather than from copying the current leaderboard leader, whose +$2,314
is entirely unrealised (realised P&L -$2 over eighteen trades) and therefore not
a template for anything.

### The fixed percentage stop was the largest remaining flaw

Measured across one most-actives list, daily ATR ranged from 2.27% (T) to 30.70%
(TNON) — a thirteen-fold spread. A single 5% stop is 2.2 daily ranges on the
first and 0.16 on the second: never reached on one, hit by ordinary noise on the
other. The same stop also means a different dollar loss on every name once size
is fixed.

`volatilitySizedTrade` derives the stop from ATR (`stop_atr_multiple`, 2.5),
clamps it between `stop_min_pct` (3) and `stop_max_pct` (15) so an extreme
reading cannot produce an absurd stop, sets the target at `target_r_multiple`
(2) times the stop to preserve the reward-to-risk ratio, and then solves size
from the stop so the dollar risk is constant. Levels are recorded on the
position at entry and the exit rules use them, falling back to the configured
percentages when ATR is unavailable or the feature is off — a missing indicator
can never size a position larger than before.

Verified live at $100,000 equity and 0.25% risk:

| Symbol | ATR | Stop | Target | Notional | Risk |
|---|---:|---:|---:|---:|---:|
| T | 2.27% | 5.7% | 11.3% | $4,411 | $250 |
| KHC | 3.08% | 7.7% | 15.4% | $3,245 | $250 |
| NVDA | 2.94% | 7.4% | 14.7% | $3,399 | $250 |
| INTC | 6.58% | 15.0% | 30.0% | $1,667 | $250 |
| TNON | 30.70% | 15.0% | 30.0% | $1,667 | $250 |

Every entry path routes through one `sizedTradeFor` helper, and the policy
broker's notional cap now receives the symbol so it applies the same figure.

### Short-horizon returns reverse for past winners

The strategy buys names that are up on heavy volume and holds them for days.
That is the horizon at which short-term reversal dominates, and reversal is more
pronounced among past winners than losers. The documented crossover from
reversal to continuation requires high turnover **together with** a high
price-to-52-week-high ratio (George & Hwang, *The 52-Week High and Momentum
Investing*). Turnover alone — which is exactly what the most-actives screener
selects for — leaves the strategy in the reversal regime.

`pct_of_52w_high` is now computed in `MarketContext` from a full year of daily
bars (the research fetch moved from 60 to 252, since a 60-bar window would
report a three-month high under a 52-week label) and gated by
`entry_min_pct_of_52w_high`, set to 75 in the paper profile. Unknown is allowed
through: a recent listing has no year of history and is not thereby
disqualified.

Measured on one most-actives list, 30 names above $5 with sufficient history: 10
were within 30% of their 52-week high, 8 within 20%, 4 within 10%. At the 75%
setting roughly a third of the screened universe survives. Names such as INTC
(72%) and NOK (64%) — both large up-moves on heavy volume — fall on the
reversal side of the line.

No forward results exist for either change. Both alter the shape of the risk and
the composition of the candidate set; neither is evidence of profitability.

## Catalyst core and borrowed structure — September 11, 2026

Profile revision `paper-baseline` r6. Five public Claude trading-skill
collections were reviewed. Three were not applicable: a Schwab swing skill built
on Ichimoku, Williams fractals and chart patterns; a 68-skill collection that is
substantially Solana, DeFi and prediction markets; and an Interactive Brokers
options advisory. One contributed a single idea. One was materially useful. All
are MIT licensed.

### The strategy now has a stated core

Previously the system had five half-strategies and no thesis: social sentiment,
short-term momentum, filings, news and macro all competed on one sentiment
score, and the weakest input was the only one able to originate a trade while
the differentiated one could not. The SEC gatherer assigned every filing a
hard-coded 0.20 against a 0.30 threshold, so no filing had ever produced a
research call.

The claim is now explicit: **a trade needs a discrete event that changes what a
company is worth.** Sentiment and volume rank candidates; only a catalyst
qualifies one. `entry_require_catalyst` enforces it at the same chokepoint as
the other gates, with `entry_min_catalyst_quality` (medium) and
`entry_max_catalyst_age_minutes` (1440, because post-event drift runs for days
rather than minutes — Ball & Brown 1968, Bernard & Thomas 1989).

`helpers/catalyst.ts` classifies headlines into ten event families over three
quality tiers, following the Episodic Pivot taxonomy in
tradermonty/claude-trading-skills (MIT). High covers guidance raises, regulatory
approvals and Phase 3 successes, earnings beats and major contract wins; medium
covers M&A, partnerships, product launches and squeezes; low covers analyst
actions and theme stories. Adverse language disqualifies regardless of any
catalyst also present: a contract win announced alongside a dilutive offering is
still a dilutive offering. That negative list independently matches the blocking
red flags already in the entry gate.

Catalysts accumulate across gather passes and are pruned by age, because the
article window is three hours while the tradable horizon is days.

### Trailing stop corrected to R units

The percentage trailing stop shipped earlier the same day was inconsistent with
the ATR-derived stops shipped alongside it. A 6% arm means a different amount of
risk on a 5.7% stop than on a 15% one. `trailing_arm_r` (1.5) and
`trailing_stop_r` (1.0) express both in multiples of that position's own stop,
so the setting means the same thing everywhere and the exit floor sits near
+0.5R:

| Symbol | ATR | Stop | Arm (1.5R) | Trail (1R) | Exit floor | Target (2R) |
|---|---:|---:|---:|---:|---:|---:|
| T | 2.27% | 5.7% | 8.5% | 5.7% | 2.4% | 11.3% |
| KHC | 3.08% | 7.7% | 11.6% | 7.7% | 3.0% | 15.4% |
| INTC | 6.58% | 15.0% | 22.5% | 15.0% | 4.1% | 30.0% |

The percentage fields remain as the fallback. This was a defect in shipped work,
not an enhancement.

### Macro read moved to cross-asset ratios

From Oft3r/agentic-trading-desk (MIT), whose own README states it has not been
backtested. Absolute moves say the tape rose; ratios say what led. RSP, HYG and
LQD were added to the basket to give cap-weight against equal-weight (breadth),
high yield against investment grade (credit) and small against large. Ratios
cancel any move common to both legs. Credit now participates in the risk
reading: an equity rally the credit market is not confirming returns "mixed"
rather than "risk-on", because credit generally reprices first.

### Range position gate

From the Episodic Pivot day-one checklist. `entry_min_range_position` (0.5)
rejects an entry closing in the lower half of the session range: a catalyst sold
into all day is not a catalyst being bought.

### Reviewed and not adopted

Chart-pattern and Ichimoku methodology, Solana and DeFi tooling, options
strategy skills, and every Python implementation — the stack here is TypeScript
on Workers. The backtesting skills in agiprolabs (vectorbt, Backtrader,
walk-forward validation) address a real gap, since nothing here has ever been
backtested, but are a reference rather than a port.

## Market data feed defect — September 12, 2026

The most consequential defect found so far, surfaced by cross-checking Alpaca
against the connected Robinhood brokerage data.

Alpaca defaults to the IEX feed. IEX is one venue and prints a small fraction of
consolidated volume. Measured against the tape on the same session:

| Symbol | Alpaca snapshot (IEX) | Alpaca bars (SIP) | Robinhood 30-day average |
|---|---:|---:|---:|
| KHC | 1,394,936 | 16,574,155 | 20,958,441 |
| INTC | 2,150,212 | 61,554,189 | 99,567,685 |
| NVDA | 2,640,914 | 157,802,919 | 125,389,510 |
| ORCL | 1,461,559 | 21,912,039 | — |

Understatement ranged from roughly 7x to 60x. Every liquidity decision was
therefore wrong by orders of magnitude: `entry_min_dollar_volume` at $20M was
behaving as a several-hundred-million-dollar test, and rejecting Oracle, Macy's
and Gamestop as too illiquid to trade. The most-actives screener reports
consolidated volume, so the two sources disagreed by an order of magnitude
within the same pass.

On this plan the bars endpoint serves SIP (HTTP 200) while the snapshot
endpoints reject it (HTTP 403). `getBars` now requests SIP by default and falls
back to the default feed if the plan refuses, and liquidity is measured as ADV20
from those bars rather than from the snapshot's previous-session volume — twenty
sessions because one day is noisy, and because ADV20 is the figure liquidity
rules are conventionally written against. Prices, gaps, range position and
spread continue to come from the snapshot, where a single venue is adequate.

Corrected figures: KHC $34.1M to $386M, INTC $217M to $11.4bn, NVDA $577M to
$25.0bn. `entry_min_dollar_volume` was re-set to $25M against real consolidated
volume.

### Consequence for gate calibration

Every threshold tuned before this was tuned against corrupted inputs. Re-running
a week of positive earnings surprises through the full gate chain afterwards:
two of fourteen pass, and every rejection is now substantive — seven on the
52-week-high rule, two on range position, two on intraday extension, one on
price. Previously zero of fifteen passed and nine of those failures were the
data defect rather than the strategy.

Two of fourteen is a real rate rather than an artifact, but it is thin: roughly
three candidates a week from the earnings channel, against an expectancy model
that needs far more trades to reach the stated return target. That tension is
unresolved and only live results can settle it.

### Robinhood connector

Read-only tools were used; no order was placed and none will be — that account
is live money, while the agent trades an Alpaca paper account. The connector is
available to this session, not to the deployed Worker, so it cannot serve as a
data source for the trading loop. Its value is verification and research: it
independently confirmed the 52-week-high implementation to the cent (INTC
$142.35, NVDA $236.54), exposed the feed defect above, and supplies earnings
dates, EPS surprises, float and sector classification that Alpaca does not.
Sector classification in particular would close the loop between the sector
leadership table and individual candidates, which the Worker currently cannot do.

## Earnings catalyst bridge — September 12, 2026

Profile revision `paper-baseline` r7.

The catalyst requirement was starving. Classifying a real trading session's news
feed produced nine catalysts from fifty articles, eight of them analyst price
target changes graded low, leaving one that met the medium threshold. The
classifier was grading correctly; the feed is the limitation. Alpaca's news
carries analyst actions, earnings-call transcripts and halt notices rather than
the primary corporate announcements the taxonomy was built around.

The strongest available catalyst is an earnings calendar with actual against
estimated EPS, and no free endpoint reachable from a Worker supplies one.
`POST /agent/catalysts` accepts catalysts from outside and merges them into the
same cache the news gatherer fills, so every source meets the same entry gate.
The payload is validated as strictly as model output, because an unvalidated
push would bypass the gate that decides whether a trade may happen at all.

`scripts/push-catalysts.mjs` converts raw EPS rows into graded catalysts:
surprises at or above 10% are high, 3 to 10% medium, below 3% discarded as
noise, and misses dropped entirely since a negative surprise drifts the wrong
way for a long-only book. Seeded with the week of September 8 to 11, twenty-five
rows produced nineteen catalysts; four misses and two sub-threshold surprises
were correctly excluded.

`entry_max_catalyst_age_minutes` moved from 1440 to 14400. A 24-hour window
discarded the entire drift horizon: the effect is strongest across the first two
to three weeks after the announcement, and positions here hold for five days.

### Threshold set at 70%

Measured against those nineteen catalysts, `entry_min_pct_of_52w_high` produces
two candidates at 75%, three at 70%, six at 65% and seven at 60%. Set to 70:
three candidates matches the stated target of two to three trades a week without
reaching into the band where short-horizon winners revert. Dropping to 65 would
roughly triple candidates while admitting exactly the names the evidence warns
about.

Candidates as of the September 11 close: GME at 75% of its 52-week high, SIG at
91%, SAIL at 72%. Stops of 7.4%, 11.5% and 15.0% against sizes of $3,371, $2,169
and $1,667 — three different stops and sizes carrying an identical $250 risk,
which is the volatility normalisation working as intended.

### Session startup

`npm run paper:start` runs the dependent steps in order: worker reachable,
credentials and model probed through the doctor, profile applied, catalysts
pushed, agent enabled. A failure stops the sequence rather than continuing,
because enabling an agent whose profile did not apply, or whose catalyst cache
is empty under a catalyst-gated strategy, would run the previous configuration
against nothing. `--no-enable` performs everything except arming.

Saving JSON still does not configure the durable object, and durable-object
state does not survive the local dev server, so the sequence is re-run each time
the worker starts.

### Expectation

Three trades a week at a 2R target and a 50% hit rate is roughly 1 to 2% a
month, not the 2 to 3% requested. Closing that gap requires a sustained hit rate
above 60%, which nothing here has demonstrated. No position has been opened and
no forward result exists.

## Trade journal — September 12, 2026

`trade_journal` and `createJournalEntry` existed in the schema and query layer
with no callers, the same pattern as the unused ATR library and the realised-loss
counter. The table already carried exit price, P&L, hold duration, outcome and
lessons; only the wiring was missing.

The journal records **why a decision was made, at the moment it was made**. None
of that survives to the exit: research expires from its cache, the macro regime
moves, the catalyst ages out. A journal assembled at exit can record only
outcomes, which is the half that teaches nothing about selection.

Captured at entry, in `helpers/thesis.ts`:

- The catalyst that permitted the trade — type, quality, headline, age in hours.
- The model's own conclusion — verdict, confidence, entry quality, reasoning,
  red flags — so confidence can later be scored against outcomes.
- Every measured gate value: price, percent of 52-week high, ATR, RSI, trend,
  relative volume, spread, extension, range position, ADV20. A threshold can
  then be re-tested against trades already taken.
- The plan: stop, target, notional and risk in dollars. Risk is stored rather
  than recomputed because it is the denominator of the R multiple.
- Macro state as flat tags (`risk:risk-on`, `leader:XLK`) so entries group by
  regime.

Outcomes are recorded in **R**, the only unit that compares trades with
different stops: +15% is 1R on a 15% stop and 3R on a 5% stop.

Exit marks are captured when the exit is decided, not when the fill confirms —
`onSell` now fires from broker reconciliation, by which point the position no
longer exists and its P&L cannot be recovered. The stored note says explicitly
that P&L is marked at decision rather than at fill. Journalling failures are
caught and logged; they can never block or fail a trade.

`GET /agent/journal` reads it back and `npm run paper:journal` renders it,
grouping closed trades by catalyst type and outcome. That grouping is the
purpose: finding out which reasons actually pay before trusting them with size.

Questions it is built to answer: do guidance catalysts pay better than earnings
beats, is the 52-week gate at 70% selecting better trades than 75% would have,
do entries in leading sectors outperform, and is model confidence correlated
with outcome at all. None of these can be answered yet — nothing has traded.

## Exit attribution — September 12, 2026

A journal that records only outcomes says a trade lost money, which is not a
lesson. `helpers/postmortem.ts` attributes each exit to a cause, because each
answer implies a different fix:

| Cause | Meaning | What to change |
|---|---|---|
| `target_hit` | Reached the profit target | Nothing |
| `company_event` | Adverse news arrived after entry | Nothing — selection was sound on the information available |
| `macro` | The tape fell and the name tracked it | Nothing about selection |
| `sector` | The sector fell while the tape held | Add a sector filter |
| `stop_too_tight` | Stopped by a move inside normal daily range | Risk settings, not selection |
| `time_expired` | Closed on time having done nothing | Selection |
| `thesis` | Lost with no external explanation | Selection |

The distinction that matters most is between the middle rows and the last two. A
thesis that was right but stopped out by noise, or drowned by a market-wide
selloff, is evidence *for* the selection process and against the risk settings.
Recording those as thesis failures is how a working edge gets tuned away.

Each attribution carries `selection_still_valid`, and the journal reader
separates losing trades on it: tune selection on one group, risk settings on the
other.

Evidence gathered at exit: the position's move, SPY over the same holding window
so beta is not mistaken for a bad pick, disqualifying headlines published since
entry, and the ATR recorded at entry. Each lookup is independent and
failure-tolerant, and the attributor reports `unknown` rather than guessing when
a field is missing.

Two limits are structural. Recovery after the exit is the cleanest evidence that
a stop was too tight, but it is a future measurement and cannot be known when
the trade closes; the ATR test stands in, treating an adverse move under 1.5x
daily range as ordinary noise, and the field is left open for a later review
pass. Sector attribution needs a symbol-to-sector map the Worker does not have —
the broker connector supplies one, which is item 7 of the backlog.

## Early exits — September 12, 2026

Closing before the target is the quietest way to destroy expectancy, and the
system already had an uncontrolled path for it. The analyst's SELL branch
requires only a confidence above the threshold and thirty minutes held; entries
require a catalyst, fresh research, eight measured gates and schema validation.
All the discipline sat on the entry side.

The cost, at a 7.5% ATR-derived stop and a 15.0% target:

| Exit at | R realised | Break-even hit rate |
|---|---:|---:|
| Target | 2.00R | 33% |
| +7% | 0.93R | 52% |
| +5% | 0.67R | 60% |
| +3% | 0.40R | 71% |
| +2% | 0.27R | 79% |

A model closing at +3% converts a 2R system into a 0.40R one.

The answer is not to forbid early exits but to require evidence that the thesis
is dead rather than merely slow. `exit_on_adverse_news` closes a position when
issuer-specific adverse news is published **after** the entry — dilution, an
offering, an investigation, a guidance cut. It is checked before the profit
target, because a dilutive offering does not become acceptable just because the
position happens to be green, and only invalidation later than the entry counts:
anything earlier was already visible to the entry gate.

This reuses the news gatherer's existing per-issuer invalidation record rather
than keeping a second cache. That record is single-issuer only, survives
restarts and is already independent of feed ordering, all of which a duplicate
would have had to re-earn.

Discretionary closes are now attributed to their own cause rather than folded in
with the rest, carrying the R realised and the target given up. Whether they help
or hurt is not knowable in advance: it is answerable only by grouping them and
comparing realised R against trades that ran to a level. Until that comparison
exists the path is left in place and measured rather than tuned.

## Diagnostics and reusable instructions

```bash
npm run doctor
npm run doctor -- --sources
npm run paper:apply
npm run paper:status
npm run paper:stop
```

Doctor uses read-only requests, prints no credentials, and returns nonzero for missing/failed dependencies. `--sources` checks basic endpoint access, not trading signal quality. September 11 probes found StockTwits reachable and Reddit HTTP 403. LLM authentication remains untested because `OPENAI_API_KEY` is blank.

Project rules are in `AGENTS.md`. The discoverable personal skill is `~/.codex/skills/mahoraga-operator/SKILL.md`, invokable as `$mahoraga-operator` once the skill list refreshes. The skill links to this checkout and its runbooks; it does not make the trading LLM read local Codex skills automatically. Trading-model rules are in `src/strategy/default/prompts/` and runtime limits are enforced in TypeScript.

## Remaining work

No model key, cloud deployment, or official leaderboard registration was added. Pending-order exposure, fill reconciliation, legacy realized-loss/cooldown accounting, dependency advisories, and persistent source availability still need work before unattended operation. Options remain disabled: their separate direct-order path is not covered by the equity broker's guarantees. No changes claim a profitable strategy or a leaderboard win.

## Verification

Worker type checking and all 214 unit tests pass. The personal skill passes the bundled validator. Local smoke checks confirm the profile is applied (10-minute preparation, staleness exits off), account equity is $100,000, budget state is exposed, the dashboard proxy returns HTTP 200, and enable without a model key returns HTTP 409 while status remains disabled. No orders or paid model requests were sent.
