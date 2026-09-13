# MAHORAGA working reference

Reviewed September 11, 2026. Goal: operate a measurable Alpaca paper strategy and prepare for SUKUNA participation. No strategy can promise first place.

Latest: [runtime improvements, diagnostics and operating rules](runtime-improvements.md). This supersedes the original daily-loss and scheduling findings below.

## Read in this order

1. [Setup and operation](setup.md): credentials, local commands, deployment, emergency stop.
2. [Architecture and configuration](architecture.md): what actually runs and which settings matter.
3. [Competition](competition.md): registration, score calculation, paused syncing, service costs.
4. [Experiment plan](experiments.md): establish a baseline and improve it without fitting noise.
5. [Review findings](findings.md): verified setup issues and remaining limitations.
6. [Backlog](backlog.md): deferred work with the reasoning behind it.
7. [Final strategy recommendation and implementation guide](earnings-continuation-implementation-guide.md): guidance continuation with news, technicals, volume, macro and cash-flow roles; explicit data, risk, execution and evaluation rules.
8. [Guidance-continuation implementation status](guidance-continuation-status.md): shadow pipeline, operating commands, verified behavior and prerequisites before a paper pilot. Supersedes earlier setup claims where explicitly noted.

## Source inventory

Trading source: https://github.com/ygwyg/MAHORAGA at `b1a42cb8b17013760c8f5cdf8fcecad5741dc99c` (February 16, 2026).
Leaderboard source: https://github.com/kalepail/MAHORAGA at `7e590b91cc855f65f6324bd40b2c7fc8e80f6e30` (February 5, 2026).
The leaderboard is a separate fork/application; it is not part of this upstream checkout.

Reviewed all six HTML documentation pages in `docs/`: index, getting-started, architecture, configuration, harness, extending; the root README; `.env.example`; `agent-config.example.json`; `wrangler.example.jsonc`; package scripts; and the leaderboard README, TOP notes, and scoring-and-fairness research. Cross-checked operational claims against the router, harness, strategy defaults, Zod schema, Alpaca provider, policy broker, cron jobs, leaderboard registration/API, metrics, scoring cron, syncer, and dashboard configuration. TOP/research documents describe proposals, not executable requirements.

Website references: https://mahoraga.dev/ and https://sukuna.dev/ . The user supplied the current paused-sync banner. Automated retrieval of SUKUNA returned no readable content via web browsing and HTTP 403 via direct retrieval, so registration availability and the deployed version are not independently verified. The GitHub snapshot does not prove what is currently deployed.

## Prepared state

- Dependencies installed from both lockfiles; all three local D1 migrations applied.
- Alpaca paper credentials saved only in ignored `.dev.vars`, mode 0600. Local API and emergency tokens generated separately.
- Read-only Alpaca checks: ACTIVE, $100,000 cash/equity, zero positions and zero open orders. No orders submitted.
- `config/paper-baseline.json` is the reusable configuration patch; `.dev.vars`, `agent-config.json`, and `wrangler.jsonc` are ignored local files.
- Local worker and dashboard started at http://127.0.0.1:8787 and http://127.0.0.1:3000. Profile applied and read back; emergency stop tested; agent confirmed disabled.
- Cloudflare paper resources are provisioned: D1 database `mahoraga-paper-db`, a dedicated KV namespace, and Worker `mahoraga-paper`. The Worker runs at `https://mahoraga-paper.raj-vinay2408.workers.dev` with paper-only mode, equities-only policy, the applied baseline profile, and its harness enabled. Its broker readback at deployment showed an ACTIVE $100,000 paper account, zero positions and zero pending orders. Provider, broker, API and emergency-stop secrets were stored as Cloudflare secrets; their values are not in the repository.
- R2 was not enabled on the Cloudflare account. The application does not currently call its R2 client, so the unused R2 deployment binding was removed. No public fork or leaderboard registration was created.
- Emergency route corrected and covered by four regression tests. Worker typecheck, 214 tests, and dashboard production build pass.

Run commands from the repository root. Do not put API credentials in tracked files or documentation.
