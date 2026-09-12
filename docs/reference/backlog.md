# Backlog

Deferred work, with the reasoning that produced it. Ordered by expected value,
not by effort. Nothing here has forward results behind it.

## 1. Implied volatility as a cross-check on ATR stops

The whole risk framework is calibrated on realised volatility: ATR sets the stop
and the stop sets the size. ATR is backward-looking. The options market prices
what it expects next, and the two can disagree materially.

Measured on GME at the 2026-09-11 close, against the Oct-16 $21 call:

| | |
|---|---|
| Daily ATR | 2.97% → annualised realised ~29% |
| Implied volatility | 43.2% |
| Ratio | **1.47x** |
| Implied move to expiry | ±13.3% |
| ATR-projected move | ±9.1% |
| Configured stop | 7.4% — **0.56x the implied move** |

GME would be sized as a 29% vol name while the market prices 43%.

Two uses, the second probably stronger:

1. Take the wider of the ATR-derived and IV-derived stop. Size shrinks
   automatically because size is solved from the stop.
2. Reject when IV/realised is extreme (roughly 2x and above). That usually means
   the market knows about an event the strategy does not — the same thing the
   red-flag taxonomy tries to catch by reading headlines, caught without needing
   the headline.

Delivery: IV is dense and fast-moving, so it is a poor fit for the periodic
catalyst push — stale IV is worse than none because it reads as authoritative.
Fetched once at entry and held for the position's life is the shape that works.

Deliberately deferred until a live session has run. Adding a fourth input to the
risk calculation before observing a single trade means an odd result cannot be
attributed between ATR, IV, the 52-week gate and relative volume.

## 2. Deploy to Cloudflare

The agent runs only while `wrangler dev` is up, which means only while the
machine is awake. `wrangler.jsonc` still carries placeholder resource IDs and
`"crons": []` against five handlers in `jobs/cron.ts` that therefore never fire —
including the daily-loss counter reset. The two scheduled pre-open tasks are a
workaround for a local dev server, not a substitute for deployment.

## 3. Route options through the policy broker before enabling them

`executeOptionsOrder` calls `alpaca.trading.createOrder` directly rather than
going through `createPolicyBroker`, so an options order faces no policy engine,
no position cap, no daily-loss guard, no kill switch and no entry gate. Better
options data does not fix a path that skips every check. `AGENTS.md` requires
separate policy review.

## 4. Realised-loss accounting and the loss cooldown

`incrementDailyLoss` and `setCooldown` exist in `storage/d1/queries/risk-state.ts`
with no callers. `daily_loss_usd` is therefore permanently zero and
`cooldown_minutes_after_loss` never triggers. The equity-based guard
(`last_equity` against `equity`) still works, so the account is not unprotected,
but the documented pause after a loss is fiction. Stop-outs cluster, which is
exactly when a pause is worth having.

## 5. Broker-side protective orders

Stops exist only in the polling loop; nothing rests at Alpaca. With five-day
holds and roughly $25,000 deployed, a gap has no protection: a 10% overnight gap
is twice the intended risk, a 20% gap four times. Alpaca refuses brackets on
notional orders (`fractional orders must be simple orders`, HTTP 422), so this
requires switching to whole-share `qty` orders — $5,000 becomes 51 shares of a
$97 stock, a trivial loss of precision for a real resting stop.

## 6. Backtesting

Nothing here has ever been backtested, so no threshold has out-of-sample
support. The `vectorbt`, `Backtrader` and walk-forward-validation skills in
agiprolabs/claude-trading-skills are a reference, though they are Python against
a TypeScript Worker.

## 7. Sector classification for candidates

The macro module ranks eleven sector ETFs, but nothing maps a candidate to a
sector, so "technology is leading, this name is a semiconductor" cannot be
computed. The broker connector supplies `sector` and `industry` per symbol;
Alpaca does not. Would also enable a correlation cap — five positions in one
sector is one bet, not five.

## 8. Post-exit review pass

Exit attribution runs when the trade closes, so it cannot see whether the name
recovered afterwards — the cleanest evidence that a stop was too tight rather
than a thesis being wrong. The ATR test stands in for now. A pass that revisits
closed entries a few days later and fills `recovered_to_pct` would separate
"stopped by noise" from "genuinely wrong" far more reliably than the proxy does.

## 9. Earnings catalysts still arrive by hand

`config/catalysts.json` is populated manually from the broker earnings calendar
and pushed with `npm run paper:catalysts`. The connector is available to a
Claude session, not to the Worker, so this cannot currently be automated from
inside the loop. A scheduled task that refreshes the file after each earnings
day would close it.
