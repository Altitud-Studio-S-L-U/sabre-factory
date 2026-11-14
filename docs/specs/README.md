# Operator console implementation

These specifications define the operator console's behavior and acceptance contracts. Read them alongside the implementation and its tests; a listed deliverable is not evidence of production readiness. Preserve existing tests, active runs, credentials and repository history. Live-provider evidence and clean installation, execution, restart and restore on each advertised platform remain separate requirements under [09](09-validation.md) and [operations](../operations.md).

| Spec | Dependency | Deliverable |
| --- | --- | --- |
| [00](00-console-concept.md) | None | Reviewable five-section prototype |
| [01](01-contracts.md) | None | Versioned canonical contracts |
| [02](02-agents.md) | 01 | Specialist catalog and registered chains |
| [03](03-configuration.md) | 00 approval, 01 | Guided configuration and YAML |
| [04](04-runs.md) | 00 approval, 01, 02 | Live process console and inspector |
| [05](05-tools.md) | 00 approval, 01 | Connections, permissions and credentials |
| [06](06-a2a.md) | 01, 02, 05 | Bidirectional external delegation |
| [07](07-memory.md) | 01, 02 | Ingestion, provenance and retrieval |
| [08](08-delivery.md) | 01, 02, 04 | PR and release preparation policies |
| [09](09-validation.md) | 02–08 | Integrated behavior and distribution evidence |
| [10](10-budgets.md) | 01, 03, 04 | Per-metric bounds, reserves and amend/resume recovery |
| [11](11-browser-qa.md) | 01, 02, 04, 05 | Isolated browser preview and visual verification capability |
| [12](12-github-connection.md) | 05, 08 | One GitHub connection with per-operation tokens |
| [13](13-projects.md) | 01, 05, 12 | Project editing, archiving and one way to add a project |
| [14](14-context-economy.md) | 02, 10 | Batch archiving, stable prefix, provider cache and failure handling |
| [15](15-observability.md) | 04, 10, 14 | Standard trace attributes, cost with cache prices, insights across runs |
| [16](16-evaluation.md) | 02, 14 | Real-task suite, baseline and regression reports |
| [17](17-memory-sources.md) | 07, 16 | Memory sources beyond delivered runs, coverage map and an honest console |

Keep LangGraph as execution authority and PostgreSQL as the persistent store. Do not introduce an auxiliary routing model or duplicate execution state machine. All mutations must use the shared application authorization and durable receipts.

Build screens from the shared components in `web/src/components` and Tailwind utilities over the SABRE tokens; do not add per-screen stylesheets or a second component system. Tokens own colour, radius and type. Blur is limited to the sticky header, the mobile tab bar and floating Supervisor chrome, with opaque fallbacks and readable contrast. Text is at least 12 px; every state reads without colour alone (text, icon or shape).

Each spec closes with its observable acceptance checks. Prototype data never counts as runtime evidence. Specs 12 to 17 describe work that is not built yet (13 is built in part: editing and archiving); the order of that work and the gaps against a public release are in [the roadmap](../roadmap.md).
