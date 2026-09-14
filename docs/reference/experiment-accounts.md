# Paper experiment accounts

Verified September 13, 2026 with GET requests to the Alpaca paper API. The baseline, guidance-continuation and price/volume credentials resolve to three distinct broker account IDs. Each account was ACTIVE and unblocked, with $100,000 cash/equity, zero positions and zero open orders at verification.

| Experiment | Credential storage | Execution readiness |
|---|---|---|
| Baseline sentiment-momentum | Existing local `.dev.vars` and deployed Cloudflare secrets | Existing `mahoraga-paper` Worker; new account setup does not change it |
| Guidance continuation | `.paper-accounts/guidance-continuation.json` | Dedicated `mahoraga-guidance-continuation` Worker deployed; shadow mode, reviewed issuer evidence and broker acceptance pending |
| Price/volume | `.paper-accounts/price-volume.json` | Dedicated `mahoraga-price-volume` Worker deployed; implemented deterministic strategy in shadow mode, broker acceptance pending |

The two new credential files are local preparation records, not Worker configurations or an execution gate. No running Worker reads them automatically. They live in a mode-0700 directory, have mode-0600 permissions and are ignored by Git. The existing baseline `.dev.vars` was preserved.

September 13 implementation follow-up: both Workers, isolated D1 databases, account pins and independent API/emergency secrets are now provisioned. Private deployment files live under `.paper-accounts/<strategy>/`; `scripts/experiment.mjs` consumes them. Finnhub is configured and remotely verified for both. Neither has an execution-acceptance secret. See [three-strategy operation](multi-strategy-operation.md) for tested behavior, actual operating modes and remaining gates. The baseline Worker's credentials were not replaced.

Account provisioning does not begin a performance evaluation. Register each executable strategy revision, evaluation dates and operating budget before comparing outcomes. No orders or account resets were performed during account verification.
