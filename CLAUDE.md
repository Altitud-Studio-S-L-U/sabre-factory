# SABRE Factory

A local software factory: a LangGraph harness (agents, tools, context, budgets, security) that turns a
work order into a verified draft pull request, plus a console for the human owner.

## Layout

- `backend/src/sabre/`: FastAPI API, LangGraph workflow (`workflows.py`), agent loop (`agents.py`),
  tools (`tools.py`), executor broker (`executor.py`), PostgreSQL repository, MCP server.
- `backend/tests/` (unit), `backend/integration/` (PostgreSQL), `backend/bench/` (SABRE Bench fixtures).
- `web/`: React 19 + Vite + Tailwind 4 + shadcn console. `web/e2e/` Playwright journeys.
- `infra/`: launcher scripts (`ops.mjs`, `dev.mjs`, `qa.mjs`, `bench.mjs`), Compose, Dockerfiles.
- `bin/sabre.mjs`: the `sabre` command (`npm link` once to install it).
- Specs in `docs/specs/`, operations in `docs/operations.md`, architecture in `docs/architecture.md`, threat model in `docs/threat-model.md`.

## Verify

Backend checks run in pinned containers; there is no local Python environment.

```sh
node infra/dev.mjs test                    # backend unit tests
SABRE_DEV_NETWORK=sabre-factory_control node infra/dev.mjs test tests integration   # with disposable PostgreSQL
node infra/dev.mjs lint
node infra/dev.mjs types
node --test infra/*.test.mjs
node bin/sabre.mjs bench                    # harness bench, reference policy, no provider
cd web && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
cd web && pnpm test:browser                 # Playwright, desktop and mobile, with axe WCAG A/AA checks
```

`pnpm` comes from Corepack (`corepack pnpm ...`). Two Playwright suites must not share a port or a results
folder: set `SABRE_BROWSER_PORT` and `SABRE_BROWSER_RESULTS`. `SABRE_GALLERY=<label> pnpm test:browser gallery`
captures every section under `work/gallery/<label>/`.

## Rules

- Conventional Commits with the noreply identity. One subject per commit. **No `Co-Authored-By` trailers.**
- Branches `fix/...` and `feat/...`. Never merge, release, deploy or change repository visibility.
- Never start a real run, change a budget or resume an existing run without the owner's explicit
  authorization. The bench and tests use synthetic models only.
- Never ask for, print or commit secrets. Owner credentials stay in protected bootstrap volumes.
- Never weaken a test, a permission or a security check to obtain a pass. Report failures with output.
- Do not delete Docker volumes, sessions, evidence or credentials as a cosmetic fix.
- Product text and docs are in English.

## Operating the factory from Claude

`.mcp.json` registers the local stdio bridge (`node bin/sabre.mjs mcp-stdio`), which runs inside the API
container with the owner's authority. Use it only from a trusted local session. Remote agents use a
delegated MCP credential instead (see `docs/operations.md#mcp-access`).

Budget changes, security exceptions, answers to owner decisions (architecture, permission, scope, exception)
and repository creation requested over MCP are only filed: the owner confirms them in the console. Read the outcome with `sabre_confirmation` and never assume approval.
