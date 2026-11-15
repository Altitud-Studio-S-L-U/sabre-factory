# Road to a public release

Written on 2026-11-14 from three audits of `main` (the previous plan against the code, telemetry, the Tools section) and a review of how current coding-agent products are built, evaluated and secured. It replaces the milestone plan that was kept outside the repository. It is a list of gaps and an order of work, not a record of success: evidence lives in pull requests, bench reports and run records.

## Verdict

The control plane is the strong part. Execution is durable and resumable, contracts are typed and versioned, budgets have reserves and revision-checked amendments, commands run in a brokered sandbox, secret and dependency scanners are gates, high-impact requests wait for the owner in the console, and the console shows an unknown value as unknown. That is the part that makes it safe to leave running.

The part that does the work is unproven and expensive. No run with a real model has delivered a pull request. The one audit that reached its report needed three harness fixes on the way, spent 43% of its tool calls recovering text it had already read, and read 5.5% of its input from cache. Only the audit flow has run with a real model; implementation, repair, review, delivery, releases, browser checks and A2A have synthetic evidence only.

So it is not yet ready to show as a factory that delivers verified pull requests. It is ready when the bar below is met.

The instance was reset on 2026-11-14 at the owner's request: every project, run and record from the test period was removed, so the figures above describe runs that no longer exist on it. Those runs used the Codex CLI; the default provider is now the Claude CLI.

## The bar

1. **It works, with a number.** A pass rate on a fixed suite of real tasks with a real model, with cost and time per passed task and the same model without the factory as a baseline ([16](specs/16-evaluation.md)).
2. **It is affordable.** Tokens per passed task within a stated multiple of that baseline, with most input read from cache ([14](specs/14-context-economy.md)).
3. **One path is effortless.** Connect GitHub, pick a repository, describe the task, watch it, receive a draft pull request with its evidence ([12](specs/12-github-connection.md), [13](specs/13-projects.md)).
4. **It installs.** Ten minutes from clone to console on Windows, macOS and Linux, each verified, with CI green on the final commit.
5. **It can be inspected and trusted.** A written threat model, cost that includes cache prices, and traces a standard viewer understands ([15](specs/15-observability.md)).
6. **It says what it is not.** A feature without real evidence is labelled experimental or left out of the first public version.

## Another framework?

No. LangGraph already provides what an orchestration framework is for here: an explicit graph, checkpoints in PostgreSQL, interrupts and resumption. CrewAI's current guidance puts a stateful flow at the centre with role crews inside its steps, which is the shape this project already has, with weaker persistence. Adding it would duplicate the scheduler that the specs forbid duplicating, and no independent evidence shows a gain.

The decision that matters is narrower: who runs the inner tool loop of the implement and repair stages. Today SABRE runs its own loop and calls the vendor CLI as a stateless model, one process per call with the whole history. That gives up the caching, compaction and parallel tool calls the vendors' own agents have. [Spec 14](specs/14-context-economy.md) keeps the current loop, fixes its economy, and defines a measured experiment with a vendor agent session as the worker. The evaluation suite decides between them.

## Gaps

