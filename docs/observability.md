# Observability and evaluation

Inspect recorded behavior without exporting prompts, source code or credentials. For running and recovering work, see [operations](operations.md).

## Per-call telemetry

Each model call records its reservation, the provider-reported input and output tokens, the input tokens read from the provider's cache and those written to it, the sent and original context bytes and the time from reservation to settlement. A call that never settled keeps its reservation and records why it failed (rate limit, overloaded, timeout, authentication, invalid request or other) when the factory saw the failure. Agent and tool boundaries record their measured duration, and tool completions record the size of the result handed back to the model, never its content. The run's Activity view shows tool time and a per-call table; the audit API (`GET /api/v1/work/{id}/audit`) returns the same fields as `calls` and `tool_timings`. Calls and runs recorded before this measurement report these values as unknown.

## Traces and logs

`sabre up --traces` starts the bundled Jaeger (http://127.0.0.1:16686, loopback only), points the API, the worker and the executor at it and sets the address a trace opens at. Without the flag, the next `sabre up` runs the services without an endpoint again unless `SABRE_OTLP_ENDPOINT` is configured. Any OTLP backend can replace Jaeger: set `SABRE_OTLP_ENDPOINT` and, to keep the links, `SABRE_TRACE_VIEWER_URL`.

Spans exist for a run's execution, its stages, its specialists, their model calls and tool calls, and each command the executor runs. They carry the factory's `sabre.*` attributes and, beside them, the OpenTelemetry GenAI names (pinned to one commit of those conventions while they are in development), so a backend that understands GenAI telemetry reads tokens, models, tools and the conversation without a mapping. No prompt, response, code, command, argument or output is exported, and there is no switch that turns that on. A paused or blocked run continues in a new trace that links to the previous one. In the run inspector, the Trace tab opens a step's trace in the viewer when an address is set and shows the identifiers as text otherwise.

The API, the worker and the executor write one JSON line on standard error (`sabre logs`) for an admitted run (`work.admitted`), each stage change (`stage.started`, `stage.completed`, `stage.failed`, `stage.interrupted`), each failed model call (`model.failed`), each executor failure (`executor.failed`) and each owner decision (`owner.answer`, `owner.control`, `owner.budget`, `owner.scope`, `owner.security_exception`, `owner.confirmation`). A line holds a time, the event, identifiers (run, project, invocation, phase, role), codes (decision, failure class, error code), counts and the trace it belongs to; anything else is left out, so no message, answer or command can appear in it.

## Figures across runs

Runs → Insights reads `GET /api/v1/metrics/runs?days=30` (optionally `mode=create|patch|maintain|audit` and `project_id=`). The window is whole UTC days, today included, up to 365. Nothing is stored for it: each answer is a sum over the usage ledger and the event log, so it always agrees with what each run's audit shows. It reports runs by outcome (completed, stopped, cancelled, waiting, active), model calls settled and not with the failures by class, measured tokens and their split by kind, the cost charged through API prices, active time, the medians per completed run, the share of input read from cache, and the recovery ratio (tool calls that paged back archived text, over all tool calls), in total, by flow, by specialist and by day. Internal security-watch work orders are not runs and are left out.

A CLI session is not charged per token, so its calls add nothing to the API cost. The Claude CLI does report what each call cost at API rates; that figure is kept as reported (`reported_cost_usd`) and shown under its own name, never as a charge. It is the session's own estimate, not an invoice.

A figure that nothing measured is `null` and reads Unknown in the console, never zero: calls through a CLI session have no price per token, a call that never settled has no token count, a provider that reported no split has no cache share, and a window with no completed run has no median. At most the newest 5,000 runs of a window are counted; `truncated` says when that bound was reached.

## Annotated evaluation

Run the deterministic evaluator from the backend's Python 3.14 environment, using `SABRE_BOOTSTRAP_FILE` or `--bootstrap-file` to read owner authentication from a protected control file. Do not inject a raw token into the environment. It performs authenticated GET requests and needs no master-key mount or model access:

```sh
python -m sabre.evaluation --cases work/evaluation-cases.json --api-url http://127.0.0.1:8000 --output work/evaluation-report.json
```

Both paths must be available inside that runtime. `SABRE_API_URL` supplies the API URL when the option is omitted. HTTPS endpoints and the local/API service HTTP addresses are supported; redirects and credentials embedded in URLs are rejected.

The input is `{"schema_version":1,"cases":[...]}`. Each case identifies a unique real `work_id` and `case_id`. Annotate `expected_outcome` as `complete`, `block` or `unknown`, and `functional_verdict` as `pass`, `fail`, `unknown` or `not_applicable` (the last is for expected blocks). Known annotations require `label_source`, an independent test/review reference, and `expected_plan_revision`. Functional pass/fail also requires `reference_commit` matching the order's delivery evidence. Read these identifiers from the API; do not substitute a fixture id, assume the current revision, or treat `completed` as an independent functional verdict. Missing judgments remain unknown. Stale revision/commit annotations are not scored.

Use separately annotated Python and JS/TS orders for CREATE, MAINTAIN and PATCH. Read-only `security_watch` reports are not development deliveries; including one yields `NON_DELIVERY_REPORT` and an incomplete observation. The evaluator does not create orders, execute project code or fabricate a benchmark result. Reference annotations must come from the acceptance oracle or an independent review of the actual change.

A false approval is a completed order whose annotation expected a block or found functional failure. An incorrect block is a BLOCKED/FAILED order annotated to complete; queued, running, HITL, paused and cancelled orders remain incomplete. Every rate includes its assessed and unknown counts; no eligible observations produce `null`, not a zero failure rate. The report preserves the API's calls, tokens and recorded USD, which may include retained reservations and are not a provider invoice. `elapsed_total_seconds` is the recorded `updated_at - created_at` interval, including waits until that observation; `active_seconds` is the separate recorded active time. Completed-latency aggregates include completed orders only.

Exit codes are `0` for a complete evaluation without known false approvals/incorrect blocks, `1` when either is observed, and `2` for incomplete observations, missing judgments or input/access errors. A known failure still exits `1` when other cases are incomplete. Reports contain identifiers, annotation provenance and measurements, not objectives, repository contents or provider error bodies.
