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

Keep LangGraph as execution authority and PostgreSQL as the persistent store. Do not introduce an auxiliary routing model or duplicate execution state machine. All mutations must use the shared application authorization and durable receipts.

Implement the approved design in the existing React application. Reuse its form fields, Select, Icon, notices, authentication and API client. Extract cohesive shared shell, surface, status and inspector components; do not replace the application or install a second component system. Tokens should own color, spacing and translucent surfaces. Blur is limited to navigation and inspector chrome, with opaque fallbacks and readable contrast.

Each spec closes with its observable acceptance checks. Prototype data never counts as runtime evidence.
