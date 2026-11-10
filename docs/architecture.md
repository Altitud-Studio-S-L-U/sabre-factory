# Architecture and execution contract

## Scope

One owner, Python and JS/TS projects, two simultaneous executions by default (configurable up to sixteen) and one writer per repository. Codex and Claude CLI subscription sessions, OpenAI, Anthropic, Google and local model endpoints use explicit provider configuration. The system delivers a branch and draft PR; it has no merge or release command. Docker Compose is the deployment target; multiple nodes or a high-availability requirement would justify revisiting Kubernetes.

```mermaid
flowchart LR
  Owner --> Channels[Web / MCP / private Slack]
  subgraph Trusted[SABRE control]
    Channels --> API[Shared application service]
    API --> Graph[LangGraph development graph]
    Graph --> Roles[LangChain role agents]
    Graph --> Security[Independent security graph]
    Graph --> DB[Postgres checkpoints and metadata]
    Graph --> Memory[Project memory / pgvector]
    Memory --> DB
    Graph --> Context[Verified source context / incremental index]
    Graph --> Tools[Authorized tools]
    Graph --> Publisher[GitHub publication and receipts]
    API --> Vault[Encrypted credential vault · separate database and role]
    Master[Protected master file] --> API
  end
  Roles --> Providers[Configured model providers]
  Roles --> CLI[Isolated Codex CLI runner]
  Auth[Factory-owned ChatGPT session] --> CLI
  CLI --> Requests[Structured action requests]
  Requests --> Tools
  Tools --> Broker[Executor broker]
  Broker --> Jobs[Untrusted ephemeral containers]
  Security --> Broker
  Publisher --> Draft[Branch and draft PR]
```

## State ownership

LangGraph checkpoints are the source for workflow continuation, including pending interrupts and role-agent continuation. Application tables index admitted orders, project configuration, progress projections, human responses, usage reservations and external-effect receipts. Procrastinate schedules execution; it does not implement a second order state machine.

Admission and job creation occur in one PostgreSQL transaction. Checkpoints use synchronous durability. A graph version and plan revision bind every execution. Revisions invalidate questions, plans and evidence from the previous scope. A client disconnect has no effect on execution. Pausing and cancellation are applied at safe boundaries; an already executing tool may finish first.

Owner responses are accepted transactionally only for an unanswered question in the current plan revision. Delivery effects use a durable operation key and inspect the target branch/PR before retrying an uncertain response. No claim of exactly-once execution is made for external systems.

## Development graph

Intake → analysis → clarification when necessary → architecture within launch permissions for CREATE → task plan → implementation → independent gates → technical review → independent security → correction or delivery.

PATCH reproduces and corrects a bounded defect. MAINTAIN preserves the target's stack and conventions. CREATE compares viable stack and structure choices and requires approval of architecture outside its launch permissions. The task plan is checked for duplicate identifiers, missing dependencies and cycles. Specialists receive bounded, role-specific tools and context. Reviewer and QA contexts are separated from the developer's narrative.

The task DAG covers product changes. Snapshot admission and dependency preparation precede the agents; independent QA, gates, review, security and publication follow their work. A small patch should keep its regression and fix in one coherent task unless independent work warrants splitting. The workspace has no Git metadata: agents use snapshot provenance, while the controlled publisher creates commits, branches and draft PRs. An inherited task requiring an unavailable operation must request clarification rather than claim completion.

CLI-only work can use per-agent controls instead of cumulative usage ceilings. An owner-authorized, revision-checked transition clears all three cumulative caps together while preserving recorded usage and existing checkpoints. Admission verifies CLI routing and every reservation requires a destination-bound CLI context receipt with zero API cost; API and embedding calls still require bounded authorization. LangGraph's existing 50 steps and a ten-minute deadline bound each agent invocation, alongside two correction cycles, per-tool limits and normal HITL/error/security stops. Metrics continue accumulating without being treated as completion criteria. No secondary execution engine or progress journal is introduced.

Tasks separately identify an authorization role and a technical specialty: general, backend, frontend, infrastructure or documentation. Specialization does not grant new tools. The analyst and architect inspect actual manifests, boundaries and conventions before recommending a structure. Backend/frontend/infrastructure may coexist; a registered project currently targets one repository, and related repositories require separately authorized orders. Cross-repository atomic delivery is not implemented.

