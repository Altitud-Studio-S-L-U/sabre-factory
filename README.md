# SABRE Factory

A local software factory for Python and JavaScript/TypeScript projects. Define an outcome, choose models by phase, and follow the work through checks, independent review and a draft pull request.

SABRE runs on your machine with your credentials. LangGraph owns recoverable execution; the panel, MCP tools and Slack use the same application service. Merge and deployment remain separate decisions.

## Status

Experimental and unreleased. What is tested is the control plane: durable and resumable runs, budgets with reserves, the command sandbox, security gates, owner confirmations, and the console, which a browser suite exercises against the real API. What is not proven is the work itself: no run with a real model has delivered a pull request, and the GitHub connection has only met a synthetic GitHub. Only Windows with Docker Desktop has been exercised. [The roadmap](docs/roadmap.md) lists every gap and the bar for a public release, and [the threat model](docs/threat-model.md) says what is defended and what is not.

## Start

Install Node.js 24 or later and a local Linux Docker engine with Compose. Use Docker Desktop on Windows or macOS, or Docker Engine on Linux. No dedicated WSL distribution is required.

```sh
node bin/sabre.mjs doctor
node bin/sabre.mjs init
node bin/sabre.mjs config
node bin/sabre.mjs build all
node bin/sabre.mjs prepare
node bin/sabre.mjs up
```

`up` opens the panel in your default browser, already signed in, on Windows, macOS and Linux. The browser stays paired while you use it and signs out after 30 days without use. To pair another browser, or after signing out, run `node bin/sabre.mjs open`. Use `up --no-open` on machines without a desktop. Run `npm link` once in this directory to use `sabre <command>` instead of `node bin/sabre.mjs <command>`. No link or token is displayed, and the panel never receives the permanent control credential.

`init` creates protected, service-specific bootstrap files and a master key in Docker volumes. The ignored `.env` contains public configuration. API keys entered in the write-only panel are encrypted in a separate PostgreSQL vault. Coding and verification containers receive no integration credentials.

Connect a model in Config › Models. An API provider (OpenAI, Anthropic, Google, or a local OpenAI-compatible endpoint) is the path this guide assumes: its key is entered in the write-only panel and stored encrypted. A Codex or Claude CLI session (`codex-login`, `claude-login`) is an alternative for your own machine only: it signs the vendor's CLI in with your personal account inside an isolated runner, and it is not meant for anything you share or run for others. Whether your plan allows that use is for you to check with the vendor; the factory cannot. Choose the factory default in Config and explicit role overrides in Agents; external connections are managed in Tools. Select explicit model names, approved destinations, prices and limits. Add a repository in Runs › Projects › Add project (from GitHub, by address or as a new repository) with its real verification commands, then launch a flow. See [operations](docs/operations.md) for login, isolation, backup and recovery.

The Supervisor conversation is available throughout the authenticated panel and through owner MCP tools. Messages are durable and read-only by default. Grant individual action tools per message when you want the Supervisor to act; run-scoped conversations cannot modify another run. Replies use the control worker independently of execution. Each new message pins its published Supervisor definition. Conversation, run coordination and independent judging retain separate contexts. A blocked message retains its checkpoint and can be explicitly reconciled and resumed.

Agents provides seven versioned specialists, with revision-checked drafts, validation and publication. Runs pin published instructions, registered procedures, skills and tool restrictions. Publishing a later version affects future launches. Tools also manages separately authenticated delegated clients and reviewed external-agent connections; external metadata and instructions cannot grant owner authority. See [configuration](docs/configuration.md) for these contracts and [implementation specs](docs/specs/README.md) for the agreed scope.

## Flows

| Flow | Outcome |
| --- | --- |
| `patch` | Baseline verification, scoped plan, regression fix, independent checks and draft PR |
| `maintain` | Analysis, dependency-ordered tasks, implementation, checks and draft PR |
| `create` | Requirements and architecture, implementation, checks and draft PR |
| `audit` | Checks and an evidence report; project changes block completion |

Flows use code-defined transitions. YAML selects registered models and skills; it cannot execute code or grant new tool permissions. Each run retains its resolved configuration and skill digests. Verification failures block publication. Budgets default to 40 invocations, 100,000 tokens, one hour and two repairs. Each metric can instead have an explicitly authorized finite reserve or no cumulative ceiling; paid API spend remains separately bounded. Repeated identical failed evidence requires intervention even with uncapped repairs. Unknown consumption remains unknown, and CLI token consumption may only be measured after an invocation.

[Flow configuration and integrations](docs/configuration.md) describe per-phase precedence, skills, Slack and signed webhooks. The panel shows measured phase, agent and tool events. Unknown measurements remain unknown. Browser tests use synthetic responses and are not evidence of a live provider run.

## Components

- `backend/`: FastAPI, Pydantic contracts, LangGraph/LangChain, PostgreSQL, Procrastinate and OpenTelemetry.
- `web/`: React/TypeScript panel; API types generated from the backend OpenAPI contract.
- `infra/` and `bin/`: pinned images, isolated runners and the common Node launcher.

[Architecture](docs/architecture.md) describes state ownership and trust boundaries. [Credential storage](docs/credential-storage.md) describes encryption and revocation.

## Verification

```sh
node --test infra/*.test.mjs
node bin/sabre.mjs bench
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
node bin/sabre.mjs build api && node infra/qa.mjs up && node infra/qa.mjs check; node infra/qa.mjs down
```

Backend checks run in pinned containers. `pnpm test:browser` answers every request from a mock; `node infra/qa.mjs check` runs the console against the real API and a real PostgreSQL on an isolated fixture, without a model provider. PostgreSQL integration and recovery checks require the isolated development network; see the operations guide. Dependency updates retain a seven-day release-age policy. Required checks must pass against the exact candidate commit.

The target host matrix is Windows 11 x64, Linux x64/arm64, and macOS Intel/Apple Silicon. Images support Linux amd64/arm64. An image build or launcher test alone does not establish full host compatibility. A public release requires installation, execution, restart and restore evidence on every advertised host; that validation is not yet complete.

## License and inspiration

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The visual separation of deterministic stages, agent work and human intervention is inspired by [super-simple-software-factory](https://github.com/disler/super-simple-software-factory). SABRE retains its own persistent runtime, tool broker and publication checks.