| # | Gap | Evidence | Answer |
| --- | --- | --- | --- |
| G1 | No evidence with a real model | No delivered pull request. The bench has four scripted tasks on one fixture and nothing compares its reports | [16](specs/16-evaluation.md) |
| G2 | Context economy | 43% of tool calls were recoveries and 5.5% of input came from cache in the real audit. Results now leave in batches under pressure and the pressure notice no longer edits the system prompt; in the scripted bench an audit that fits its window recovers nothing, and one that must compact is unchanged. Requests to the Anthropic API now mark what can be cached. CLI session reuse and a real run to confirm any of it are still missing | [14](specs/14-context-economy.md) |
| G3 | An audit cannot finish when the scanner cannot parse valid code | Semgrep reported a partial parse of two valid TypeScript lines in the audited repository and the factory treats any scanner error as an incomplete scan | Owner decision 1 |
| G4 | The GitHub connection has not met github.com | A GitHub App can be registered from the console, installed on chosen repositories and used for reading and delivering with a token per operation and repository; commits made through it are signed by GitHub. All of it was exercised against a synthetic GitHub. Creating repositories still uses a pasted token | [12](specs/12-github-connection.md) |
| G5 | Adding a project has three forms | One Add project dialog in Projects now holds the three sources, and Tools only links to it. The sources still do not end on one shared form | The shared form of [13](specs/13-projects.md) |
| G6 | Telemetry is unproven on a real run | Cache counts are no longer dropped, cost charges cached input at its own prices, a failed call keeps its class in the ledger, Insights shows figures across runs, spans carry the standard GenAI names, a resumed run links to its predecessor, the executor records its commands, and operational events are logged. A cost the CLI reports is kept beside the charged one. Prices are still entered by hand, and no real run has fed any of it or been read in a viewer | [15](specs/15-observability.md) |
| G7 | Provider failures | A rate limit, an overload and a timeout are now retried twice inside the same reservation, each failure leaves with a code that names its class, and every failed call leaves an event. No fallback model yet, and no real provider has exercised it | [14](specs/14-context-economy.md) |
| G8 | No CI evidence and one verified platform | GitHub Actions is disabled for the repository, so no commit since 2026-11-11 has a CI result. Only Windows has been exercised | Phase 5 |
| G9 | The documented setup leads with subscription logins | The README starts by connecting a Codex or Claude CLI session, and the only real runs were made that way. Anthropic's documentation reserves subscription login for its own applications and asks products built on Claude to use API keys or a cloud provider. OpenAI's terms for the Codex CLI were not reviewed | Lead public documentation with API-key providers; present the CLI bridges as the owner's private option, whose terms the owner checks |
| G10 | Isolation is a hardened container | Read-only root, no network by default, dropped capabilities, seccomp and a Docker permission proxy, on a kernel shared with the control services. Current guidance for untrusted code is VM-level isolation with default-deny egress. The [threat model](threat-model.md) is written and names both as undefended | Make the executor's egress acceptance script part of a check that runs on the deployed host, evaluate a stronger runtime where the host offers one |
| G11 | The role pipeline is unmeasured | Seven specialists and several model stages, none justified by an ablation | [16](specs/16-evaluation.md) |
| G12 | Console and plan leftovers | See "Left over from the previous plan" | Phase 0 and Phase 5 |
| G13 | Work is sequential | One task at a time and no streaming; the console polls every five seconds | After G1 and G2: read-only parallel subagents first |
| G14 | Memory fills, and nothing shows that it helps | Reading a repository proposes what its instruction files and manifests say, the owner can record knowledge against an indexed commit, and a run's specialists can propose records whether or not it delivers. No real run has used the tool yet, and nothing measures whether recall helps | [17](specs/17-memory-sources.md) |

## Plan

Each phase ends on evidence, and Phase 1 is the gate: what it measures decides the size of Phases 2 and 3.

**Phase 0 · Close what is open.** The owner decides the scanner policy, so the next audit of a repository like that one completes or stops for a stated reason. Tools is organised by service (done alongside this document). Projects gains edit and archive (done, [13](specs/13-projects.md)). Memory opens on a map of the repository as indexed, stops claiming what it cannot do and proposes what the repository already says for the owner's review (done, [17](specs/17-memory-sources.md)). The small defects left from the previous plan are fixed (done: the run list shows a pending pause or cancel, the Supervisor reserves estimated tokens, no text is under 12 px, every hooks rule is an error, the launcher help is complete and in English, unused packages are gone). *Exit:* one real audit with a report; no known defect in the console's main path.

**Phase 1 · Prove.** Grow the suite to twenty tasks on three repositories (six tasks on two so far). Recovery ratio and prefix stability are reported by the scripted driver and compared with a committed baseline (done); run it in CI. Run the provider driver and the baseline with the owner's authorization and budget. Deliver the first real patch as a draft pull request on a sample repository. *Exit:* a committed report with pass rate, cost and time for the factory and for the baseline.

