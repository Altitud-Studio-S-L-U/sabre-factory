# 00 · Console concept

## Outcome
Review the five-section operator experience before further production UI changes. Open `../prototype/index.html` in a browser. It is self-contained, makes no network calls and holds only synthetic data in memory.

## Behavior
- Runs: inspect nodes, JSON and evidence; preview pause, a question and delivery.
- Agents: inspect all seven specialists, chains, instructions, tools, context and versions.
- Tools: distinguish endpoint availability, credential state and effective access; preview diagnostics.
- Memory: inspect provenance, proposals, sources, relationships and supplied context.
- Config: follow provider → model → project → readiness; inspect the effective contract and policies.
- Scenario selector previews empty, error and disconnected conditions. Disconnection disables mutations.

## Acceptance and boundary
Review desktop and mobile, keyboard focus, readable translucency, navigation, inspector selection and error recovery. All demonstration values must remain labelled. The prototype's JSON check is illustrative, not the production YAML/schema validator. Obtain visual-direction approval before implementing this design in React. No backend or account state changes are part of this spec.
