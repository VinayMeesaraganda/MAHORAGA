# Plan for improving competition performance

Winning is an objective, not a promise. Begin by showing that the full data-to-order path works and produces reliable records. The initial small allocation is for this purpose; it is not expected to maximize rank.

## Stage 1: establish a working baseline

- Validate model authentication, source availability, signal freshness and the research response schema.
- Run the prepared paper profile across multiple equity sessions. Inspect accepted, rejected, partially filled and canceled orders; reconcile actual fills and positions rather than assuming submission means execution.
- Record daily close equity, cash, exposure, peak-to-trough drawdown, returns, profitable-day rate, model spend, source errors and policy rejections.
- Verify stopping and restarting with positions present. Resolve daily-loss accounting and pending-order exposure before increasing size or leaving it unattended.

## Stage 2: evaluate rather than chase a frozen rank

Use a cash baseline and a consistently measured broad-market benchmark over the same dates, and report exposure alongside returns. Compute the leaderboard's approximate component metrics locally; exact relative composite rank requires other participants' comparable current data.

Do not reset or top up the paper account to erase losses. Record deposits/withdrawals separately from trading returns. A few profitable days are not evidence of an edge; aim for at least 20 trading sessions for a first review and substantially more observations across market conditions before drawing strong conclusions.

## Stage 3: controlled improvements

1. Compare sentiment-only inputs with independent-source confirmation and stale-signal rejection.
2. Measure spread, liquidity and fill quality; test liquidity filters before lowering confidence thresholds to force more trades.
3. Compare the baseline prompt/model against one alternative using the same timestamped examples, then separate forward paper runs. Treat model confidence calibration as an empirical question.
4. Test one exit change at a time, including turnover, slippage and drawdown effects.
5. Scale exposure only after fill reconciliation, concentration limits and loss accounting work under failure scenarios.

Do not tune on future prices or repeatedly select the best parameter set on the same evaluation period. Social-history availability may prevent faithful backtests; record inputs prospectively rather than inventing historical sentiment. Retain a holdout period, version the code/configuration with every run, and include unsuccessful trials in results.

## Cost discipline

The slower baseline and small model reduce some usage, and a daily completion-attempt limit of 300 is now enforced, but no hard daily dollar cap exists. The harness cost tracker contains hard-coded model prices and is an estimate, not a billing authority. Check provider billing directly and choose a daily operating budget before unattended operation. Do not assume upstream's $0.50–2/day or free hosting estimate still applies.

Suggested experiment record: start/end date, code commit, profile hash, provider/model, starting equity, cash flows, ending equity, daily returns, drawdown, Sharpe sample size, winning-day rate, turnover, rejected orders, source failures, model cost, and keep/reject rationale.