Design recommendations identify the problem, alternatives, affected files and tradeoffs rather than selecting patterns by name. Documentation work maintains existing guides and canonical OpenAPI contracts, verifies examples and regenerates client types. UI work requires user-visible behavior checks and actual rendered evidence when visual acceptance is relevant. The current Codex adapter is text-only: browser test output can be assessed, but it does not provide model-based screenshot review. Missing browser or visual evidence must be reported instead of inferred from a successful build. Playwright's [testing guidance](https://playwright.dev/docs/best-practices), [OWASP ASVS](https://asvs.owasp.org/) and the [pattern selection criteria](https://learn.microsoft.com/en-us/azure/architecture/patterns/) are reference sources, not blanket compliance claims.

There are two correction cycles after an initial implementation. Scanner infrastructure failures, exhausted budgets, missing configuration and invalid authorization block explicitly. Read failures eligible for retry are bounded. A failed test is evidence for correction, never a reason to weaken the gate.

Specialist questions interrupt the graph, including planning, implementation, QA and review. Each answer is checkpointed separately. Material dependency, runtime, build and infrastructure changes require an owner permission bound to the exact selected manifests. A generic description cannot authorize a later, different change.

## Trust boundaries

Project contents, memory and tool results are data, not instructions with authority. The control process holds provider credentials. Jobs never receive them, the Docker socket or owner directory mounts. The executor broker is the only Docker-capable component. Workspaces and gate environments are separate; gates are evaluated against the approved source snapshot.

The [credential storage decision](credential-storage.md) defines the separate vault database, authenticated encryption and automatic unlock. The project/memory role cannot connect to the vault. Only trusted API/worker/control processes receive its database credential and read-only master-key mount. Service-specific bootstrap files replace secret environment values. Fixed-purpose authenticated adapters supply GitHub read access to the executor and Slack tokens to the gateway; their tokens cannot access owner APIs or another adapter. Credential values are absent from OpenAPI output models, MCP tools and agent state.

Credential identifiers bind the hosted provider or canonical endpoint digest. Explicit role deactivation suppresses default fallback. Agents check the vault revision before and after model/tool calls, blocking for resume after a change. Publisher and Slack notification requests resolve current credentials at each operation. The Slack gateway rechecks credentials every ten seconds and reconnects on change; in-flight upstream requests cannot be revoked by SABRE.

All file access is confined to a work order. Secret checks run before model calls and before content enters memory, ordinary outputs or the artifact store. Supported secret detection is a control with testable coverage, not a guarantee that arbitrary sensitive text can be recognized.

