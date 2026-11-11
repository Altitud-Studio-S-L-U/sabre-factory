# 08 · Commits, PRs and releases

## Outcome
Apply explicit delivery policies and let DevOps prepare release candidates. Preserve the existing controlled publisher and publication receipts.

## Interfaces and behavior
Validate Conventional Commit messages before publication. Draft PRs include scope, acceptance, exact checked snapshot, executed checks and remaining limitations. A model's summary cannot replace system evidence.

Release preparation produces version, changelog, inventories, checksums and an immutable candidate referencing the exact commit. Publication is a separate authenticated command, authorized for that candidate, with idempotency and uncertain-effect reconciliation. Recheck terminal CI, required security disposition and candidate identity before publishing. Merge/deployment remain independently unauthorized.

## Acceptance
Failed or missing checks block publication. Reject stale approval, changed artifact, invalid commit message and CI from another commit. Recover a lost GitHub response without duplicate release/PR. Verify no author email, session material or secret enters artifacts. Never publish from the prototype or synthetic fixtures.