**Phase 2 · Economy.** Archive in batches under pressure and keep the prefix stable (done, measured with the scripted driver only). Classify and retry provider failures (done, tested against the SDKs' exception types, not against a provider). Account for cache tokens (done: read and written tokens are stored and priced, and the cache share is reported across runs) and mark what the Anthropic API can cache (done, unobserved against the provider). Rerun the suite. Measure runs with memory on and off, now that specialists can propose records ([17](specs/17-memory-sources.md)). Build the worker-session experiment and decide with the numbers. *Exit:* recoveries under 10% of tool calls, the cache share reported, and a written decision on the worker.

**Phase 3 · Effortless path.** GitHub connection with per-operation tokens and signed delivery commits through the API (built, against a synthetic GitHub); and one Add project dialog with the three sources (built); repository creation through the app is not. *Exit:* live evidence on github.com for a personal account and an organization; no token is pasted anywhere in the path.

**Phase 4 · Observable.** [Spec 15](specs/15-observability.md). Built except the price table per model: the ledger, cost with cache prices, a cost the provider reports, the metrics endpoint, Insights, standard attribute names, trace continuity, executor spans, logs and the viewer link. *Exit:* cost per run that matches the provider's invoice within the price table's precision, and an Insights page fed by real runs.

**Phase 5 · Installable and showable.** Verify macOS and Linux installs, turn CI back on, write the threat model (done), mark unproven surfaces as experimental (done as labels; hiding them instead stays the owner's choice), publish the report and real screenshots in the README. *Exit:* [spec 09](specs/09-validation.md)'s release gate.

## Decisions for the owner

1. **Scanner partial parse.** Record a warning-level partial parse as a visible coverage finding and let the audit complete, or keep failing closed. The audit it stopped was removed with the reset, and the next audit of that repository will stop the same way; nothing changes until this is decided.
2. **Real-model evaluation.** Authorization and budget for provider runs, and an API key for them: the baseline and the cache measurements need an API provider, and the public path needs one anyway (G9).
3. **Sample repositories** for the suite and for the public demonstration.
4. **Unproven surfaces** (A2A, releases, browser checks, the create flow, Slack, the GitHub connection): they now carry an Experimental label that hides and disables nothing. Keep the label or hide them in the first public version.
5. **Default budgets by flow**, once Phase 1 shows what an audit and a patch cost. The single default of 100,000 tokens stopped the real audit at its fourth call.
6. **CI and visibility.** When to turn Actions back on; the repository stays private until the release gate holds.

## Left over from the previous plan

| Item | State | Disposition |
| --- | --- | --- |
| No test covers the console mounted in the real application | Done: `node infra/qa.mjs check` runs browser journeys against the real API and PostgreSQL with no model provider. Its first runs found a launcher that did not parse, a configuration revision shown as a 32-bit-shifted token, a Supervisor that read Ready without a model and empty states that pointed at the wrong section; all fixed. No journey launches a run | Kept in CI's plan; Actions is off |
| Bench without a TypeScript fixture, a maintain task or a real-model driver; its reports now compare against a committed baseline | Partial | [16](specs/16-evaluation.md) |
| Default budgets are the same for every flow | Not done | Decision 5 |
| Timeline: zoom to selection, state kept per run across reloads | Not done | Phase 5, after the main path |
| Supervisor avatar as the helmeted foreman; a drawn avatar per specialist | Partial (an orb; initials in a ring) | Phase 5 |
| Collapsible sidebar; sticky run header | Not done | Phase 5 |
| Effort per role, progressive skills, provider retries | Not done | [14](specs/14-context-economy.md) |
| Streaming to the console | Not done | After G1 and G2 |

## Documentation that did not match the code

Corrected with this document: the operations and configuration guides named an Integrations section that no longer exists, the provider list omitted `claude_cli`, [spec 03](specs/03-configuration.md) described a setup wizard and [spec 05](specs/05-tools.md) did not describe the console.

Corrected since, by changing the sentence to what the code does: where blur is used, what the console keeps in browser storage, the Supervisor's two own stylesheets, the order of the registered checks and independent QA, and the timeline collapsing idle time by default.
