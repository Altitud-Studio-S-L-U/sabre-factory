# SABRE Factory

A local software factory for Python and JavaScript/TypeScript projects. Define an outcome, choose models by phase, and follow the work through checks, independent review and a draft pull request.

SABRE runs on your machine with your credentials. LangGraph owns recoverable execution; the panel, MCP tools and Slack use the same application service. Merge and deployment remain separate decisions.

## Start

Install Node.js 24 or later and a local Linux Docker engine with Compose. Use Docker Desktop on Windows or macOS, or Docker Engine on Linux. No dedicated WSL distribution is required.

```sh
node bin/sabre.mjs doctor
node bin/sabre.mjs init
node bin/sabre.mjs config
node bin/sabre.mjs build all
node bin/sabre.mjs prepare
node bin/sabre.mjs up
node bin/sabre.mjs open
```

On Windows, run `open` in your own interactive terminal and follow the single-use local link. Do not redirect or share it. The panel never receives the permanent control credential.

`init` creates protected, service-specific bootstrap files and a master key in Docker volumes. The ignored `.env` contains public configuration. API keys entered in the write-only panel are encrypted in a separate PostgreSQL vault. Coding and verification containers receive no integration credentials.

Connect an official Codex or Claude CLI session with `codex-login` or `claude-login`, or configure an API provider in Integrations. Select explicit model names, approved destinations, prices and limits. Register a repository with its real verification commands, then launch a flow. Alternatively, authorize creation of a new repository and its flow together in Integrations. See [operations](docs/operations.md) for login, isolation, backup and recovery.

## Flows

| Flow | Outcome |
| --- | --- |
| `patch` | Baseline verification, scoped plan, regression fix, independent checks and draft PR |
| `maintain` | Analysis, dependency-ordered tasks, implementation, checks and draft PR |
| `create` | Requirements and architecture, implementation, checks and draft PR |
| `audit` | Checks and an evidence report; project changes block completion |

Flows use code-defined transitions. YAML selects registered models and skills; it cannot execute code or grant new tool permissions. Each run retains its resolved configuration and skill digests. Verification failures block publication. Repair defaults to two cycles and can be reduced. API cost, invocation, token and active-time limits are checked by the runtime.

[Flow configuration and integrations](docs/configuration.md) describe per-phase precedence, skills, Slack and signed webhooks. The panel shows measured phase, agent and tool events. Unknown measurements remain unknown. Browser tests use synthetic responses and are not evidence of a live provider run.

## Components

- `backend/`: FastAPI, Pydantic contracts, LangGraph/LangChain, PostgreSQL, Procrastinate and OpenTelemetry.
- `web/`: React/TypeScript panel; API types generated from the backend OpenAPI contract.
- `infra/` and `bin/`: pinned images, isolated runners and the common Node launcher.

[Architecture](docs/architecture.md) describes state ownership and trust boundaries. [Credential storage](docs/credential-storage.md) describes encryption and revocation.

## Verification

```sh
node --test infra/*.test.mjs
node infra/dev.mjs test
node infra/dev.mjs lint
node infra/dev.mjs types
pnpm --dir web install --frozen-lockfile
pnpm --dir web typecheck
pnpm --dir web lint
pnpm --dir web test
pnpm --dir web exec playwright install chromium
pnpm --dir web test:browser
pnpm --dir web build
```

Backend checks run in pinned containers. PostgreSQL integration and recovery checks require the isolated development network; see the operations guide. Dependency updates retain a seven-day release-age policy. Required checks must pass against the exact candidate commit.

The target host matrix is Windows 11 x64, Linux x64/arm64, and macOS Intel/Apple Silicon. Images support Linux amd64/arm64. An image build or launcher test alone does not establish full host compatibility. A public release requires installation, execution, restart and restore evidence on every advertised host; that validation is not yet complete.

## License and inspiration

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The visual separation of deterministic stages, agent work and human intervention is inspired by [super-simple-software-factory](https://github.com/disler/super-simple-software-factory). SABRE retains its own persistent runtime, tool broker and publication checks.
