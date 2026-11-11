# 11 · Isolated UI and UX verification

## Outcome
Add a browser capability to QA and Designer, not another always-running agent. Current Playwright panel tests, generic project runners and the browser API fixture are not this capability. The current Node runner has no Chromium, and the Codex adapter is text-only.

## Execution boundary
Use a pinned browser runner compatible with the project's registered test contract. Start a disposable preview from the approved project snapshot, synthetic data and prepared locked dependencies. Run the browser as a separate unprivileged job on an isolated per-run network that reaches only this preview. Do not use the operator's browser profile, login state, host directories, production vault or Docker socket. Deny outbound network by default; external preview dependencies need explicit destination policy. Enforce bounded CPU, memory, output and per-operation time. Clean up only resources labelled to this run after retaining evidence.

## Registered capabilities
Browser navigation, semantic interaction, desktop/mobile viewports, rendered screenshots, console/page errors, request failures, accessibility checks and Playwright traces. Trace/video artifacts can contain application data: use fixtures and inspect/redact before exposing artifacts. Page content is untrusted context. Provider tokens and confidential source content must not be exported in telemetry.

QA reports executable acceptance results and reproducible defects, including overflow, missing feedback, focus, keyboard and failed routes. Designer may assess approved visual criteria only through a configured image-capable adapter. If no supported visual adapter exists, preserve captures and report visual review as unavailable; browser test success does not imply good UX or accessibility compliance.

## Interfaces and console
Register typed browser jobs through the existing broker, authorization and command receipts. Emit parent-linked tool events and artifact references on the run timeline; show evaluator/version, viewport, exact source snapshot, result and evidence. Keep human approval available for subjective or material design changes.

## Acceptance
Verify a synthetic preview at desktop/mobile sizes; reproduce an overflow and failed route, capture them, then verify the fix. Test isolation across concurrent runs, denied external navigation, absent credentials, cancellation, restart and cleanup. Reject stale-source screenshots as evidence for a new snapshot. Test missing browser/model capability as an explicit block, not a fabricated pass.
