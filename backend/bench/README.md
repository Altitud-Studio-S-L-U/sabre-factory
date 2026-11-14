# SABRE Bench

Fixture repositories (`repos/`), task definitions (`tasks/`) and hidden graders (`graders/`) for the
harness bench. Run it with `sabre bench`; see `docs/operations.md#sabre-bench`.

`reports/baseline.json` is the committed baseline of the reference policy: what the harness did on
this suite, without timing, prompts or code. `sabre bench compare` sets a run against it and
`sabre bench baseline` records it again when a change to the harness or the suite is intended.

`repos/ledger` is generated: four modules written by hand hold the logic and the risks an audit should
name, and the rest come from one template per record type, so the repository is large enough for a long
audit. `reference.read_batch` spreads the reads over several turns and `reference.revisit` names the
files the agent needs in view again when it concludes; what is no longer there it recovers, which is
what the recovery ratio counts.

A task names its repository, mode, objective, acceptance criteria, gate commands, grader and the
reference policy's inspection paths, plan and edits. Graders never ship inside the fixture repository:
PATCH graders are copied next to the delivered snapshot only after the run finishes.
