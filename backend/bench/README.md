# SABRE Bench

Fixture repositories (`repos/`), task definitions (`tasks/`) and hidden graders (`graders/`) for the
harness bench. Run it with `sabre bench`; see `docs/operations.md#sabre-bench`.

A task names its repository, mode, objective, acceptance criteria, gate commands, grader and the
reference policy's inspection paths, plan and edits. Graders never ship inside the fixture repository:
PATCH graders are copied next to the delivered snapshot only after the run finishes.
