# 09 · Integrated acceptance

## Outcome
Validate the exact candidate across console, runtime, external interfaces and supported hosts. Record results in the delivery conversation and candidate evidence rather than adding success diaries to the source tree.

## Scenarios
- Configure provider/model/project, ingest source and launch a reproducible regression fix through draft PR.
- Observe stages, messages, tool use and limits; pause, reconnect, answer and resume without duplicated effects.
- Kill and recover a worker; backup, restore and resume an interrupted run.
- Delegate to an independent A2A agent and submit work to SABRE through A2A and MCP.
- Exercise credential revocation, malicious repository instructions, memory isolation and uncertain publication.
- Verify desktop/mobile UI, keyboard focus, readable translucent surfaces and opaque fallbacks.
- Install, execute, stop/restart and restore on every advertised operating system/architecture.

## Publication gates
Every candidate requires terminal successful CI on its exact commit and review of source/history, dependencies, image advisories, inventories, checksums and provenance. Mocked tests do not establish provider, Slack, webhook or platform compatibility. Publication, merge and deployment use the owner's explicit authorization and the repository's branch protections.

The 0.1.0 experimental source preview may publish the complete source with Windows 11 x64 installation, real-model read-only execution, restart and isolated restore evidence. Its README and release notes must identify the experimental status, exact evidence scope, known advisories and unverified platforms and interfaces. Linux/macOS installation and real GitHub change delivery remain pending; the preview must not claim them as supported or demonstrated. The backend-only wheel is not a product distribution, so this preview does not target PyPI.

A stable release or broader host-support claims still require the end-to-end scenarios above, including a real regression fix through draft PR and installation, execution, restart and restore on each advertised host. Keep the repository private while required source-preview evidence is missing. Preserve resources supporting open work and retained backups.
