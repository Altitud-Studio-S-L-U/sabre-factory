# 10 · Configurable budgets and recovery

## Outcome and compatibility
Support bounded, bounded-with-reserve and uncapped cumulative work policies, per metric: tokens, model invocations, active time and repair cycles. Preserve current bounded defaults (40 calls, 100,000 tokens, one hour, two repairs). Null means uncapped; zero repairs means no repair. Zero authorized API spend means no paid API permission, never unlimited spend. Keep unknown usage distinct from zero. Existing CLI progress-mode requests remain readable through an explicit compatibility adapter.

## Interfaces
Add a versioned budget policy to configuration and launch contracts. Primary ceilings, preauthorized reserve and absolute ceilings are separate typed fields. A reserve is finite, explicitly granted at launch and never automatically replenished. Factory/provider constraints remain effective even if a run metric is uncapped. Paid spend is independently configured and authorized; uncapping tokens or repairs does not authorize extra API spend.

Add a revision-checked budget amendment command for each metric and repair policy. Persist immutable initial configuration plus append-only authorizations and effective-budget revisions. Never rewrite original launch snapshots or usage receipts. Broadening limits requires operator authorization or an existing exact reserve grant; the Supervisor cannot grant itself more work. Reserving/activating increments must be atomic across workers.

## Exhaustion and resumption
Before dispatch, check measurable limits and reservations. On exhaustion, preserve the LangGraph checkpoint, stop new model/tool dispatch, record the limiting metric and notify through the durable outbox. UI shows used/reserved/remaining amounts, unknown outcomes and the pending step. The Supervisor conversation remains available under a separate, explicit bounded allowance; exhausted execution cannot silently charge further reasoning against the run.

If an eligible reserve remains, activate only the authorized tranche, record its receipt and continue from the reconciled checkpoint. Otherwise offer amend-and-resume or cancel. Reconcile uncertain calls and external writes before resuming; preserve total usage and repair history. Never treat a budget pause as a completed run or restart the task from scratch.

Uncapped cumulative work does not remove per-invocation timeout/output bounds, cancellation, concurrency, credential checks or mandatory verification. Repeated identical failure without new evidence triggers a separately visible no-progress intervention; unlimited repair count is not authority to ignore it. Define no progress as repeated identical failed gate/snapshot/task fingerprints across consecutive repair outcomes, with a versioned configurable detection threshold (default three). Do not infer progress solely from an agent's prose.

## Acceptance
Test each metric independently, null/zero semantics, reserve exhaustion, concurrent activation, stale amendments, changes during in-flight calls and crash recovery after activation. Resuming retains all usage and does not duplicate publications. CLI tests preserve the fact that aggregate tokens may only be known after invocation: the UI must not promise exact preventive token caps. Failed checks still block delivery after budget extension.
