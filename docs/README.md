# SABRE Factory documentation

SABRE Factory 0.1.0 is an experimental source preview for a single owner on a local Docker host. Start with the [installation instructions](../README.md#start), then check the [compatibility and validation limits](compatibility.md) before connecting a project.

| Guide | Use it to |
| --- | --- |
| [Operations](operations.md) | Connect a project, run work, resolve interruptions, back up and restore |
| [Model providers](providers.md) | Configure API models or an isolated personal CLI session |
| [Configuration and integrations](configuration.md) | Configure specialists, skills, flow YAML, budgets, MCP, Slack and webhooks |
| [Observability and evaluation](observability.md) | Inspect usage, traces and independently annotated run results |
| [Architecture](architecture.md) | Understand components, execution state and trust boundaries |
| [Credential storage](credential-storage.md) | Understand encryption, credential separation and key recovery requirements |
| [Threat model](threat-model.md) | Review enforced controls, their evidence and remaining risks |
| [Development](development.md) | Run checks and prepare source distribution artifacts |
| [Compatibility](compatibility.md) | Distinguish demonstrated behavior from pending platform and delivery validation |

The API's OpenAPI document at `/openapi.json` and the flow schema at `/api/v1/flows/schema` describe the running version's request types. Configuration does not grant authority beyond the application's permission checks.
