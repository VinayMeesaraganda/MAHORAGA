# SUKUNA participation and scoring

## Availability

Superseded September 11, 2026: sukuna.dev was rendered directly and reported a
last sync of 20:15 ET the same day, with 15 agents and 1,766 trades, and the Join
page accepting registrations. The earlier paused-sync banner no longer applies.
The observations below about self-hosting still hold.

The user supplied a SUKUNA banner saying syncing is paused because Cloudflare D1 writes were expensive, with rankings frozen at the last sync. This checkout cannot resume the operator's service. Self-hosting the leaderboard would create a separate leaderboard, not update sukuna.dev.

## Registration path in the source

The Join page describes creating an Alpaca paper account, running a bot, then supplying a username and GitHub fork URL. `worker/api.ts` accepts usernames of 3–20 lowercase letters, digits, or underscores and rejects already-registered usernames/repo URLs. It redirects to Alpaca OAuth with `env=paper`; callback verification reads the paper account and stores the access token encrypted. The README describes this as read-only OAuth; inspect the actual consent screen before authorizing. The bot's API key/secret are not registration form fields.

A local clone is not a public GitHub fork. Still needed: the desired username, a user-owned repository URL, and user-completed OAuth consent. Availability of current registration has not been verified, and registration during a pause may never receive an initial snapshot.

## Ranking implemented in the inspected fork

| Component | Nominal weight | Calculation |
|---|---:|---|
| ROI | 40% | Percentage return; synced from Alpaca history |
| Sharpe | 30% | Daily returns, sample standard deviation, annualized by sqrt(252), hard-coded 5% annual risk-free assumption |
| Winning days | 15% | Positive-P&L days / nonzero-P&L days |
| Inverse max drawdown | 15% | 100 minus peak-to-trough drawdown percentage |

`worker/cron.ts` normalizes against participants' latest snapshots and combines scores, capped at 100. Missing/degenerate Sharpe or win-rate components can change the effective weights. This is a relative score: a fixed absolute return does not imply a fixed rank. `worker/metrics.ts` requires at least five equity samples/four valid returns for Sharpe, and two nonzero-P&L days for win rate. These minimums are not enough to establish robust performance.

The older research document discusses 7/30/90-day freshness filters and possible seasonal resets. The inspected `getLeaderboard` handler currently parses sort, direction, minimum trades, limit and offset; it does not implement that proposed rolling-period competition. Do not assume a monthly reset or rolling-return season. No verified prize terms, deadline, or guarantee of placement was found in the reviewed materials.

## Cost issue and possible service improvements

The syncer deletes and reinserts equity history and recent trades per sync; it also replaces daily performance snapshots. High-ranked traders can sync around once per minute. Rewriting histories and indexed rows repeatedly can drive D1 usage even when little data changes.

A possible improvement project would measure actual rows written, retain immutable historical equity rows, upsert only changed daily rows, insert new fills by stable IDs, retain incremental cursors, and reduce idle-account polling. Cache public reads separately from data collection and update scoring at a bounded cadence. Preserve corrections, pagination, retention, and late fills in tests. Savings must be measured using Cloudflare billing metrics; batching alone does not eliminate per-row writes. No leaderboard service has been deployed or modified in this task.

Sources: [leaderboard source](https://github.com/kalepail/MAHORAGA/tree/main/leaderboard), particularly `worker/api.ts`, `metrics.ts`, `cron.ts`, and `syncer.ts`. Source version is pinned in the reference index.
