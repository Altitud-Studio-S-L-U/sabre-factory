# 15 · Observability

## Outcome
Answer three questions without reading the database: what a run cost and why, where its time went, and whether the factory is getting better or worse. Keep the current privacy boundary: no prompt, response, code or secret leaves through telemetry.

## State it starts from
Traces exist but are off unless `SABRE_OTLP_ENDPOINT` is set, use only `sabre.*` attribute names, and silently drop the cache-read count and the pressure-notice flag because neither is in the attribute allowlist. Cache-write tokens are captured and not stored. Cost ignores cache prices and records CLI calls as zero. A failed model call leaves no row, and every provider failure reads as `MODEL_PROVIDER_FAILED`. A resumed run starts an unrelated trace. The executor emits no spans. There are no metrics and no application logs. The console shows a run in depth and almost nothing across runs.

## Built so far
- *Allowlist.* The cache-read and cache-write counts, the pressure-notice flag and error codes that carry a digit now pass. A recorder remembers every name it refuses. One test drives a scripted run, the agent loop, a failing provider and the Supervisor's conversation and fails if any attribute is set and dropped; another checks every error code the factory raises.
- *Ledger.* A settled call stores the tokens written to the provider's cache beside those read from it. A call that never settled stores its failure class and keeps its reservation. Both show per call in the run's audit.
- *Cost.* A model selection can carry a price for cached input and one for input written to the cache. A settled call is charged at the price of each kind of token, and a kind with no price of its own is charged as input. The reservation charges every input token at the dearest of those prices, so no settlement can exceed it. A role that names its own model never inherits the default model's cache prices.
- *Metrics.* `GET /api/v1/metrics/runs` sums the ledger and the event log on request, over a window of whole UTC days and optionally one flow or one project: runs by outcome, calls settled and not, failures by class, tokens by kind, API cost, active time, medians per completed run, the cache-read share and the recovery ratio, in total, by flow, by specialist and by day. A figure nothing measured is null: the cost of calls made through a CLI session, a split no call reported, a median with no completed run.
- *Console.* Runs has an Insights page with the summary, runs by outcome per day or per week (read with the pointer or the arrow keys, and as a table), tokens by kind, calls and failures, a table by flow and tokens by specialist. An unknown figure reads Unknown with its reason, apart from a measured zero.

Still to build: the price table per model with its source and date (prices are what the operator enters on a selection, and one price covers every cache write whatever its lifetime), a cost the provider reports itself, the GenAI attribute names, continuity between the executions of a run, executor spans, structured logs and the link from the inspector to a trace viewer. No real run has fed any of this yet: every figure above was checked against synthetic rows.

## Interfaces and behavior
**Spans.** Keep the closed set of span names and add the OpenTelemetry GenAI attribute names beside the existing ones, pinned to a commit of the conventions while they remain in development: operation, provider, request model, input, output, cache-read and cache-write tokens on model calls; tool name and call id on tool spans, with MCP tools named by their reviewed identifier; the run as the conversation id. The allowlist stays the only door, and it gains the attributes dropped today. Content capture stays off and is never a default.

**Continuity.** Each execution of a run links to the root span of the previous one. The broker propagates the trace context to the executor, which records one span per command with duration, exit code and output bytes.

**Failures.** The failure class of [14](14-context-economy.md) is a span attribute and a ledger field. A failed model call produces an event row like any other boundary.

**Ledger and cost.** Store cache-write tokens. Compute cost from input, output, cache-read and cache-write prices held in a price table per model with its source and date; the operator can override a row. A provider that reports its own cost is recorded as reported. A call whose cost cannot be known is unknown, never zero.

**Metrics.** Derive them from the ledger and the event log through a read endpoint instead of a second pipeline: per window and mode, runs by outcome, median and total tokens split by kind, cost, active time, cache-read share and recovery ratio.

**Console.** Runs gains an Insights page: outcomes over time, tokens and cost per completed run, cache-read share and recovery ratio, by mode and by specialist, with unknown shown as unknown. The run inspector links a span to the configured trace viewer when one is set and shows the identifiers otherwise.

**Logs.** Structured lines on standard error for admission, stage changes, provider failures, executor failures and owner decisions, each with run, invocation and trace identifiers and no payload.

**Viewers.** Jaeger stays the bundled local viewer, started with one flag. Any OTLP backend that understands the GenAI conventions can replace it by setting the endpoint; none is required.

## Acceptance
A test fails if an attribute is set and dropped. Model and tool spans carry both vocabularies and no content, checked with a recording exporter. A resumed run's trace links to its predecessor. Each provider failure class maps to its attribute and its event row. Cost with cache prices matches a worked example, and an unpriced model yields unknown. The metrics endpoint agrees with the ledger on a fixture, and Insights renders unknown separately from zero on desktop and mobile.
