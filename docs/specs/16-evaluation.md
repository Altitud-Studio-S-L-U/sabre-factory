# 16 · Evaluation

## Outcome
A number the factory can stand behind: on a fixed suite of real tasks, how often it delivers a change that passes hidden checks, at what cost and in how long, compared with the same model working without the factory. Until this exists, no statement about what the factory can do is evidence.

## State it starts from
The bench has four tasks on one Python fixture and drives the real graph with a scripted policy. It measures harness mechanics, which is useful and stays. No task has run with a real model, reports are local and never compared, and the bench is not part of CI. `sabre.evaluation` can score recorded runs against labels, and no labelled set is committed.

## Interfaces and behavior
**Suite.** Between 20 and 50 tasks taken from real work orders and real failures, over at least three repositories and both supported stacks, in audit, patch and maintain modes. A task pins its snapshot, states the objective and acceptance as an owner would, and carries deterministic graders the agent never sees. Some tasks seed a defect that review or the security stage should flag, because passing tests is not the same as being mergeable. Fixtures are synthetic or licensed for redistribution.

**Drivers.** `scripted` is today's reference policy and runs in CI. `provider` uses a real model; it is a real run, so it needs the owner's explicit authorization and budget and never runs in CI. `baseline` gives the same task text, sandbox image and time limit to the model's own vendor agent with no factory stages, which shows what the factory adds or costs.

**Trials and report.** Each task runs N times (default three) in a clean environment. The report gives the pass rate with its interval, the share of tasks passed on every trial, tokens by kind, cost and wall and active time per passed task, and stops by reason. It names the model, the suite version, the harness commit and the limits. A difference under three points is not claimed as a difference.

**Harness metrics.** Every driver reports the recovery ratio, the prefix stability between consecutive requests, tokens per model call and the share of tokens by specialist ([14](14-context-economy.md)).

**Ablations.** Each stage that spends model tokens is measured with and without it. A stage that neither raises the pass rate nor catches a seeded defect is a candidate for removal: the pipeline has to earn its roles.

**Regression.** Reports are small JSON files without prompts or code, committed under `backend/bench/reports/`. `sabre bench compare` sets a report against the stored baseline, and CI fails the scripted driver on a regression of the mechanics metrics.

**Real runs.** Completed real runs can be labelled by the owner (delivered and correct, delivered and wrong, correctly blocked, wrongly blocked) and scored with `sabre.evaluation`, so the suite grows from what actually happened.

## Acceptance
The scripted driver is deterministic across two runs of the same commit. A grader cannot be read from the task workspace. A provider run without an authorization is refused before any call. The baseline driver runs in the same image with the same limits. `compare` flags a seeded regression and passes an unchanged report. A published figure can be regenerated from its committed report.
