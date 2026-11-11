# Flows and external communication

## Factory configuration and specialists

`GET /api/v1/configuration` returns the same versioned factory document used by the guided editor and YAML. Preview validates fields and shows a diff without mutation; save compares the current revision and commits model selection and factory settings together. The launch snapshot and resolved phase selection use the same model revision. Configuration documents, diffs and exports contain no credential values. A configured delivery credential is not reported as verified repository access.

`GET /api/v1/agents` lists PM, Designer, Developer, QA, Manager (displayed as Supervisor), DevOps and CISO. Save a draft with its expected revision, validate it, then publish it through the corresponding `/agents/{id}/draft`, `/validate` and `/publish` operations. Definitions contain instructions, registered capability steps, skill digests, optional model selection, a context bound and an optional tool restriction. Procedures contain at most four registered steps per capability. They cannot execute YAML code or expand code-defined, project or owner grants. Unsupported model-based visual review blocks validation instead of being reported as completed.

Developer owns architecture and implementation. Designer advises explicit interface planning; DevOps independently inspects delivery preparation. Manager planning and independent review use different invocations. Each launch pins immutable published definitions. New owner messages separately pin the Supervisor definition at admission, preserving their original action grants through retries.

## Launch configuration

The panel editor and YAML import use `FlowConfiguration`, defined in `backend/src/sabre/flow_contracts.py`. Retrieve its JSON Schema through `/api/v1/flows/schema` or the `sabre_flow_schema` MCP tool. JSON and YAML reject unknown fields, wrong types, duplicate keys and unsupported versions. YAML anchors and executable tags are rejected.

```yaml
version: 1
repair_cycles: 2
permissions:
  architecture: true
  dependency_changes: false
  draft_pull_request: true
phases:
  implementation:
    skills: [engineering]
  review:
    skills: [review]
```

Add a `model` to a phase, or a selection under `phase_models`, using the same provider/name/destination contract as Integrations. Precedence is run `phase_models`, flow phase `model`, published specialist model, legacy role configuration, default configuration. A specialist with no model override preserves existing role inheritance. Destinations must already be approved. Explicit model names and available credentials are required; the factory does not fall back to another provider. CLI sessions use official binaries and separate authentication directories. Their tokens are never converted into API credentials.

A run retains the resolved selections, model revision, graph/flow versions, skill digests and configuration digest. Global model changes affect later runs. Credential revocation applies immediately at the next authorized call. Restoring a run requires its recorded skill versions. Skills provide bounded instructions and cannot expand permissions.

The request also includes its project, objective, acceptance criteria, constraints, budget and idempotency key. Keep the key when retrying an uncertain submission. Default limits are 40 model calls, 100,000 tokens and one hour of active work, with zero API spending authorization until explicitly configured. CLI-only progress controls are an explicit alternative and preserve recorded consumption. Prices must be configured for API phases.

## Budget authorization and recovery

`Budget.policy` at launch, or the flow's `budget_policy`, accepts version `1` with independent `tokens`, `invocations`, `active_seconds` and `repairs` metrics. Each metric has `primary`, `reserve` and `absolute`: a bounded metric uses `{primary: 40, reserve: 0, absolute: 40}`; a finite preauthorized reserve uses `{primary: 40, reserve: 10, absolute: 50}`; uncapped cumulative work uses `{primary: null, reserve: 0, absolute: null}`. Zero repairs permits no repair. API spend stays in `max_cost_usd`; zero never authorizes paid API work. Historical budget requests remain readable and new durable admissions adapt their original limits into an immutable policy.

The runtime activates a finite reserve once, atomically, and records its authorization. `GET /api/v1/work/{id}/budget` distinguishes measured usage, unsettled reservations, remaining ceilings and CLI measurements that cannot establish an exact preventive token cap. `/budget/amend` requires the expected budget revision, one metric, its new policy and an owner reason; it can also request resumption. Initial launch snapshots and consumption receipts are retained.

Unknown provider outcomes require reconciliation before a versioned run resumes. `/budget/reconcile` records the owner's explicit decision to retain the complete listed reservations as unknown consumption; it does not replace them with zero or invent actual usage. Existing publication and external-agent receipts still reconcile uncertain effects. Exhaustion preserves checkpoints and failed verification continues to block delivery after an amendment. The versioned no-progress threshold defaults to three identical gate, snapshot and task outcomes, independently of agent prose. Supervisor conversations use their separate bounded allowance.

## Create a new repository at launch

In Integrations, open **Create a repository and launch its flow**, review its exact owner, name, visibility, checks and budget, then grant the explicit creation permission. The same strict request is available at `POST /api/v1/create-flows` and `sabre_launch_create`. It requires version `1`, `authorize_repository_creation: true` and `repository.initialize: true`. The dedicated `github.create` credential must be configured. GitHub initializes the default branch; the receipt binds the project to the branch GitHub actually returned.

