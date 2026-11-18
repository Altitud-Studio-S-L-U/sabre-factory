# Development

Use Node.js and pnpm versions declared in [web/package.json](../web/package.json). Backend tooling runs in pinned containers with Python 3.14; no host Python environment is required. Preserve the project's stack, authorization boundaries and deterministic gates.

## Local checks

From the checkout root:

```sh
node --test infra/*.test.mjs
node infra/dev.mjs test
node infra/dev.mjs lint
node infra/dev.mjs types
node bin/sabre.mjs bench compare --strict
pnpm --dir web install --frozen-lockfile
pnpm --dir web typecheck
pnpm --dir web lint
pnpm --dir web format:check
pnpm --dir web test
pnpm --dir web exec playwright install chromium
pnpm --dir web test:browser
pnpm --dir web build
```

PostgreSQL integration checks use disposable databases on the isolated development network. Start this checkout's development PostgreSQL using `node infra/ops.mjs init`, `node infra/ops.mjs build postgres` and `node infra/ops.mjs up postgres`; do not point tests at an unrelated installation. Set `SABRE_DEV_NETWORK=sabre-factory_control` in the shell and run `node infra/dev.mjs test tests integration`. Each invocation creates private database/bootstrap fixtures.

`node infra/bootstrap-check.mjs` checks repeatable provisioning and encrypted legacy migration. Native isolation checks are `node infra/dev.mjs codex-policy` and `node infra/dev.mjs claude-policy`; read the [host-policy requirements](providers.md) first. Runtime and real-API browser checks are in [operations](operations.md#verification).

The browser fixture suite mocks API responses. The separate `infra/qa.mjs` suite uses real API/PostgreSQL services without a provider. Do not run two suites on shared ports/results: configure `SABRE_BROWSER_PORT` and `SABRE_BROWSER_RESULTS`. Gallery captures go under `work/gallery/<label>/`; label their example data accordingly.

## Harness bench

`node bin/sabre.mjs bench --task patch-discount` exercises the included Python fixture. Omit `--task` for the suite. The real graph, role loop, policies, context projection, budgets and checkpoints run with reference model/executor/publisher implementations and no external account. PATCH graders run regression tests against the delivered snapshot; AUDIT graders require unchanged source and expected evidence.

Reports under `work/bench/` contain outcomes, grades, calls, estimated tokens, context bytes, tools and stage order. Tokens use UTF-8 bytes divided by four and are not provider measurements. Probes describe harness behavior separately from task grading. A pass does not establish real-model task quality.

`bench compare --strict` compares against [the committed baseline](../backend/bench/reports/baseline.json). It fails on regressions and any other baseline difference. Update with `bench baseline` only after reviewing an intentional behavior change; include the change and baseline together. Do not weaken tests, permissions or thresholds to obtain a pass.

## Contribution workflow

Create descriptive branches under `feat/`, `fix/`, `docs/`, `ci/` or `chore/`; never use `codex/`. Use Conventional Commits and keep each commit coherent. Keep secrets, personal configuration, generated reports, dependencies and temporary files out of version control. Update existing public guides when behavior changes; keep internal planning and UI prototypes outside published documentation.

Open a pull request with the problem, resulting behavior and relevant validation. Required CI must finish successfully on its exact head. Follow signature and branch protections. Merge, release and deployment use the owner's authorization. [.github/workflows/check.yml](../.github/workflows/check.yml) runs backend/integration checks on Linux amd64/arm64, launcher checks on four host targets, web checks, real-API browser journeys and candidate generation. These jobs do not establish complete platform support.

## Source distribution

The distribution target is the complete source product on GitHub. The Hatchling wheel has no launcher, panel, Compose services or bootstrap provisioning; `python -m sabre` has no application entry point. Do not upload it to PyPI as the product installer.

After committing the reviewed candidate and installing locked web dependencies:

```sh
pnpm --dir web licenses list --json --prod > work/web-licenses.json
node infra/dev.mjs run python -c "print('Candidate environment built')"
node infra/release.mjs
```

Ensure `work/` exists before redirecting the inventory. The helper requires a clean Git tree and matching backend/application/panel versions. It writes five assets under `work/release/<version>-<commit-prefix>/`:

| Asset | Contents |
| --- | --- |
| `sabre-factory-<version>-<commit-prefix>.tar.gz` | Tracked source at the exact commit |
| `backend.cdx.json` | Lock-derived CycloneDX backend inventory |
| `web.cdx.json` | Production web dependency/license inventory |
| `source.json` | Repository, package version and source commit |
| `SHA256SUMS` | SHA-256 values for the other four files |

Select only that candidate directory. Verify its source commit and every checksum; review archive contents, source/history exposure and [LICENSE](../LICENSE), [NOTICE](../NOTICE) and [binary notices](../infra/licenses/). Installed metadata supplements backend licenses only for matching versions; platform-unavailable metadata stays explicitly unresolved. An inventory is not a redistribution-rights certification. Source assets do not bundle provider binaries, images or downloaded dependencies.

CI retains candidates named for the exact checkout commit. Public main pushes also generate GitHub build-provenance attestations. A `source.json` receipt alone is not a cryptographic attestation. Download and verify the exact candidate before publication. Preserve existing version tags and release assets; changed release contents require a later version.

SABRE separately prepares registered-project delivery candidates through `/api/v1/releases`. Preparation does not publish. Publication requires expiring authorization bound to digest/revision and successful exact-commit CI, security and artifact checks. Unknown external responses require read-only reconciliation. Synthetic runs are not publishable delivery evidence. This grants neither merge nor deployment.

## Dependency and image review

Runtime images are digest-pinned and dependencies locked. Ordinary updates retain the seven-day release-age policy. Image security steps use signed distribution updates, so rebuilt identities can change even with the same base digest. Retain exact application/database images needed by backups.

The preview includes APT fixes for CVE-2026-109518, pip 26.3/npm 11.21.3 in language runners and OpenTelemetry 1.45.2 for CVE-2026-126360. Runtime images exclude pip and installer/download caches. These changes do not clear other advisories.

Candidate-specific review remains necessary for unfixed distribution findings, scanner applicability and development dependencies. The preview review retained findings involving SQLite/zlib source metadata, gosu's bundled Go runtime, pnpm's vendored undici, pip's vendored setuptools metadata, and development minimatch/picomatch dependencies. A source-lock scan does not clear image findings; passing CI does not imply zero vulnerabilities. Record exact package/image, fix availability and disposition with candidate evidence; do not silently suppress findings or infer current advisory status from this historical list.
