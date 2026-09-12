# Scheduler repair — September 12, 2026

This repair changes execution scheduling, not the strategy's claimed edge or risk allocation. Paper trading remains the intended account mode; enabling the agent is a separate operation.

## Implemented behavior

- Every active alarm reconciles outstanding broker intents before checking market hours. During equity hours it refreshes account and holdings, then checks deterministic exits before optional work.
- Each alarm runs at most one optional stage: gathering, signal research, analyst/execution, premarket planning/execution, position research, crypto, or Twitter checks. The oldest due stage wins, so frequent gathering cannot indefinitely defer research or analysis.
- Signal research rotates through the five strongest distinct candidate symbols, researching at most one per alarm. Failed attempts rotate as well. The per-symbol scheduling interval is one fifth of the former research interval, with a 30-second minimum; this aims to retain coverage without putting five model requests ahead of the next exit check.
- Premarket planning reads cached signal research. Position research also handles one position per stage; the current profile disables it.
- The next alarm is scheduled relative to the start of the current alarm. A 15-second cycle leaves a 15-second wait. A cycle longer than 30 seconds leaves a 1-second wait. If initial broker reconciliation and exits already take 30 seconds, optional work is deferred.
- Gatherers receive isolated state and a 15-second publication deadline. Successful sources commit completed caches. Timed-out, stopped, or failed sources cannot publish partial or late state. Source timeouts are logged by name. These gather contexts expose no model or broker-order methods.
- Raw SEC, ticker-cache and Twitter requests now have 10-second abort signals. The shared Alpaca client has a 10-second whole-response deadline; raw OpenAI completions have a 30-second deadline. Neither provider retries timed-out financial mutations.

## Limits that remain

**A 30-second heartbeat is a target, not a guaranteed exit latency.** An order-capable stage is awaited rather than raced against a timer: abandoning it could leave a financial mutation running in the background. A signal-research stage can include several bounded market-data requests plus one bounded model request. Reconciliation and multiple exits can also require several broker calls. The next protection check can therefore occur later than 30 seconds during slow responses.

Cloudflare permits only one `alarm()` handler to run at once per Durable Object. Scheduling another alarm during a long request would not create an independent watchdog. A hard separation of research from execution would require a separate execution object or broker-native protective orders with fill and modification reconciliation. [Cloudflare alarm semantics](https://developers.cloudflare.com/durable-objects/api/alarms/#alarm)

The gather deadline bounds how long the harness waits and whether results can be published. A transport created internally by a gatherer must still honor its own request abort signal; an arbitrary custom gatherer does not acquire transport cancellation merely by receiving isolated state. The source may perform bounded read work after its result is discarded. Source logs should be inspected during forward paper sessions before considering its feed healthy.

These changes do not establish profitable expectancy, eliminate overnight gaps, or guarantee fills at a trailing-stop threshold.

## Regression evidence

Scheduling tests verify one-stage selection, oldest-due fairness despite severe overruns, start-relative wakeups, and research rotation after both success and failure. Gather-boundary tests verify successful commit, retained-reference isolation, timeout rejection, blocked partial/late writes, stop-before-publication, and absent order/model capabilities. Provider tests verify actual abort delivery to stalled request transports and deadlines covering stalled body reads. No live test orders were used.
