# 13 · Projects

## Outcome
Make a project something the owner can add, change and retire in one place. Today a project can only be created: its checks cannot be edited, a project that is no longer wanted stays in every list, and three screens can create one (the Projects dialog, the repository browser in Tools and the create flow).

## Interfaces and behavior
Projects stays a page of the Runs area; the sidebar keeps its five sections.

**Add.** One Add project action with three sources. *From GitHub* lists the repositories the connection reaches ([12](12-github-connection.md)) and falls back to the account search while only tokens are configured. *By address* registers a public repository. *New repository* prepares the creation proposal and, optionally, the create flow that follows it; approval, single attempt and reconciliation are unchanged. Every source ends on the same form: name, environment and the verification commands, entered one per line as the argument array the runner executes. The repository import and creation blocks leave Tools › GitHub, which keeps only access and links here.

**Edit.** Name, default branch, environment, verification commands and browser preview are editable together, with an expected revision; allowed MCP servers keep their own revision-checked control in Tools. Stages read the project as they go, so an edit is refused while a run of the project is executing and applies to runs launched or resumed afterwards. Changing the repository address is not an edit: it is a new project.

**Archive and restore.** An archived project leaves the lists and pickers of Runs, Memory, Security findings, Tools and the MCP tools, and no run can be launched for it. Its runs, evidence, memory and receipts are kept and stay reachable by address, and a filter shows archived projects. Restore reverses it. Both are revision-checked commands with an audit event. A project with a run that is queued, running, paused, blocked or waiting cannot be archived; the refusal names the run. A scheduled security report never holds a project open, and the daily report skips archived projects. The console offers no deletion: removing evidence is an operator procedure, not a button.

**Contract.** `Project` gains `revision` and `archived_at`. `PUT /api/v1/projects/{id}` replaces the editable fields, and `POST .../archive` and `POST .../restore` change its state; each takes `expected_revision`. `GET /api/v1/projects` returns active projects and accepts `include=archived`. Admission and resumption refuse an archived project with a typed error before any effect. Every change records its revision, its action and the names of the fields it changed. The schema change is an additive, forward-only migration.

## Built so far
Edit, archive and restore, with their contract and audit, are built. Add project is one dialog in Projects with the three sources: From GitHub lists what the connection reaches and falls back to the account search while only tokens are configured; By address is the form that existed; New repository holds the creation proposals and the create flow. The dialog starts on From GitHub once the app is installed and on By address otherwise, and a draft by address survives a look at another source. Tools › GitHub no longer imports or creates: it keeps the access and links to the dialog.

Not built: the three sources do not yet end on one shared form. Importing from GitHub and registering by address each keep their own fields for name, environment and checks, and a created repository is still registered as a project in a separate step.

## Acceptance
Edit under a stale revision is refused and keeps the form's unsaved values. An edit is refused while a run of the project is executing. Archiving hides the project everywhere and blocks submission through the console, the API, MCP and A2A; its past runs still open. Archiving is refused while a run is queued, running, paused, blocked or waiting. Restore brings the project back with its memory intact. Browser tests cover the three sources on desktop and mobile, the edit conflict and the archived filter.
