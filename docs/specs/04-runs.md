# 04 · Process console

## Outcome and interfaces
Expose registered topology and persisted step attempts through the run API. Extend the event projection with sanitized message and artifact references. Do not reconstruct every checkpoint on each refresh or introduce an independent UI execution state.

## Behavior
The primary process view is a temporal swimlane: elapsed-time ruler at the top and project phases down the left. Plan, Spec, Design, Build, Verify, Review and Deliver are conceptual labels mapped to the selected registered flow, not mandatory stages invented for every run. Expand phase rows into agent invocations and tool spans on the same time scale. Hover/focus previews metadata; click pins a selection. Show parallelism, repeated attempts and repair routes explicitly. Tooltips must be keyboard-accessible and dismissible. Keep phase names visible during horizontal scrolling.

Render expected topology separately from observed execution. Show repeated attempts, branches, current phase, elapsed and measured active time, recorded tokens, pending usage and unknown cost. Preserve selection while cursor-based polling or streaming updates arrive. On disconnect retain a labelled snapshot and disable unsafe controls.

Inspect actual messages, typed inputs/results, tool calls, failures and artifacts. Payloads are bounded, access-controlled, redacted before storage and paginated. No hidden reasoning is collected. Historical inspection must display its sequence and never masquerade as current state. Controls use shared command receipts and current revisions.

The inspector exposes state, evaluations, logs, JSON, evidence and OpenTelemetry correlation. Evaluations identify their criteria, evaluator/version, input snapshot and measured result. Trace links use actual recorded trace/span IDs; no span means no link. Runtime instrumentation must not export prompt or code payloads by default.

Expose the Supervisor agent persistently throughout the console, with factory-scoped and run-scoped conversations. Availability is independent of run pause/HITL, subject to actual provider availability and separate bounded inference authorization; do not promise zero-latency or unlimited service. Persist operator messages, receipts and replies. A chat message does not implicitly alter scope, tools or permissions. Pause/cancel and material changes use explicit typed commands with current revisions. Associate resulting commands with the originating message.

For HITL, show the question, reason, blocked phase, affected scope, question ID and plan revision. Permit the operator to ask the Supervisor for clarification while waiting. Revalidate before accepting an answer; duplicate/stale answers have no effects. Remain paused when required input or permission is missing.

## Acceptance
Test replay, duplicated/out-of-order notifications, gaps, reconnect, independent attempts, stale answers and cancellation. Verify no secret leakage through nested payloads. Browser tests cover node selection, keyboard, mobile overflow, unknown usage, errors and recovery. A synthetic screenshot is not a completed real run.

Additional journeys: flag a risk while a run continues; ask about a failed evaluation; request and confirm pause; ask for clarification during HITL; answer from another channel; resume after a valid decision; navigate to another page without losing the supervisor conversation; surface supervisor/provider unavailability without losing the operator message.
