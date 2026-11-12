# 04 · Process console

## Outcome and interfaces
Expose registered topology and persisted step attempts through the run API. Extend the event projection with sanitized message and artifact references. Do not reconstruct every checkpoint on each refresh or introduce an independent UI execution state.

## Behavior
The primary process view is a temporal swimlane: elapsed-time ruler at the top and project phases down the left. Plan, Spec, Design, Build, Verify, Review and Deliver are conceptual labels mapped to the selected registered flow, not mandatory stages invented for every run. Expand phase rows into agent invocations and tool spans on the same time scale. Hover/focus previews metadata; click pins a selection. Show parallelism, repeated attempts and repair routes explicitly. Tooltips must be keyboard-accessible and dismissible. Keep phase names visible during horizontal scrolling.

The ruler uses a real time scale with readable adaptive ticks. Zoom is continuous and anchored at the pointer (Ctrl or Cmd with the wheel, trackpad pinch, or the plus, minus and zero keys when the timeline has focus); dragging pans; Fit returns to the whole run. A minimap shows and moves the visible window. Live runs offer Follow now with a Now marker. Expand all and Collapse all toggle every phase. Arrow keys move between bars and Enter pins one. The immersive workspace fills the screen and splits timeline and inspector with a separator that resizes by pointer or keyboard; on narrow screens the inspector follows the timeline. Each specialist has a static crew avatar that reads without colour.

New runs are created in four short steps (work, acceptance, flow and limits, review). Every step stays mounted so drafts survive moving between steps; Next validates the visible step and Launch validates all of them, opening the first step that needs attention. Nothing is sent before Launch.

Render expected topology separately from observed execution. Show repeated attempts, branches, current phase, elapsed and measured active time, recorded tokens, pending usage and unknown cost. Preserve selection while cursor-based polling or streaming updates arrive. On disconnect retain a labelled snapshot and disable unsafe controls.

Inspect actual messages, typed inputs/results, tool calls, failures and artifacts. Payloads are bounded, access-controlled, redacted before storage and paginated. No hidden reasoning is collected. Historical inspection must display its sequence and never masquerade as current state. Controls use shared command receipts and current revisions.

The inspector exposes state, evaluations, logs, JSON, evidence and OpenTelemetry correlation. Evaluations identify their criteria, evaluator/version, input snapshot and measured result. Trace links use actual recorded trace/span IDs; no span means no link. Runtime instrumentation must not export prompt or code payloads by default.

Expose the Supervisor agent persistently throughout the console, with factory-scoped and run-scoped conversations. Availability is independent of run pause/HITL, subject to actual provider availability and separate bounded inference authorization; do not promise zero-latency or unlimited service. Persist operator messages, receipts and replies. A chat message does not implicitly alter scope, tools or permissions. Pause/cancel and material changes use explicit typed commands with current revisions. Associate resulting commands with the originating message. The Supervisor's avatar reflects only observable state (offline, ready, listening, queued, working, using a named tool while a recorded tool call is pending, needs you, replied, blocked) and never suggests hidden reasoning.

For HITL, show the question, reason, blocked phase, affected scope, question ID and plan revision. Permit the operator to ask the Supervisor for clarification while waiting. Revalidate before accepting an answer; duplicate/stale answers have no effects. Remain paused when required input or permission is missing.

## Acceptance
Test replay, duplicated/out-of-order notifications, gaps, reconnect, independent attempts, stale answers and cancellation. Verify no secret leakage through nested payloads. Browser tests cover node selection, keyboard, mobile overflow, unknown usage, errors and recovery. A synthetic screenshot is not a completed real run.

Additional journeys: flag a risk while a run continues; ask about a failed evaluation; request and confirm pause; ask for clarification during HITL; answer from another channel; resume after a valid decision; navigate to another page without losing the supervisor conversation; surface supervisor/provider unavailability without losing the operator message.
