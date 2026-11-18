# Operations

This guide assumes the [installation steps](../README.md#start) are complete. Read the [compatibility limits](compatibility.md) and [threat model](threat-model.md) before connecting a repository. Commands run from the checkout root; `npm link` optionally makes `sabre` equivalent to `node bin/sabre.mjs`.

## Configuration and access

`init` creates service-specific protected bootstrap files and a 32-byte vault master key in Docker volumes. The ignored `.env` contains public configuration and file paths only. Raw secret environment variables, including empty placeholders, are rejected. Enter integration credentials through the write-only panel controls; configuration exports contain no credential values.

`node bin/sabre.mjs up` starts services and opens a paired browser. Use `open` to pair another browser or `up --no-open` without a desktop. Pairing uses a sixty-second, single-use loopback relay; it does not print the grant or permanent credential. The permanent owner credential stays in the API container.

Browser sessions use an HttpOnly, SameSite cookie, CSRF validation and exact origin/host checks. They expire after 30 idle days by default (`SABRE_PANEL_SESSION_DAYS`, maximum 90). **Config › Access** lists paired browsers and revokes sessions. Logout revokes the current session. `SABRE_PANEL_ORIGIN` must match the exact local origin and port; it does not enable remote access.

Configure [model providers](providers.md) in **Config › Models** and GitHub, MCP and notification connections in **Tools**. Connections have independent enabled states and revision checks. Disabling one blocks subsequent call boundaries; an already sent request can finish. Deactivating a stored credential does not revoke it at the upstream provider.

For an installation using the previous secret-bearing `.env` layout, build the current `postgres` and `api` images, run `node bin/sabre.mjs migrate-credentials`, then `up`. Migration quiesces this factory, verifies encrypted imports and removes secret fields atomically without a plaintext backup. An interrupted import reconciles identical values only; conflicting destination values require review.

## GitHub and project gates

In **Runs › Projects › Add project**, choose a repository available through GitHub, enter a repository address or propose a new repository. Existing projects need an initialized base branch. Register the environment and real verification commands as explicit argument arrays, for example:

```json
["python", "-m", "unittest", "discover"]
```

For a Node project, a gate can be `["node", "--test"]`. Commands must work against the source checkout within the selected runner. Python uses 3.14 and compatible locked wheels. Dependency preparation has restricted registry access; code execution and final gates have no network. Unsupported locks or unavailable dependencies block intake before model work.

**Tools › GitHub › Connect GitHub** creates a private GitHub App on the selected account or organization. Complete it within one hour from the same paired browser, then select repositories on GitHub. The app key remains in the vault. Each read/delivery operation mints a short-lived, repository-scoped token with its required permissions. This path has been tested against a synthetic GitHub service only.

Disconnect removes credentials from SABRE; uninstall/delete the app on GitHub separately. If registration succeeded but SABRE did not receive the app key, delete that app on GitHub before reconnecting. Token-based installations use separate `github.read` and `github.publish` credentials. Repository creation always uses the dedicated `github.create` credential with upstream creation/administration permission.

**Add project › New repository** creates an immutable owner-reviewed proposal. An uncertain response requires reconciliation, never a repeated POST based only on a matching name. The repository is empty; initialization and project registration are separate actions. The initialized **create-and-launch** operation is described in [configuration](configuration.md#create-a-new-repository-at-launch).

Project edits compare revisions and are refused while execution is active. Archive refuses projects with unfinished work and retains runs, memory and evidence. Restore reverses archival; the console offers no project deletion.

## Launch and inspect work

Choose `patch`, `maintain`, `create` or `audit`, then supply the objective, observable acceptance criteria, constraints, models, permissions and budget. Draft PR publication, dependency changes and architecture changes are separate permissions. Merge and deployment remain outside the workflow.

The normal path is intake, analysis, task planning, implementation, deterministic gates, independent QA/review, security and draft PR delivery. A failed gate blocks advancement. Audit requires unchanged source and produces evidence. [Configuration](configuration.md) describes immutable flow/specialist snapshots and model precedence.

Use Activity and inspection views to check recorded tool responses, exit codes, usage and decisions. A completed model reply is not evidence that a command ran. Deterministic checks run against the exact snapshot; QA receives their recorded command, exit status, digest and bounded output. Final publication checks the delivery snapshot again.

Publication uses controlled GitHub APIs outside coding containers. It verifies the base commit, gates, review and security results, and reconciles uncertain effects through durable receipts. It does not force-push. New branches use `fix/sabre-…` for patch, `feat/sabre-…` for create and `chore/sabre-…` for maintain. Historical deliveries retain their recorded branch on recovery.

## Owner Supervisor conversation

The Supervisor is available throughout the authenticated panel in factory or run context. Messages default to read-only; grant specific action tools per message. A run-scoped conversation cannot modify another run or factory policy. Coordination and independent judging use separate contexts.

A connected provider and explicit model are required. **No model** links to configuration; a previously submitted blocked message stays recorded until resumed. Conversation inference has a separate bounded allowance and monthly spend policy. It cannot increase a run budget, waive security, merge or deploy.

Messages and grants survive restarts. After an uncertain reply, inspect/reconcile the existing message before submitting another. Resume retains its identity and original grants. Unknown model usage stays reserved. A new message does not recover an older incomplete checkpoint automatically.

Owner MCP tools include `sabre_talk_supervisor`, `sabre_supervisor_messages` and `sabre_resume_supervisor_message`. They are intended for trusted owner clients, not delegated agents.

## Operating from the terminal

| Command | Purpose |
| --- | --- |
| `sabre runs --state attention` | List runs needing attention (`active`, `closed` and `all` are also available) |
| `sabre run <run>` | Inspect usage, current questions and tasks |
| `sabre watch <run>` | Follow recorded events until the run settles |
| `sabre ask "<message>" --run <run>` | Send a read-only Supervisor message |
| `sabre answer <run> <question> "<answer>"` | Answer a clarification or file an owner decision for confirmation |
| `sabre pause <run>` / `sabre resume <run>` | Control execution at safe boundaries |
| `sabre cancel <run> --yes` | Cancel remaining work |

Identifiers accept unique prefixes or suffixes. Commands use the in-container MCP client; they do not copy the owner credential to the host.

## MCP access

For trusted local clients, configure `node` with the absolute path to `bin/sabre.mjs` and `mcp-stdio` as separate arguments. See the [client example](configuration.md#mcp-and-slack). Start SABRE first. The bridge acts with owner authority and keeps the credential inside the API container.

`node bin/sabre.mjs mcp tools` lists the catalog. Call a tool with `node bin/sabre.mjs mcp <tool-name> work/arguments.json`; use the schema's JSON object, including a `request` wrapper where required. Inputs are limited to 64 KiB and output to 1 MiB. A timeout never retries a mutation automatically: inspect the recorded state first.

The authenticated Streamable HTTP endpoint is `/mcp/`. Configure bearer authentication through the client's supported secret controls; keep tokens out of source-controlled configuration. The explicit `node infra/ops.mjs access-token` command is for an owner terminal only and reveals a credential; the browser and local bridge do not need it.

Submission returns a durable work ID. Answers bind the question ID and plan revision; stale/repeated answers are rejected. Native elicitation is optional client support; durable IDs and the explicit answer tool remain the compatibility path.

### Owner confirmations

Budget amendments, security exceptions, architecture/permission/scope decisions and repository creation requested through MCP are filed as pending requests. They take effect only when the owner confirms the exact displayed request in a paired browser. The Supervisor inbox shows pending, failed and uncertain outcomes.

`sabre_confirmations` and `sabre_confirmation` inspect requests; no MCP tool confirms one. Confirmation uses the request digest and normal revision checks, at most once. Requests expire after 24 hours. Failures record their code; an unknown outcome remains `applying` for inspection and is not retried automatically. Clarifications, submission, pause, resume, cancel and scope-change commands retain their existing authorization rules.

### Remote agents

Issue a project-scoped delegated credential with explicit operations, expiry (up to 24 hours), run count and cumulative limits. It is shown once and stored only as a hash. `/delegated/mcp/` rechecks grants on every call and refuses the owner token. Delegates query their own work, submit within scope, answer clarifications and cancel their own runs. They cannot approve architecture, dependency changes, exceptions, budgets or publication. A2A ingress uses the same scoped delegation boundary.

The API binds to loopback. Remote access requires an authenticated TLS network path, such as a private tunnel; do not expose the API port directly to the internet.

## Budget recovery

Default run limits are 40 model invocations, 100,000 tokens, one hour of active work and two repairs. Each metric can have a finite preauthorized reserve or an explicitly uncapped cumulative policy. Paid API spending and factory monthly spending remain separately bounded. CLI subscription use is not an API charge.

A call can be blocked below the displayed ceiling: measured consumption **plus unsettled reservations plus the next call's reservation** must fit. Read the recorded denial rather than comparing only consumed tokens. CLI aggregate tokens may be known only after a call.

1. Inspect the denial, authorization revision and unknown reservations.
2. Reconcile uncertain usage explicitly when required. This retains the complete listed reservation as unknown consumption; it never replaces it with zero.
3. Review and save a limit amendment, reserve or ceiling removal for the intended metric. Other metrics and API authorization still apply.
4. Use the explicit resume/recheck action. Saving a policy alone does not resume execution. If the next reservation still cannot fit, inspect the new denial.

Versioned policies use `sabre_amend_budget` and `sabre_reconcile_budget`; over MCP these require browser confirmation. Legacy flat-limit tools apply only to historical orders without a policy and reject versioned runs with `VERSIONED_BUDGET_REQUIRED`. No path resets consumption or checkpoints. Three identical gate/source/task outcomes trigger the default no-progress intervention independently of available budget.

## Security decisions

Daily monitoring scans registered projects at 08:00 UTC without model calls and records remediation proposals. It never starts development work. The newest review is current; prior records remain available by ID. Scanner errors and secrets block assessment. New high/critical findings block delivery unless the owner accepts that exact eligible finding.

An exception binds a finding fingerprint, justification, expiry (at most thirty days), snapshot, rules version and plan revision. Review it in the panel, or file `sabre_approve_security_exception` over MCP and confirm it in the browser. Resume for a new security review. Secrets and incomplete scanner results cannot be waived. Source/rules/scope changes invalidate approval; publication rechecks expiry. Revocation does not undo a published PR.

## Pause, failures and recovery

Pause takes effect at a safe boundary; an in-flight tool may finish. Resume retains the work ID and checkpoint. Cancel cannot undo an external effect. Stalled worker jobs recover through queue heartbeats; model usage and remote effects retain separate receipts.

A scope change requires paused/blocked work, increments the plan revision and invalidates earlier plans/evidence. On resume it resolves the current base and replaces the previous workspace. Inspect pending changes before revising scope. Usage and historical checkpoints remain. After a lost response, read the current revision before repeating a command.

Snapshot persistence or incompatible volume ownership errors require inspection. The launcher provisions its own executor-state directory and refuses unknown/incompatible entries; it does not recursively repair arbitrary volume contents. After correction, resume the same work ID. If intake never saved a snapshot, retry resolves the current base again.

### Backup and restore

Quiesce the application before backing up. Back up both PostgreSQL databases, artifacts and broker snapshots, and retain exact configuration and application/database images. Preserve bootstrap/master material separately in a protected owner-controlled destination. The encrypted database alone cannot recover a lost master key.

```sh
node bin/sabre.mjs backup
node bin/sabre.mjs verify <backup-directory>
```

Backups default to `work/backups`. Format 2 includes encrypted vault data, not protected bootstrap/master files. Verification restores a scratch instance, checks integrity, decrypts with the original retained master and resumes a synthetic restored LangGraph intervention. It does not prove recovery after master-volume loss.

`node bin/sabre.mjs restore <backup-directory> --replace` replaces this factory's data. Review the destination and preserve its current data first. Restore with matching images and key material; validate a pending question, source artifacts and vault decryption before reopening access. Never use broad Docker prune operations while backups depend on existing volumes/images. Database downgrades require the older version's matching backup; do not point older code at a newer schema.

## Verification

After startup, run `node infra/runtime-check.mjs` to check authentication, secret separation, effective CLI policy and sandbox behavior through the deployed Docker proxy. Its isolated workspace checks network/socket/credential denial, snapshot-bound gates and restarted broker recovery; it does not start a product run.

The real-API browser fixture is separate from production, with its own database, bootstrap material and loopback port 8001:

```sh
node bin/sabre.mjs build api
node infra/qa.mjs up
node infra/qa.mjs check
node infra/qa.mjs down
```

Always stop the fixture after checking, including after a failure. It has no model provider or worker; no journey launches work. If its served panel differs from the working tree, rebuild `api` and run `node infra/qa.mjs refresh`. The mocked `pnpm test:browser` suite tests different boundaries. Neither proves live-provider delivery. See [development](development.md) for the complete check commands.

## Candidate distribution

Install the complete GitHub source release, not the backend wheel. Review [compatibility](compatibility.md), source inventories, notices and image advisories for the exact candidate. Artifact generation is documented under [source distribution](development.md#source-distribution).

Source archives exclude history and untracked local configuration. A public repository separately exposes reachable history. Published archives remain tied to their original commit; current documentation changes do not replace an earlier release.
