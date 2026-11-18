# Model providers

## API configuration

In **Config › Models**, choose OpenAI, Anthropic, Google or an explicitly configured local OpenAI-compatible endpoint. Enter the credential in the write-only field, choose an explicit model name, review its data destination and configure prices and spending limits. Credentials are encrypted in the vault; configuration exports contain no secret values.

Use API providers for deployments shared with or operated for others. The isolated CLI sessions below are alternatives for the owner's personal machine. Check the vendor's terms for the account and intended use. SABRE cannot establish subscription eligibility on the owner's behalf.

Choose the default in Config and overrides in Agents or individual flow phases. An override requires the selected provider's credential; it cannot inherit another provider's key. There is no automatic provider fallback. Changing a model does not increase a budget or resume blocked work. A conflicting configuration edit requires refreshing its revision.

Input/output prices are per million tokens. Optional cache-read and cache-write prices apply to those portions of input; otherwise the ordinary input price applies. Anthropic API requests mark tool, instruction and conversation cache boundaries with a five-minute lifetime. A configured price is accounting input, not a provider invoice.

## Codex CLI session

Run the native-policy check on a new host **before** connecting an account:

```sh
node infra/dev.mjs codex-policy
```

For an existing installation:

```sh
node bin/sabre.mjs prepare-codex
node bin/sabre.mjs build api
node bin/sabre.mjs build codex-runner
node bin/sabre.mjs up
node bin/sabre.mjs codex-login
```

Complete the official login in the owner's terminal, then select Codex and an explicit model in Config › Models. Authentication lives in a dedicated protected volume. SABRE does not import the owner's interactive Codex credentials.

The pinned CLI runs read-only with native shell/image tools disabled, no external MCP servers and bounded input/output. It has no project mount, Docker socket, database access, GitHub credential or vault master key. Structured replies request actions from SABRE's role-scoped tool catalog; the CLI does not execute those actions itself.

Native checks use the actual pinned binary with synthetic providers and no account. The seccomp policy is derived from Moby's profile with the scoped namespace/mount calls needed by Codex's bundled bubblewrap. Host security modules still apply: AppArmor can deny mounts even when seccomp permits them. A failed positive control means the sandbox is unavailable; do not interpret it as proof of isolation or disable host security to bypass it. The uniquely scoped CI AppArmor helper is restricted to GitHub-hosted CI and is not a deployment policy.

`node infra/codex-profile-check.mjs` checks Compose transport and exact 64-bit values in the profile. Do not round the policy through JavaScript JSON parsing. Apache-2.0 and LGPL notices are retained in [infra/licenses](../infra/licenses/) and `/usr/share/licenses/sabre-codex/` in the runner image.

The bridge accepts commentary followed by exactly one schema-valid final result. Missing/malformed final output, multiple structured results and native tool events fail with `CODEX_PROTOCOL_INVALID`. Diagnostics expose reason codes, not provider event bodies. Unknown usage can require owner reconciliation before resume.

## Claude CLI session

Run `node infra/dev.mjs claude-policy` before connecting an account on a new host. For an existing installation:

```sh
node bin/sabre.mjs prepare-claude
node bin/sabre.mjs build api
node bin/sabre.mjs build claude-runner
node bin/sabre.mjs up
node bin/sabre.mjs claude-login
```

Complete the official login in the owner's terminal, then select Claude and an explicit model. Preparation enables the runner for subsequent starts; selecting a provider in the panel alone does not start it or authenticate an account. To replace an already connected account, first run `node bin/sabre.mjs stop claude-runner`. An unconnected bridge is stopped by the login helper automatically.

The adapter admits verified personal Pro, Max or Ultra subscriptions. Unknown account types and organizational policies block inference. The proprietary CLI has a pinned version and digest, and a publisher notice separate from SABRE's source license. Refer to the vendor's [authentication guide](https://code.claude.com/docs/en/authentication) for account requirements.

Only the CLI's internal JSON-schema formatter is available; filesystem, shell, MCP, hooks and customization discovery are disabled. At most two internal turns may produce one validated structured envelope within the invocation deadline. There is no prose fallback. The native-policy check uses the pinned CLI against a local synthetic provider, without an account. Build `api` and `claude-runner` together after updates: mismatched bridge/control protocols are refused.

## Limits and troubleshooting

Each runner admits one inference at a time and bounds an invocation to two minutes, including admission/login checks. LangGraph retains its own agent-step and execution deadlines. One adapter invocation can contain multiple internal provider requests, including vendor reconnects. CLI aggregate tokens may only be known after invocation; the displayed call count and budget are not a subscription quota meter or an exact preventive token cap.

| Failure | Action |
| --- | --- |
| Rate limit or overloaded provider | Inspect the recorded code after bounded retries; check account capacity before resuming |
| Access denied | Check the account/plan and sign in again if required |
| Request rejected | Check the explicit model name and advanced settings |
| Protocol/structured-output failure | Preserve the diagnostic code and usage reservation; inspect before resuming |
| Native-policy positive control fails | Review host compatibility; leave the account disconnected |

CLI **reasoning effort** is configured under advanced model settings. Available levels and their interpretation depend on the CLI and model: Claude may lower unsupported levels; Codex passes the requested level to the provider, which can reject it. Provider default leaves the choice to the vendor. Role-specific models do not inherit the default model's effort. API providers have no equivalent control here yet. Higher effort has no demonstrated quality or cost benefit on SABRE tasks.

SABRE records CLI API spend as zero; subscription charges and account limits remain external. Zero API authorization never permits paid API calls. Embeddings need a separate supported API configuration and their own budget authorization; lexical memory remains available without them. Unknown outcomes retain reservations. See [budget recovery](operations.md#budget-recovery) and [per-call telemetry](observability.md#per-call-telemetry).
