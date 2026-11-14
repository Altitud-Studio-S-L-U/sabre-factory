# 13 · Projects

## Outcome
Make a project something the owner can add, change and retire in one place. Today a project can only be created: its checks cannot be edited, a project that is no longer wanted stays in every list, and three screens can create one (the Projects dialog, the repository browser in Tools and the create flow).

## Interfaces and behavior
Projects stays a page of the Runs area; the sidebar keeps its five sections.

**Add.** One Add project action with three sources. *From GitHub* lists the repositories the connection reaches ([12](12-github-connection.md)) and falls back to the account search while only tokens are configured. *By address* registers a public repository. *New repository* prepares the creation proposal and, optionally, the create flow that follows it; approval, single attempt and reconciliation are unchanged. Every source ends on the same form: name, environment and the verification commands, entered one per line as the argument array the runner executes. The repository import and creation blocks leave Tools › GitHub, which keeps only access and links here.

**Edit.** Name, default branch, environment, verification commands, browser preview and allowed MCP servers are editable with an expected revision. A change applies to runs launched afterwards; a run already admitted keeps the snapshot it resolved at launch. Changing the repository address is not an edit: it is a new project.

**Archive and restore.** An archived project leaves the lists and pickers of Runs, Memory, Security findings, Tools and the MCP tools, and no run can be launched for it. Its runs, evidence, memory and receipts are kept and stay reachable by address, and a filter shows archived projects. Restore reverses it. Both are revision-checked commands with an audit event. A project with a run that is not terminal cannot be archived; the refusal names the run. The console offers no deletion: removing evidence is an operator procedure, not a button.

**Contract.** `Project` gains `revision` and `archived_at`. `PATCH /api/v1/projects/{id}`, `POST .../archive` and `POST .../restore` take `expected_revision`; `GET /api/v1/projects` returns active projects and accepts `include=archived`. Admission refuses an archived project with a typed error before any effect. The schema change is an additive, forward-only migration.

## Acceptance
Edit under a stale revision is refused and keeps the form's unsaved values. An admitted run is unaffected by a later edit of its project's checks. Archiving hides the project everywhere and blocks submission through the console, the API, MCP and A2A; its past runs still open. Archiving is refused while a run is queued, running, paused, blocked or waiting. Restore brings the project back with its memory intact. Browser tests cover the three sources on desktop and mobile, the edit conflict and the archived filter.
