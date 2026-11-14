# 14 · Model transport and context economy

## Outcome
A run spends its tokens on new work. The request a model receives only grows between explicit compaction points, most of its input is read from the provider's cache, and a result stays in view until the request needs the room.

## Evidence that motivates it
The first real audit to reach its report used 533,093 tokens in 20 model calls. Of 61 tool calls, 26 (43%) recovered text the agent had already read, because a read is archived two turns after it arrives even when the request is far below its limit. Of 495,777 input tokens, 27,136 (5.5%) were read from cache: every call is a new CLI process that receives the whole history as one prompt, the projection rewrites earlier messages on each turn, and the pressure notice edits the system prompt. For comparison, one vendor reports 98% of its production input read from cache for an append-only harness (its own figure, not independently verified). The gap is cost and latency paid on every call.

## Interfaces and behavior
**Archive under pressure, in batches.** A result stays in the model-facing request until the measured request crosses a high-water mark (initially 60% of `context_input_max_bytes`). The oldest eligible results are then archived in one batch down to a low-water mark (initially 40%). Between batches the request is append-only: no earlier message changes. `keep_model_turns` still protects the most recent turns, the escalation chain of last resorts is unchanged, and receipts record each batch. Both marks are configuration with documented defaults.

**Stable prefix.** System instructions, tool definitions and the response schema are byte-identical for the whole invocation. Anything that varies per call (the pressure notice, budget status) travels as a trailing message, never as an edit to the system prompt.

**Provider caching.** API providers use their prompt cache: explicit breakpoints after the stable prefix and at the end of the stable history where the provider needs them, automatic prefix caching where it does not. The ledger and the spans record cache-read and cache-write tokens, and cost uses the provider's cache prices ([15](15-observability.md)).

**CLI transport.** One process per call with the full history remains the compatibility path and is documented as the most expensive one. Where the pinned CLI can resume a session, an invocation may keep one session and send only the new messages, starting a fresh session at each compaction batch; this is adopted only if the bench shows the saving and the CLI's terms allow it.

**Provider failures.** A failed call is classified (rate limit, overloaded, timeout, authentication, invalid request, other). Retryable classes are retried with bounded backoff inside the same reservation; the rest stop as today. A role may name one fallback model, used only after retries are exhausted and recorded with the reason. Every failed call leaves an event with its class.

**Effort.** A role may set the provider's reasoning-effort level where the provider has one. The default leaves the provider's own default.

**Worker sessions: an experiment with a decision gate.** For the implement and repair stages, an alternative worker runs a vendor agent session inside the executor sandbox instead of SABRE's own tool loop: the agent keeps its own cache, compaction and parallel tool calls. SABRE supplies the task packet, enforces policy through the agent's tool hooks (path scope, denied operations, secret guard on outputs), caps turns and spend, records usage, cost and a transcript digest, and verifies the result with the same deterministic gates, review and security stages. It requires API-key authentication and an egress proxy that adds the credential outside the sandbox; it is never offered on a subscription login. It is adopted only if the evaluation suite ([16](16-evaluation.md)) shows a better pass rate or cost at equal safety. Until then it does not ship.

**Skills.** Skills stay inline while each is a few hundred bytes. Once a skill grows past a documented size it is listed by name and summary and loaded on use.

## Acceptance
On the long-audit bench task: recoveries are under 10% of tool calls, and on turns without a compaction batch the common prefix with the previous request is at least 90% of its bytes; both figures are reported by every bench run, with the scripted driver included. No archived result becomes unrecoverable, and receipts stay valid across a batch. The pressure notice never changes the system prompt. Cache tokens appear in the ledger, the spans and the run audit. Retries and fallback are tested for each failure class, including that a non-retryable class never retries and that a retry never reserves twice. A worker session cannot read outside its workspace, reach a destination other than the model proxy or see a credential, and a denied tool call is recorded.
