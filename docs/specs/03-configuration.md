# 03 · Guided configuration

## Outcome
Make setup understandable without exposing implementation details as required decisions. Reuse the existing model, integration and flow services.

## Interfaces and behavior
Offer guided editing and YAML for the same versioned contract. Parsing returns field-level diagnostics; preview returns the resolved configuration and diff without mutation. Save uses revision checking. Secret values never appear in documents, diffs or exports.

Setup proceeds through provider connection, explicit model, project access and readiness. CLI login remains the official owner authentication path. A connected session alone is not readiness. Model overrides, limits, policies and storage are progressive advanced options. Existing precedence remains phase-run → phase-flow → role → default.

Show Codex CLI, Claude Code, OpenAI API and Anthropic API as distinct connection methods, with existing Google/custom-endpoint adapters under advanced choices. Session and API-key authentication require different instructions and diagnostics. Preserve the selected provider when editing; changing provider clears incompatible model and credential bindings.

GitHub is a repository/delivery connection, not a model provider. Reuse current destination-scoped, write-only read/publish/create credentials with explicit repository and operation permissions. Check access before readiness. Do not silently import credentials from the operator's CLI or keychain. A future GitHub App installation flow needs its own authentication and integration specification; do not present it as implemented.

Policy domains include commits/PRs, branch naming, UI/component conventions, infrastructure/architecture, security and run budgets. Every rule is a typed Required constraint with a registered validator or an advisory Preference. Do not describe subjective design preferences as mechanically verified. Show effective value, origin, version, validation method and conflicts. Resolve factory/project bindings at launch and pin them; run settings cannot silently relax mandatory policy or grant permissions. A material exception needs explicit authorization and a receipt.

Budget policy is specified in [10](10-budgets.md). Replace fixed repair-count assumptions with explicit per-run bounds or uncapped values only after the new budget contract and recovery behavior are implemented.

## Acceptance
Round-trip equivalent forms and YAML; preserve current schema compatibility. Reject aliases, duplicate keys, unknown capabilities and oversized input. Preserve unsaved edits after conflicts. Saving must not run agents, increase permissions or publish. Readiness displays missing inputs with a concrete next action, including unavailable models or absent GitHub permissions.
