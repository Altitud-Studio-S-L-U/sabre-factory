# 01 · Canonical contracts and versions

## Outcome and interfaces
Extend Pydantic contracts with versioned AgentDefinition, ChainDefinition, ChainStep, AgentMessage, StepResult and ArtifactReference. Generate JSON Schema, OpenAPI and TypeScript from those definitions. Commands, events and domain messages remain distinct typed envelopes; MCP/A2A wire formats remain official protocol formats.

## Behavior
Messages carry run, step, attempt, sender, recipient and correlation identifiers. Effectful commands carry idempotency keys; events have persistent sequence numbers. Chain steps reference registered capabilities, not executable YAML strings. Artifacts keep native formats and are referenced by bounded metadata and digests.

Use additive, versioned migrations. Preserve current configuration parsing and historical runs; explicitly adapt old role identifiers at the boundary. Invalid or unsupported versions must produce structured errors before effects. Snapshot resolved configuration and published definitions at launch.

## Acceptance
Reject coercions, unknown fields, missing required values, unregistered steps and incompatible results. Verify duplicate command reconciliation, concurrent revision conflicts and round-trip generated types. Existing run recovery tests must remain valid.
