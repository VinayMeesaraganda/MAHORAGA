# Review findings and verification

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