The launch stores its resolved flow before enqueueing repository creation. Reusing the repository request key preserves that snapshot and rejects changed scope. An uncertain GitHub outcome requires reconciliation; the factory never repeats an unconfirmed creation. After a confirmed receipt, project registration and work admission use fixed identities. Retrying an interrupted continuation cannot enqueue a second flow. Existing-repository create flows remain available from Runs.

## Events and recovery

`GET /api/v1/work/{id}/execution-events?after=0&limit=200` returns versioned events with monotonically increasing sequence numbers, run/revision identifiers, correlation IDs and measured durations. Continue with `next_cursor` while `has_more` is true. Event payloads omit prompts, tool arguments, code and complete responses. Older runs may lack timing data.

LangGraph remains the execution authority. Event tables are read projections; notification receipts do not decide phase transitions. PostgreSQL migrations are ordered, transactional and checksum-verified. Back up the database, artifacts and protected master key together before an upgrade; use the corresponding application version to restore.

The authenticated `/work/{id}/inspection` projection pages recorded visible messages, tool calls and results. It omits provider reasoning fields and system messages, redacts detected secrets and marks truncated history. Invocation identifiers resolve only within the selected run. Repository registration and intake enqueue rebuildable, commit-bound source indexes through the existing worker; indexes remain evidence and navigation data, never approvals or instructions.

## MCP and Slack

Use `node bin/sabre.mjs mcp-stdio` as the local MCP transport. The bridge keeps the permanent credential inside the API container. `node bin/sabre.mjs mcp tools` lists tools for command-line use; pass a tool name and an argument JSON file to call one. Native elicitation requires a direct authenticated MCP HTTP connection; the standard answer tool is available through stdio. Tools share application authorization, request validation and revision checks with the panel. MCP can submit, inspect, pause, resume, cancel and answer a current intervention. A disconnected client does not cancel a run.

In an MCP client that supports local stdio servers, select `node` as the executable and pass the absolute path to `bin/sabre.mjs` followed by `mcp-stdio` as separate arguments. For clients using the `mcpServers` JSON format:

```json
{
  "mcpServers": {
    "sabre-factory": {
      "command": "node",
      "args": ["/absolute/path/to/sabre-factory/bin/sabre.mjs", "mcp-stdio"]
    }
  }
}
```

Replace the example path with your checkout path. On Windows, forward slashes work, including paths with spaces, such as `D:/workspace/sabre-factory/bin/sabre.mjs`. Keep the path as one argument. If the client cannot find Node, use its absolute executable path. Start SABRE before connecting; a successful connection lists the tools but does not authenticate model providers or grant GitHub permissions. No bearer token belongs in this stdio configuration. Only connect trusted local clients: this connection acts as the factory owner.

Install a Slack app using [the manifest](../infra/slack-manifest.yml), enable Socket Mode, and create an app token with `connections:write`. Store bot/app credentials through the factory credential controls. Set `SABRE_SLACK_OWNER_ID` to the one explicitly linked owner. Only direct messages from that owner are admitted. Repository text and tool output cannot authorize commands. Do not send secrets in Slack messages.

Delivery records use deduplication and a bounded retry schedule. Uncertain Slack effects are reconciled against receipts and message metadata before another send. They are shown as uncertain if confirmation is impossible; they are never blindly reposted. Failed deliveries can be retried explicitly from Integrations after fixing the cause.

## Signed webhooks

Configure public HTTPS destinations in the ignored instance `.env`:

```dotenv
SABRE_WEBHOOKS={"builds":{"endpoint":"https://notifications.example.com/sabre"}}
```

Store at least 32 random characters as the vault credential `webhook.builds`. The endpoint and credential name are separate; configuration files must not contain the key. Restart API and worker after changing destinations. A changed destination does not inherit pending deliveries for the old endpoint.

Every body is a versioned `work.updated` notification containing identifiers, status, phase and revision. It excludes request text, findings, prompts and credentials. Headers are `X-Sabre-Event-Id`, `X-Sabre-Timestamp` (Unix seconds), and `X-Sabre-Signature` (`v1=` plus a SHA-256 HMAC in hex).

Verify the HMAC over `timestamp + "." + event_id + "." + raw_body` using the shared key and a constant-time comparison. Reject timestamps outside your replay window and deduplicate by event ID. Delivery is at least once: a timeout may occur after the receiver accepted a request. A successful 2xx response acknowledges it. Retryable failures back off, stop after six attempts and remain visible. Explicit retry preserves the event ID.

Only port 443 is allowed. Credentials in URLs, redirects, private destinations and DNS rebinding are rejected. Targets resolve to pinned public addresses for each request. Outbound webhooks do not accept inbound commands; use authenticated MCP or Slack for control.