Credential-URL detection recognizes the literal `user:password` placeholder only in unambiguous HTTP(S) URLs without an explicit port whose host is exactly `example.com`, `example.net` or `example.org`, the example domains reserved by [RFC 2606](https://www.rfc-editor.org/rfc/rfc2606.html#section-3). This content rule applies equally to checking and redaction; it is not a file exclusion. Different credentials, other hosts, encoded or ambiguous forms remain subject to detection. Known factory secrets and all other credential patterns are checked independently, including inside examples.

Tool schemas and role permissions are checked locally. MCP annotations supplied by external servers do not grant permissions. External servers and allowed tool names are registered by the owner, and changing servers does not implicitly expand access.

The dynamic MCP registry stores revisioned public HTTPS endpoints and approved manifest digests in PostgreSQL. Save/edit disables the connection atomically; role selection, project assignment and activation are independent commands. Active project execution holds the same lock required to change its allowlist. Dynamic connections resolve only public addresses, pin the chosen address to the transport and retain the original TLS hostname. They reject redirects, compressed responses and automatic authorization discovery. The published contract is rechecked before exposure and invocation; this detects contract drift, not a malicious remote implementation. Read-only upstream credentials remain necessary.

Each subscription CLI has a separate process, bridge and authentication volume, no project mounts and no control database, master key or GitHub access. Its result requests actions from the same SABRE catalog used by API models. Codex's pinned native policy disables shell/image tools and runs read-only. Claude exposes only its internal JSON-schema formatter, with operating tools, MCP, hooks and customization discovery disabled. It uses an empty temporary working directory and admits verified personal subscriptions only; organizational or unknown policies block invocation. The formatter returns an AssistantEnvelope, not an executable action: SABRE separately validates every requested action against its authorized catalog. Deterministic checks exercise the actual pinned binaries against synthetic providers before account connection. CLI duration, concurrency and output are bounded, but internal provider requests and aggregate tokens cannot be pre-counted exactly.

The panel and MCP use one durable model configuration with compare-and-swap revisions. Every role explicitly overrides or inherits the default; a change requires approval of the selected data destinations, preserves deployment capability restrictions and does not transfer credentials between providers. API and worker refresh this revision at existing credential boundaries. A changed revision interrupts pending sends instead of silently switching an in-flight agent. Reservation receipts bind the selected provider, configured model and configuration revision to the existing usage ledger. Their byte counts measure LangChain input material before CLI transport wrapping. CLI JSON visibly escapes DEL/C1 controls while preserving decoded content and ordinary UTF-8; it does not rewrite sources or checkpoint history. Historical missing attribution and unsettled reservations remain unknown. Model aliases identify a selection, not a resolved model version; heterogeneity is an experiment to assess, not an assumed quality improvement.

## Security graph

The independent graph collects scanner evidence, applies the owner-approved baseline and produces a blocking decision. Gitleaks handles secrets; Trivy handles dependencies and configuration; Semgrep CE handles code rules. A scanner that is missing, fails or produces an incomplete report blocks assessment. Secrets and new high/critical findings block delivery.

Findings bind the source snapshot and rules configuration. Baselines are explicit owner configuration. Expiring exceptions require an owner justification and bind one finding, work order, plan revision, snapshot and rules version. The independent graph validates them; neither scanners nor agents can supply an accepted exception id. Secrets and scanner failures remain blocking. Delivery evidence records the policy digest and exception ids; expiry or revocation invalidates pending publication.

The daily watch scans registered projects and records prioritized remediation tasks; it never launches a patch order by itself. Recommendations retain scanner references, source locations and fixed dependency versions when available.

## Memory and diagnostics

Checkpoints, project knowledge and execution lessons are distinct. Memory records have a project scope, source work, commit, evidence reference, activation and invalidation state. Only facts mechanically derived from successful delivery evidence activate automatically. Free-text facts and lessons require owner approval. Retrieval filters active records by scope and source commit; embeddings are derived data.

The source index is a separate derived navigation cache keyed by project, path, content digest and index version. The current guarded snapshot controls file membership and freshness; cached metadata cannot replace source verification. Role context contains bounded references, and source tools provide literal search and line ranges with provenance. This does not automatically make a lesson valid after its source commit changes, nor does it eliminate reading changed source bytes. Context and cache measurements must precede any claim of token savings.

The analyst can pass a bounded summary and decisions to the supervisor through the same LangGraph checkpoint. This short-term handoff retains work, project, plan revision, snapshot and commit provenance; only a matching current snapshot may use it. It remains untrusted data, separate from approved project memory, with truncation and omissions reported explicitly. Patch navigation starts with at most twelve relevant paths, prioritizing named files and manifests; complete source search remains available. Existing child checkpoints retain their instruction identity and saved messages instead of replacing their history with a smaller context.

LangGraph/LangChain remain the orchestration and agent frameworks. PostgreSQL stores relational contracts and pgvector supports optional semantic retrieval. LlamaIndex's [ingestion pipeline](https://developers.llamaindex.ai/python/framework/module_guides/loading/ingestion_pipeline/) provides reusable transformation caching and document management; it is an option when a broader document corpus needs those operations. Its [property graph index](https://developers.llamaindex.ai/python/framework/module_guides/indexing/lpg_index_guide/) is relevant when measured retrieval tasks require relations. Neither a second ingestion framework nor a graph database is required for bounded source navigation today. Adoption needs representative retrieval labels, provenance/invalidations, resource measurements and compatibility checks; the workflow graph is not a knowledge graph.

OpenTelemetry spans cover orders, graph nodes, role agents, model calls and tools. They export allowlisted identifiers, phases, roles, timings, usage, error codes and outcomes to a local endpoint. Prompts, code, model responses, credentials and raw exception text are excluded. The shipped HTTP servers disable access logs so query strings do not become a content log. Interrupts and pause/cancel control are normal control flow. Exporter failure cannot replace the application result.

The owner-facing audit is a bounded projection of the existing LangGraph child checkpoints and usage ledger. It exposes role, plan revision, tool name, response state, recorded exit code and usage without returning prompts, arguments or tool output. A received tool response is not a passed gate. Unsettled usage remains reserved, absent timings remain unknown, and truncated projections are labelled. This projection does not maintain a second execution state machine. The memory panel separately reports approved records, resumable checkpoints and recorded source references; saved context does not establish current source freshness.

The integration catalog groups capabilities with their credential destinations and role policies. Persisted connection switches are owner commands with revision checks and an atomic audit event. GitHub resolves its enabled state at each request; agents revalidate connection and credential revisions at tool/model boundaries, including anonymous MCP access. Configured endpoints and project allowlists remain the authority for which external tools can be exposed. Repository discovery projects only selected GitHub fields and revalidates imports; it does not create remote repositories or start development work.

Repository creation uses a separate immutable proposal and dedicated credential. An owner decision binds revision and request digest; approval and Procrastinate admission share a transaction. A worker claims the proposal before its only POST attempt. Verified receipts bind GitHub id, full name and visibility. Lost or unverifiable responses require read-only reconciliation; a matching name alone cannot establish provenance. Creation does not register a project, initialize source or start an order.

The LangChain middleware projects older large internal read responses to historical references in an invocation-local request. It guards original material, archives original bytes, applies `request.override`, guards the projected material, checks the complete request ceiling and reserves usage in that order. LangGraph checkpoints retain full messages, call ids, arguments and child identity. Human instructions, actions, execution output, failures and recent turns remain intact. Recovery authority derives from original call/response pairs in the current child and is rebuilt before resuming pending tools; the entire original passes today's secret guard before paginated recovery. No summarization model or second execution store is introduced.

Context receipts belong to the existing model-usage reservation transaction. Their scoped request digests, byte counts, policy and reference coverage establish what was projected without persisting another prompt log. Audit aggregates preserve unknowns for legacy calls and unmeasured recovery intervals. Codex serialization retains the same JSON contract and places stable instructions/tools before the changing conversation; improved common-prefix opportunity does not establish actual cache reuse or token savings.

Task packets carry bounded completed-dependency observations and a source delta checked against an immutable metadata index captured at intake. An old checkpoint without an index cannot claim a delta. Approved memory retrieval remains project/commit-scoped in PostgreSQL, supplying at most four excerpts within 6 KiB and a guarded recovery tool; no eligible memories means no embedding call or memory-tool schema. These packets do not replace independent source review, deterministic gates or approval. Exact source replacements use an expected digest checked under the same broker lock as the write, preventing concurrent lost updates.

Annotated evaluation compares actual work records against independent, revision-linked labels and commit-linked functional verdicts. It counts false approvals, incorrect blocks, recorded consumption and elapsed/active latency. Missing evidence remains unknown; completing a workflow is not itself proof of functional correctness.


## Public factory contracts

`contracts`, `flow_contracts`, `phase_results`, `commands` and `events` define the shared wire types. Extra fields are rejected. Version numbers are integers, never booleans or strings. Phase outcomes require an explicit status and evidence field; deterministic gates decide advancement. The legacy internal result adapter requires an explicit acceptance value.

`Runtime` is the composition root. `FactoryService` owns authorization and admission, `Factory` owns the versioned LangGraph topology, and provider/tool/publisher adapters retain their existing boundaries. `flows` resolves immutable launch selections and `skills` registers bounded, versioned instructions. `migrations` records SQL checksums; repository connections use a bounded pool with session-lock cleanup.

`POST /api/v1/commands` and `sabre_command` share strict command envelopes. Command receipts deduplicate completed effects and retain correlation identifiers. Uncertain controls are rejected until the caller inspects current state; submitting again uses the existing transactional work-admission key. Existing REST/MCP operations remain compatibility adapters over the same application service.

Execution events and notification outboxes are persistent projections. They never decide graph transitions. Phase, agent and tool observations contain identifiers and measured durations, not prompt or tool content. Signed webhook retries and Slack reconciliation are isolated from the execution graph; delivery failure cannot claim workflow success.
