# Compatibility and validation

## Experimental preview scope

Version 0.1.0 distributes the complete source product through GitHub. Installation uses the Node.js launcher, the panel and Docker Compose together. The Python wheel contains only the backend and is not a product installer; this preview does not target PyPI.

The demonstrated scope includes durable execution, budget reservations, owner confirmations, sandbox controls, browser journeys against the real API, a real-model read-only Python audit, restart recovery and an isolated backup/restore check. These observations do not establish production readiness or successful delivery of changes by a real model.

| Host | Full installation, execution, restart and restore |
| --- | --- |
| Windows 11 x64 with Docker Desktop | Local evidence, including a real-model read-only Python audit |
| Linux x64 | Pending |
| Linux arm64 | Pending |
| macOS Intel | Pending |
| macOS Apple Silicon | Pending |

Images target Linux amd64 and arm64. CI tests the launcher on Windows, macOS and both Linux architectures, and backend contracts in both Linux architectures. A launcher test or container build does not prove the complete host lifecycle.

## Project requirements

- Python jobs use Python 3.14. Locked dependencies must supply compatible wheels for the runner architecture. Preparation disables source builds and project installation scripts; gates must run against the source checkout without installing the project itself.
- JavaScript/TypeScript jobs require supported locked dependencies. Preparation has restricted registry access; coding and verification have no network by default.
- A project identifies one initialized repository, its base branch, environment and explicit verification commands. Cross-repository atomic delivery is not implemented.
- The deployment assumes one trusted owner and one trusted Docker host. Shared hosting, multiple tenants and high availability are outside the evaluated scope.

## Integration and recovery limits

No run with a real model has delivered a pull request. The GitHub connection has been exercised against a synthetic GitHub service; that does not validate its live installation and delivery path. Mocked provider, Slack, webhook, MCP and A2A tests establish their tested contracts, not every live client or account configuration.

The provider-free bench uses the real workflow graph with reference implementations for model, executor and publisher. The real-API console fixture has no model provider and does not launch work. Neither is evidence of a live-model delivery.

The isolated restore check validates databases, vault decryption, artifacts, broker snapshots and a restored LangGraph intervention using the original protected master key and matching images. Recovery after loss of the master key is not possible from the database backup alone. Native CLI isolation must be checked with the effective host security policy; a successful image build is insufficient.

Browser automation exercises actual rendered interactions and accessibility rules. The shipped model adapters do not receive image input, so model-based screenshot review is unavailable. Passing automation does not establish complete accessibility compliance or subjective design quality.

## Requirements for broader claims

Before a stable release or a broader host-support claim, retain evidence on the exact candidate for:

1. Installation, provider/model/project configuration and a reproducible regression fix through a real draft pull request.
2. Pause, reconnect, answer and resume without duplicated external effects; worker termination and checkpoint recovery.
3. Backup, restore and resumption of interrupted work on every advertised operating system and architecture.
4. Live external interfaces being advertised, including delegated-agent and MCP submission where applicable.
5. Credential revocation, malicious repository content, project-memory separation and uncertain-publication reconciliation.
6. Desktop/mobile interaction, keyboard focus and any required visual evidence.

Every public candidate also needs successful CI on its exact commit, source and history review, third-party notice review, dependency and image-advisory disposition, inventories and verified checksums. See [development](development.md#source-distribution) and the [threat model](threat-model.md). Keep unverified behavior explicit in the README and release notes.
